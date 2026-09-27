const { SlashCommandBuilder, ChannelType } = require('discord.js');
const Giveaway = require('../../database/models/Giveaway');
const { isAuthorized } = require('../utils/permissions');
const { buildHelpMessage } = require('../cogs/modules/help');
const { formatDuration } = require('../utils/duration');
const giveawayForm = require('../cogs/modules/giveawayForm');
const { durationChoices } = require('../utils/autocomplete');
const {
  parseDuration,
  formatTime,
  resolveColor,
  describeRequirements,
  launchGiveaway,
  finishGiveawayById,
  refreshGiveaway,
  rerollGiveaway,
  deleteGiveaway,
  replyOrEdit,
  entryWeights,
  cleanBonus
} = require('../cogs/modules/giveaways');

const MAX_GIVEAWAY_MS = 365 * 86400000;
const TEXT_CHANNELS = [ChannelType.GuildText, ChannelType.GuildAnnouncement];

// Options shared by /loof start and /loof drop (and offered by /loof create's form and the dashboard).
const addLookOptions = (sub, { emoji = true } = {}) => {
  sub
    .addStringOption((opt) =>
      opt.setName('ping').setDescription('Ping @everyone or @here when it starts').addChoices({ name: '@everyone', value: 'everyone' }, { name: '@here', value: 'here' })
    )
    .addRoleOption((opt) => opt.setName('ping_role').setDescription('Role to ping when it starts'))
    .addStringOption((opt) => opt.setName('color').setDescription('Hex or name color (e.g. #FF5733, green, gold)'))
    .addStringOption((opt) => opt.setName('description').setDescription('Custom description text').setMaxLength(1000));
  if (emoji) sub.addStringOption((opt) => opt.setName('button_emoji').setDescription('Emoji on the Enter button (default 🎉)'));
  return sub
    .addRoleOption((opt) => opt.setName('required_role').setDescription('Only members with this role can enter'))
    .addIntegerOption((opt) => opt.setName('min_days').setDescription('Minimum days in the server to enter').setMinValue(1))
    .addIntegerOption((opt) => opt.setName('min_level').setDescription('Minimum XP level to enter').setMinValue(1));
};

const messageIdOption = (opt, description = 'Giveaway — start typing its prize') =>
  opt.setName('message_id').setDescription(description).setRequired(true).setAutocomplete(true);

