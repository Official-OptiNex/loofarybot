const { Client, GatewayIntentBits, Partials, Collection } = require('discord.js');

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
  partials: [Partials.Message, Partials.Channel, Partials.GuildMember, Partials.User, Partials.Reaction]
});

// In-memory command collection (populated in registerCommands).
client.commands = new Collection();

module.exports = client;
