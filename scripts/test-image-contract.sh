#!/usr/bin/env bash
set -euo pipefail
python3 - <<'PY'
from pathlib import Path
relay = Path('docker/relay.Dockerfile').read_text()
app = Path('Dockerfile').read_text()
assert 'FROM strfry-build AS relay' not in relay, 'relay runtime must not include the compiler/build tree'
for source in [relay, app]:
    for line in source.splitlines():
        if line.startswith('FROM ') and ':' in line.split()[1]:
            assert '@sha256:' in line, 'external base image must be digest pinned'
    assert 'org.opencontainers.image.source' in source
    assert 'org.opencontainers.image.revision' in source
    assert 'USER 10001:10001' in source
assert '/usr/share/strfry-source' in relay
assert '--production' in app
assert 'AS portal' in app and 'AS moderation' in app
assert 'https://github.com/divinevideo/armada-discord-bridge' in Path('packages/portal/web/src/App.tsx').read_text()
print('PASS image contract: pinned non-root runtimes, source labels, GPL source, and public fork link')
PY
