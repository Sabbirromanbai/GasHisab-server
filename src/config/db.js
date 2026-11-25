import mongoose from 'mongoose';

let connectionPromise;

export const connectDB = (uri = process.env.MONGODB_URI) => {
  if (mongoose.connection.readyState === 1) {
    return Promise.resolve(mongoose.connection);
  }

  // Share an in-flight attempt so parallel callers do not open duplicate connections.
  if (connectionPromise) {
    return connectionPromise;
  }

  if (mongoose.connection.readyState === 2) {
    return mongoose.connection.asPromise();
  }

  if (typeof uri !== 'string' || uri.trim() === '') {
    return Promise.reject(new Error('MONGODB_URI is required.'));
  }

  // Never let a deployment URI's default/path database redirect runtime writes.
  connectionPromise = mongoose
    .connect(uri.trim(), { dbName: 'gashisab' })
    .then(() => mongoose.connection)
    .finally(() => {
      connectionPromise = undefined;
    });

  return connectionPromise;
};
