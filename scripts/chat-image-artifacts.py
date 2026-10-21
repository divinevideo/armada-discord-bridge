#!/usr/bin/env python3
"""Build and verify complete source image sets. Python standard library only.

Publication consumes Docker archives as data. It never starts a candidate image
or runs a program from the source checkout. Registry names are deliberately fixed.

Default command: verify (no Docker or registry access). Build uses only a Git
archive of --source-sha and records --harness-sha separately. Keep the printed
manifest SHA256 with the review evidence. Publishing requires the explicit
publish command plus --authorize-source-sha matching the reviewed source, a
clean publisher checkout at the harness SHA, and both commits in origin/main.
Fetch origin/main before a manual publish. Use only reviewed main tooling, with
an existing Docker credential helper configured separately; this program never
logs in, creates credentials or deploys. GAR CI intentionally has no identity.
Registry manifest digests are saved separately from local image config IDs.
"""
import argparse
import hashlib
import gzip
import io
import json
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
import tarfile
import tempfile


KIND = 'bridge'
LOCAL_PREFIX = 'divine-local/chat-source-'
SOURCE = 'https://github.com/divinevideo/armada-discord-bridge'
MIGRATION_ROOT = 'packages/moderation/db/migrations'
REQUIRED_MIGRATIONS = [MIGRATION_ROOT + '/017_moderation_lifecycle.sql', MIGRATION_ROOT + '/018_public_capacity.sql', MIGRATION_ROOT + '/019_audit_restriction_refresh.sql', MIGRATION_ROOT + '/020_audit_closure_guard.sql', MIGRATION_ROOT + '/021_hold_extension.sql', MIGRATION_ROOT + '/022_settled_publication_audit.sql']
CLIENT_ROOT_INPUTS = []
REGISTRY = 'us-central1-docker.pkg.dev/dv-platform-prod/containers-production/'
TARGETS = [
    {'name': 'portal', 'repository': REGISTRY + 'armada-discord-bridge', 'target': 'portal', 'dockerfile': 'Dockerfile', 'entrypoint': ['/usr/local/bin/docker-entrypoint.sh'], 'command': ['bun', 'run', 'packages/portal/src/index.ts'], 'migrations': True, 'migration_prefix': 'app/'},
    {'name': 'moderation', 'repository': REGISTRY + 'concord-moderation', 'target': 'moderation', 'dockerfile': 'Dockerfile', 'entrypoint': ['/usr/local/bin/docker-entrypoint.sh'], 'command': ['bun', 'run', 'packages/moderation/src/index.ts'], 'migrations': True, 'migration_prefix': 'app/'},
    {'name': 'relay', 'repository': REGISTRY + 'concord-relay', 'target': 'relay', 'dockerfile': 'docker/relay.Dockerfile', 'entrypoint': ['/usr/local/bin/strfry'], 'command': ['--config=/data/strfry.conf', 'relay'], 'migrations': True, 'migration_prefix': 'opt/divine/'},
]


def require(condition, message):
    if not condition:
        raise ValueError(message)


def full_sha(value):
    require(re.fullmatch(r'[0-9a-f]{40}', value or '') is not None, 'A full lowercase 40-character source/harness SHA is required')
    return value


def run(args, cwd=None):
    return subprocess.check_output(args, cwd=cwd, stderr=subprocess.PIPE)


