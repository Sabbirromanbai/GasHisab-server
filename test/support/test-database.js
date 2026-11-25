import mongoose from 'mongoose';
import { MongoClient } from 'mongodb';

const TEST_DATABASE_NAME = 'gashisab_test';
const TEST_DATABASE_HOST = '127.0.0.1';
const TEST_DATABASE_PORT = '27018';
const TEST_REPLICA_SET = 'gashisab-rs';

export const getTestDatabaseName = (uri = process.env.MONGODB_TEST_URI) => {
  if (typeof uri !== 'string' || uri.trim() === '') {
    throw new Error('MONGODB_TEST_URI is required for refill integration tests.');
  }

  let parsed;
  try {
    parsed = new URL(uri);
  } catch {
    throw new Error('MONGODB_TEST_URI must be a valid MongoDB connection string.');
  }

  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
  if (databaseName !== TEST_DATABASE_NAME
      || parsed.hostname !== TEST_DATABASE_HOST
      || parsed.port !== TEST_DATABASE_PORT
      || parsed.searchParams.get('replicaSet') !== TEST_REPLICA_SET) {
    throw new Error('Refusing to run tests: MONGODB_TEST_URI must target the dedicated local GasHisab test replica set.');
  }
  return databaseName;
};

export const connectTestDatabase = async () => {
  const uri = process.env.MONGODB_TEST_URI?.trim();
  const databaseName = getTestDatabaseName(uri);

  // Inspect the target with the native driver before connecting Mongoose models.
  await assertTestDatabaseIsEmpty(uri);

  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 3000,
    dbName: databaseName,
  });

  try {
    // Refill writes use transactions; the configured replica set must match.
    const hello = await mongoose.connection.db.admin().command({ hello: 1 });
    const expectedSet = new URL(uri).searchParams.get('replicaSet');
    if (!hello.setName || (expectedSet && hello.setName !== expectedSet)) {
      throw new Error('Refusing to run transaction tests: MongoDB must use the requested replica set.');
    }
  } catch (error) {
    await mongoose.disconnect();
    throw error;
  }

  return { databaseName, connection: mongoose.connection };
};

export const disconnectTestDatabase = async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
};

export const assertTestDatabaseIsEmpty = async (uri = process.env.MONGODB_TEST_URI) => {
  const databaseName = getTestDatabaseName(uri);
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 3000 });

  try {
    await client.connect();
    // Check both replica-set identity and emptiness before Mongoose can create collections.
    const hello = await client.db(databaseName).admin().command({ hello: 1 });
    const expectedSet = new URL(uri).searchParams.get('replicaSet');
    if (!hello.setName || (expectedSet && hello.setName !== expectedSet)) {
      throw new Error('Refusing to run transaction tests: MongoDB must use the requested replica set.');
    }

    const database = client.db(databaseName);
    const collections = await database.listCollections({}, { nameOnly: true }).toArray();
    const collectionsWithDocuments = [];
    for (const collection of collections) {
      if (collection.name.startsWith('system.')) continue;

      // Empty collections can be left by Mongoose; reject only collections containing documents.
      const document = await database.collection(collection.name).findOne({}, { projection: { _id: 1 } });
      if (document) collectionsWithDocuments.push(collection.name);
    }
    if (collectionsWithDocuments.length > 0) {
      throw new Error(`Refusing to run tests: ${databaseName} is not empty.`);
    }
  } finally {
    await client.close();
  }
};
