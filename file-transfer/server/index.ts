import express from 'express';
import http from 'http';
import path from 'path';
import { PORT } from './config.js';
import deviceRoutes from './routes/device.js';
import transferRoutes from './routes/transfers.js';
import { attachWebSocket } from './ws.js';

async function main() {
  const app = express();
  app.set('trust proxy', true);

  // Mount REST routers — each carries its own JSON parser
  app.use('/api', deviceRoutes);
  app.use('/api', transferRoutes);

  // Vite dev middleware or static dist serving
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(distDir, 'index.html'));
    });
  }

  const server = http.createServer(app);
  attachWebSocket(server);

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[server] port ${PORT} already in use — exiting`);
      process.exit(1);
    } else {
      console.error(`[server] error: ${err?.message || err}`);
    }
  });

  process.on('uncaughtException', (err) => {
    console.error(`[process] uncaughtException: ${err?.message || err}`);
    console.error(err?.stack || '');
    // Don't exit — let the server keep serving
  });

  process.on('unhandledRejection', (reason) => {
    const r = reason as Error | undefined;
    const msg = r?.message ?? String(reason);
    console.error(`[process] unhandledRejection: ${msg}`);
    if (r?.stack) console.error(r.stack);
  });

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`AirVault server running on http://0.0.0.0:${PORT}`);
  });
}

main();
