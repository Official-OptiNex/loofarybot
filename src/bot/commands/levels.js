const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const { getOrCreateConfig, getRank, getLeaderboard, xpForLevel } = require('../cogs/modules/leveling');

const data = new SlashCommandBuilder()
  .setName('levels')
  .setDescription('Leveling system commands')
  .addSubcommand((sub) =>
    sub
      .setName('rank')
      .setDescription("Check your (or someone else's) level and XP")
      .addUserOption((opt) => opt.setName('user').setDescription('User to check').setRequired(false))
  )
  .addSubcommand((sub) => sub.setName('leaderboard').setDescription('Show the server XP leaderboard'))
  .addSubcommand((sub) =>
    sub
      .setName('setrole')
      .setDescription('Assign a cosmetic role reward for reaching a level (Admin only)')
      .addIntegerOption((opt) => opt.setName('level').setDescription('Milestone level').setRequired(true))
      .addRoleOption((opt) => opt.setName('role').setDescription('Role to grant').setRequired(true))
  )
  .addSubcommand((sub) =>
    sub
      .setName('toggle')
      .setDescription('Enable or disable XP gain for this server (Admin only)')
      .addBooleanOption((opt) => opt.setName('enabled').setDescription('Turn leveling on or off').setRequired(true))
  );

// setrole/toggle are admin-only. Discord only lets us gate an entire command (not a single
// subcommand) via setDefaultMemberPermissions, so we enforce this at runtime instead.
const ADMIN_ONLY_SUBCOMMANDS = ['setrole', 'toggle'];

async function execute(interaction) {
  const sub = interaction.options.getSubcommand();

  if (ADMIN_ONLY_SUBCOMMANDS.includes(sub) && !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    return interaction.reply({ content: '❌ This subcommand requires Administrator permission.', ephemeral: true });
  }

  if (sub === 'rank') {
    const target = interaction.options.getUser('user') || interaction.user;
    const result = await getRank(interaction.guildId, target.id);
    if (!result) {
      return interaction.reply({ content: `${target.username} hasn't earned any XP yet.`, ephemeral: true });
    }
    const { record, rank } = result;
    const nextLevelXp = xpForLevel(record.level + 1);
    const embed = new EmbedBuilder()
      .setTitle(`${target.username}'s Rank`)
      .setColor('#5865F2')
      .addFields(
        { name: 'Level', value: `${record.level}`, inline: true },
        { name: 'XP', value: `${record.xp} / ${nextLevelXp}`, inline: true },
        { name: 'Server Rank', value: `#${rank}`, inline: true }
      );
    return interaction.reply({ embeds: [embed] });
  }

  if (sub === 'leaderboard') {
    const top = await getLeaderboard(interaction.guildId, 10);
    if (top.length === 0) {
      return interaction.reply({ content: 'No XP data yet for this server.', ephemeral: true });
    }
    const lines = top.map((r, i) => `**${i + 1}.** <@${r.userId}> — Level ${r.level} (${r.xp} XP)`);
    const embed = new EmbedBuilder().setTitle('🏆 XP Leaderboard').setColor('#F1C40F').setDescription(lines.join('\n'));
    return interaction.reply({ embeds: [embed] });
  }

  if (sub === 'setrole') {
    const level = interaction.options.getInteger('level');
    const role = interaction.options.getRole('role');
    const config = await getOrCreateConfig(interaction.guildId);

    const existing = config.levelRoles.find((lr) => lr.level === level);
    if (existing) {
      existing.roleId = role.id;
    } else {
      config.levelRoles.push({ level, roleId: role.id });
    }
    await config.save();
    return interaction.reply({ content: `✅ Level ${level} will now grant ${role}.`, ephemeral: true });
  }

  if (sub === 'toggle') {
    const enabled = interaction.options.getBoolean('enabled');
    const config = await getOrCreateConfig(interaction.guildId);
    config.levelingEnabled = enabled;
    await config.save();
    return interaction.reply({ content: `✅ Leveling is now **${enabled ? 'enabled' : 'disabled'}**.`, ephemeral: true });
  }
}

module.exports = { data, execute };
