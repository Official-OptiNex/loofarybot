// /loof create: the same options as /loof start (and the dashboard), in a form.
// Step 1 is a popup with the basics; then a private setup panel shows a live preview with buttons
// to fill in the look, requirements and ping, and to start it.
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  EmbedBuilder,
  LabelBuilder,
  ModalBuilder,
  PermissionFlagsBits,
  RoleSelectMenuBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle
} = require('discord.js');
const { parseDuration, formatDuration } = require('../../utils/duration');
const giveaways = require('./giveaways');

const DRAFT_TTL_MS = 30 * 60 * 1000;
const MAX_GIVEAWAY_MS = 365 * 86400000;
const drafts = new Map(); // draftId -> draft (lives in memory; a restart just asks you to run /loof create again)

const DEFAULTS = {
  timed: { desc: 'Click the button below to enter!', color: '#5865F2', duration: '1d' },
  drop: { desc: 'Be quick — first come, first served!', color: '#F1C40F', duration: '24h' }
};

function sweep() {
  const now = Date.now();
  for (const [id, d] of drafts) if (d.expiresAt < now) drafts.delete(id);
}

function newDraft(interaction, { channelId, pingRoleId, type } = {}) {
  sweep();
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const t = type === 'drop' ? 'drop' : 'timed';
  const draft = {
    id,
    userId: interaction.user.id,
    guildId: interaction.guildId,
    type: t,
    channelId: channelId || interaction.channelId,
    prize: '',
    duration: DEFAULTS[t].duration,
    winners: 1,
    description: '',
    color: '',
    emoji: '🎉',
    ping: '', // '' | 'everyone' | 'here'
    pingRoleId: pingRoleId || null,
    reqRoleId: null,
    minDays: null,
    minLevel: null,
    expiresAt: Date.now() + DRAFT_TTL_MS
  };
  drafts.set(id, draft);
  return draft;
}

function getDraft(interaction, id) {
  const d = drafts.get(id);
  if (!d || d.expiresAt < Date.now() || d.userId !== interaction.user.id) return null;
  d.expiresAt = Date.now() + DRAFT_TTL_MS; // any activity keeps it alive
  return d;
}

const text = (id, style, value, { placeholder, required = false, max } = {}) => {
  const input = new TextInputBuilder().setCustomId(id).setStyle(style).setRequired(required);
  if (value !== null && value !== undefined && value !== '') input.setValue(String(value));
  if (placeholder) input.setPlaceholder(placeholder);
  if (max) input.setMaxLength(max);
  return input;
};
const label = (name, description) => {
  const l = new LabelBuilder().setLabel(name);
  if (description) l.setDescription(description);
  return l;
};

function basicsModal(d) {
  return new ModalBuilder()
    .setCustomId(`gwd:${d.id}:basics`)
    .setTitle('Create a giveaway')
    .addLabelComponents(
      label('Type').setStringSelectMenuComponent(
        new StringSelectMenuBuilder()
          .setCustomId('type')
          .addOptions(
            new StringSelectMenuOptionBuilder().setLabel('Timed giveaway').setDescription('Members enter; winners are drawn at the end').setValue('timed').setEmoji('🎁').setDefault(d.type === 'timed'),
            new StringSelectMenuOptionBuilder().setLabel('Drop').setDescription('The first people to click win instantly').setValue('drop').setEmoji('⚡').setDefault(d.type === 'drop')
          )
      ),
      label('Post in').setChannelSelectMenuComponent(
        new ChannelSelectMenuBuilder()
          .setCustomId('channel')
          .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setDefaultChannels(d.channelId ? [d.channelId] : [])
      ),
      label('Prize').setTextInputComponent(text('prize', TextInputStyle.Short, d.prize, { required: true, max: 256, placeholder: 'e.g. Discord Nitro (1 month)' })),
      label('Duration', 'e.g. 30m, 2h, 1d12h. For drops: how long it can be claimed.').setTextInputComponent(
        text('duration', TextInputStyle.Short, d.duration, { required: true, max: 20, placeholder: '1d' })
      ),
      label('Winners', 'How many people win (drops: how many can claim).').setTextInputComponent(
        text('winners', TextInputStyle.Short, d.winners, { required: true, max: 3, placeholder: '1' })
      )
    );
}

function lookModal(d) {
  return new ModalBuilder()
    .setCustomId(`gwd:${d.id}:look`)
    .setTitle('Description & look')
    .addLabelComponents(
      label('Description', 'Shown at the top of the giveaway.').setTextInputComponent(
        text('description', TextInputStyle.Paragraph, d.description, { max: 1000, placeholder: DEFAULTS[d.type].desc })
      ),
      label('Color', 'Hex like #FF5733, or a name: green, red, blue, gold, purple…').setTextInputComponent(
        text('color', TextInputStyle.Short, d.color, { max: 20, placeholder: DEFAULTS[d.type].color })
      ),
      label('Button emoji', d.type === 'drop' ? 'Drops always use ⚡ Claim.' : 'Emoji on the Enter button.').setTextInputComponent(
        text('emoji', TextInputStyle.Short, d.emoji, { max: 64, placeholder: '🎉' })
      )
    );
}