const data = new SlashCommandBuilder()
  .setName('loof')
  .setDescription('LoofaryBot giveaways and drops')
  .addSubcommand((sub) =>
    addLookOptions(
      sub
        .setName('start')
        .setDescription('Start a giveaway or drop right away with inline options')
        .addChannelOption((opt) => opt.setName('channel').setDescription('Where to post it').addChannelTypes(...TEXT_CHANNELS).setRequired(true))
        .addStringOption((opt) =>
          opt.setName('duration').setDescription('How long it runs, e.g. 10m, 1h, 2d (drops: how long it can be claimed)').setRequired(true).setAutocomplete(true)
        )
        .addIntegerOption((opt) => opt.setName('winners').setDescription('Number of winners (drops: how many can claim)').setRequired(true).setMinValue(1).setMaxValue(100))
        .addStringOption((opt) => opt.setName('prize').setDescription('The prize').setRequired(true).setMaxLength(256))
        .addStringOption((opt) =>
          opt
            .setName('type')
            .setDescription('Timed giveaway (default) or first-to-click drop')
            .addChoices({ name: '🎁 Timed giveaway — winners drawn at the end', value: 'timed' }, { name: '⚡ Drop — first to click win', value: 'drop' })
        )
    )
      .addRoleOption((opt) => opt.setName('bonus_role').setDescription('Members with this role get extra entries'))
      .addIntegerOption((opt) => opt.setName('bonus_entries').setDescription('How many extra entries bonus_role gets (default 1)').setMinValue(1).setMaxValue(10))
  )
  .addSubcommand((sub) =>
    addLookOptions(
      sub
        .setName('drop')
        .setDescription('Start a first-to-click drop — the first N people to claim win instantly')
        .addChannelOption((opt) => opt.setName('channel').setDescription('Where to post it').addChannelTypes(...TEXT_CHANNELS).setRequired(true))
        .addStringOption((opt) => opt.setName('prize').setDescription('Prize').setRequired(true).setMaxLength(256))
        .addIntegerOption((opt) => opt.setName('winners').setDescription('How many people can claim (default 1)').setMinValue(1).setMaxValue(100))
        .addStringOption((opt) => opt.setName('expires').setDescription('Auto-close if unclaimed after (e.g. 10m, 1h — default 24h)').setAutocomplete(true)),
      { emoji: false }
    )
  )
  .addSubcommand((sub) =>
    sub
      .setName('create')
      .setDescription('Set up a giveaway or drop in a form, with a live preview before posting')
      .addChannelOption((opt) => opt.setName('channel').setDescription('Where to post it (you can change it in the form)').addChannelTypes(...TEXT_CHANNELS))
      .addStringOption((opt) =>
        opt.setName('type').setDescription('Start the form as a timed giveaway or a drop').addChoices({ name: '🎁 Timed giveaway', value: 'timed' }, { name: '⚡ Drop', value: 'drop' })
      )
      .addRoleOption((opt) => opt.setName('ping_role').setDescription('Role to ping (you can change it in the form)'))
  )
  .addSubcommand((sub) =>
    sub
      .setName('edit')
      .setDescription('Change a running giveaway — anything left empty stays the same')
      .addStringOption((opt) => messageIdOption(opt))
      .addStringOption((opt) => opt.setName('new_prize').setDescription('New prize text').setMaxLength(256))
      .addIntegerOption((opt) => opt.setName('new_winners').setDescription('New winner count').setMinValue(1).setMaxValue(100))
      .addStringOption((opt) => opt.setName('ends_in').setDescription('New end time, counted from now (e.g. 2h, 1d)').setAutocomplete(true))
      .addStringOption((opt) => opt.setName('new_description').setDescription('New description').setMaxLength(1000))
      .addStringOption((opt) => opt.setName('new_color').setDescription('New color (hex or name)'))
      .addStringOption((opt) => opt.setName('new_emoji').setDescription('New Enter button emoji (timed giveaways)'))
      .addRoleOption((opt) => opt.setName('bonus_role').setDescription('Give this role extra entries (timed giveaways)'))
      .addIntegerOption((opt) => opt.setName('bonus_entries').setDescription('Extra entries for bonus_role (0 removes its bonus)').setMinValue(0).setMaxValue(10))
  )
  .addSubcommand((sub) =>
    sub
      .setName('entries')
      .setDescription('See who entered a giveaway (and their bonus entries)')
      .addStringOption((opt) => messageIdOption(opt))
  )
  .addSubcommand((sub) =>
    sub
      .setName('requirements')
      .setDescription('Set or clear entry requirements on a running giveaway or drop')
      .addStringOption((opt) => messageIdOption(opt))
      .addRoleOption((opt) => opt.setName('role').setDescription('Required role'))
      .addIntegerOption((opt) => opt.setName('min_days').setDescription('Minimum days in the server (0 = none)').setMinValue(0))
      .addIntegerOption((opt) => opt.setName('min_level').setDescription('Minimum XP level (0 = none)').setMinValue(0))
      .addBooleanOption((opt) => opt.setName('clear').setDescription('Remove all requirements'))
  )
  .addSubcommand((sub) => sub.setName('end').setDescription('End a running giveaway now and draw the winners').addStringOption((opt) => messageIdOption(opt)))
  .addSubcommand((sub) =>
    sub.setName('reroll').setDescription('Draw a new winner for an ended giveaway').addStringOption((opt) => messageIdOption(opt, 'Ended giveaway — start typing its prize'))
  )
  .addSubcommand((sub) => sub.setName('delete').setDescription('Delete a giveaway and its message').addStringOption((opt) => messageIdOption(opt)))
  .addSubcommand((sub) => sub.setName('list').setDescription('Running giveaways and recently ended ones'))
  .addSubcommand((sub) => sub.setName('ping').setDescription('Check bot websocket and API latency'))
  .addSubcommand((sub) => sub.setName('help').setDescription('Browse every LoofaryBot command by category'));

// Subcommands that do a Discord API call plus a database round trip before replying — defer so
// Discord's 3-second window is never missed. `create` opens a form, which must be the first response.
const DEFER_SUBCOMMANDS = ['start', 'drop', 'requirements', 'end', 'reroll', 'delete', 'edit', 'list', 'entries'];

