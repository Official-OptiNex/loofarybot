// Support tickets: a panel with an "Open a ticket" button creates a private channel for the member and
// the support team, with Close / Claim / Ping buttons inside. Closing DMs the member, saves a
// transcript (dashboard + optional log channel) and deletes the channel after a short countdown.
// Everything here is shared by /ticket, the buttons and the dashboard's Tickets page.
const {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  LabelBuilder,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle
} = require('discord.js');
const TicketConfig = require('../../../database/models/TicketConfig');
const Ticket = require('../../../database/models/Ticket');

const MAX_TRANSCRIPT = 1000; // messages kept per ticket
const NAME_FORMATS = ['ticket-{number}', 'ticket-{username}', '{username}-{number}'];
const BUTTON_STYLES = { Primary: ButtonStyle.Primary, Success: ButtonStyle.Success, Secondary: ButtonStyle.Secondary, Danger: ButtonStyle.Danger };
const HEX = /^#[0-9a-f]{6}$/i;

// ---------------------------------------------------------------- Settings

const DEFAULTS = new TicketConfig({ guildId: 'defaults' }).toObject();

// Plain settings object with every default filled in (older / lean documents may miss fields).
function settingsOf(doc) {
  const d = doc || {};
  return {
    enabled: d.enabled !== false,
    panelChannelId: d.panelChannelId || null,
    panelMessageId: d.panelMessageId || null,
    categoryId: d.categoryId || null,
    supportRoleIds: Array.isArray(d.supportRoleIds) ? d.supportRoleIds : [],
    nameFormat: d.nameFormat || DEFAULTS.nameFormat,
    maxOpenPerUser: d.maxOpenPerUser ?? DEFAULTS.maxOpenPerUser,
    askReason: !!d.askReason,
    pingSupport: d.pingSupport !== false,
    welcomeMessage: d.welcomeMessage ?? DEFAULTS.welcomeMessage,
    panel: { ...DEFAULTS.panel, ...(d.panel || {}) },
    button: { ...DEFAULTS.button, ...(d.button || {}) },
    dmOnClose: d.dmOnClose !== false,
    closeDelaySeconds: d.closeDelaySeconds ?? DEFAULTS.closeDelaySeconds,
    logChannelId: d.logChannelId || null,
    saveTranscripts: d.saveTranscripts !== false
  };
}

async function getSettings(guildId) {
  return settingsOf(await TicketConfig.findOne({ guildId }).lean());
}

async function getConfigDoc(guildId) {
  return (await TicketConfig.findOne({ guildId })) || new TicketConfig({ guildId });
}

/**
 * Checks and normalises a settings update (from /ticket setup or the dashboard). Only keys present in
 * `input` are changed. Returns { patch } or { error }.
 */
