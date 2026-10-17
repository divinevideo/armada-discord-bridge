/** Local synthetic proof only. Real-guild acceptance is recorded separately. */
const args = process.argv.slice(2);
if (args.length !== 1 || args[0] !== '--local-synthetic' || !process.env.STRFRY_TEST_IMAGE) {
  console.error('Require --local-synthetic and STRFRY_TEST_IMAGE; no live-guild mode is enabled.');
  process.exit(2);
}
const image = process.env.STRFRY_TEST_IMAGE;
const inspected = Bun.spawn(['docker', 'image', 'inspect', image, '--format', '{{.Id}} {{index .Config.Labels "org.opencontainers.image.revision"}}'], { stdout: 'pipe', stderr: 'ignore' });
const identity = (await new Response(inspected.stdout).text()).trim();
if (await inspected.exited !== 0 || !/^sha256:[0-9a-f]{64} [0-9a-f]{40}$/.test(identity)) throw new Error('A source-labelled image is required');
console.log(`Synthetic proof image/source: ${identity}`);
for (const script of ['test-strfry-policy.sh', 'test-strfry-purge.sh', 'test-moderation-runtime.sh']) {
  const child = Bun.spawn(['bash', new URL(script, import.meta.url).pathname], { stdout: 'inherit', stderr: 'inherit', env: process.env });
  if (await child.exited !== 0) process.exit(1);
}
console.log('PASS local raw-client and runtime proof. Live Coop/Discord/client/staff acceptance remains separate.');