function readRequirementOptions(interaction) {
  return {
    roleId: interaction.options.getRole('required_role')?.id || null,
    minDaysInServer: interaction.options.getInteger('min_days') || null,
    minLevel: interaction.options.getInteger('min_level') || null
  };
}

function pingFromOptions(interaction) {
  const extra = interaction.options.getString('ping');
  const role = interaction.options.getRole('ping_role');
  return [extra ? `@${extra}` : null, role ? `${role}` : null].filter(Boolean).join(' ') || null;
}

const findGiveaway = (interaction, messageId) => Giveaway.findOne({ messageId: String(messageId).trim(), guildId: interaction.guildId });

async function execute(interaction, client) {
  const sub = interaction.options.getSubcommand();
  if (sub === 'help') {
    return interaction.reply({ ...buildHelpMessage(client, interaction.guildId), ephemeral: true });
  }
  if (sub !== 'ping' && !isAuthorized(interaction)) {
    return interaction.reply({ content: '❌ Only Administrators or @loofary can use LoofaryBot giveaway commands.', ephemeral: true });
  }

  if (sub === 'create') {
    return giveawayForm.openCreateForm(interaction, {
      channelId: interaction.options.getChannel('channel')?.id,
      pingRoleId: interaction.options.getRole('ping_role')?.id,
      type: interaction.options.getString('type')
    });
  }

  if (DEFER_SUBCOMMANDS.includes(sub)) await interaction.deferReply({ ephemeral: true });

  if (sub === 'ping') {
    const sent = await interaction.reply({ content: 'Pinging...', fetchReply: true, ephemeral: true });
    const roundtrip = sent.createdTimestamp - interaction.createdTimestamp;
    return interaction.editReply({ content: `🏓 **Pong!**\n• API Latency: \`${roundtrip}ms\`\n• WebSocket Latency: \`${Math.round(client.ws.ping)}ms\`` });
  }

  if (sub === 'start' || sub === 'drop') {
    const type = sub === 'drop' || interaction.options.getString('type') === 'drop' ? 'drop' : 'timed';
    const raw = sub === 'drop' ? interaction.options.getString('expires') : interaction.options.getString('duration');
    const durationMs = raw ? parseDuration(raw) : 24 * 3600000;
    if (!durationMs || durationMs > MAX_GIVEAWAY_MS) {
      return replyOrEdit(interaction, { content: '❌ Invalid duration — use e.g. `10m`, `1h`, `2d` (max 365d).' });
    }
    return launchGiveaway(client, {
      interaction,
      channel: interaction.options.getChannel('channel'),
      durationMs,
      winnerCount: interaction.options.getInteger('winners') || 1,
      prize: interaction.options.getString('prize'),
      ping: pingFromOptions(interaction),
      colorHex: resolveColor(interaction.options.getString('color') || (type === 'drop' ? 'gold' : null)),
      emoji: type === 'drop' ? '⚡' : interaction.options.getString('button_emoji') || '🎉',
      customDesc: interaction.options.getString('description') || (type === 'drop' ? 'Be quick — first come, first served!' : 'Click the button below to enter!'),
      type,
      requirements: readRequirementOptions(interaction),
      bonusEntries: interaction.options.getRole('bonus_role')
        ? [{ roleId: interaction.options.getRole('bonus_role').id, extra: interaction.options.getInteger('bonus_entries') || 1 }]
        : []
    });
  }

  if (sub === 'list') {
    const [active, ended] = await Promise.all([
      Giveaway.find({ ended: false, guildId: interaction.guildId }).sort({ endTimestamp: 1 }),
      Giveaway.find({ ended: true, guildId: interaction.guildId }).sort({ updatedAt: -1 }).limit(5)
    ]);
    if (!active.length && !ended.length) {
      return replyOrEdit(interaction, { content: 'No giveaways yet. Start one with `/loof create` or `/loof start`.' });
    }
    const link = (g) => `https://discord.com/channels/${g.guildId}/${g.channelId}/${g.messageId}`;
    const line = (g) => {
      const stats = g.type === 'drop' ? `${g.entries.length}/${g.winnerCount} claimed` : `${g.entries.length} entries · ${g.winnerCount} winner(s)`;
      const req = describeRequirements(g.requirements) ? ' · 🔒' : '';
      return `${g.type === 'drop' ? '⚡' : '🎁'} **[${g.prize}](${link(g)})** in <#${g.channelId}> · ${stats}${req} · ${g.ended ? 'ended' : 'ends'} ${formatTime(g.endTimestamp)}\n-# ID \`${g.messageId}\``;
    };
    const parts = [];
    if (active.length) parts.push(`**Running (${active.length})**\n${active.slice(0, 15).map(line).join('\n')}`);
    if (ended.length) parts.push(`**Recently ended**\n${ended.map(line).join('\n')}`);
    return replyOrEdit(interaction, { content: parts.join('\n\n').slice(0, 2000) });
  }

  const msgId = interaction.options.getString('message_id');
  const g = await findGiveaway(interaction, msgId);

  if (sub === 'entries') {
    if (!g) return replyOrEdit(interaction, { content: '❌ Giveaway not found.' });
    if (!g.entries.length) return replyOrEdit(interaction, { content: `Nobody has entered **${g.prize}** yet.` });
    const weights = await entryWeights(interaction.guild, g, g.entries);
    const tickets = [...weights.values()].reduce((a, b) => a + b, 0);
    const shown = g.entries.slice(0, 60).map((id) => `<@${id}>${weights.get(id) > 1 ? ` ×${weights.get(id)}` : ''}${(g.winners || []).includes(id) ? ' 🏆' : ''}`);
    return replyOrEdit(interaction, {
      content:
        `👥 **${g.prize}** — ${g.entries.length} ${g.type === 'drop' ? 'claim' : 'entr'}${g.entries.length === 1 ? (g.type === 'drop' ? '' : 'y') : g.type === 'drop' ? 's' : 'ies'}` +
        `${tickets !== g.entries.length ? ` · ${tickets} tickets with bonuses` : ''}\n${shown.join(', ')}${g.entries.length > 60 ? `\n…and ${g.entries.length - 60} more (see the dashboard for everyone)` : ''}`.slice(0, 1990),
      allowedMentions: { parse: [] }
    });
  }

  if (sub === 'requirements') {
    if (!g || g.ended) return replyOrEdit(interaction, { content: '❌ Giveaway not found or already ended.' });
    const role = interaction.options.getRole('role');
    const minDays = interaction.options.getInteger('min_days');
    const minLevel = interaction.options.getInteger('min_level');
    if (interaction.options.getBoolean('clear')) {
      g.requirements = { roleId: null, minDaysInServer: null, minLevel: null };
    } else {
      if (!role && minDays === null && minLevel === null) {
        return replyOrEdit(interaction, { content: '❌ Give at least one of `role`, `min_days`, `min_level` — or `clear`.' });
      }
      if (role) g.requirements.roleId = role.id;
      if (minDays !== null) g.requirements.minDaysInServer = minDays || null;
      if (minLevel !== null) g.requirements.minLevel = minLevel || null;
    }
    await g.save();
    await refreshGiveaway(client, g);
    const summary = describeRequirements(g.requirements) || '\n\nNo requirements — anyone can enter.';
    return replyOrEdit(interaction, {
      content: `✅ Requirements updated for **${g.prize}**.${summary}` + (g.type === 'timed' ? '\n_Existing entrants who no longer qualify are skipped at the draw._' : '')
    });
  }

  if (sub === 'end') {
    if (!g || g.ended) return replyOrEdit(interaction, { content: '❌ Giveaway not found or already ended.' });
    await finishGiveawayById(client, g.messageId);
    return replyOrEdit(interaction, { content: `✅ **${g.prize}** ended early — winners announced.` });
  }

  if (sub === 'reroll') {
    if (!g) return replyOrEdit(interaction, { content: '❌ Giveaway not found.' });
    const result = await rerollGiveaway(client, g);
    if (result.error) return replyOrEdit(interaction, { content: `❌ ${result.error}` });
    return replyOrEdit(interaction, { content: `✅ Rerolled **${g.prize}**. New winner: <@${result.winner}>` });
  }

  if (sub === 'delete') {
    if (!g) return replyOrEdit(interaction, { content: '❌ Giveaway not found.' });
    await deleteGiveaway(client, g);
    return replyOrEdit(interaction, { content: `✅ Deleted **${g.prize}** and its message.` });
  }

  if (sub === 'edit') {
    if (!g || g.ended) return replyOrEdit(interaction, { content: '❌ Giveaway not found or already ended.' });
    const changes = [];
    const newPrize = interaction.options.getString('new_prize');
    const newWinners = interaction.options.getInteger('new_winners');
    const endsIn = interaction.options.getString('ends_in');
    const newDesc = interaction.options.getString('new_description');
    const newColor = interaction.options.getString('new_color');
    const newEmoji = interaction.options.getString('new_emoji');

    if (endsIn) {
      const ms = parseDuration(endsIn);
      if (!ms || ms > MAX_GIVEAWAY_MS) return replyOrEdit(interaction, { content: '❌ Invalid `ends_in` — use e.g. `30m`, `2h`, `1d`.' });
      g.endTimestamp = Date.now() + ms;
      changes.push(`ends ${formatTime(g.endTimestamp)}`);
    }
    if (newWinners) {
      if (g.type === 'drop' && newWinners < g.entries.length) {
        return replyOrEdit(interaction, { content: `❌ ${g.entries.length} people already claimed — prizes can't go below that.` });
      }
      g.winnerCount = newWinners;
      changes.push(`${newWinners} winner(s)`);
    }
    if (newPrize) (g.prize = newPrize), changes.push(`prize “${newPrize}”`);
    if (newDesc) (g.customDesc = newDesc), changes.push('description');
    if (newColor) (g.colorHex = resolveColor(newColor)), changes.push(`color ${g.colorHex}`);
    if (newEmoji && g.type !== 'drop') (g.emoji = newEmoji), changes.push(`emoji ${newEmoji}`);
    const bonusRole = interaction.options.getRole('bonus_role');
    if (bonusRole && g.type !== 'drop') {
      const extra = interaction.options.getInteger('bonus_entries') ?? 1;
      const others = (g.bonusEntries || []).filter((b) => b.roleId !== bonusRole.id).map((b) => ({ roleId: b.roleId, extra: b.extra }));
      g.bonusEntries = cleanBonus(extra > 0 ? [...others, { roleId: bonusRole.id, extra }] : others);
      changes.push(extra > 0 ? `${bonusRole.name} +${extra} entries` : `removed ${bonusRole.name} bonus`);
    }
    if (!changes.length) return replyOrEdit(interaction, { content: 'ℹ️ Nothing to change — fill in at least one option.' });

    await g.save();
    try {
      await refreshGiveaway(client, g);
    } catch (err) {
      return replyOrEdit(interaction, { content: `⚠️ Saved, but Discord rejected the update (${err.message}). Is the emoji valid?` });
    }
    if (g.type === 'drop' && g.entries.length >= g.winnerCount) await finishGiveawayById(client, g.messageId);
    return replyOrEdit(interaction, { content: `✅ Updated **${g.prize}**: ${changes.join(', ')}.` });
  }
}

