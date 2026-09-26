const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, ChannelType } = require('discord.js');
const {
  getOrCreateConfig,
  getRank,
  getLeaderboard,
  xpForLevel,
  getEffectiveXpSettings,
  adjustXp
} = require('../cogs/modules/leveling');
const UserLevel = require('../../database/models/UserLevel');
const { resolveColor } = require('../cogs/modules/giveaways');

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
  .addSubcommandGroup((group) =>
    group
      .setName('multiplier')
      .setDescription('Bonus XP multipliers for channels or roles (Admin only)')
      .addSubcommand((sub) =>
        sub
          .setName('add')
          .setDescription('Set an XP multiplier for a channel or a role')
          .addNumberOption((opt) =>
            opt.setName('multiplier').setDescription('e.g. 2 = double XP, 0.5 = half, 0 = no XP').setMinValue(0).setMaxValue(10).setRequired(true)
          )
          .addChannelOption((opt) => opt.setName('channel').setDescription('Channel (threads use their parent channel)'))
          .addRoleOption((opt) => opt.setName('role').setDescription('Role (e.g. Server Booster)'))
      )
      .addSubcommand((sub) =>
        sub
          .setName('remove')
          .setDescription('Remove a channel or role multiplier')
          .addChannelOption((opt) => opt.setName('channel').setDescription('Channel'))
          .addRoleOption((opt) => opt.setName('role').setDescription('Role'))
      )
      .addSubcommand((sub) => sub.setName('list').setDescription('List every XP multiplier'))
  )
  .addSubcommand((sub) =>
    sub
      .setName('givexp')
      .setDescription('Give XP to a member (Admin only)')
      .addUserOption((opt) => opt.setName('user').setDescription('Member').setRequired(true))
      .addIntegerOption((opt) => opt.setName('amount').setDescription('XP to give').setMinValue(1).setRequired(true))
  )
  .addSubcommand((sub) =>
    sub
      .setName('takexp')
      .setDescription('Take XP from a member (Admin only)')
      .addUserOption((opt) => opt.setName('user').setDescription('Member').setRequired(true))
      .addIntegerOption((opt) => opt.setName('amount').setDescription('XP to take').setMinValue(1).setRequired(true))
  )
  .addSubcommand((sub) =>
    sub
      .setName('resetxp')
      .setDescription("Reset a member's XP and level to 0 (Admin only)")
      .addUserOption((opt) => opt.setName('user').setDescription('Member').setRequired(true))
  )
  .addSubcommand((sub) =>
    sub
      .setName('card')
      .setDescription('Customize your /levels rank card')
      .addStringOption((opt) => opt.setName('color').setDescription('Accent color (hex like #FF5733 or a name like gold)'))
      .addStringOption((opt) => opt.setName('background').setDescription('Image URL shown on your card (https://...)'))
      .addStringOption((opt) => opt.setName('text').setDescription('A short bio/tagline shown on your card').setMaxLength(200))
      .addBooleanOption((opt) => opt.setName('reset').setDescription('Reset your card to the default look'))
  )
  .addSubcommand((sub) =>
    sub
      .setName('cardaccess')
      .setDescription('Choose who can customize rank cards (Admin only)')
      .addBooleanOption((opt) => opt.setName('boosters_only').setDescription('Only server boosters can use /levels card').setRequired(true))
  )
  .addSubcommand((sub) => sub.setName('xpconfig_show').setDescription('Show current XP tuning for this server'));

// Admin-only subcommands. Discord only lets us gate an entire command (not a single
// subcommand) via setDefaultMemberPermissions, so we enforce this at runtime instead.
const ADMIN_ONLY_SUBCOMMANDS = [
  'setrole',
  'removerole',
  'toggle',
  'xpconfig',
  'announcechannel',
  'givexp',
  'takexp',
  'resetxp',
  'cardaccess',
  'add',
  'remove',
  'list'
];

function progressBar(current, total, size = 12) {
  const ratio = total > 0 ? Math.min(Math.max(current / total, 0), 1) : 0;
  const filled = Math.round(ratio * size);
  return `${'▰'.repeat(filled)}${'▱'.repeat(size - filled)} ${Math.round(ratio * 100)}%`;
}

function isHttpsUrl(str) {
  try {
    return new URL(str).protocol === 'https:';
  } catch {
    return false;
  }
}

function describeMultiplier(m) {
  return `${m.type === 'channel' ? `<#${m.targetId}>` : `<@&${m.targetId}>`} → **${m.multiplier}x**`;
}

function checkRoleHierarchy(guild, role) {
  const botMember = guild.members.me;
  if (!botMember || !role) return true;
  return botMember.roles.highest.position > role.position;
}