function cleanSettings(guild, input) {
  const patch = {};
  const has = (k) => input[k] !== undefined;
  const text = (v, max) => String(v ?? '').trim().slice(0, max);
  const url = (v, what) => {
    const s = text(v, 500);
    if (!s) return null;
    if (!/^https?:\/\/\S+$/i.test(s)) throw new Error(`${what} must be an http(s) image link.`);
    return s;
  };
  try {
    if (has('enabled')) patch.enabled = !!input.enabled;
    if (has('categoryId')) {
      const id = input.categoryId ? String(input.categoryId) : null;
      if (id && guild.channels.cache.get(id)?.type !== ChannelType.GuildCategory) throw new Error('Pick a category for new tickets.');
      patch.categoryId = id;
    }
    if (has('supportRoleIds')) {
      const ids = [...new Set((Array.isArray(input.supportRoleIds) ? input.supportRoleIds : []).map(String))];
      const missing = ids.filter((id) => !guild.roles.cache.has(id));
      if (missing.length) throw new Error("One of the support roles doesn't exist any more.");
      if (ids.length > 10) throw new Error('Pick at most 10 support roles.');
      patch.supportRoleIds = ids;
    }
    if (has('nameFormat')) {
      const f = text(input.nameFormat, 60).toLowerCase() || DEFAULTS.nameFormat;
      if (!/\{number\}|\{username\}/.test(f)) throw new Error('The channel name needs {number} or {username} in it.');
      patch.nameFormat = f;
    }
    if (has('maxOpenPerUser')) {
      const n = Number.parseInt(input.maxOpenPerUser, 10);
      if (!Number.isFinite(n) || n < 0 || n > 10) throw new Error('Open tickets per member must be 0–10 (0 = no limit).');
      patch.maxOpenPerUser = n;
    }
    for (const k of ['askReason', 'pingSupport', 'dmOnClose', 'saveTranscripts']) if (has(k)) patch[k] = !!input[k];
    if (has('welcomeMessage')) patch.welcomeMessage = text(input.welcomeMessage, 1500);
    if (has('closeDelaySeconds')) {
      const n = Number.parseInt(input.closeDelaySeconds, 10);
      if (!Number.isFinite(n) || n < 0 || n > 60) throw new Error('The close countdown must be 0–60 seconds.');
      patch.closeDelaySeconds = n;
    }
    if (has('logChannelId')) {
      const id = input.logChannelId ? String(input.logChannelId) : null;
      const ch = id ? guild.channels.cache.get(id) : null;
      if (id && (!ch || !ch.isTextBased() || ch.isThread())) throw new Error('The transcript log channel must be a text channel.');
      patch.logChannelId = id;
    }
    if (input.panel) {
      const p = input.panel;
      if (p.title !== undefined) patch['panel.title'] = text(p.title, 256) || DEFAULTS.panel.title;
      if (p.description !== undefined) patch['panel.description'] = text(p.description, 4000);
      if (p.color !== undefined) {
        const c = text(p.color, 7);
        if (!HEX.test(c)) throw new Error('The panel color must be a hex color like #5865F2.');
        patch['panel.color'] = c;
      }
      if (p.thumbnailUrl !== undefined) patch['panel.thumbnailUrl'] = url(p.thumbnailUrl, 'The thumbnail');
      if (p.imageUrl !== undefined) patch['panel.imageUrl'] = url(p.imageUrl, 'The banner image');
      if (p.footer !== undefined) patch['panel.footer'] = text(p.footer, 2048) || null;
    }
    if (input.button) {
      const b = input.button;
      if (b.label !== undefined) patch['button.label'] = text(b.label, 80) || DEFAULTS.button.label;
      if (b.style !== undefined) {
        if (!BUTTON_STYLES[b.style]) throw new Error('Button style must be Primary, Success, Secondary or Danger.');
        patch['button.style'] = b.style;
      }
      if (b.emoji !== undefined) patch['button.emoji'] = text(b.emoji, 64) || null;
    }
  } catch (err) {
    return { error: err.message };
  }
  return { patch };
}

async function saveSettings(guildId, patch) {
  const doc = await TicketConfig.findOneAndUpdate({ guildId }, { $set: patch }, { new: true, upsert: true, setDefaultsOnInsert: true });
  return settingsOf(doc.toObject ? doc.toObject() : doc);
}

// ---------------------------------------------------------------- Permissions

const isAdmin = (member) => !!member?.permissions?.has(PermissionFlagsBits.Administrator);
// Support staff: admins, anyone with Manage Server, or a configured support role.
function isStaff(member, s) {
  if (!member) return false;
  if (isAdmin(member) || member.permissions?.has(PermissionFlagsBits.ManageGuild)) return true;
  return s.supportRoleIds.some((id) => member.roles?.cache?.has(id));
}

// What LoofaryBot needs server-wide to create ticket channels with private permissions.
function missingBotPerms(guild, s) {
  const me = guild.members.me;
  if (!me) return ['Manage Channels', 'Manage Roles'];
  const where = s.categoryId ? guild.channels.cache.get(s.categoryId) : null;
  const perms = where ? where.permissionsFor(me) : me.permissions;
  const need = [
    [PermissionFlagsBits.ManageChannels, 'Manage Channels'],
    [PermissionFlagsBits.ManageRoles, 'Manage Roles'],
    [PermissionFlagsBits.ViewChannel, 'View Channel'],
    [PermissionFlagsBits.SendMessages, 'Send Messages'],
    [PermissionFlagsBits.EmbedLinks, 'Embed Links']
  ];
  return need.filter(([flag]) => !perms?.has(flag)).map(([, name]) => name);
}

// ---------------------------------------------------------------- Panel