function requirementsModal(d) {
  return new ModalBuilder()
    .setCustomId(`gwd:${d.id}:req`)
    .setTitle('Entry requirements')
    .addLabelComponents(
      label('Required role', 'Leave empty for none.').setRoleSelectMenuComponent(
        new RoleSelectMenuBuilder().setCustomId('role').setRequired(false).setMinValues(0).setMaxValues(1).setDefaultRoles(d.reqRoleId ? [d.reqRoleId] : [])
      ),
      label('Minimum days in the server', 'Leave empty for none.').setTextInputComponent(text('days', TextInputStyle.Short, d.minDays, { max: 4, placeholder: 'e.g. 7' })),
      label('Minimum XP level', 'Leave empty for none.').setTextInputComponent(text('level', TextInputStyle.Short, d.minLevel, { max: 4, placeholder: 'e.g. 5' }))
    );
}

function pingModal(d) {
  return new ModalBuilder()
    .setCustomId(`gwd:${d.id}:ping`)
    .setTitle('Ping when it starts')
    .addLabelComponents(
      label('Ping').setStringSelectMenuComponent(
        new StringSelectMenuBuilder()
          .setCustomId('ping')
          .addOptions(
            new StringSelectMenuOptionBuilder().setLabel('No @everyone / @here').setValue('none').setDefault(!d.ping),
            new StringSelectMenuOptionBuilder().setLabel('@everyone').setValue('everyone').setDefault(d.ping === 'everyone'),
            new StringSelectMenuOptionBuilder().setLabel('@here').setValue('here').setDefault(d.ping === 'here')
          )
      ),
      label('Also ping a role', 'Optional.').setRoleSelectMenuComponent(
        new RoleSelectMenuBuilder().setCustomId('role').setRequired(false).setMinValues(0).setMaxValues(1).setDefaultRoles(d.pingRoleId ? [d.pingRoleId] : [])
      )
    );
}

const MODALS = { basics: basicsModal, look: lookModal, req: requirementsModal, ping: pingModal };

function pingText(d) {
  return [d.ping ? `@${d.ping}` : null, d.pingRoleId ? `<@&${d.pingRoleId}>` : null].filter(Boolean).join(' ') || null;
}

function draftToGiveaway(d) {
  const ms = parseDuration(d.duration) || 0;
  return {
    prize: d.prize || 'Your prize',
    winnerCount: Number(d.winners) || 1,
    endTimestamp: Date.now() + ms,
    colorHex: giveaways.resolveColor(d.color || DEFAULTS[d.type].color),
    emoji: d.type === 'drop' ? '⚡' : d.emoji || '🎉',
    customDesc: d.description || DEFAULTS[d.type].desc,
    hostId: d.userId,
    entries: [],
    type: d.type,
    requirements: { roleId: d.reqRoleId, minDaysInServer: d.minDays, minLevel: d.minLevel }
  };
}

// Problems that stop it from starting (shown in the panel so they're fixed before pressing Start).
function problems(d, guild) {
  const out = [];
  if (!d.prize) out.push('Add a prize (✏️ Basics).');
  const ms = parseDuration(d.duration);
  if (!ms || ms > MAX_GIVEAWAY_MS) out.push('Duration must look like 30m, 2h or 1d12h (max 365d).');
  const w = Number(d.winners);
  if (!Number.isInteger(w) || w < 1 || w > 100) out.push('Winners must be a whole number from 1 to 100.');
  const channel = guild.channels.cache.get(d.channelId);
  const me = guild.members.me;
  if (!channel) out.push('Pick a channel (✏️ Basics).');
  else if (!channel.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
    out.push(`LoofaryBot can't post embeds in ${channel}.`);
  }
  return out;
}