// ---------- Autocomplete: pick giveaways by prize, and suggest common durations ----------

async function autocomplete(interaction) {
  const focused = interaction.options.getFocused(true);
  const query = String(focused.value || '').toLowerCase().trim();

  if (['duration', 'expires', 'ends_in'].includes(focused.name)) return interaction.respond(durationChoices(query));

  if (focused.name !== 'message_id' || !isAuthorized(interaction)) return interaction.respond([]);
  const sub = interaction.options.getSubcommand();
  const filter = { guildId: interaction.guildId };
  if (['end', 'edit', 'requirements'].includes(sub)) filter.ended = false;
  // entries / delete: any giveaway
  if (sub === 'reroll') Object.assign(filter, { ended: true, type: { $ne: 'drop' } }); // older giveaways have no type field
  const list = await Giveaway.find(filter).sort({ ended: 1, endTimestamp: -1 }).limit(100).lean();
  const now = Date.now();
  const when = (g) => {
    const diff = g.endTimestamp - now;
    return diff > 0 ? `ends in ${formatDuration(diff).split(' ').slice(0, 2).join(' ')}` : 'ended';
  };
  const channelName = (id) => interaction.guild.channels.cache.get(id)?.name || 'deleted-channel';
  const choices = list
    .filter((g) => !query || g.prize.toLowerCase().includes(query) || g.messageId.includes(query))
    .slice(0, 25)
    .map((g) => ({
      name: `${g.type === 'drop' ? '⚡' : '🎁'} ${g.prize.slice(0, 50)} — #${channelName(g.channelId)} · ${g.entries.length} ${g.type === 'drop' ? 'claimed' : 'entries'} · ${when(g)}`.slice(0, 100),
      value: g.messageId
    }));
  return interaction.respond(choices);
}

module.exports = { data, execute, autocomplete };