function buildPanel(s) {
  const embed = new EmbedBuilder().setTitle(s.panel.title).setColor(HEX.test(s.panel.color) ? s.panel.color : '#5865F2');
  if (s.panel.description) embed.setDescription(s.panel.description);
  if (s.panel.thumbnailUrl) embed.setThumbnail(s.panel.thumbnailUrl);
  if (s.panel.imageUrl) embed.setImage(s.panel.imageUrl);
  if (s.panel.footer) embed.setFooter({ text: s.panel.footer });
  const button = new ButtonBuilder().setCustomId('tk:open').setLabel(s.button.label).setStyle(BUTTON_STYLES[s.button.style] || ButtonStyle.Primary);
  if (s.button.emoji) button.setEmoji(s.button.emoji);
  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(button)] };
}

/**
 * Posts the panel in `channelId` (or the saved panel channel). If the panel is already in that channel
 * it's edited in place; if it moved, the old message is deleted. Returns { message } or { error }.
 */
async function publishPanel(guild, channelId = null) {
  const doc = await getConfigDoc(guild.id);
  const s = settingsOf(doc.toObject());
  const targetId = channelId || s.panelChannelId;
  const channel = targetId ? guild.channels.cache.get(targetId) : null;
  if (!channel || !channel.isTextBased() || channel.isThread()) return { error: 'Pick a text channel for the ticket panel.' };
  const perms = channel.permissionsFor(guild.members.me);
  if (!perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
    return { error: `LoofaryBot can't post in #${channel.name} — it needs View Channel, Send Messages and Embed Links there.` };
  }
  const payload = buildPanel(s);
  let message = null;
  if (s.panelMessageId && s.panelChannelId === channel.id) {
    const existing = await channel.messages.fetch(s.panelMessageId).catch(() => null);
    if (existing) message = await existing.edit(payload).catch(() => null);
  }
  try {
    if (!message) message = await channel.send(payload);
  } catch (err) {
    return { error: `Discord rejected the panel — check the button emoji and image links. (${err.message})` };
  }
  if (s.panelMessageId && s.panelMessageId !== message.id) {
    const oldChannel = guild.channels.cache.get(s.panelChannelId);
    await oldChannel?.messages?.delete(s.panelMessageId).catch(() => null);
  }
  doc.panelChannelId = channel.id;
  doc.panelMessageId = message.id;
  await doc.save();
  return { message };
}

// ---------------------------------------------------------------- Opening

const pendingOpens = new Set(); // guild:user — stops a double click from opening two tickets

function channelName(format, number, user) {
  const username = (user.username || 'user').toLowerCase().replace(/[^a-z0-9_-]+/g, '').slice(0, 20) || 'user';
  return format
    .replace(/\{number\}/g, String(number).padStart(4, '0'))
    .replace(/\{username\}/g, username)
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 100) || `ticket-${number}`;
}

// Closes records whose channel was deleted by hand, so they don't count toward the open limit.
async function openTicketsOf(guild, userId) {
  const open = await Ticket.find({ guildId: guild.id, openerId: userId, status: 'OPEN' }).lean();
  const live = [];
  for (const t of open) {
    if (guild.channels.cache.has(t.channelId)) live.push(t);
    else await markClosed(t, { reason: 'The ticket channel was deleted.' });
  }
  return live;
}

function ticketButtons(ticket) {
  const claim = ticket.claimedBy
    ? new ButtonBuilder().setCustomId('tk:claim').setLabel(`Claimed by ${String(ticket.claimedByTag || 'staff').slice(0, 60)}`).setEmoji('📌').setStyle(ButtonStyle.Secondary)
    : new ButtonBuilder().setCustomId('tk:claim').setLabel('Claim').setEmoji('📌').setStyle(ButtonStyle.Success);
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('tk:close').setLabel('Close').setEmoji('🔒').setStyle(ButtonStyle.Danger),
    claim,
    new ButtonBuilder().setCustomId('tk:ping').setLabel('Ping user').setEmoji('🔔').setStyle(ButtonStyle.Secondary)
  );
}

function fill(text, { member, guild, number, s }) {
  return String(text || '')
    .replace(/\{user\}/g, `${member}`)
    .replace(/\{username\}/g, member.user?.username || 'member')
    .replace(/\{server\}/g, guild.name)
    .replace(/\{number\}/g, String(number))
    .replace(/\{support\}/g, s.supportRoleIds.map((id) => `<@&${id}>`).join(' ') || 'the support team');
}