function panel(d, guild, note = '') {
  const g = draftToGiveaway(d);
  const ms = parseDuration(d.duration);
  const req = giveaways.describeRequirements(g.requirements).replace(/^\n\n\*\*Requirements:\*\*\n/, '') || 'None — anyone can enter';
  const issues = problems(d, guild);
  const summary = new EmbedBuilder()
    .setColor(issues.length ? '#FEE75C' : '#57F287')
    .setTitle(`${d.type === 'drop' ? '⚡ Drop' : '🎁 Giveaway'} setup`)
    .setDescription(
      [
        `**Post in:** ${d.channelId ? `<#${d.channelId}>` : '—'}`,
        `**${d.type === 'drop' ? 'Claimable for' : 'Runs for'}:** ${ms ? formatDuration(ms) : `\`${d.duration || '—'}\``}`,
        `**${d.type === 'drop' ? 'Prizes' : 'Winners'}:** ${d.winners}`,
        `**Ping:** ${pingText(d) || 'none'}`,
        `**Requirements:**\n${req}`,
        issues.length ? `\n⚠️ ${issues.join('\n⚠️ ')}` : '\n✅ Ready — press **Start** to post it.',
        note ? `\n${note}` : ''
      ].join('\n')
    )
    .setFooter({ text: 'Preview below · setup expires after 30 minutes of inactivity' });

  const btn = (action, labelText, style = ButtonStyle.Secondary) => new ButtonBuilder().setCustomId(`gwd:${d.id}:${action}`).setLabel(labelText).setStyle(style);
  return {
    content: '',
    embeds: [summary, giveaways.buildGiveawayEmbed(g)],
    components: [
      new ActionRowBuilder().addComponents(btn('basics', '✏️ Basics'), btn('look', '🎨 Description & look'), btn('req', '🔒 Requirements'), btn('ping', '📣 Ping')),
      new ActionRowBuilder().addComponents(
        btn('start', d.type === 'drop' ? '⚡ Start drop' : '🚀 Start giveaway', ButtonStyle.Success).setDisabled(issues.length > 0),
        btn('cancel', 'Cancel', ButtonStyle.Danger)
      )
    ],
    allowedMentions: { parse: [] }
  };
}

const expired = (interaction) =>
  interaction.reply({ content: '⌛ This giveaway setup expired (or the bot restarted). Run `/loof create` again.', ephemeral: true });

/** Entry point from /loof create. */
async function openCreateForm(interaction, options) {
  const d = newDraft(interaction, options);
  return interaction.showModal(basicsModal(d));
}

async function handleDraftButton(interaction, client) {
  const [, id, action] = interaction.customId.split(':');
  const d = getDraft(interaction, id);
  if (!d) return expired(interaction);

  if (MODALS[action]) return interaction.showModal(MODALS[action](d));

  if (action === 'cancel') {
    drafts.delete(id);
    return interaction.update({ content: '🗑️ Giveaway setup cancelled.', embeds: [], components: [] });
  }

  if (action === 'start') {
    const issues = problems(d, interaction.guild);
    if (issues.length) return interaction.update(panel(d, interaction.guild));
    await interaction.deferUpdate();
    const g = draftToGiveaway(d);
    try {
      const { message } = await giveaways.postGiveaway(client, {
        channel: interaction.guild.channels.cache.get(d.channelId),
        hostId: d.userId,
        durationMs: parseDuration(d.duration),
        winnerCount: g.winnerCount,
        prize: d.prize,
        ping: pingText(d),
        colorHex: g.colorHex,
        emoji: g.emoji,
        customDesc: g.customDesc,
        type: d.type,
        requirements: g.requirements
      });
      drafts.delete(id);
      return interaction.editReply({
        content: `✅ ${d.type === 'drop' ? 'Drop' : 'Giveaway'} started in <#${d.channelId}> — [jump to it](${message.url}).\nManage it with \`/loof edit\`, \`/loof end\`… or the dashboard.`,
        embeds: [],
        components: []
      });
    } catch (err) {
      return interaction.editReply(panel(d, interaction.guild, `❌ Discord rejected it: ${err.message}. Check the button emoji and LoofaryBot's permissions.`));
    }
  }
}

function readText(fields, id) {
  try {
    return fields.getTextInputValue(id).trim();
  } catch (e) {
    return '';
  }
}

async function handleDraftModal(interaction) {
  const [, id, step] = interaction.customId.split(':');
  const d = getDraft(interaction, id);
  if (!d) return expired(interaction);
  const f = interaction.fields;

  if (step === 'basics') {
    d.type = f.getStringSelectValues('type')[0] === 'drop' ? 'drop' : 'timed';
    d.channelId = f.getSelectedChannels('channel')?.first()?.id || d.channelId;
    d.prize = readText(f, 'prize').slice(0, 256);
    d.duration = readText(f, 'duration') || DEFAULTS[d.type].duration;
    d.winners = readText(f, 'winners') || '1';
  } else if (step === 'look') {
    d.description = readText(f, 'description').slice(0, 1000);
    d.color = readText(f, 'color');
    d.emoji = readText(f, 'emoji') || '🎉';
  } else if (step === 'req') {
    d.reqRoleId = f.getSelectedRoles('role')?.first()?.id || null;
    const days = parseInt(readText(f, 'days'), 10);
    const level = parseInt(readText(f, 'level'), 10);
    d.minDays = days > 0 ? Math.min(days, 3650) : null;
    d.minLevel = level > 0 ? Math.min(level, 1000) : null;
  } else if (step === 'ping') {
    const choice = f.getStringSelectValues('ping')[0];
    d.ping = choice === 'everyone' || choice === 'here' ? choice : '';
    d.pingRoleId = f.getSelectedRoles('role')?.first()?.id || null;
  }

  // The first submit (straight from /loof create) opens the panel; later ones update it in place.
  const view = panel(d, interaction.guild);
  if (interaction.isFromMessage()) return interaction.update(view);
  return interaction.reply({ ...view, ephemeral: true });
}

module.exports = { openCreateForm, handleDraftButton, handleDraftModal, drafts, _test: { panel, problems, newDraft, draftToGiveaway } };
