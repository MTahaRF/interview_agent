import { MongoClient } from 'mongodb';

let client = null;

export async function getMongoClient(uri) {
  if (!client) {
    client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
    await client.connect();
    console.log('[MongoDB] Global connection pool established.');
  } else {
    try {
      await client.db('admin').command({ ping: 1 });
    } catch (err) {
      console.warn('[MongoDB] Connection lost. Reconnecting...');
      client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
      await client.connect();
      console.log('[MongoDB] Connection re-established.');
    }
  }
  return client;
}
