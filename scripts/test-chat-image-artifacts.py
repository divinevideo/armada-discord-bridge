#!/usr/bin/env python3
"""Artifact tests use synthetic saved Docker images; no daemon or credentials."""
import copy
import hashlib
import gzip
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
import sys
from unittest.mock import patch

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
HELPER = HERE / ('concord-image-artifacts.py' if HERE.name == 'divine' else 'chat-image-artifacts.py')
spec = importlib.util.spec_from_file_location('artifacts', HELPER)
a = importlib.util.module_from_spec(spec)
spec.loader.exec_module(a)
SHA = '1' * 40
HARNESS = '2' * 40


def add(tar, name, data):
    info = tarfile.TarInfo(name)
    info.size = len(data)
    tar.addfile(info, io.BytesIO(data))


class Artifacts(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.migrations = {p: hashlib.sha256(p.encode()).hexdigest() for p in a.REQUIRED_MIGRATIONS}
        if a.KIND == 'coop':
            self.migrations['db/src/scripts/api-server-pg/2026.10.19T00.14.35.add_room_operation_lifecycle.sql'] = hashlib.sha256(b'lifecycle').hexdigest()
        self.contract = {'migrations': self.migrations, 'client_inputs': {'src/Room.tsx': '3' * 64} if a.KIND == 'coop' else {}}
        self.manifest = {'version': 1, 'kind': a.KIND, 'source_sha': SHA, 'harness_sha': HARNESS,
                         'platform': 'linux/amd64', 'source_contract': self.contract, 'images': []}
        for target in a.TARGETS:
            entry = copy.deepcopy(target)
            entry.update({'tag': target['repository'] + ':' + SHA, 'local_tag': a.LOCAL_PREFIX + target['name'] + ':' + SHA, 'archive': target['name'] + '.tar'})
            self.archive(entry)
            self.manifest['images'].append(entry)
        self.write()

    def tearDown(self):
        self.tmp.cleanup()

    def archive(self, entry, command=None, revision=SHA, platform='amd64', missing=None, client=True):
        files = {}
        if entry['migrations']:
            for p in self.migrations:
                if p != missing:
                    files[entry['migration_prefix'] + p] = b'lifecycle' if 'lifecycle' in p and p not in a.REQUIRED_MIGRATIONS else p.encode()
        if entry['name'] == 'client' and client:
            files['usr/share/nginx/html/index.html'] = b'<html></html>'
            files['usr/share/nginx/html/assets/source.js'] = b'Room enforcement source client'
            assets = {p.removeprefix('usr/share/nginx/html/'): hashlib.sha256(v).hexdigest() for p, v in files.items() if p.startswith('usr/share/nginx/html/')}
            files['usr/share/nginx/html/source-build.json'] = json.dumps({'source_sha': SHA, 'inputs': self.contract['client_inputs'], 'assets': assets}).encode()
        layer = io.BytesIO()
        with tarfile.open(fileobj=layer, mode='w') as tar:
            for p, data in files.items():
                add(tar, p, data)
        layer = layer.getvalue()
        config = {'architecture': platform, 'os': 'linux', 'config': {
            'Entrypoint': entry['entrypoint'], 'Cmd': command or entry['command'],
            'Labels': {'org.opencontainers.image.source': a.SOURCE, 'org.opencontainers.image.revision': revision}},
            'rootfs': {'type': 'layers', 'diff_ids': ['sha256:' + hashlib.sha256(layer).hexdigest()]}}
        config = json.dumps(config).encode()
        config_name = hashlib.sha256(config).hexdigest() + '.json'
        path = self.root / entry['archive']
        with tarfile.open(path, 'w') as tar:
            add(tar, config_name, config)
            add(tar, 'layer.tar', layer)
            add(tar, 'manifest.json', json.dumps([{'Config': config_name, 'RepoTags': [entry['local_tag']], 'Layers': ['layer.tar']}]).encode())
        entry['config_digest'] = 'sha256:' + hashlib.sha256(config).hexdigest()
        entry['local_image_id'] = entry['config_digest']
        entry['archive_sha256'] = a.file_hash(path)

    def write(self):
        path = self.root / 'artifact-set.json'
        path.write_text(json.dumps(self.manifest))
        return a.file_hash(path)

    def verify(self):
        return a.verify(self.root, SHA, HARNESS, self.write(), self.contract)

    def test_containerd_index_id_and_gzip_layers(self):
        self.containerd_archives()

    def test_containerd_publication_tags_the_daemon_index_handle(self):
        self.containerd_archives()
        self.publication_readback(False)

    def containerd_archives(self):
        for entry in self.manifest['images']:
            path = self.root / entry['archive']
            with tarfile.open(path) as tar:
                parts = {m.name: tar.extractfile(m).read() for m in tar.getmembers()}
            saved = json.loads(parts['manifest.json'])[0]
            config = parts[saved['Config']]
            layer = gzip.compress(parts['layer.tar'], mtime=0)
            def descriptor(data, media, **extra):
                digest = 'sha256:' + hashlib.sha256(data).hexdigest()
                parts['blobs/sha256/' + digest.split(':')[1]] = data
                return {'digest': digest, 'size': len(data), 'mediaType': media, **extra}
            config_desc = descriptor(config, 'application/vnd.oci.image.config.v1+json')
            layer_desc = descriptor(layer, 'application/vnd.oci.image.layer.v1.tar+gzip')
            runtime = json.dumps({'schemaVersion': 2, 'config': config_desc, 'layers': [layer_desc]}).encode()
            runtime_desc = descriptor(runtime, 'application/vnd.oci.image.manifest.v1+json', platform={'os': 'linux', 'architecture': 'amd64'})
            index = json.dumps({'schemaVersion': 2, 'manifests': [runtime_desc]}).encode()
            index_desc = descriptor(index, 'application/vnd.oci.image.index.v1+json')
            parts['index.json'] = json.dumps({'schemaVersion': 2, 'manifests': [index_desc]}).encode()
            saved['Config'] = 'blobs/sha256/' + config_desc['digest'].split(':')[1]
            saved['Layers'] = ['blobs/sha256/' + layer_desc['digest'].split(':')[1]]
            parts['manifest.json'] = json.dumps([saved]).encode()
            with tarfile.open(path, 'w') as tar:
                for name, data in parts.items():
                    add(tar, name, data)
            entry['local_image_id'] = index_desc['digest']
            entry['archive_sha256'] = a.file_hash(path)
            self.assertNotEqual(entry['local_image_id'], entry['config_digest'])
        self.verify()

    def test_registry_index_resolves_the_exact_runtime_config(self):
        runtime = json.dumps({'config': {'digest': self.manifest['images'][0]['config_digest']}}).encode()
        digest = 'sha256:' + hashlib.sha256(runtime).hexdigest()
        index = {'manifests': [{'digest': digest, 'size': len(runtime), 'platform': {'os': 'linux', 'architecture': 'amd64'}}]}
        def stub(args, **kwargs):
            return runtime if '@sha256:' in args[-1] else json.dumps(index).encode()
        with patch.object(a, 'run', side_effect=stub):
            self.assertEqual(a.remote_config(self.manifest['images'][0]['tag']), self.manifest['images'][0]['config_digest'])

    def test_client_deletions_are_not_served_assets(self):
        if a.KIND != 'coop':
            return
        entry = self.manifest['images'][-1]
        path = self.root / entry['archive']
        with tarfile.open(path) as tar:
            parts = {m.name: tar.extractfile(m).read() for m in tar.getmembers()}
        saved = json.loads(parts['manifest.json'])[0]
        config = json.loads(parts[saved['Config']])
        for name, files in [('base.tar', {'usr/share/nginx/html/50x.html': b'old base page'}), ('remove.tar', {'usr/share/nginx/html/.wh.50x.html': b''})]:
            layer = io.BytesIO()
            with tarfile.open(fileobj=layer, mode='w') as tar:
                for file, data in files.items():
                    add(tar, file, data)
            parts[name] = layer.getvalue()
            config['rootfs']['diff_ids'].append('sha256:' + hashlib.sha256(parts[name]).hexdigest())
            saved['Layers'].append(name)
        data = json.dumps(config).encode()
        config_name = hashlib.sha256(data).hexdigest() + '.json'
        parts[config_name] = data; saved['Config'] = config_name
        parts['manifest.json'] = json.dumps([saved]).encode()
        with tarfile.open(path, 'w') as tar:
            for name, data in parts.items():
                add(tar, name, data)
        entry['config_digest'] = entry['local_image_id'] = 'sha256:' + config_name[:-5]
        entry['archive_sha256'] = a.file_hash(path)
        self.verify()

    def test_compressed_layer_descriptor_hash_checked(self):
        self.containerd_archives()
        entry = self.manifest['images'][0]
        path = self.root / entry['archive']
        with tarfile.open(path) as tar:
            parts = {m.name: tar.extractfile(m).read() for m in tar.getmembers()}
        name = json.loads(parts['manifest.json'])[0]['Layers'][0]
        parts[name] += b'altered compressed bytes'
        with tarfile.open(path, 'w') as tar:
            for name, data in parts.items():
                add(tar, name, data)
        entry['archive_sha256'] = a.file_hash(path)
        with self.assertRaises(ValueError):
            self.verify()

    def test_complete_set(self):
        self.assertEqual(len(self.verify()['images']), len(a.TARGETS))

    def test_wrong_source_before_docker(self):
        self.manifest['source_sha'] = '3' * 40
        with patch.object(a, 'run', side_effect=AssertionError('must not invoke docker')):
            with self.assertRaises(ValueError):
                self.verify()

    def test_full_sha_required(self):
        with self.assertRaises(ValueError):
            a.verify(self.root, SHA[:7], HARNESS, self.write(), self.contract)

    def test_missing_or_unexpected_image(self):
        original = copy.deepcopy(self.manifest)
        for mutation in ('missing', 'db-client'):
            self.manifest = copy.deepcopy(original)
            if mutation == 'missing':
                self.manifest['images'].pop()
            else:
                self.manifest['images'][0]['repository'] += '-db-client'
            with self.assertRaises(ValueError):
                self.verify()

    def test_wrong_command_platform_revision(self):
        entry = self.manifest['images'][0]
        for options in ({'command': ['bun', 'run', 'packages/bridge/src/index.ts']},
                        {'platform': 'arm64'}, {'revision': '3' * 40}):
            self.archive(entry, **options)
            with self.assertRaises(ValueError):
                self.verify()

    def test_missing_migration(self):
        for entry in self.manifest['images']:
            if entry['migrations']:
                for missing in self.migrations:
                    self.archive(entry, missing=missing)
                    with self.assertRaises(ValueError):
                        self.verify()
                self.archive(entry)

    def test_migration_hash_mismatch(self):
        self.contract['migrations'][a.REQUIRED_MIGRATIONS[0]] = '0' * 64
        with self.assertRaises(ValueError):
            self.verify()

    def test_upstream_static_client(self):
        if a.KIND != 'coop':
            return
        entry = self.manifest['images'][-1]
        self.archive(entry, client=False)
        with self.assertRaises(ValueError):
            self.verify()

    def test_manifest_hash_and_archive_hash(self):
        with self.assertRaises(ValueError):
            a.verify(self.root, SHA, HARNESS, '0' * 64, self.contract)
        self.manifest['images'][0]['archive_sha256'] = '0' * 64
        with self.assertRaises(ValueError):
            self.verify()

    def test_layer_hash_checked(self):
        entry = self.manifest['images'][0]
        path = self.root / entry['archive']
        # Retain the config identity while altering a layer.
        with tarfile.open(path) as tar:
            parts = {m.name: tar.extractfile(m).read() for m in tar.getmembers()}
        parts['layer.tar'] = b'altered layer'
        with tarfile.open(path, 'w') as tar:
            for name, data in parts.items():
                add(tar, name, data)
        entry['archive_sha256'] = a.file_hash(path)
        with self.assertRaises(ValueError):
            self.verify()

    def test_no_authorization_no_push(self):
        with patch.object(a, 'run', side_effect=AssertionError('no login/push allowed')):
            for authorized in ('', 'false', 'true', SHA[:7]):
                with self.assertRaises(ValueError):
                    a.publish(self.root, SHA, HARNESS, self.write(), self.contract, authorized)

    def test_invalid_set_cannot_push_even_authorized(self):
        self.manifest['images'].pop()
        with patch.object(a, 'run', side_effect=AssertionError('no login/push allowed')):
            with self.assertRaises(ValueError):
                a.publish(self.root, SHA, HARNESS, self.write(), self.contract, SHA)

    def test_conflicting_remote_tag_fails_before_push(self):
        calls = []
        def stub(args, **kwargs):
            calls.append(args)
            if '--raw' in args:
                return json.dumps({'config': {'digest': 'sha256:' + '0' * 64}}).encode()
            return b''
        with patch.object(a, 'run', side_effect=stub):
            with self.assertRaises(ValueError):
                a.publish(self.root, SHA, HARNESS, self.write(), self.contract, SHA)
        self.assertFalse(any('push' in call or 'login' in call for call in calls))

    def test_authorized_publication_reads_back_without_execution(self):
        self.publication_readback(False)

    def test_matching_existing_tags_are_not_overwritten(self):
        self.publication_readback(True)

    def publication_readback(self, existing):
        calls = []
        published = {image['tag'] for image in self.manifest['images']} if existing else set()
        def stub(args, **kwargs):
            calls.append(args)
            if args[1:3] == ['buildx', 'imagetools']:
                if '--raw' in args:
                    tag = args[-1]
                    if tag not in published and '@sha256:' not in tag:
                        raise a.subprocess.CalledProcessError(1, args, stderr=b'manifest unknown')
                    image = next(x for x in self.manifest['images'] if x['tag'] == tag or tag.startswith(x['repository'] + '@'))
                    return json.dumps({'config': {'digest': image['config_digest']}}).encode()
                image = next(x for x in self.manifest['images'] if x['tag'] == args[4])
                raw = json.dumps({'config': {'digest': image['config_digest']}}).encode()
                return json.dumps({'digest': 'sha256:' + hashlib.sha256(raw).hexdigest()}).encode()
            if args[1] == 'tag':
                image = next(x for x in self.manifest['images'] if x['tag'] == args[3])
                self.assertEqual(args[2], image['local_image_id'])
            if args[1] == 'push':
                published.add(args[2])
            if args[1:3] == ['image', 'inspect']:
                image = next(x for x in self.manifest['images'] if args[3].startswith(x['repository'] + '@'))
                return json.dumps([{'Id': image['local_image_id'], 'Architecture': 'amd64', 'Os': 'linux', 'Config': {
                    'Entrypoint': image['entrypoint'], 'Cmd': image['command'], 'Labels': {
                        'org.opencontainers.image.source': a.SOURCE, 'org.opencontainers.image.revision': SHA}}}]).encode()
            return b''
        with patch.object(a, 'run', side_effect=stub):
            a.publish(self.root, SHA, HARNESS, self.write(), self.contract, SHA)
        self.assertEqual(len(published), len(a.TARGETS))
        self.assertEqual(sum(call[1] == 'push' for call in calls), 0 if existing else len(a.TARGETS))
        self.assertFalse(any('run' in call or 'login' in call or 'build' in call for call in calls))
        result = json.loads((self.root / 'published-digests.json').read_text())
        expected_digest = 'sha256:' + hashlib.sha256(json.dumps({'config': {'digest': self.manifest['images'][0]['config_digest']}}).encode()).hexdigest()
        self.assertEqual(result['images'][0]['digest'], expected_digest)
        self.assertNotEqual(result['images'][0]['digest'], self.manifest['images'][0]['config_digest'])

    def test_registry_error_is_not_treated_as_absent(self):
        with patch.object(a, 'run', side_effect=a.subprocess.CalledProcessError(1, ['docker'], stderr=b'unauthorized')):
            with self.assertRaises(a.subprocess.CalledProcessError):
                a.publish(self.root, SHA, HARNESS, self.write(), self.contract, SHA)

    def test_missing_lifecycle_contract(self):
        self.contract['migrations'] = {p: h for p, h in self.migrations.items() if 'lifecycle' not in p}
        with self.assertRaises(ValueError):
            self.verify()

    def test_local_tags_never_name_a_registry(self):
        for image in self.manifest['images']:
            self.assertTrue(image['local_tag'].startswith('divine-local/'))
            self.assertTrue(image['tag'].startswith(a.REGISTRY))

    def test_source_hashes_are_discovered_from_exact_git_revision(self):
        source = self.root / 'source'
        source.mkdir()
        def git(*args):
            return a.subprocess.check_output(['git', *args], cwd=source, stderr=a.subprocess.PIPE).decode().strip()
        git('init', '-q')
        git('config', 'user.email', 'synthetic@example.invalid')
        git('config', 'user.name', 'Synthetic artifact test')
        paths = list(self.migrations)
        paths.append(a.MIGRATION_ROOT + '/999_extra_forward.sql')
        for path in paths:
            (source / path).parent.mkdir(parents=True, exist_ok=True)
            (source / path).write_text('-- synthetic ' + path)
        if a.KIND == 'coop':
            (source / 'client/src').mkdir(parents=True)
            (source / 'client/src/Room.tsx').write_text('source room UI')
        git('add', '.')
        git('commit', '-qm', 'test: synthetic source inputs')
        revision = git('rev-parse', 'HEAD')
        contract = a.source_contract(source, revision)
        self.assertEqual(set(contract['migrations']), set(paths))
        for path in paths:
            self.assertEqual(contract['migrations'][path], a.file_hash(source / path))
        (source / paths[-1]).write_text('-- uncommitted different data')
        self.assertEqual(a.source_contract(source, revision), contract)

        # Restore tracked data, then add a local undeclared file. The real build
        # function must pass only the exact Git archive to Docker.
        git('checkout', '--', paths[-1])
        (source / 'undeclared-local.env').write_text('synthetic-local-only')
        class ContextInspected(Exception):
            pass
        def inspect_context(args, **kwargs):
            self.assertEqual(args[:3], ['docker', 'buildx', 'build'])
            context = Path(args[-1])
            self.assertFalse((context / 'undeclared-local.env').exists())
            self.assertEqual((context / paths[-1]).read_bytes(), (source / paths[-1]).read_bytes())
            self.assertTrue(args[args.index('-t') + 1].startswith('divine-local/'))
            raise ContextInspected()
        with patch.object(a.subprocess, 'check_call', side_effect=inspect_context):
            with self.assertRaises(ContextInspected):
                a.build(source, revision, HARNESS, self.root / 'build-artifacts')

    def test_source_client_asset_proof_generator(self):
        if a.KIND != 'coop':
            return
        import os
        source = self.root / 'client-build'
        (source / 'src').mkdir(parents=True)
        (source / 'build/assets').mkdir(parents=True)
        (source / 'src/Room.tsx').write_text('synthetic source Room UI')
        (source / 'package.json').write_text('{}')
        (source / 'build/index.html').write_text('<script src="/assets/source.js"></script>')
        (source / 'build/assets/source.js').write_text('synthetic built Room UI')
        generator = HERE / 'coop-client-source/write-build-proof.mjs'
        environment = dict(os.environ, BUILD_ID=SHA)
        a.subprocess.check_call(['node', str(generator)], cwd=source, env=environment)
        proof = json.loads((source / 'build/source-build.json').read_text())
        self.assertEqual(proof['source_sha'], SHA)
        self.assertEqual(proof['inputs']['src/Room.tsx'], a.file_hash(source / 'src/Room.tsx'))
        self.assertEqual(proof['assets']['assets/source.js'], a.file_hash(source / 'build/assets/source.js'))
        (source / 'build/assets/source.js').unlink()
        result = a.subprocess.run(['node', str(generator)], cwd=source, env=environment, capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(b'Missing built client assets', result.stderr)

    def test_privileged_workflow_uses_only_protected_tooling(self):
        workflow = HERE.parent / '.github/workflows' / ('publish-concord-source.yaml' if a.KIND == 'coop' else 'publish-chat-images.yml')
        text = workflow.read_text()
        build, publication = text.split('\n  publish:\n', 1)
        self.assertIn('default: false', build)
        self.assertNotIn('packages: write', build)
        self.assertNotIn('secrets.', build)
        self.assertIn('persist-credentials: false', build)
        self.assertIn("github.ref == 'refs/heads/main'", publication)
        self.assertIn('inputs.publication_authorization == inputs.source_sha', publication)
        self.assertNotIn('candidate/', publication)
        self.assertNotIn('docker run', publication)
        self.assertIn('path: tooling', publication)
        self.assertIn('ref: ${{ github.workflow_sha }}', publication)
        if a.KIND == 'coop':
            self.assertLess(publication.index(' verify '), publication.index('docker login'))
            self.assertIn('packages: write', publication)
        else:
            self.assertNotIn('docker login', publication)
            self.assertNotIn('secrets.', publication)
            self.assertIn('exit 1', publication)


if __name__ == '__main__':
    unittest.main()
