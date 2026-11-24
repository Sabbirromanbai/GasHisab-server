import mongoose from 'mongoose';

const TEST_DATABASE_PATTERN = /(?:^|[_-])test$/i;

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
  if (!databaseName || !TEST_DATABASE_PATTERN.test(databaseName)) {
    throw new Error('Refusing to run tests: MONGODB_TEST_URI must name an explicit *_test database.');
  }
  return databaseName;
};

export const connectTestDatabase = async () => {
  const uri = process.env.MONGODB_TEST_URI?.trim();
  const databaseName = getTestDatabaseName(uri);

  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 3000,
    dbName: databaseName,
  });

  // Refill writes use transactions; a replica set is mandatory for these tests.
  const hello = await mongoose.connection.db.admin().command({ hello: 1 });
  if (!hello.setName) {
    await mongoose.disconnect();
    throw new Error('Refusing to run transaction tests: MongoDB must be a replica set.');
  }

  return { databaseName, connection: mongoose.connection };
};

export const disconnectTestDatabase = async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
};

export const assertTestDatabaseIsEmpty = async () => {
  const databaseName = getTestDatabaseName();
  const collections = await mongoose.connection.db.listCollections().toArray();
  const unexpected = collections.filter((collection) => !collection.name.startsWith('system.'));
  if (unexpected.length > 0) {
    throw new Error(`Refusing to run tests: ${databaseName} is not empty.`);
  }
};
