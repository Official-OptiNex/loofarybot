const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, ChannelType } = require('discord.js');
const { getOrCreateConfig, getRank, getLeaderboard, xpForLevel, getEffectiveXpSettings } = require('../cogs/modules/leveling');

const data = new SlashCommandBuilder()
  .setName('levels')
  .setDescription('Leveling system commands')
  .addSubcommand((sub) =>
    sub
      .setName('rank')
      .setDescription("Check your (or someone else's) level and XP")
      .addUserOption((opt) => opt.setName('user').setDescription('User to check').setRequired(false))
  )
  .addSubcommand((sub) =>
    sub
      .setName('leaderboard')
      .setDescription('Show the server XP leaderboard')
      .addIntegerOption((opt) => opt.setName('page').setDescription('Page number (10 per page)').setRequired(false))
  )
  .addSubcommand((sub) =>
    sub
      .setName('setrole')
      .setDescription('Assign a cosmetic role reward for reaching a level (Admin only)')
      .addIntegerOption((opt) => opt.setName('level').setDescription('Milestone level').setRequired(true))
      .addRoleOption((opt) => opt.setName('role').setDescription('Role to grant').setRequired(true))
  )
  .addSubcommand((sub) =>
    sub
      .setName('removerole')
      .setDescription('Remove a level-up role reward (Admin only)')
      .addIntegerOption((opt) => opt.setName('level').setDescription('Milestone level to clear').setRequired(true))
  )
  .addSubcommand((sub) =>
    sub
      .setName('toggle')
      .setDescription('Enable or disable XP gain for this server (Admin only)')
      .addBooleanOption((opt) => opt.setName('enabled').setDescription('Turn leveling on or off').setRequired(true))
  )
  .addSubcommand((sub) =>
    sub
      .setName('xpconfig')
      .setDescription('Tune XP-per-message and leveling speed for this server (Admin only)')
      .addIntegerOption((opt) => opt.setName('min_xp').setDescription('Minimum XP per message').setRequired(false))
      .addIntegerOption((opt) => opt.setName('max_xp').setDescription('Maximum XP per message').setRequired(false))
      .addIntegerOption((opt) => opt.setName('cooldown_seconds').setDescription('Seconds between XP-earning messages').setRequired(false))
      .addIntegerOption((opt) =>
        opt
          .setName('level_base')
          .setDescription('Higher = slower leveling curve (default 100)')
          .setRequired(false)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName('announcechannel')
      .setDescription('Choose where level-up messages are sent (Admin only)')
      .addChannelOption((opt) =>
        opt
          .setName('channel')
          .setDescription('Channel for level-up messages — leave empty to send them in the same channel')
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setRequired(false)
      )
  )
  .addSubcommand((sub) => sub.setName('xpconfig_show').setDescription('Show current XP tuning for this server'));

// Admin-only subcommands. Discord only lets us gate an entire command (not a single
// subcommand) via setDefaultMemberPermissions, so we enforce this at runtime instead.
const ADMIN_ONLY_SUBCOMMANDS = ['setrole', 'removerole', 'toggle', 'xpconfig', 'announcechannel'];

function checkRoleHierarchy(guild, role) {
  const botMember = guild.members.me;
  if (!botMember || !role) return true;
  return botMember.roles.highest.position > role.position;
}

async function execute(interaction) {
  const sub = interaction.options.getSubcommand();

  if (ADMIN_ONLY_SUBCOMMANDS.includes(sub) && !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    return interaction.reply({ content: '❌ This subcommand requires Administrator permission.', ephemeral: true });
  }

  if (sub === 'rank') {
    const target = interaction.options.getUser('user') || interaction.user;
    const config = await getOrCreateConfig(interaction.guildId);
    const { levelXpBase } = getEffectiveXpSettings(config);
    const result = await getRank(interaction.guildId, target.id);
    if (!result) {
      return interaction.reply({ content: `${target.username} hasn't earned any XP yet.`, ephemeral: true });
    }
    const { record, rank } = result;
    const nextLevelXp = xpForLevel(record.level + 1, levelXpBase);
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
    const page = interaction.options.getInteger('page') || 1;
    const { entries, page: safePage, totalPages, total } = await getLeaderboard(interaction.guildId, page, 10);
    if (total === 0) {
      return interaction.reply({ content: 'No XP data yet for this server.', ephemeral: true });
    }
    if (safePage > totalPages) {
      return interaction.reply({ content: `There are only ${totalPages} page(s) of leaderboard data.`, ephemeral: true });
    }
    const startRank = (safePage - 1) * 10;
    const lines = entries.map((r, i) => `**${startRank + i + 1}.** <@${r.userId}> — Level ${r.level} (${r.xp} XP)`);
    const embed = new EmbedBuilder()
      .setTitle('🏆 XP Leaderboard')
      .setColor('#F1C40F')
      .setDescription(lines.join('\n'))
      .setFooter({ text: `Page ${safePage} of ${totalPages} • ${total} ranked member(s)` });
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

    const hierarchyOk = checkRoleHierarchy(interaction.guild, role);
    const warning = hierarchyOk
      ? ''
      : `\n⚠️ **Heads up:** LoofaryBot's own role is currently positioned *below* ${role} in Server Settings → Roles, ` +
        `so it won't actually be able to grant this role until you drag LoofaryBot's role above it.`;

    return interaction.reply({ content: `✅ Level ${level} will now grant ${role}.${warning}`, ephemeral: true });
  }

  if (sub === 'removerole') {
    const level = interaction.options.getInteger('level');
    const config = await getOrCreateConfig(interaction.guildId);
    const before = config.levelRoles.length;
    config.levelRoles = config.levelRoles.filter((lr) => lr.level !== level);
    if (config.levelRoles.length === before) {
      return interaction.reply({ content: `No role reward was set for level ${level}.`, ephemeral: true });
    }
    await config.save();
    return interaction.reply({ content: `✅ Removed the role reward for level ${level}.`, ephemeral: true });
  }

  if (sub === 'toggle') {
    const enabled = interaction.options.getBoolean('enabled');
    const config = await getOrCreateConfig(interaction.guildId);
    config.levelingEnabled = enabled;
    await config.save();
    return interaction.reply({ content: `✅ Leveling is now **${enabled ? 'enabled' : 'disabled'}**.`, ephemeral: true });
  }

  if (sub === 'xpconfig') {
    const minXp = interaction.options.getInteger('min_xp');
    const maxXp = interaction.options.getInteger('max_xp');
    const cooldown = interaction.options.getInteger('cooldown_seconds');
    const levelBase = interaction.options.getInteger('level_base');

    if (minXp !== null && maxXp !== null && minXp > maxXp) {
      return interaction.reply({ content: '❌ `min_xp` cannot be greater than `max_xp`.', ephemeral: true });
    }

    const config = await getOrCreateConfig(interaction.guildId);
    if (minXp !== null) config.xpMin = minXp;
    if (maxXp !== null) config.xpMax = maxXp;
    if (cooldown !== null) config.xpCooldownSeconds = cooldown;
    if (levelBase !== null) config.levelXpBase = levelBase;
    await config.save();

    const effective = getEffectiveXpSettings(config);
    return interaction.reply({
      content:
        `✅ XP settings updated.\n` +
        `**Min XP:** ${effective.xpMin} • **Max XP:** ${effective.xpMax} • ` +
        `**Cooldown:** ${effective.cooldownMs / 1000}s • **Level curve base:** ${effective.levelXpBase}`,
      ephemeral: true
    });
  }

  if (sub === 'announcechannel') {
    const channel = interaction.options.getChannel('channel');
    const config = await getOrCreateConfig(interaction.guildId);

    if (!channel) {
      config.levelUpChannelId = null;
      await config.save();
      return interaction.reply({
        content: '✅ Level-up messages will now be sent in the **same channel** the member was chatting in.',
        ephemeral: true
      });
    }

    const me = interaction.guild.members.me;
    if (!me || !channel.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {
      return interaction.reply({
        content: `❌ LoofaryBot can't send messages in ${channel}. Give it View Channel + Send Messages there first.`,
        ephemeral: true
      });
    }

    config.levelUpChannelId = channel.id;
    await config.save();
    return interaction.reply({ content: `✅ Level-up messages will now be sent to ${channel}.`, ephemeral: true });
  }

  if (sub === 'xpconfig_show') {
    const config = await getOrCreateConfig(interaction.guildId);
    const effective = getEffectiveXpSettings(config);
    const embed = new EmbedBuilder()
      .setTitle('XP Configuration')
      .setColor('#5865F2')
      .addFields(
        { name: 'Min XP / message', value: `${effective.xpMin}`, inline: true },
        { name: 'Max XP / message', value: `${effective.xpMax}`, inline: true },
        { name: 'Cooldown', value: `${effective.cooldownMs / 1000}s`, inline: true },
        { name: 'Level curve base', value: `${effective.levelXpBase}`, inline: true },
        { name: 'Leveling enabled', value: config.levelingEnabled ? 'Yes' : 'No', inline: true },
        {
          name: 'Level-up messages',
          value: config.levelUpChannelId ? `<#${config.levelUpChannelId}>` : 'Same channel',
          inline: true
        }
      );
    return interaction.reply({ embeds: [embed], ephemeral: true });
  }
}

module.exports = { data, execute };
