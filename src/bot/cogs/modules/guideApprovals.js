// Guide change approvals: when a guide editor (not an admin) adds, deletes — or, if switched on, edits —
// a guide, the change waits as a request until an admin approves it. Requests are posted with Approve /
// Reject buttons in the approval channel (default: the guide editors' channel) and listed on the
// dashboard's Guides page. Approving applies the change as the editor; the editor gets a DM either way.
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, LabelBuilder, ModalBuilder, PermissionFlagsBits, TextInputBuilder, TextInputStyle } = require('discord.js');
const GuideChange = require('../../../database/models/GuideChange');
const GuildConfig = require('../../../database/models/GuildConfig');
const guides = require('./guides');
const { REDIRECT_URI } = require('../../../config');

const VERB = { create: 'Add', edit: 'Edit', delete: 'Delete' };
const STATUS = {
  PENDING: { color: 0xfee75c, label: '⏳ Waiting for an admin' },
  APPROVED: { color: 0x57f287, label: '✅ Approved' },
  REJECTED: { color: 0xed4245, label: '❌ Rejected' },
  CANCELLED: { color: 0x4e5058, label: '↩️ Cancelled' }
};

const settingsOf = async (guild) => guides.guidesSettings(await GuildConfig.findOne({ guildId: guild.id }, { guides: 1 }).lean());
const isAdminMember = (member) => !!(member?.permissions?.has?.(PermissionFlagsBits.ManageGuild) || member?.permissions?.has?.(PermissionFlagsBits.Administrator));
const dashLink = (guildId, id) => {
  try {
    return `${new URL(REDIRECT_URI).origin}/dashboard/${guildId}/guides?change=${id}`;
  } catch {
    return null;
  }
};

/** True when this action by a non-admin editor must wait for an admin. */
const needsApproval = (settings, type, isAdmin) => !isAdmin && !!settings.approval?.[type];

/** A short preview of a guide body for the approval message. */
function summary(payload) {
  if (!payload) return '';
  const e = (payload.body?.embeds || [])[0] || {};
  const text = [e.title, e.description || payload.body?.content].filter(Boolean).join('\n');
  const extra = (payload.messages || []).length ? `\n*+${payload.messages.length} more message${payload.messages.length === 1 ? '' : 's'}*` : '';
  return (text.length > 700 ? `${text.slice(0, 700)}…` : text) + extra;
}

function changeEmbed(c) {
  const s = STATUS[c.status] || STATUS.PENDING;
  const embed = new EmbedBuilder()
    .setColor(s.color)
    .setTitle(`📖 ${VERB[c.type]} guide: ${c.title || c.slug}`.slice(0, 256))
    .setDescription(
      `**Requested by:** <@${c.requestedBy}>\n` +
        (c.type === 'delete' ? '**Deletes the guide and its forum post.**' : `**Tags:** ${(c.payload?.tags || []).join(', ') || '—'}\n\n${summary(c.payload) || '*(empty)*'}`)
    )
    .setTimestamp(new Date(c.createdAt || Date.now()));
  const by = c.status !== 'PENDING' && c.status !== 'CANCELLED' ? ` by ${c.decidedByTag || 'an admin'}${c.note ? ` — ${c.note}` : ''}` : '';
  embed.setFooter({ text: `${s.label}${by}${c.error ? ` · ⚠️ ${c.error}` : ''}`.slice(0, 2048) });
  return embed;
}

function changeButtons(c) {
  const done = c.status !== 'PENDING';
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`gch:ok:${c._id}`).setLabel('Approve').setEmoji('✅').setStyle(ButtonStyle.Success).setDisabled(done),
    new ButtonBuilder().setCustomId(`gch:no:${c._id}`).setLabel('Reject').setEmoji('❌').setStyle(ButtonStyle.Danger).setDisabled(done)
  );
  const link = dashLink(c.guildId, c._id);
  if (link) row.addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(link).setLabel('Preview on dashboard'));
  return row;
}

async function refreshMessage(guild, c) {
  const channel = c.channelId && guild.channels.cache.get(c.channelId);
  const message = channel && (await channel.messages?.fetch(c.messageId).catch(() => null));
  if (message) await message.edit({ embeds: [changeEmbed(c)], components: [changeButtons(c)] }).catch(() => null);
}

/**
 * Files a change request. `type` create (payload), edit (slug + payload) or delete (slug).
 * `by` is { id, tag }. Returns { change } or { error }.
 */
async function requestChange(guild, { type, slug = null, payload = null }, by, settings = null) {
  settings = settings || (await settingsOf(guild));
  let title = String(payload?.title || '').trim().slice(0, 100);
  if (type === 'create' && !title) return { error: 'A guide needs a title.' };
  if (type !== 'create') {
    const g = await guides.getGuide(guild.id, slug);
    if (!g) return { error: 'No guide by that name.' };
    slug = g.slug;
    title = title || g.title;
    if (await GuideChange.findOne({ guildId: guild.id, slug, type, status: 'PENDING' }).lean()) {
      return { error: `There's already a request to ${type} “${g.title}” waiting for an admin.` };
    }
  }
  const doc = await GuideChange.create({ guildId: guild.id, type, slug, title, payload, requestedBy: by.id, requestedByTag: by.tag || null });
  const change = doc.toObject ? doc.toObject() : doc;
  const channel = guild.channels.cache.get(settings.approvalChannelId || settings.editorChannelId || '');
  if (channel?.isTextBased?.()) {
    const message = await channel.send({ embeds: [changeEmbed(change)], components: [changeButtons(change)], allowedMentions: { parse: [] } }).catch(() => null);
    if (message) {
      await GuideChange.updateOne({ _id: change._id }, { $set: { channelId: channel.id, messageId: message.id } });
      Object.assign(change, { channelId: channel.id, messageId: message.id });
    }
  }
  return { change };
}

