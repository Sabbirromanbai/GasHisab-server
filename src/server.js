// Load .env before startup validation reads process.env.
import 'dotenv/config';
import mongoose from 'mongoose';
import { createApp } from './app.js';
import { createAuthConfig, createBetterAuth } from './config/auth.js';
import { connectDB } from './config/db.js';

const validateEnvironment = () => {
  const portValue = process.env.PORT?.trim();
  const mongoUri = process.env.MONGODB_URI?.trim();

  if (!portValue) {
    throw new Error('PORT is required.');
  }

  const port = Number(portValue);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535.');
  }

  if (!mongoUri) {
    throw new Error('MONGODB_URI is required.');
  }

  const authConfig = createAuthConfig(process.env);
  return { port, mongoUri, authConfig };
};

const startServer = async () => {
  try {
    const { port, mongoUri, authConfig } = validateEnvironment();
    // Keep the HTTP server closed until MongoDB is ready.
    await connectDB(mongoUri);
    console.log('Connected to MongoDB');

    // Share Mongoose's client and explicitly bind auth storage to the runtime database.
    const mongoClient = mongoose.connection.getClient();
    const auth = createBetterAuth({ db: mongoClient.db('gashisab'), mongoClient, config: authConfig });
    const app = createApp({ auth, config: authConfig });
    const server = app.listen(port, () => {
      console.log(`GasHisab server listening on port ${port}`);
    });

    // Let in-flight refill transactions finish before a deploy or restart drops the process.
    let shuttingDown = false;
    const shutdown = (signal) => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`Received ${signal}; closing GasHisab server.`);
      server.closeIdleConnections?.();
      server.close(async () => {
        await mongoose.disconnect().catch(() => {});
        process.exit(0);
      });
      // Never hold the platform's shutdown window open indefinitely.
      setTimeout(() => process.exit(1), 10_000).unref();
    };
    process.once('SIGTERM', () => shutdown('SIGTERM'));
    process.once('SIGINT', () => shutdown('SIGINT'));

    server.once('error', async (error) => {
      console.error(`Failed to start GasHisab server (${error.code ?? error.name}).`);
      await mongoose.disconnect().catch(() => {});
      process.exitCode = 1;
    });
  } catch (error) {
    // Avoid logging raw connection errors, which may contain deployment details.
    console.error(`GasHisab startup failed (${error.name}). Check configuration and MongoDB availability.`);
    await mongoose.disconnect().catch(() => {});
    process.exitCode = 1;
  }
};

startServer();
