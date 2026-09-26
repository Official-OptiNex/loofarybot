const { handleMessageXp } = require('../cogs/modules/leveling');
const { handleHoneypotMessage } = require('../cogs/modules/honeypot');
const GuildConfig = require('../../database/models/GuildConfig');

module.exports = function registerMessageCreateEvent(client) {
  client.on('messageCreate', async (message) => {
    try {
      // Honeypot check runs first: if the message is in the trap channel it gets
      // deleted immediately, so it should never also count toward XP gain.
      if (message.guild) {
        const guildConfig = await GuildConfig.findOne({ guildId: message.guild.id }).lean();
        if (guildConfig && guildConfig.honeypotEnabled !== false && guildConfig.honeypotChannelId === message.channel.id) {
          return handleHoneypotMessage(message);
        }
      }
      await handleMessageXp(message);
    } catch (err) {
      console.error('Error in messageCreate handler:', err);
    }
  });
};