/**
 * Opens a ticket for `member`. Returns { channel, ticket } or { error } (a message for the member).
 */
async function openTicket(member, { reason = null } = {}) {
  const guild = member.guild;
  const s = await getSettings(guild.id);
  if (!s.enabled) return { error: 'Tickets are turned off on this server right now.' };
  const lockKey = `${guild.id}:${member.id}`;
  if (pendingOpens.has(lockKey)) return { error: 'Your ticket is already being created — one moment.' };
  pendingOpens.add(lockKey);
  try {
    const open = await openTicketsOf(guild, member.id);
    if (s.maxOpenPerUser > 0 && open.length >= s.maxOpenPerUser) {
      const list = open.map((t) => `<#${t.channelId}>`).join(', ');
      return { error: `You already have ${open.length === 1 ? 'an open ticket' : `${open.length} open tickets`}: ${list}. Close it before opening another.` };
    }
    const missing = missingBotPerms(guild, s);
    if (missing.length) return { error: `LoofaryBot can't create ticket channels — it needs **${missing.join(', ')}**. Ask an admin to fix its role.` };

    const counter = await TicketConfig.findOneAndUpdate({ guildId: guild.id }, { $inc: { counter: 1 } }, { new: true, upsert: true, setDefaultsOnInsert: true });
    const number = counter.counter;
    const category = s.categoryId && guild.channels.cache.get(s.categoryId)?.type === ChannelType.GuildCategory ? s.categoryId : null;
    const access = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.EmbedLinks];
    const overwrites = [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      {
        id: guild.members.me.id,
        allow: [...access, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles, PermissionFlagsBits.ManageMessages]
      },
      { id: member.id, allow: access },
      ...s.supportRoleIds.filter((id) => guild.roles.cache.has(id)).map((id) => ({ id, allow: access }))
    ];

    let channel;
    try {
      channel = await guild.channels.create({
        name: channelName(s.nameFormat, number, member.user),
        type: ChannelType.GuildText,
        parent: category,
        topic: `Ticket #${number} · opened by ${member.user.tag}${reason ? ` · ${reason.slice(0, 200)}` : ''}`,
        permissionOverwrites: overwrites,
        reason: `Ticket #${number} opened by ${member.user.tag}`
      });
    } catch (err) {
      const full = /maximum number of channels/i.test(err.message) ? ' The ticket category is full (50 channels) — pick another one.' : '';
      return { error: `Discord refused to create the ticket channel.${full} (${err.message})` };
    }

    const ticket = await Ticket.create({
      guildId: guild.id,
      channelId: channel.id,
      number,
      openerId: member.id,
      openerTag: member.user.tag,
      reason: reason || null
    });

    const embed = new EmbedBuilder()
      .setColor(HEX.test(s.panel.color) ? s.panel.color : '#5865F2')
      .setTitle(`🎫 Ticket #${number}`)
      .setDescription(fill(s.welcomeMessage, { member, guild, number, s }) || `Hi ${member}!`)
      .addFields({ name: 'Opened by', value: `${member} (${member.user.tag})`, inline: true })
      .setFooter({ text: 'Staff: 📌 claim it · 🔔 ping the member · 🔒 close when done' })
      .setTimestamp();
    if (reason) embed.addFields({ name: 'Needs help with', value: reason.slice(0, 1024) });
    const pings = [`${member}`, ...(s.pingSupport ? s.supportRoleIds.map((id) => `<@&${id}>`) : [])].join(' ');
    await channel
      .send({ content: pings, embeds: [embed], components: [ticketButtons(ticket)], allowedMentions: { users: [member.id], roles: s.pingSupport ? s.supportRoleIds : [] } })
      .then((m) => m.pin().catch(() => null))
      .catch(() => null);
    return { channel, ticket };
  } finally {
    pendingOpens.delete(lockKey);
  }
}

// ---------------------------------------------------------------- Claim / ping / add / remove / rename

async function ticketForChannel(channelId, status = 'OPEN') {
  return Ticket.findOne({ channelId, ...(status ? { status } : {}) });
}

