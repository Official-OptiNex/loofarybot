const GuildConfig = require('../../database/models/GuildConfig');
const { recordJoin } = require('../cogs/modules/joinTracking');
const { sendWelcome } = require('../cogs/modules/welcome');
const { reportError, reportIssue } = require('../utils/errorReporter');

async function applyAutoRole(member) {
  const config = await GuildConfig.findOne({ guildId: member.guild.id }).lean();
  if (!config || !config.autoRoleEnabled || !config.autoRoleId) return;

  const role = member.guild.roles.cache.get(config.autoRoleId);
  const botMember = member.guild.members.me;
  if (!role || !botMember || botMember.roles.highest.position <= role.position) {
    reportIssue(
      member.guild.id,
      'Auto-role could not be given',
      role
        ? `LoofaryBot's role is below **${role.name}** in Server Settings → Roles, so new members aren't getting it. Move LoofaryBot's role above it.`
        : 'The configured auto-role no longer exists. Pick a new one on the dashboard.'
    );
    return;
  }

  await member.roles.add(role, 'Auto-role on join').catch((err) => {
    console.error(`Failed to auto-assign role to ${member.id}:`, err.message);
  });
}

module.exports = function registerGuildMemberAddEvent(client) {
  client.on('guildMemberAdd', async (member) => {
    if (member.user.bot) return;
    // Independent steps: a failure in one (e.g. a bad welcome channel) must not skip the others.
    const results = await Promise.allSettled([recordJoin(member), applyAutoRole(member), sendWelcome(member)]);
    for (const r of results) {
      if (r.status === 'rejected') reportError(r.reason, { guildId: member.guild.id, context: 'Member join handling failed' });
    }
    // sendWelcome resolves with a reason when it couldn't post; only real setup problems are worth an alert.
    const welcomeProblem = results[2].status === 'fulfilled' ? results[2].value : null;
    if (welcomeProblem && !/disabled|empty/i.test(welcomeProblem)) {
      reportIssue(member.guild.id, 'Welcome message not sent', welcomeProblem);
    }
  });
};
