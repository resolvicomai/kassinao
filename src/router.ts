import { readRouterRuntimeConfiguration } from './routerRuntime';
import { createEdgeTopology, listenEdgeRouter } from './web/edgeRouter';

if (process.platform === 'darwin') delete process.env.__CF_USER_TEXT_ENCODING;

async function main(): Promise<void> {
  const runtime = readRouterRuntimeConfiguration(process.env);
  const listener = await listenEdgeRouter({
    topology: createEdgeTopology(runtime.origins),
    port: runtime.port,
    bindInterfaces: runtime.bindInterfaces,
    releaseDigest: runtime.releaseDigest,
    deploymentFingerprint: runtime.deploymentFingerprint,
  });

  let closing = false;
  const close = (): void => {
    if (closing) return;
    closing = true;
    listener.close((error) => process.exit(error ? 1 : 0));
    setTimeout(() => process.exit(1), 15_000).unref();
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}

void main().catch((error: unknown) => {
  console.error(`Router indisponível: ${(error as Error).message}`);
  process.exit(1);
});