/** Approves (applies) or rejects a pending request. `by` is { id, tag }. Returns { change } or { error }. */
async function decideChange(guild, id, { approve, by, note = null }, settings = null) {
  const c = await GuideChange.findOne({ _id: id, guildId: guild.id }).catch(() => null);
  if (!c) return { error: 'That request no longer exists.' };
  if (c.status !== 'PENDING') return { error: `That request was already ${c.status.toLowerCase()}.` };
  settings = settings || (await settingsOf(guild));
  if (approve) {
    const p = c.payload || {};
    let res;
    if (c.type === 'create') res = await guides.createGuide(guild, { title: p.title, tags: p.tags || [], body: p.body, messages: p.messages || [], inIndex: !!p.inIndex, authorId: c.requestedBy, createdBy: c.requestedBy }, settings);
    else if (c.type === 'edit') res = await guides.editGuide(guild, c.slug, { title: p.title, tags: p.tags, body: p.body, messages: p.messages, inIndex: p.inIndex }, c.requestedBy, settings);
    else res = await guides.deleteGuide(guild, c.slug, settings);
    if (res.error) {
      c.error = res.error;
      await c.save();
      await refreshMessage(guild, c);
      return { error: `Couldn't apply it: ${res.error}` };
    }
    if (res.guide?.slug) c.slug = res.guide.slug;
  }
  c.status = approve ? 'APPROVED' : 'REJECTED';
  c.decidedBy = by?.id || null;
  c.decidedByTag = by?.tag || null;
  c.decidedAt = new Date();
  c.note = note ? String(note).slice(0, 500) : null;
  c.error = null;
  await c.save();
  await refreshMessage(guild, c);
  // Let the editor know.
  const user = await guild.client?.users?.fetch(c.requestedBy).catch(() => null);
  const what = `your request to ${c.type} the guide **${c.title || c.slug}** in **${guild.name}**`;
  await user?.send({ content: `${approve ? '✅ An admin approved' : '❌ An admin rejected'} ${what}.${c.note ? `\n**Note:** ${c.note}` : ''}`.slice(0, 2000), allowedMentions: { parse: [] } }).catch(() => null);
  return { change: c.toObject() };
}

/** The requester (or an admin) withdraws a pending request. */
async function cancelChange(guild, id, userId, isAdmin = false) {
  const c = await GuideChange.findOne({ _id: id, guildId: guild.id }).catch(() => null);
  if (!c) return { error: 'That request no longer exists.' };
  if (c.status !== 'PENDING') return { error: `That request was already ${c.status.toLowerCase()}.` };
  if (c.requestedBy !== userId && !isAdmin) return { error: 'Only the person who asked (or an admin) can cancel it.' };
  c.status = 'CANCELLED';
  await c.save();
  await refreshMessage(guild, c);
  return { change: c.toObject() };
}

async function listChanges(guildId, { status = null, limit = 50 } = {}) {
  const q = { guildId };
  if (status) q.status = status;
  return (await GuideChange.find(q).lean()).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, limit);
}

// ---------------------------------------------------------------- Discord buttons

const tagOf = (u) => u?.tag || u?.username || 'admin';

async function handleChangeButton(interaction) {
  const [, action, id] = interaction.customId.split(':');
  if (!isAdminMember(interaction.member)) return interaction.reply({ content: '🔒 Only admins (Manage Server) can approve guide changes.', ephemeral: true });
  if (action === 'ok') {
    await interaction.deferReply({ ephemeral: true });
    const res = await decideChange(interaction.guild, id, { approve: true, by: { id: interaction.user.id, tag: tagOf(interaction.user) } });
    return interaction.editReply({ content: res.error ? `❌ ${res.error}` : '✅ Approved — the change is live.' });
  }
  if (action === 'no') {
    const input = new TextInputBuilder().setCustomId('note').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(500).setPlaceholder('Why? (sent to the editor)');
    return interaction.showModal(new ModalBuilder().setCustomId(`gchm:no:${id}`).setTitle('Reject guide change').addLabelComponents(new LabelBuilder().setLabel('Note (optional)').setTextInputComponent(input)));
  }
  return interaction.reply({ content: '❌ Unknown button.', ephemeral: true });
}

async function handleChangeModal(interaction) {
  const [, , id] = interaction.customId.split(':');
  if (!isAdminMember(interaction.member)) return interaction.reply({ content: '🔒 Only admins can do that.', ephemeral: true });
  await interaction.deferReply({ ephemeral: true });
  const note = interaction.fields.getTextInputValue('note')?.trim() || null;
  const res = await decideChange(interaction.guild, id, { approve: false, by: { id: interaction.user.id, tag: tagOf(interaction.user) }, note });
  return interaction.editReply({ content: res.error ? `❌ ${res.error}` : '❌ Rejected — the editor was told.' });
}

module.exports = { needsApproval, requestChange, decideChange, cancelChange, listChanges, changeEmbed, handleChangeButton, handleChangeModal, isAdminMember };
