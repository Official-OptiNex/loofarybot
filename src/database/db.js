const mongoose = require('mongoose');
const { MONGODB_URI } = require('../config');

let isConnected = false;

async function connectDB() {
  if (isConnected) return mongoose.connection;

  mongoose.set('strictQuery', true);

  await mongoose.connect(MONGODB_URI, {
    serverSelectionTimeoutMS: 15000
  });

  isConnected = true;
  console.log('✅ Connected to MongoDB Atlas.');

  mongoose.connection.on('disconnected', () => {
    console.warn('⚠️  MongoDB disconnected. Mongoose will attempt to reconnect automatically.');
    isConnected = false;
  });

  mongoose.connection.on('error', (err) => {
    console.error('MongoDB connection error:', err);
  });

  return mongoose.connection;
}

module.exports = { connectDB };