// Claims the ticket for `staff`, or unclaims it if they already hold it. Returns { ticket, claimed } or { error }.
async function toggleClaim(ticket, staff, { force = false } = {}) {
  if (ticket.claimedBy && ticket.claimedBy !== staff.id && !force) {
    return { error: `This ticket is already claimed by <@${ticket.claimedBy}>.` };
  }
  const claiming = ticket.claimedBy !== staff.id;
  ticket.claimedBy = claiming ? staff.id : null;
  ticket.claimedByTag = claiming ? staff.tag || staff.username : null;
  await ticket.save();
  return { ticket, claimed: claiming };
}

// Refreshes the Claim button on the ticket's first message after a claim change.
async function refreshButtons(channel, ticket) {
  const pinned = await channel.messages.fetchPinned().catch(() => null);
  const msg = pinned?.find((m) => m.author.id === channel.client.user.id && m.components?.length);
  if (msg) await msg.edit({ components: [ticketButtons(ticket)] }).catch(() => null);
}

async function setMemberAccess(channel, ticket, userId, allow) {
  const access = { ViewChannel: allow, SendMessages: allow, AttachFiles: allow, ReadMessageHistory: allow, EmbedLinks: allow };
  if (allow) await channel.permissionOverwrites.edit(userId, access, { reason: `Added to ticket #${ticket.number}` });
  else await channel.permissionOverwrites.delete(userId, `Removed from ticket #${ticket.number}`);
  const set = new Set(ticket.addedUserIds || []);
  allow ? set.add(userId) : set.delete(userId);
  ticket.addedUserIds = [...set];
  await ticket.save();
}

// ---------------------------------------------------------------- Closing

async function collectTranscript(channel) {
  const lines = [];
  let before;
  while (lines.length < MAX_TRANSCRIPT) {
    const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) }).catch(() => null);
    if (!batch || !batch.size) break;
    for (const m of batch.values()) {
      const extras = m.embeds.map((e) => `[embed${e.title ? `: ${e.title}` : ''}]`).join(' ');
      lines.push({
        authorId: m.author.id,
        authorTag: m.author.tag,
        bot: m.author.bot,
        content: [m.content, extras].filter(Boolean).join(' ').slice(0, 2000),
        attachments: [...m.attachments.values()].map((a) => a.url),
        at: m.createdAt
      });
    }
    before = batch.last().id;
    if (batch.size < 100) break;
  }
  return lines.reverse().slice(-MAX_TRANSCRIPT);
}

function transcriptText(ticket, lines, guildName) {
  const head = [
    `Ticket #${ticket.number} — ${guildName}`,
    `Opened by ${ticket.openerTag || ticket.openerId} on ${new Date(ticket.createdAt).toISOString()}`,
    ticket.reason ? `Reason: ${ticket.reason}` : null,
    `Closed by ${ticket.closedByTag || 'unknown'} on ${new Date(ticket.closedAt || Date.now()).toISOString()}${ticket.closeReason ? ` — ${ticket.closeReason}` : ''}`,
    ''.padEnd(60, '-')
  ].filter((l) => l !== null);
  const body = lines.map(
    (l) => `[${new Date(l.at).toISOString().replace('T', ' ').slice(0, 19)}] ${l.authorTag}${l.bot ? ' [BOT]' : ''}: ${l.content || ''}${l.attachments.length ? ` ${l.attachments.join(' ')}` : ''}`
  );
  return [...head, ...body].join('\n');
}

// Flips a ticket to CLOSED exactly once (a second close finds nothing and does nothing).
async function markClosed(ticket, { by = null, byTag = null, reason = null, transcript = null } = {}) {
  const set = { status: 'CLOSED', closedAt: new Date(), closedBy: by, closedByTag: byTag, closeReason: reason ? String(reason).slice(0, 500) : null };
  if (transcript) Object.assign(set, { transcript, messageCount: transcript.length });
  return Ticket.findOneAndUpdate({ _id: ticket._id, status: 'OPEN' }, { $set: set }, { new: true });
}

const closingNow = new Set(); // ticket ids being closed right now

/**
 * Closes a ticket: saves the transcript, DMs the member, logs it and deletes the channel after the
 * countdown. `closer` is a User (or { id, tag } from the dashboard). Returns { ticket } or { error }.
 */
