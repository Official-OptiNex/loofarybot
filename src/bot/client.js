const { Client, GatewayIntentBits, Partials, Collection } = require('discord.js');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates // voice join/leave/move logs
  ],
  // Partials let logging still see edits/deletes/leaves for messages & members that aren't cached.
  partials: [Partials.Message, Partials.Channel, Partials.GuildMember, Partials.User]
});

// In-memory command collection (populated in registerCommands).
client.commands = new Collection();

module.exports = client;
