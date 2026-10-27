import { buildApplication } from './compositionRoot.js';
import { loadConfig } from './config/env.js';

const config = loadConfig();
const app = buildApplication(config);

let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'shutting down');

  // If in-flight requests or the pool refuse to drain, exit anyway rather than hang the orchestrator.
  const forceExit = setTimeout(() => {
    app.log.error('graceful shutdown timed out');
    process.exit(1);
  }, config.shutdownTimeoutMs);
  forceExit.unref();

  try {
    await app.close();
    app.log.info('shutdown complete');
  } catch (error) {
    app.log.error({ err: error }, 'error during shutdown');
    process.exitCode = 1;
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, (received) => void shutdown(received));
}

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.fatal({ err: error }, 'failed to start');
  process.exit(1);
}