async function closeTicket(guild, ticket, closer, reason = null) {
  const key = String(ticket._id);
  if (closingNow.has(key)) return { error: 'This ticket is already closing.' };
  closingNow.add(key);
  try {
    const s = await getSettings(guild.id);
    const channel = guild.channels.cache.get(ticket.channelId);
    const lines = channel && s.saveTranscripts ? await collectTranscript(channel) : null;
    const closerTag = closer.tag || closer.username || 'Staff';
    const closed = await markClosed(ticket, { by: closer.id, byTag: closerTag, reason, transcript: lines });
    if (!closed) return { error: 'This ticket is already closed.' };

    const duration = Math.max(0, closed.closedAt - new Date(closed.createdAt));
    const summary = new EmbedBuilder()
      .setColor('#ED4245')
      .setTitle(`🔒 Ticket #${closed.number} closed`)
      .addFields(
        { name: 'Opened by', value: `<@${closed.openerId}>`, inline: true },
        { name: 'Closed by', value: closer.id ? `<@${closer.id}>` : closerTag, inline: true },
        { name: 'Claimed by', value: closed.claimedBy ? `<@${closed.claimedBy}>` : '—', inline: true },
        { name: 'Open for', value: humanDuration(duration), inline: true },
        { name: 'Messages', value: String(lines ? lines.length : '—'), inline: true },
        { name: 'Reason', value: (reason || 'No reason given').slice(0, 1024) }
      )
      .setTimestamp();
    if (closed.reason) summary.addFields({ name: 'Opened for', value: closed.reason.slice(0, 1024) });

    // 1. DM the member.
    let dmSent = false;
    if (s.dmOnClose) {
      const user = await guild.client.users.fetch(closed.openerId).catch(() => null);
      if (user) {
        const dm = new EmbedBuilder()
          .setColor('#5865F2')
          .setTitle('🎫 Your ticket was closed')
          .setDescription(`Your ticket **#${closed.number}** in **${guild.name}** has been closed by **${closerTag}**.\n**Reason:** ${reason || 'No reason given'}`)
          .setTimestamp();
        dmSent = await user.send({ embeds: [dm] }).then(() => true).catch(() => false);
      }
    }

    // 2. Log channel with the transcript file.
    const logChannel = s.logChannelId ? guild.channels.cache.get(s.logChannelId) : null;
    if (logChannel?.isTextBased()) {
      const files = lines ? [new AttachmentBuilder(Buffer.from(transcriptText(closed, lines, guild.name), 'utf8'), { name: `ticket-${closed.number}.txt` })] : [];
      await logChannel.send({ embeds: [summary], files, allowedMentions: { parse: [] } }).catch(() => null);
    }

    // 3. Countdown, then delete the channel.
    if (channel) {
      const delay = Math.max(0, s.closeDelaySeconds) * 1000;
      if (delay) {
        await channel
          .send({
            embeds: [
              new EmbedBuilder()
                .setColor('#ED4245')
                .setDescription(`🔒 Ticket closed by **${closerTag}**${reason ? ` — ${reason}` : ''}.\nThis channel will be deleted <t:${Math.floor((Date.now() + delay) / 1000)}:R>.`)
            ]
          })
          .catch(() => null);
      }
      setTimeout(() => channel.delete(`Ticket #${closed.number} closed by ${closerTag}`).catch(() => null), delay).unref?.();
    }
    return { ticket: closed, dmSent };
  } finally {
    closingNow.delete(key);
  }
}

