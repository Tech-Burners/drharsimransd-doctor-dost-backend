import mongoose from 'mongoose';
import config from '../app/config';

// maxPoolSize is explicit. The driver default of 100 per process exhausts a small Atlas
// tier once two API instances and a worker run.
export const connectMongo = async (): Promise<typeof mongoose> => {
  if (!config.database_url) throw new Error('DATABASE_URL is not set');
  return mongoose.connect(config.database_url, {
    maxPoolSize: config.mongo_max_pool_size,
    connectTimeoutMS: 10000,
    serverSelectionTimeoutMS: 10000,
  });
};

export const isMongoReachable = async (): Promise<boolean> => {
  try {
    if (mongoose.connection.readyState !== 1 || !mongoose.connection.db) return false;
    await mongoose.connection.db.admin().ping();
    return true;
  } catch {
    return false;
  }
};