def file_hash(path):
    h = hashlib.sha256()
    with open(path, 'rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def source_contract(source, revision):
    full_sha(revision)
    paths = run(['git', 'ls-tree', '-r', '--name-only', revision], cwd=source).decode().splitlines()
    migrations = sorted(p for p in paths if p.startswith(MIGRATION_ROOT + '/') and p.endswith('.sql'))
    require(all(p in migrations for p in REQUIRED_MIGRATIONS), 'Required release migrations are missing from source')
    if KIND == 'coop':
        require(any(p.endswith('.add_room_operation_lifecycle.sql') for p in migrations), 'Coop lifecycle migration missing')
    result = {p: hashlib.sha256(run(['git', 'show', revision + ':' + p], cwd=source)).hexdigest() for p in migrations}
    client_inputs = {}
    if KIND == 'coop':
        inputs = [p for p in paths if p.startswith(('client/src/', 'client/public/', 'client/eslint/')) or p in CLIENT_ROOT_INPUTS]
        client_inputs = {p.removeprefix('client/'): hashlib.sha256(run(['git', 'show', revision + ':' + p], cwd=source)).hexdigest() for p in inputs}
    return {'migrations': result, 'client_inputs': client_inputs}


def read_member(tar, name, limit=16 * 1024 * 1024):
    entry = tar.getmember(name)
    require(entry.isfile() and entry.size <= limit, 'Invalid or oversized artifact member: ' + name)
    return tar.extractfile(entry).read()


def archive_identity(path, local_id=None):
    """Bind an observed daemon handle to config or the selected OCI descriptor chain."""
    with tarfile.open(path, 'r:') as archive:
        saved = json.loads(read_member(archive, 'manifest.json'))
        require(len(saved) == 1, 'Expected one saved runtime image')
        config = read_member(archive, saved[0]['Config'])
        config_digest = 'sha256:' + hashlib.sha256(config).hexdigest()
        handles = {config_digest}
        default_id = config_digest
        if 'index.json' in archive.getnames():
            root = json.loads(read_member(archive, 'index.json'))
            require(len(root['manifests']) == 1, 'Expected one local image descriptor')
            descriptor = root['manifests'][0]
            oci = descriptor_json(archive, descriptor)
            handles.add(descriptor['digest'])
            default_id = descriptor['digest']
            if 'manifests' in oci:
                descriptor = runtime_descriptor(oci)
                oci = descriptor_json(archive, descriptor)
                handles.add(descriptor['digest'])
            require(oci['config']['digest'] == config_digest and oci['config']['size'] == len(config), 'OCI runtime config mismatch')
        # Store the actual inspect.Id rather than infer daemon semantics from
        # archive format. Config, image and index handles must all prove the
        # same selected runtime through their verified descriptor/config chain.
        observed = default_id if local_id is None else local_id
        require(observed in handles, 'Daemon handle is not bound to the saved runtime')
        return config_digest, observed


def descriptor_json(archive, descriptor):
    digest = descriptor['digest']
    require(re.fullmatch(r'sha256:[0-9a-f]{64}', digest) is not None, 'Invalid OCI descriptor digest')
    data = read_member(archive, 'blobs/sha256/' + digest.split(':')[1])
    require('sha256:' + hashlib.sha256(data).hexdigest() == digest and len(data) == descriptor['size'], 'OCI descriptor hash/size mismatch')
    return json.loads(data)


def runtime_descriptor(index):
    descriptors = index.get('manifests', [])
    runtime = [d for d in descriptors if d.get('platform') == {'architecture': 'amd64', 'os': 'linux'}]
    require(len(runtime) == 1, 'Expected exactly one linux/amd64 runtime descriptor')
    for descriptor in descriptors:
        require(descriptor in runtime or (descriptor.get('annotations', {}).get('vnd.docker.reference.type') == 'attestation-manifest' and descriptor.get('platform') == {'architecture': 'unknown', 'os': 'unknown'}), 'Unexpected runnable OCI platform')
    return runtime[0]


def layer_stream(archive, name):
    stream = archive.extractfile(name)
    require(stream is not None, 'Missing image layer')
    magic = stream.read(2)
    stream.seek(0)
    return gzip.GzipFile(fileobj=stream) if magic == b'\x1f\x8b' else stream


def inspect_archive(path, entry, revision, contract):
    required = {entry['migration_prefix'] + p: h for p, h in contract['migrations'].items()} if entry['migrations'] else {}
    found = {}
    client_assets = {}
    client_proof = None
    with tarfile.open(path, 'r:') as archive:
        names = archive.getnames()
        require(len(names) == len(set(names)), 'Duplicate image archive members')
        saved = json.loads(read_member(archive, 'manifest.json'))
        require(len(saved) == 1 and saved[0].get('RepoTags') == [entry['local_tag']], 'Archive contains unexpected image/tag')
        image = saved[0]
        identity = archive_identity(path, entry['local_image_id'])
        require(identity == (entry['config_digest'], entry['local_image_id']), 'Local image/config identity mismatch')
        if 'index.json' in names:
            root = json.loads(read_member(archive, 'index.json'))
            oci = descriptor_json(archive, root['manifests'][0])
            if 'manifests' in oci:
                oci = descriptor_json(archive, runtime_descriptor(oci))
            require(oci['config']['digest'] == entry['config_digest'], 'OCI runtime config mismatch')
            require([d['digest'].replace('sha256:', 'blobs/sha256/') for d in oci['layers']] == image['Layers'], 'OCI layer descriptor mismatch')
            for descriptor, name in zip(oci['layers'], image['Layers']):
                compressed = archive.extractfile(name)
                require(compressed is not None, 'Missing OCI layer')
                digest = hashlib.sha256()
                size = 0
                for chunk in iter(lambda: compressed.read(1024 * 1024), b''):
                    digest.update(chunk); size += len(chunk)
                require('sha256:' + digest.hexdigest() == descriptor['digest'] and size == descriptor['size'], 'Compressed OCI layer hash/size mismatch')
        config_bytes = read_member(archive, image['Config'])
        config_digest = 'sha256:' + hashlib.sha256(config_bytes).hexdigest()
        require(config_digest == entry['config_digest'], 'Image config hash mismatch')
        config = json.loads(config_bytes)
        require(config.get('os') == 'linux' and config.get('architecture') == 'amd64', 'Image platform mismatch')
        cfg = config['config']
        labels = cfg.get('Labels') or {}
        require(labels.get('org.opencontainers.image.revision') == revision, 'Image source revision mismatch')
        require(labels.get('org.opencontainers.image.source') == SOURCE, 'Image source repository mismatch')
        require((cfg.get('Entrypoint') or []) == entry['entrypoint'] and cfg.get('Cmd') == entry['command'], 'Image default command mismatch')
        layers = image['Layers']
        diff_ids = config['rootfs']['diff_ids']
        require(len(layers) == len(diff_ids), 'Image layer count mismatch')
        for name, expected in zip(layers, diff_ids):
            layer = layer_stream(archive, name)
            h = hashlib.sha256()
            for chunk in iter(lambda: layer.read(1024 * 1024), b''):
                h.update(chunk)
            require('sha256:' + h.hexdigest() == expected, 'Image layer hash mismatch')
            # Read only relevant regular files; no extraction, symlink following,
            # candidate execution or trust in a source-provided file list.
            with tarfile.open(fileobj=layer_stream(archive, name), mode='r|') as tar:
                for member in tar:
                    p = member.name.removeprefix('./').lstrip('/')
                    base = PurePosixPath(p).name
                    parent = str(PurePosixPath(p).parent)
                    if base.startswith('.wh.'):
                        removed = (parent + '/' + base[4:]).removeprefix('./')
                        for prior in list(found):
                            if prior == removed or prior.startswith(removed + '/') or (base == '.wh..wh..opq' and prior.startswith(parent + '/')):
                                del found[prior]
                        for prior in list(client_assets):
                            full = 'usr/share/nginx/html/' + prior
                            if full == removed or full.startswith(removed + '/') or (base == '.wh..wh..opq' and full.startswith(parent + '/')):
                                del client_assets[prior]
                        proof_path = 'usr/share/nginx/html/source-build.json'
                        if proof_path == removed or proof_path.startswith(removed + '/') or (base == '.wh..wh..opq' and proof_path.startswith(parent + '/')):
                            client_proof = None
                        continue
                    if p in required:
                        require(member.isfile() and member.size <= 16 * 1024 * 1024, 'Invalid migration file')
                        found[p] = hashlib.sha256(tar.extractfile(member).read()).hexdigest()
                    if entry['name'] == 'client' and p.startswith('usr/share/nginx/html/') and member.isfile():
                        rel = p.removeprefix('usr/share/nginx/html/')
                        require(member.size <= 64 * 1024 * 1024, 'Oversized client asset')
                        data = tar.extractfile(member).read()
                        if rel == 'source-build.json':
                            client_proof = json.loads(data)
                        else:
                            client_assets[rel] = hashlib.sha256(data).hexdigest()
    require(found == required, 'Image is missing source-matched migration files')
    if entry['name'] == 'client':
        require(client_proof is not None, 'Client lacks a source build proof (upstream static assets are not accepted)')
        require(client_proof.get('source_sha') == revision and client_proof.get('inputs') == contract['client_inputs'], 'Client source input proof mismatch')
        require(client_proof.get('assets') == client_assets and 'index.html' in client_assets and any(p.startswith('assets/') and p.endswith('.js') for p in client_assets), 'Client built asset proof mismatch')


def verify(directory, revision, harness, manifest_hash, contract):
    full_sha(revision)
    full_sha(harness)
    directory = Path(directory)
    require(re.fullmatch(r'[0-9a-f]{64}', manifest_hash or '') is not None, 'Expected manifest SHA256 is required')
    require(file_hash(directory / 'artifact-set.json') == manifest_hash, 'Artifact manifest hash mismatch')
    require(set(contract) == {'migrations', 'client_inputs'}, 'Invalid source contract')
    require(all(p in contract['migrations'] for p in REQUIRED_MIGRATIONS), 'Required migration contract missing')
    require(bool(contract['client_inputs']) == (KIND == 'coop'), 'Client source contract mismatch')
    if KIND == 'coop':
        require(any(p.endswith('.add_room_operation_lifecycle.sql') for p in contract['migrations']), 'Lifecycle migration contract missing')
    manifest = json.loads((directory / 'artifact-set.json').read_text())
    require(set(manifest) == {'version', 'kind', 'source_sha', 'harness_sha', 'platform', 'source_contract', 'images'}, 'Unexpected manifest fields')
    require(manifest['version'] == 1 and manifest['kind'] == KIND and manifest['platform'] == 'linux/amd64', 'Artifact schema/platform mismatch')
    require(manifest['source_sha'] == revision and manifest['harness_sha'] == harness, 'Source/harness SHA mismatch')
    require(manifest['source_contract'] == contract, 'Artifact migrations/source UI contract mismatch')
    require(len(manifest['images']) == len(TARGETS), 'Incomplete artifact set')
    for actual, expected in zip(manifest['images'], TARGETS):
        require(set(actual) == set(expected) | {'tag', 'local_tag', 'archive', 'config_digest', 'local_image_id', 'archive_sha256'}, 'Unexpected image fields')
        require(all(actual.get(k) == v for k, v in expected.items()), 'Image name/target/default command contract mismatch')
        require(actual['local_tag'] == LOCAL_PREFIX + expected['name'] + ':' + revision, 'Local image source tag mismatch')
        require(actual['tag'] == expected['repository'] + ':' + revision, 'Image source tag mismatch')
        require(actual['archive'] == expected['name'] + '.tar', 'Image archive name mismatch')
        require(re.fullmatch(r'sha256:[0-9a-f]{64}', actual['config_digest']) is not None, 'Invalid image config digest')
        require(re.fullmatch(r'sha256:[0-9a-f]{64}', actual['local_image_id']) is not None, 'Invalid local image handle')
        archive = directory / actual['archive']
        require(archive.is_file() and not archive.is_symlink() and file_hash(archive) == actual['archive_sha256'], 'Image archive hash mismatch')
        inspect_archive(archive, actual, revision, contract)
    return manifest


def build(source, revision, harness, output):
    full_sha(revision)
    full_sha(harness)
    require(run(['git', 'rev-parse', 'HEAD'], cwd=source).decode().strip() == revision, 'Source checkout SHA mismatch')
    require(not run(['git', 'status', '--porcelain', '--untracked-files=no'], cwd=source).strip(), 'Commit tracked changes before building release images')
    contract = source_contract(source, revision)
    output = Path(output).resolve()
    output.mkdir(parents=True, exist_ok=False)
    manifest = {'version': 1, 'kind': KIND, 'source_sha': revision, 'harness_sha': harness, 'platform': 'linux/amd64', 'source_contract': contract, 'images': []}
    # A clean index does not exclude ignored/untracked files. Build a fresh
    # context from the commit so local .env files or stale generated assets
    # cannot become undeclared release inputs.
    with tempfile.TemporaryDirectory(prefix='source-image-context-') as scratch:
        context = Path(scratch)
        committed = run(['git', 'archive', '--format=tar', revision], cwd=source)
        with tarfile.open(fileobj=io.BytesIO(committed), mode='r:') as source_tar:
            source_tar.extractall(context, filter='data')
        for target in TARGETS:
            entry = dict(target)
            tag = LOCAL_PREFIX + target['name'] + ':' + revision
            args = ['docker', 'buildx', 'build', '--platform', 'linux/amd64', '--load', '--target', target['target'], '-f', str(context / target['dockerfile']), '--build-arg', 'VCS_REF=' + revision, '--build-arg', 'BUILD_ID=' + revision, '--label', 'org.opencontainers.image.source=' + SOURCE, '--label', 'org.opencontainers.image.revision=' + revision, '-t', tag, str(context)]
            subprocess.check_call(args)
            entry.update({'tag': target['repository'] + ':' + revision, 'local_tag': tag, 'archive': target['name'] + '.tar'})
            local_id = json.loads(run(['docker', 'image', 'inspect', tag]))[0]['Id']
            subprocess.check_call(['docker', 'image', 'save', '--output', str(output / entry['archive']), tag])
            entry['config_digest'], entry['local_image_id'] = archive_identity(output / entry['archive'], local_id)
            entry['archive_sha256'] = file_hash(output / entry['archive'])
            manifest['images'].append(entry)
    (output / 'artifact-set.json').write_text(json.dumps(manifest, indent=2) + '\n')
    digest = file_hash(output / 'artifact-set.json')
    verify(output, revision, harness, digest, contract)
    print(digest)
    return digest


def remote_config(tag):
    try:
        raw = run(['docker', 'buildx', 'imagetools', 'inspect', '--raw', tag])
    except subprocess.CalledProcessError as error:
        # A failed read is not proof of absence. Require the registry's explicit
        # not-found response before treating the immutable source tag as unused.
        stderr = (error.stderr or b'').decode() if isinstance(error.stderr, bytes) else (error.stderr or '')
        if 'manifest unknown' in stderr.lower() or 'not found' in stderr.lower():
            return None
        raise
    if '@sha256:' in tag:
        require('sha256:' + hashlib.sha256(raw).hexdigest() == tag.split('@', 1)[1], 'Pinned registry descriptor hash mismatch')
    manifest = json.loads(raw)
    if 'manifests' in manifest:
        descriptor = runtime_descriptor(manifest)
        repository = tag.split('@')[0].rsplit(':', 1)[0]
        raw = run(['docker', 'buildx', 'imagetools', 'inspect', '--raw', repository + '@' + descriptor['digest']])
        require('sha256:' + hashlib.sha256(raw).hexdigest() == descriptor['digest'] and len(raw) == descriptor['size'], 'Registry runtime descriptor hash/size mismatch')
        manifest = json.loads(raw)
    require('config' in manifest and not manifest.get('manifests'), 'Expected one registry runtime image')
    return manifest['config']['digest']


def publish(directory, revision, harness, manifest_hash, contract, authorization):
    require(authorization == full_sha(revision), 'Explicit per-run full source SHA publication authorization is required')
    manifest = verify(directory, revision, harness, manifest_hash, contract)
    # Check the entire set first so a conflicting later tag cannot cause a
    # partial overwrite. No login or credential handling is performed here.
    existing_configs = {}
    for image in manifest['images']:
        existing = remote_config(image['tag'])
        require(existing is None or existing == image['config_digest'], 'Existing source tag has conflicting artifact identity')
        existing_configs[image['tag']] = existing
    results = []
    for image in manifest['images']:
        if existing_configs[image['tag']] is None:
            run(['docker', 'image', 'load', '--input', str(Path(directory) / image['archive'])])
            run(['docker', 'tag', image['local_image_id'], image['tag']])
            run(['docker', 'push', image['tag']])
        require(remote_config(image['tag']) == image['config_digest'], 'Published registry config identity mismatch')
        descriptor = json.loads(run(['docker', 'buildx', 'imagetools', 'inspect', image['tag'], '--format', '{{json .Manifest}}']))
        digest = descriptor.get('digest', '')
        require(re.fullmatch(r'sha256:[0-9a-f]{64}', digest) is not None, 'Registry did not return a deployment manifest digest')
        ref = image['repository'] + '@' + digest
        require(remote_config(ref) == image['config_digest'], 'Pinned registry config chain mismatch')
        run(['docker', 'pull', '--platform', 'linux/amd64', ref])
        readback = json.loads(run(['docker', 'image', 'inspect', ref]))[0]
        require(readback['Architecture'] == 'amd64' and readback['Os'] == 'linux', 'Registry readback platform mismatch')
        cfg = readback['Config']
        require(cfg['Labels'].get('org.opencontainers.image.revision') == revision and cfg['Labels'].get('org.opencontainers.image.source') == SOURCE, 'Registry readback source mismatch')
        require((cfg.get('Entrypoint') or []) == image['entrypoint'] and cfg['Cmd'] == image['command'], 'Registry readback command mismatch')
        results.append({'name': image['name'], 'tag': image['tag'], 'digest': digest, 'config_digest': image['config_digest'], 'platform': 'linux/amd64'})
    (Path(directory) / 'published-digests.json').write_text(json.dumps({'source_sha': revision, 'harness_sha': harness, 'images': results}, indent=2) + '\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', nargs='?', default='verify', choices=['build', 'verify', 'publish'])
    parser.add_argument('--source', type=Path, required=True, help='Git checkout used only as source data')
    parser.add_argument('--source-sha', required=True)
    parser.add_argument('--harness-sha', required=True)
    parser.add_argument('--artifacts', type=Path, required=True)
    parser.add_argument('--manifest-sha256', default='')
    parser.add_argument('--authorize-source-sha', default='')
    args = parser.parse_args()
    try:
        if args.command == 'build':
            build(args.source.resolve(), args.source_sha, args.harness_sha, args.artifacts)
        else:
            contract = source_contract(args.source, args.source_sha)
            if args.command == 'verify':
                verify(args.artifacts, args.source_sha, args.harness_sha, args.manifest_sha256, contract)
                print('PASS complete source artifact set')
            else:
                # Both application and publisher must already belong to reviewed
                # main history. Fetch origin/main before this command; no source
                # program is run to establish that relationship.
                run(['git', 'merge-base', '--is-ancestor', args.source_sha, 'origin/main'], cwd=args.source)
                run(['git', 'merge-base', '--is-ancestor', args.harness_sha, 'origin/main'], cwd=args.source)
                tooling = Path(__file__).resolve().parent.parent
                require(run(['git', 'rev-parse', 'HEAD'], cwd=tooling).decode().strip() == args.harness_sha, 'Publisher checkout does not match harness SHA')
                require(not run(['git', 'status', '--porcelain', '--untracked-files=no'], cwd=tooling).strip(), 'Publisher tooling must be clean')
                publish(args.artifacts, args.source_sha, args.harness_sha, args.manifest_sha256, contract, args.authorize_source_sha)
    except (ValueError, KeyError, OSError, tarfile.TarError, subprocess.CalledProcessError) as error:
        print('Artifact contract failed: ' + str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
