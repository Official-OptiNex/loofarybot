const { BOT_TOKEN } = require('./src/config');
const { connectDB } = require('./src/database/db');
const client = require('./src/bot/client');
const { startWebServer } = require('./src/web/server');

const registerReadyEvent = require('./src/bot/events/ready');
const registerInteractionCreateEvent = require('./src/bot/events/interactionCreate');
const registerMessageCreateEvent = require('./src/bot/events/messageCreate');
const registerGuildMemberAddEvent = require('./src/bot/events/guildMemberAdd');
const registerGuildMemberRemoveEvent = require('./src/bot/events/guildMemberRemove');
const { registerLoggingEvents } = require('./src/bot/cogs/modules/logging');
const { registerBoostListener } = require('./src/bot/cogs/modules/boosterPerks');
const { registerTicketEvents } = require('./src/bot/cogs/modules/tickets');
const { registerStarboardEvents } = require('./src/bot/cogs/modules/starboard');
const { registerCountingEvents } = require('./src/bot/cogs/modules/counting');

const { registerProcessHandlers } = require('./src/bot/utils/errorReporter');

async function main() {
  registerProcessHandlers(client);
  await connectDB();

  registerReadyEvent(client);
  registerInteractionCreateEvent(client);
  registerMessageCreateEvent(client);
  registerGuildMemberAddEvent(client);
  registerGuildMemberRemoveEvent(client);
  registerLoggingEvents(client);
  registerBoostListener(client);
  registerTicketEvents(client);
  registerStarboardEvents(client);
  registerCountingEvents(client);

  await client.login(BOT_TOKEN);

  // The web server reads live guild/channel/role data off `client`, so it's
  // fine to start it right away — routes just won't find guilds until the
  // bot's READY event has populated the cache, which happens within seconds.
  startWebServer(client);
}

// Render sends SIGTERM before stopping the instance (redeploys, restarts). Settle open games so no
// one loses a bet, then disconnect cleanly. Render allows ~30s; we cap our work well under that.
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received — settling open games and shutting down.`);
  const { settleAllForShutdown } = require('./src/bot/cogs/modules/gambling');
  const timeout = new Promise((resolve) => setTimeout(resolve, 15000));
  try {
    const settled = await Promise.race([settleAllForShutdown(), timeout]);
    if (typeof settled === 'number') console.log(`Settled ${settled} open game(s).`);
  } catch (err) {
    console.error('Error settling games on shutdown:', err);
  }
  await client.destroy().catch(() => null);
  await require('mongoose').disconnect().catch(() => null);
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
