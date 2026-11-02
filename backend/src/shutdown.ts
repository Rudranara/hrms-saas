import type { Server } from "node:http";

// A single bounded drain for both signals. The deadline also covers disconnect.
export function installShutdown(server: Server, stopRecovery: () => Promise<unknown>, disconnect: () => Promise<unknown>, deadlineMs = 30000) {
  let shutdown: Promise<void> | null = null;
  const drain = () => {
    if (shutdown) return shutdown;
    const deadline = setTimeout(() => { server.closeAllConnections(); process.exit(1); }, deadlineMs);
    // Connections that were busy at close() may become idle during the drain.
    const idleSweep = setInterval(() => server.closeIdleConnections(), 100);
    shutdown = (async () => {
      try {
        const recovery = stopRecovery();
        const http = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        server.closeIdleConnections();
        await Promise.all([recovery, http]);
        await disconnect();
        clearTimeout(deadline);
        clearInterval(idleSweep);
        process.exit(0);
      } catch {
        server.closeAllConnections();
        try { await disconnect(); } finally { clearTimeout(deadline); clearInterval(idleSweep); process.exit(1); }
      }
    })();
    return shutdown;
  };
  process.on("SIGTERM", drain);
  process.on("SIGINT", drain);
  return drain;
}
