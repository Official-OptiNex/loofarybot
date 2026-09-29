// Preloaded by test/run.js: tests never connect to MongoDB, so any database call a test didn't stub
// fails straight away (and is logged by the bot's own error handling) instead of waiting 10s.
require('mongoose').set('bufferCommands', false);
// Tests swap the models' query functions for in-memory ones, which skip Mongoose's hooks — so the
// settings cache would never be cleared. Turn it off (test/config-cache.test.js covers it).
if (process.env.CONFIG_CACHE_MS === undefined) process.env.CONFIG_CACHE_MS = '0';