function humanDuration(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'under a minute';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

// ---------------------------------------------------------------- Buttons & modals

function reasonModal(customId, title, labelText, { required = false, placeholder } = {}) {
  const input = new TextInputBuilder().setCustomId('reason').setStyle(TextInputStyle.Paragraph).setRequired(required).setMaxLength(500);
  if (placeholder) input.setPlaceholder(placeholder);
  return new ModalBuilder().setCustomId(customId).setTitle(title).addLabelComponents(new LabelBuilder().setLabel(labelText).setTextInputComponent(input));
}

async function replyOpened(interaction, result) {
  const content = result.error ? `❌ ${result.error}` : `✅ Your ticket is open: ${result.channel}`;
  return interaction.deferred || interaction.replied ? interaction.editReply({ content }) : interaction.reply({ content, ephemeral: true });
}

async function handleTicketButton(interaction) {
  const action = interaction.customId.split(':')[1];
  const s = await getSettings(interaction.guildId);

  if (action === 'open') {
    if (!s.enabled) return interaction.reply({ content: '❌ Tickets are turned off on this server right now.', ephemeral: true });
    if (s.askReason) {
      return interaction.showModal(reasonModal('tkm:open', 'Open a ticket', 'What do you need help with?', { required: true, placeholder: 'Describe your issue so the right person can help.' }));
    }
    await interaction.deferReply({ ephemeral: true });
    return replyOpened(interaction, await openTicket(interaction.member));
  }

  const ticket = await ticketForChannel(interaction.channelId);
  if (!ticket) return interaction.reply({ content: '❌ This ticket is already closed.', ephemeral: true });
  const staff = isStaff(interaction.member, s);

  if (action === 'close') {
    if (!staff && interaction.user.id !== ticket.openerId) {
      return interaction.reply({ content: '❌ Only the person who opened this ticket or the support team can close it.', ephemeral: true });
    }
    return interaction.showModal(reasonModal(`tkm:close:${ticket.channelId}`, `Close ticket #${ticket.number}?`, 'Reason (optional)', { placeholder: 'e.g. Solved — thanks!' }));
  }

  if (!staff) return interaction.reply({ content: '❌ Only the support team can do that.', ephemeral: true });

  if (action === 'claim') {
    const result = await toggleClaim(ticket, interaction.user);
    if (result.error) return interaction.reply({ content: `❌ ${result.error}`, ephemeral: true });
    await interaction.update({ components: [ticketButtons(result.ticket)] }).catch(() => null);
    return interaction.channel.send({
      content: result.claimed ? `📌 ${interaction.user} claimed this ticket and will be helping you.` : `📌 ${interaction.user} unclaimed this ticket.`,
      allowedMentions: { parse: [] }
    });
  }

  if (action === 'ping') {
    await interaction.reply({ content: '🔔 Pinged.', ephemeral: true });
    return interaction.channel.send({
      content: `🔔 <@${ticket.openerId}>, ${interaction.user} is waiting for your reply in this ticket.`,
      allowedMentions: { users: [ticket.openerId] }
    });
  }
  return interaction.reply({ content: '❌ Unknown ticket button.', ephemeral: true });
}

async function handleTicketModal(interaction) {
  const [, action, channelId] = interaction.customId.split(':');
  const reason = interaction.fields.getTextInputValue('reason')?.trim() || null;
  if (action === 'open') {
    await interaction.deferReply({ ephemeral: true });
    return replyOpened(interaction, await openTicket(interaction.member, { reason }));
  }
  if (action === 'close') {
    const ticket = await ticketForChannel(channelId);
    if (!ticket) return interaction.reply({ content: '❌ This ticket is already closed.', ephemeral: true });
    const s = await getSettings(interaction.guildId);
    if (!isStaff(interaction.member, s) && interaction.user.id !== ticket.openerId) {
      return interaction.reply({ content: '❌ Only the person who opened this ticket or the support team can close it.', ephemeral: true });
    }
    await interaction.deferReply();
    const result = await closeTicket(interaction.guild, ticket, interaction.user, reason);
    return interaction.editReply(result.error ? `❌ ${result.error}` : `🔒 Closing ticket #${ticket.number}…${result.dmSent ? ' The member was sent a DM.' : ''}`).catch(() => null);
  }
  return interaction.reply({ content: '❌ Unknown form.', ephemeral: true });
}

// A ticket channel deleted by hand is marked closed so it doesn't block the member's next ticket.
function registerTicketEvents(client) {
  client.on('channelDelete', async (channel) => {
    if (!channel.guild) return;
    const ticket = await Ticket.findOne({ channelId: channel.id, status: 'OPEN' }).catch(() => null);
    if (ticket) await markClosed(ticket, { reason: 'The ticket channel was deleted.' }).catch(() => null);
  });
}

module.exports = {
  NAME_FORMATS,
  BUTTON_STYLES,
  settingsOf,
  getSettings,
  cleanSettings,
  saveSettings,
  isStaff,
  missingBotPerms,
  buildPanel,
  publishPanel,
  channelName,
  openTicket,
  ticketForChannel,
  toggleClaim,
  refreshButtons,
  setMemberAccess,
  closeTicket,
  markClosed,
  collectTranscript,
  transcriptText,
  humanDuration,
  handleTicketButton,
  handleTicketModal,
  registerTicketEvents
};
