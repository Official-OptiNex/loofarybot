const mongoose = require('mongoose');
const { MONGODB_URI } = require('../config');

let isConnected = false;

async function connectDB() {
  if (isConnected) return mongoose.connection;

  mongoose.set('strictQuery', true);
  // Free-tier Atlas (M0) occasionally drops an idle connection; Mongoose reconnects on its own, but
  // by default a query made during that gap *buffers* for 10 s before erroring. That's longer than
  // Discord's 3 s interaction window, so a brief blip turned every command into a silent "the
  // application did not respond". Fail fast instead (2.5 s), so the interaction handler can reply with
  // a visible "try again in a moment" and an alert — far easier to spot than dead silence.
  mongoose.set('bufferTimeoutMS', 2500);

  await mongoose.connect(MONGODB_URI, {
    serverSelectionTimeoutMS: 15000,
    // One bot + dashboard doesn't need Mongoose's default 100 connections; 10 is plenty and keeps
    // memory (Render: 512 MB) and Atlas M0's connection limit comfortable.
    maxPoolSize: 10,
    minPoolSize: 1
  });

  isConnected = true;
  console.log('✅ Connected to MongoDB Atlas.');

  mongoose.connection.on('disconnected', () => {
    console.warn('⚠️  MongoDB disconnected. Mongoose will attempt to reconnect automatically.');
    isConnected = false;
  });

  mongoose.connection.on('reconnected', () => {
    console.log('✅ MongoDB reconnected.');
    isConnected = true;
  });

  mongoose.connection.on('error', (err) => {
    console.error('MongoDB connection error:', err);
  });

  startKeepAlive();
  return mongoose.connection;
}

// A tiny periodic ping keeps a pooled connection warm so Atlas/NAT is less likely to silently drop it
// as idle. Cheap (an admin `ping`), best-effort, and never throws into the event loop.
let keepAliveTimer = null;
function startKeepAlive(intervalMs = 4 * 60 * 1000) {
  if (keepAliveTimer) return;
  keepAliveTimer = setInterval(() => {
    if (mongoose.connection.readyState !== 1) return; // only when connected
    mongoose.connection.db.admin().ping().catch(() => null);
  }, intervalMs);
  keepAliveTimer.unref?.();
}

// True when an error means "the database is momentarily unreachable" (a dropped/reconnecting
// connection, a buffering timeout, or server selection failing) rather than a real bug. Used to show
// a friendlier, retry-able message instead of a generic internal error.
function isDbUnavailable(err) {
  if (!err) return false;
  const name = err.name || '';
  if (name === 'MongooseServerSelectionError' || name === 'MongoNetworkError' || name === 'MongoNotConnectedError') return true;
  const msg = String(err.message || err);
  return /buffering timed out|failed to connect|ECONNREFUSED|ETIMEDOUT|topology was destroyed|connection .* closed|server selection/i.test(msg);
}

module.exports = { connectDB, isDbUnavailable, startKeepAlive };
