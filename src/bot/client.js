const { Client, GatewayIntentBits, Partials, Collection, Options } = require('discord.js');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates, // voice join/leave/move logs
    GatewayIntentBits.GuildMessageReactions, // starboard
    GatewayIntentBits.GuildModeration, // ban/unban logs
    GatewayIntentBits.GuildInvites, // invite logs
    GatewayIntentBits.GuildExpressions // emoji & sticker logs
  ],
  // Partials let logging still see edits/deletes/leaves for messages & members that aren't cached,
  // and let the starboard see reactions on older messages.
  partials: [Partials.Message, Partials.Channel, Partials.GuildMember, Partials.User, Partials.Reaction],
  // Keep memory flat on Render's 512 MB free instance: at most 100 messages cached per channel
  // (plenty for edit/delete logs of recent chat) and no presences; messages older than 6 hours and
  // archived threads older than a day are swept every hour.
  makeCache: Options.cacheWithLimits({
    ...Options.DefaultMakeCacheSettings,
    MessageManager: 100,
    PresenceManager: 0,
    // These are read live from events, never from long-lived cache — keep tiny LRUs so they can't
    // grow unbounded on the 512 MB instance.
    GuildBanManager: 0,
    AutoModerationRuleManager: 0,
    GuildInviteManager: 0
  }),
  sweepers: {
    ...Options.DefaultSweeperSettings,
    messages: { interval: 3600, lifetime: 6 * 3600 },
    threads: { interval: 3600, lifetime: 24 * 3600 },
    // Reactions are acted on the moment they arrive (starboard), so we don't keep them cached; and
    // drop stale User objects we no longer reference. The bot's own user is never swept.
    reactions: { interval: 1800, filter: () => () => true },
    users: { interval: 3600, filter: () => (user) => user.id !== user.client.user.id }
  }
});

// In-memory command collection (populated in registerCommands).
client.commands = new Collection();

module.exports = client;
