// Preloaded by test/run.js: tests never connect to MongoDB, so any database call a test didn't stub
// fails straight away (and is logged by the bot's own error handling) instead of waiting 10s.
require('mongoose').set('bufferCommands', false);
