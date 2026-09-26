const { BOT_TOKEN } = require('./src/config');
const { connectDB } = require('./src/database/db');
const client = require('./src/bot/client');
const { startWebServer } = require('./src/web/server');

const registerReadyEvent = require('./src/bot/events/ready');
const registerInteractionCreateEvent = require('./src/bot/events/interactionCreate');
const registerMessageCreateEvent = require('./src/bot/events/messageCreate');

async function main() {
  await connectDB();

  registerReadyEvent(client);
  registerInteractionCreateEvent(client);
  registerMessageCreateEvent(client);

  await client.login(BOT_TOKEN);

  // The web server reads live guild/channel/role data off `client`, so it's
  // fine to start it right away — routes just won't find guilds until the
  // bot's READY event has populated the cache, which happens within seconds.
  startWebServer(client);
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
