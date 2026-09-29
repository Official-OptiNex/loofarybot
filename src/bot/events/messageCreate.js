const { handleMessageXp } = require('../cogs/modules/leveling');
const { handleHoneypotMessage } = require('../cogs/modules/honeypot');
const { handleMediaOnly } = require('../cogs/modules/mediaOnly');
const { noteActivity } = require('../cogs/modules/chatDrops');
const { handleCounting } = require('../cogs/modules/counting');
const { handleAutomod } = require('../cogs/modules/automod');
const { handleShopMessage } = require('../cogs/modules/shop');
const { noteChat } = require('../cogs/modules/xpPot');
const { getCachedConfig } = require('../../database/configCache');
const { reportError } = require('../utils/errorReporter');

module.exports = function registerMessageCreateEvent(client) {
  client.on('messageCreate', async (message) => {
    try {
      // Honeypot check runs first: if the message is in the trap channel it gets
      // deleted immediately, so it should never also count toward XP gain.
      if (message.guild) {
        const guildConfig = await getCachedConfig(message.guild.id); // cached a few seconds — this runs for every message
        if (guildConfig && guildConfig.honeypotEnabled !== false && guildConfig.honeypotChannelId === message.channel.id) {
          return handleHoneypotMessage(message);
        }
        // Spam caught by auto-mod is removed and earns nothing.
        if (await handleAutomod(message, guildConfig)) return;
        // Text-only posts in a media-only channel are removed and don't earn XP.
        if (await handleMediaOnly(message, guildConfig)) return;
        noteActivity(message); // chat drops only land in channels people are talking in
        noteChat(message); // Daily XP Pot: who's been chatting before the draw
        await handleCounting(message, guildConfig); // counting game channel (still earns normal XP)
        handleShopMessage(message, guildConfig).catch(() => null); // auto-react bought in the XP shop
      }
      await handleMessageXp(message);
    } catch (err) {
      reportError(err, { guildId: message.guildId, context: 'Message handling failed' });
    }
  });
};