async function execute(interaction) {
  const group = interaction.options.getSubcommandGroup(false);
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
    const levelStartXp = record.level > 0 ? xpForLevel(record.level, levelXpBase) : 0;
    const nextLevelXp = xpForLevel(record.level + 1, levelXpBase);
    const card = record.card || {};
    const embed = new EmbedBuilder()
      .setAuthor({ name: `${target.username}'s Rank`, iconURL: target.displayAvatarURL({ size: 64 }) })
      .setColor(card.color || '#5865F2')
      .setThumbnail(target.displayAvatarURL({ size: 128 }))
      .addFields(
        { name: 'Level', value: `${record.level}`, inline: true },
        { name: 'XP', value: `${record.xp} / ${nextLevelXp}`, inline: true },
        { name: 'Server Rank', value: `#${rank}`, inline: true },
        { name: 'Progress', value: progressBar(record.xp - levelStartXp, nextLevelXp - levelStartXp) }
      );
    if (card.text) embed.setDescription(card.text);
    if (card.backgroundUrl) embed.setImage(card.backgroundUrl);
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

  if (group === 'multiplier') {
    const config = await getOrCreateConfig(interaction.guildId);
    const channel = interaction.options.getChannel('channel');
    const role = interaction.options.getRole('role');

    if (sub === 'list') {
      const list = config.xpMultipliers || [];
      return interaction.reply({
        content: list.length ? `**XP multipliers:**\n${list.map(describeMultiplier).join('\n')}` : 'No XP multipliers are set.',
        ephemeral: true,
        allowedMentions: { parse: [] }
      });
    }

    if ((channel ? 1 : 0) + (role ? 1 : 0) !== 1) {
      return interaction.reply({ content: '❌ Pick exactly one: a `channel` or a `role`.', ephemeral: true });
    }
    const type = channel ? 'channel' : 'role';
    const targetId = (channel || role).id;
    const existing = config.xpMultipliers.find((m) => m.type === type && m.targetId === targetId);

    if (sub === 'add') {
      const multiplier = interaction.options.getNumber('multiplier');
      if (existing) existing.multiplier = multiplier;
      else config.xpMultipliers.push({ type, targetId, multiplier });
      await config.save();
      return interaction.reply({
        content: `✅ ${describeMultiplier({ type, targetId, multiplier })}` +
          (type === 'role' ? '\nIf a member has several multiplier roles, the highest one applies (then × the channel multiplier).' : ''),
        ephemeral: true,
        allowedMentions: { parse: [] }
      });
    }

    if (sub === 'remove') {
      if (!existing) return interaction.reply({ content: '❌ No multiplier is set for that.', ephemeral: true });
      config.xpMultipliers = config.xpMultipliers.filter((m) => m !== existing);
      await config.save();
      return interaction.reply({ content: '✅ Multiplier removed.', ephemeral: true });
    }
  }

  if (sub === 'givexp' || sub === 'takexp') {
    const target = interaction.options.getUser('user');
    const amount = interaction.options.getInteger('amount');
    if (target.bot) return interaction.reply({ content: "❌ Bots don't earn XP.", ephemeral: true });
    const result = await adjustXp(interaction.guild, target.id, sub === 'givexp' ? amount : -amount);
    const levelChange =
      result.newLevel !== result.oldLevel ? ` (Level ${result.oldLevel} → **${result.newLevel}**)` : ` (Level ${result.newLevel})`;
    const warn = result.roleFailures.length
      ? `\n⚠️ Couldn't assign ${result.roleFailures.join(', ')} — move LoofaryBot's role above it.`
      : '';
    return interaction.reply({
      content: `✅ ${sub === 'givexp' ? 'Gave' : 'Took'} **${amount} XP** ${sub === 'givexp' ? 'to' : 'from'} ${target}. ` +
        `They now have **${result.record.xp} XP**${levelChange}.${warn}`,
      ephemeral: true
    });
  }

  if (sub === 'resetxp') {
    const target = interaction.options.getUser('user');
    await UserLevel.updateOne({ guildId: interaction.guildId, userId: target.id }, { $set: { xp: 0, level: 0 } });
    return interaction.reply({ content: `✅ Reset ${target}'s XP and level to 0. (Earned role rewards were kept.)`, ephemeral: true });
  }

  if (sub === 'cardaccess') {
    const config = await getOrCreateConfig(interaction.guildId);
    config.rankCardBoosterOnly = interaction.options.getBoolean('boosters_only');
    await config.save();
    return interaction.reply({
      content: `✅ Rank card customization is now available to **${config.rankCardBoosterOnly ? 'server boosters only' : 'everyone'}**.`,
      ephemeral: true
    });
  }

  if (sub === 'card') {
    const config = await getOrCreateConfig(interaction.guildId);
    const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
    if (config.rankCardBoosterOnly && !interaction.member?.premiumSince && !isAdmin) {
      return interaction.reply({ content: '💎 Rank card customization is a **server booster** perk here.', ephemeral: true });
    }

    const color = interaction.options.getString('color');
    const background = interaction.options.getString('background');
    const text = interaction.options.getString('text');
    const reset = interaction.options.getBoolean('reset');

    const update = {};
    if (reset) {
      update['card.color'] = null;
      update['card.backgroundUrl'] = null;
      update['card.text'] = null;
    } else {
      if (!color && !background && !text) {
        return interaction.reply({ content: '❌ Give at least one of `color`, `background`, `text` — or `reset`.', ephemeral: true });
      }
      if (color) {
        const hex = resolveColor(color);
        if (hex === '#5865F2' && !/blurple|5865f2/i.test(color)) {
          return interaction.reply({ content: '❌ Unknown color. Use a hex code like `#FF5733` or a name like `gold`.', ephemeral: true });
        }
        update['card.color'] = hex;
      }
      if (background) {
        if (!isHttpsUrl(background)) {
          return interaction.reply({ content: '❌ The background must be an `https://` image link.', ephemeral: true });
        }
        update['card.backgroundUrl'] = background;
      }
      if (text) update['card.text'] = text;
    }

    await UserLevel.updateOne(
      { guildId: interaction.guildId, userId: interaction.user.id },
      { $set: update, $setOnInsert: { xp: 0, level: 0, lastMessageTimestamp: 0 } },
      { upsert: true }
    );
    return interaction.reply({
      content: reset ? '✅ Your rank card was reset.' : '✅ Rank card updated — check it with `/levels rank`.',
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
