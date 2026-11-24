// Load .env before startup validation reads process.env.
import 'dotenv/config';
import mongoose from 'mongoose';
import app from './app.js';
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

  return { port, mongoUri };
};

const startServer = async () => {
  try {
    const { port, mongoUri } = validateEnvironment();
    // Keep the HTTP server closed until MongoDB is ready.
    await connectDB(mongoUri);
    console.log('Connected to MongoDB');

    const server = app.listen(port, () => {
      console.log(`GasHisab server listening on port ${port}`);
    });

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
