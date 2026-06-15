import app from './app.js';
import { config } from './config/env.js';
import { prisma } from './db/prisma.js';

const server = app.listen(config.port, () => {
  console.log(`LingoShorts API running on http://localhost:${config.port}${config.apiPrefix}`);
  console.log(`Mock external services: ${config.mockExternal}`);
});

async function shutdown(signal) {
  console.log(`\n${signal} received, shutting down...`);
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
