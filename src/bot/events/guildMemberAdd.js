const GuildConfig = require('../../database/models/GuildConfig');

module.exports = function registerGuildMemberAddEvent(client) {
  client.on('guildMemberAdd', async (member) => {
    try {
      if (member.user.bot) return;

      const config = await GuildConfig.findOne({ guildId: member.guild.id }).lean();
      if (!config || !config.autoRoleEnabled || !config.autoRoleId) return;

      const role = member.guild.roles.cache.get(config.autoRoleId);
      const botMember = member.guild.members.me;
      if (!role || !botMember || botMember.roles.highest.position <= role.position) {
        console.error(
          `Auto-role skipped for ${member.id} in guild ${member.guild.id}: role missing or bot's role is too low in the hierarchy.`
        );
        return;
      }

      await member.roles.add(role, 'Auto-role on join').catch((err) => {
        console.error(`Failed to auto-assign role to ${member.id}:`, err.message);
      });
    } catch (err) {
      console.error('Error in guildMemberAdd handler:', err);
    }
  });
};
