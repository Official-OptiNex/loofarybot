// Applications: a customizable panel with an "Apply" button, posted in any channel. Pressing it checks
// the member against the form's requirements (level, account age, time in the server, a role, one
// pending application, a re-apply cooldown) and opens a pop-up form with the form's questions. Answers
// are posted to a review channel (optionally pinging a role) with Approve / Deny buttons; a decision can
// give a role and DMs the applicant. Shared by the buttons and the dashboard's Applications page.
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  LabelBuilder,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle
} = require('discord.js');
const ApplicationForm = require('../../../database/models/ApplicationForm');
const Application = require('../../../database/models/Application');
const UserLevel = require('../../../database/models/UserLevel');

const MAX_QUESTIONS = 5; // Discord's limit for a pop-up form
const MAX_FORMS = 25;
const BUTTON_STYLES = { Primary: ButtonStyle.Primary, Success: ButtonStyle.Success, Secondary: ButtonStyle.Secondary, Danger: ButtonStyle.Danger };
const HEX = /^#[0-9a-f]{6}$/i;
const STATUS = {
  PENDING: { color: 0x5865f2, label: '🕒 Pending review' },
  APPROVED: { color: 0x57f287, label: '✅ Approved' },
  DENIED: { color: 0xed4245, label: '❌ Denied' }
};
const DEFAULT_QUESTION = { label: 'Why do you want to apply?', placeholder: '', style: 'paragraph', required: true, minLength: 0, maxLength: 1000 };

// ---------------------------------------------------------------- Forms

const DEFAULTS = new ApplicationForm({ guildId: 'x', formId: 'x', name: 'x' }).toObject();

/** A plain form object with every default filled in. */
function formOf(doc) {
  const d = doc || {};
  return {
    formId: d.formId,
    name: d.name || 'Application',
    open: d.open !== false,
    panel: { ...DEFAULTS.panel, ...(d.panel || {}) },
    button: { ...DEFAULTS.button, ...(d.button || {}) },
    questions: (Array.isArray(d.questions) && d.questions.length ? d.questions : [DEFAULT_QUESTION]).map((q) => ({ ...DEFAULT_QUESTION, ...q })),
    requirements: { ...DEFAULTS.requirements, ...(d.requirements || {}) },
    limits: { ...DEFAULTS.limits, ...(d.limits || {}) },
    review: { ...DEFAULTS.review, ...(d.review || {}), pingRoleIds: d.review?.pingRoleIds || [], reviewerRoleIds: d.review?.reviewerRoleIds || [] }
  };
}

const listForms = async (guildId) => (await ApplicationForm.find({ guildId }).sort({ createdAt: 1 }).lean()).map(formOf);
async function getForm(guildId, formId) {
  const doc = await ApplicationForm.findOne({ guildId, formId }).lean();
  return doc ? formOf(doc) : null;
}

/** Checks and normalises a form update from the dashboard. Returns { form } (full, clean) or { error }. */
function cleanForm(guild, input, base = {}) {
  const f = formOf(base);
  const text = (v, max) => String(v ?? '').trim().slice(0, max);
  const num = (v, min, max) => Math.max(min, Math.min(max, Math.floor(Number(v) || 0)));
  const role = (id) => (id && guild.roles.cache.has(String(id)) ? String(id) : null);
  const roles = (ids) => [...new Set((Array.isArray(ids) ? ids : []).map(role).filter(Boolean))].slice(0, 10);
  const channel = (id, what) => {
    if (!id) return null;
    const c = guild.channels.cache.get(String(id));
    if (!c || !c.isTextBased?.() || c.isThread?.()) throw new Error(`Pick a text channel for ${what}.`);
    return c.id;
  };
  const url = (v, what) => {
    const s = text(v, 500);
    if (s && !/^https?:\/\/\S+$/i.test(s)) throw new Error(`${what} must be an http(s) image link.`);
    return s;
  };
  try {
    if (input.name !== undefined) f.name = text(input.name, 80) || f.name;
    if (input.open !== undefined) f.open = !!input.open;
    const p = input.panel || {};
    if (p.channelId !== undefined) f.panel.channelId = channel(p.channelId, 'the panel');
    if (p.content !== undefined) f.panel.content = text(p.content, 2000);
    if (p.title !== undefined) f.panel.title = text(p.title, 256);
    if (p.description !== undefined) f.panel.description = text(p.description, 4000);
    if (p.color !== undefined) f.panel.color = HEX.test(String(p.color)) ? String(p.color) : f.panel.color;
    if (p.imageUrl !== undefined) f.panel.imageUrl = url(p.imageUrl, 'The image');
    if (p.thumbnailUrl !== undefined) f.panel.thumbnailUrl = url(p.thumbnailUrl, 'The thumbnail');
    if (p.footer !== undefined) f.panel.footer = text(p.footer, 2048);
    if (!f.panel.title && !f.panel.description) throw new Error('The panel needs a title or a description.');
    const b = input.button || {};
    if (b.label !== undefined) f.button.label = text(b.label, 80) || 'Apply';
    if (b.emoji !== undefined) f.button.emoji = text(b.emoji, 64);
    if (b.style !== undefined) f.button.style = BUTTON_STYLES[b.style] ? b.style : 'Primary';
    if (input.questions !== undefined) {
      const qs = (Array.isArray(input.questions) ? input.questions : []).filter((q) => text(q?.label, 45));
      if (!qs.length) throw new Error('Add at least one question.');
      if (qs.length > MAX_QUESTIONS) throw new Error(`A form can have at most ${MAX_QUESTIONS} questions (Discord's limit).`);
      f.questions = qs.map((q) => {
        const style = q.style === 'short' ? 'short' : 'paragraph';
        // Answers go in embed fields (1,024 characters max), so long answers are capped at 1,000.
        const maxLength = num(q.maxLength || (style === 'short' ? 200 : 1000), 1, style === 'short' ? 400 : 1000);
        return { label: text(q.label, 45), placeholder: text(q.placeholder, 100), style, required: q.required !== false, minLength: Math.min(num(q.minLength, 0, 1000), maxLength), maxLength };
      });
    }
    const r = input.requirements || {};
    if (r.minLevel !== undefined) f.requirements.minLevel = num(r.minLevel, 0, 1000);
    if (r.minAccountAgeDays !== undefined) f.requirements.minAccountAgeDays = num(r.minAccountAgeDays, 0, 3650);
    if (r.minDaysInServer !== undefined) f.requirements.minDaysInServer = num(r.minDaysInServer, 0, 3650);
    if (r.requiredRoleId !== undefined) f.requirements.requiredRoleId = role(r.requiredRoleId);
    const l = input.limits || {};
    if (l.reapplyCooldownHours !== undefined) f.limits.reapplyCooldownHours = num(l.reapplyCooldownHours, 0, 24 * 365);
    if (l.blockIfHasRole !== undefined) f.limits.blockIfHasRole = !!l.blockIfHasRole;
    const v = input.review || {};
    if (v.channelId !== undefined) f.review.channelId = channel(v.channelId, 'reviewing applications');
    if (v.pingRoleIds !== undefined) f.review.pingRoleIds = roles(v.pingRoleIds);
    if (v.reviewerRoleIds !== undefined) f.review.reviewerRoleIds = roles(v.reviewerRoleIds);
    if (v.approveRoleId !== undefined) f.review.approveRoleId = role(v.approveRoleId);
    if (v.dmApplicant !== undefined) f.review.dmApplicant = !!v.dmApplicant;
    if (v.approveMessage !== undefined) f.review.approveMessage = text(v.approveMessage, 1500);
    if (v.denyMessage !== undefined) f.review.denyMessage = text(v.denyMessage, 1500);
    if (!f.review.channelId) throw new Error('Pick a review channel — that’s where applications are sent.');
  } catch (err) {
    return { error: err.message };
  }
  return { form: f };
}

const newFormId = () => Math.random().toString(36).slice(2, 8);

async function createForm(guild, input) {
  if ((await ApplicationForm.find({ guildId: guild.id }).lean()).length >= MAX_FORMS) return { error: `A server can have up to ${MAX_FORMS} application forms.` };
  const clean = cleanForm(guild, input);
  if (clean.error) return clean;
  const formId = newFormId();
  await ApplicationForm.create({ guildId: guild.id, ...clean.form, formId });
  return { form: await getForm(guild.id, formId) };
}

/** Saves a form and, if its panel is posted, updates the panel in place. */
async function saveForm(guild, formId, input) {
  const doc = await ApplicationForm.findOne({ guildId: guild.id, formId }).lean();
  if (!doc) return { error: 'That form no longer exists.' };
  const clean = cleanForm(guild, input, doc);
  if (clean.error) return clean;
  const { formId: _id, ...rest } = clean.form;
  rest.panel = { ...rest.panel, channelId: doc.panel?.channelId || null, messageId: doc.panel?.messageId || null }; // moved only by publishPanel
  await ApplicationForm.updateOne({ guildId: guild.id, formId }, { $set: rest });
  const form = await getForm(guild.id, formId);
  if (form.panel.messageId) {
    const ch = guild.channels.cache.get(form.panel.channelId);
    const msg = await ch?.messages?.fetch(form.panel.messageId).catch(() => null);
    if (msg) await msg.edit(buildPanel(form)).catch(() => null);
  }
  return { form };
}

async function deleteForm(guild, formId) {
  const form = await getForm(guild.id, formId);
  if (!form) return { error: 'That form no longer exists.' };
  if (form.panel.messageId) {
    const ch = guild.channels.cache.get(form.panel.channelId);
    await ch?.messages?.delete(form.panel.messageId).catch(() => null);
  }
  await ApplicationForm.deleteOne({ guildId: guild.id, formId });
  return { ok: true, name: form.name };
}

// ---------------------------------------------------------------- Panel

function buildPanel(form) {
  const p = form.panel;
  const embed = new EmbedBuilder().setColor(HEX.test(p.color) ? p.color : '#5865F2');
  if (p.title) embed.setTitle(p.title);
  if (p.description) embed.setDescription(p.description);
  if (p.thumbnailUrl) embed.setThumbnail(p.thumbnailUrl);
  if (p.imageUrl) embed.setImage(p.imageUrl);
  if (p.footer) embed.setFooter({ text: p.footer });
  const button = new ButtonBuilder()
    .setCustomId(`ap:apply:${form.formId}`)
    .setLabel(form.open ? form.button.label : `${form.button.label} (closed)`.slice(0, 80))
    .setStyle(BUTTON_STYLES[form.button.style] || ButtonStyle.Primary)
    .setDisabled(!form.open);
  if (form.button.emoji) button.setEmoji(form.button.emoji);
  // Role pings in the message text are meant to ping (that's why someone would put them there).
  return { content: p.content || null, embeds: [embed], components: [new ActionRowBuilder().addComponents(button)], allowedMentions: { parse: ['roles'] } };
}

/** Posts (or moves / updates) a form's panel in `channelId`. Returns { message } or { error }. */
async function publishPanel(guild, formId, channelId) {
  const form = await getForm(guild.id, formId);
  if (!form) return { error: 'That form no longer exists.' };
  const channel = guild.channels.cache.get(String(channelId || form.panel.channelId || ''));
  if (!channel || !channel.isTextBased?.() || channel.isThread?.()) return { error: 'Pick a text channel for the panel.' };
  const perms = channel.permissionsFor?.(guild.members.me);
  if (perms && !perms.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
    return { error: `LoofaryBot can't post in #${channel.name} — it needs View Channel, Send Messages and Embed Links there.` };
  }
  const payload = buildPanel(form);
  let message = null;
  if (form.panel.messageId && form.panel.channelId === channel.id) {
    const existing = await channel.messages.fetch(form.panel.messageId).catch(() => null);
    if (existing) message = await existing.edit(payload).catch(() => null);
  }
  try {
    if (!message) message = await channel.send(payload);
  } catch (err) {
    return { error: `Discord rejected the panel — check the button emoji and image links. (${err.message})` };
  }
  if (form.panel.messageId && form.panel.messageId !== message.id) {
    await guild.channels.cache.get(form.panel.channelId)?.messages?.delete(form.panel.messageId).catch(() => null);
  }
  await ApplicationForm.updateOne({ guildId: guild.id, formId }, { $set: { 'panel.channelId': channel.id, 'panel.messageId': message.id } });
  return { message };
}

// ---------------------------------------------------------------- Applying

const DAY = 86400000;
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** Every check for `member` applying to `form`: { ok, text } (text lists ✅/❌ for each requirement). */
async function checkEligibility(member, form) {
  if (!form.open) return { ok: false, text: `**${form.name}** applications are closed right now.` };
  const r = form.requirements;
  const approveRole = form.review.approveRoleId;
  if (form.limits.blockIfHasRole && approveRole && member.roles.cache.has(approveRole)) return { ok: false, text: `You already have the <@&${approveRole}> role.` };

  const pending = await Application.findOne({ guildId: member.guild.id, formId: form.formId, userId: member.id, status: 'PENDING' }).lean();
  if (pending) return { ok: false, text: `You already have a **${form.name}** application waiting for review — hang tight!` };
  if (form.limits.reapplyCooldownHours) {
    const last = (await Application.find({ guildId: member.guild.id, formId: form.formId, userId: member.id, status: 'DENIED' }).lean())
      .sort((a, b) => new Date(b.decidedAt || b.createdAt) - new Date(a.decidedAt || a.createdAt))[0];
    const until = last ? new Date(last.decidedAt || last.createdAt).getTime() + form.limits.reapplyCooldownHours * 3600000 : 0;
    if (until > Date.now()) return { ok: false, text: `You can apply for **${form.name}** again <t:${Math.ceil(until / 1000)}:R>.` };
  }

  const checks = [];
  if (r.minLevel) {
    const level = (await UserLevel.findOne({ guildId: member.guild.id, userId: member.id }).lean())?.level ?? 0;
    checks.push({ ok: level >= r.minLevel, text: `Be **Level ${r.minLevel}+** (you're Level ${level})` });
  }
  if (r.minAccountAgeDays) {
    const days = Math.floor((Date.now() - (member.user?.createdTimestamp || Date.now())) / DAY);
    checks.push({ ok: days >= r.minAccountAgeDays, text: `Have a Discord account at least **${plural(r.minAccountAgeDays, 'day')}** old (yours is ${plural(days, 'day')})` });
  }
  if (r.minDaysInServer) {
    const days = member.joinedTimestamp ? Math.floor((Date.now() - member.joinedTimestamp) / DAY) : 0;
    checks.push({ ok: days >= r.minDaysInServer, text: `Be in the server for **${plural(r.minDaysInServer, 'day')}** (you're at ${days})` });
  }
  if (r.requiredRoleId) checks.push({ ok: member.roles.cache.has(r.requiredRoleId), text: `Have the <@&${r.requiredRoleId}> role` });
  if (checks.every((c) => c.ok)) return { ok: true };
  return { ok: false, text: `You can't apply for **${form.name}** yet:\n${checks.map((c) => `${c.ok ? '✅' : '❌'} ${c.text}`).join('\n')}` };
}

function applyModal(form) {
  const modal = new ModalBuilder().setCustomId(`apm:submit:${form.formId}`).setTitle(`Apply: ${form.name}`.slice(0, 45));
  form.questions.slice(0, MAX_QUESTIONS).forEach((q, i) => {
    const input = new TextInputBuilder()
      .setCustomId(`q${i}`)
      .setStyle(q.style === 'short' ? TextInputStyle.Short : TextInputStyle.Paragraph)
      .setRequired(!!q.required)
      .setMaxLength(Math.max(1, q.maxLength || 1000));
    if (q.minLength) input.setMinLength(Math.min(q.minLength, q.maxLength || 1000));
    if (q.placeholder) input.setPlaceholder(q.placeholder.slice(0, 100));
    modal.addLabelComponents(new LabelBuilder().setLabel(q.label.slice(0, 45)).setTextInputComponent(input));
  });
  return modal;
}

const fill = (text, { form, guild, user, reason }) =>
  String(text || '')
    .replace(/\{form\}/gi, form.name)
    .replace(/\{server\}/gi, guild.name)
    .replace(/\{user\}/gi, user ? `<@${user.id}>` : '')
    .replace(/\{reason\}/gi, reason || '—');

/** The review-channel embed for an application (also used after a decision). */
async function reviewEmbed(guild, app, member = null) {
  const s = STATUS[app.status] || STATUS.PENDING;
  const user = member?.user || (await guild.client?.users?.fetch(app.userId).catch(() => null));
  const level = (await UserLevel.findOne({ guildId: guild.id, userId: app.userId }).lean())?.level ?? 0;
  const created = user?.createdTimestamp;
  const joined = member?.joinedTimestamp || (await guild.members.fetch(app.userId).catch(() => null))?.joinedTimestamp;
  const embed = new EmbedBuilder()
    .setColor(s.color)
    .setTitle(`📝 ${app.formName} application`)
    .setDescription(
      `**Applicant:** <@${app.userId}> (${app.userTag || app.userId})\n` +
        `**Account created:** ${created ? `<t:${Math.floor(created / 1000)}:R>` : 'unknown'} · **Joined:** ${joined ? `<t:${Math.floor(joined / 1000)}:R>` : 'unknown'} · **Level:** ${level}`
    )
    .addFields(app.answers.slice(0, 5).map((a) => ({ name: a.question.slice(0, 256), value: (a.answer || '*—no answer—*').slice(0, 1024) })))
    .setTimestamp(new Date(app.createdAt || Date.now()));
  if (user?.displayAvatarURL) embed.setThumbnail(user.displayAvatarURL());
  const decided = app.status !== 'PENDING' ? ` · by ${app.decidedByTag || 'staff'}${app.reason ? ` — ${app.reason}` : ''}` : '';
  embed.setFooter({ text: `${s.label}${decided}`.slice(0, 2048) });
  return embed;
}

function reviewButtons(app) {
  const done = app.status !== 'PENDING';
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`ap:ok:${app._id}`).setLabel('Approve').setEmoji('✅').setStyle(ButtonStyle.Success).setDisabled(done),
    new ButtonBuilder().setCustomId(`ap:no:${app._id}`).setLabel('Deny').setEmoji('❌').setStyle(ButtonStyle.Danger).setDisabled(done)
  );
}

const submitting = new Set(); // guild:form:user — stops a double submit creating two applications

/** Files an application and posts it for review. Returns { app } or { error }. */
async function submitApplication(member, form, answers) {
  const key = `${member.guild.id}:${form.formId}:${member.id}`;
  if (submitting.has(key)) return { error: 'Your application is already being sent.' };
  submitting.add(key);
  try {
    const again = await checkEligibility(member, form); // things may have changed while the form was open
    if (!again.ok) return { error: again.text };
    const channel = member.guild.channels.cache.get(form.review.channelId);
    if (!channel?.isTextBased?.()) return { error: 'This form has no review channel set up — please tell a moderator.' };
    const app = await Application.create({ guildId: member.guild.id, formId: form.formId, formName: form.name, userId: member.id, userTag: member.user?.tag || member.user?.username || null, answers });
    const pings = form.review.pingRoleIds;
    const message = await channel
      .send({ content: pings.length ? pings.map((id) => `<@&${id}>`).join(' ') : null, embeds: [await reviewEmbed(member.guild, app, member)], components: [reviewButtons(app)], allowedMentions: { roles: pings } })
      .catch(() => null);
    if (!message) {
      await Application.deleteOne({ _id: app._id });
      return { error: "I couldn't post your application to the review channel — please tell a moderator." };
    }
    await Application.updateOne({ _id: app._id }, { $set: { reviewChannelId: channel.id, reviewMessageId: message.id } });
    return { app: { ...app.toObject(), reviewChannelId: channel.id, reviewMessageId: message.id } };
  } finally {
    submitting.delete(key);
  }
}

// ---------------------------------------------------------------- Reviewing

function isReviewer(member, form) {
  if (!member) return false;
  if (member.permissions?.has?.(PermissionFlagsBits.ManageGuild) || member.permissions?.has?.(PermissionFlagsBits.Administrator)) return true;
  const roles = [...form.review.reviewerRoleIds, ...form.review.pingRoleIds];
  return roles.some((id) => member.roles?.cache?.has(id));
}

/**
 * Approves or denies an application: gives the approve role (if set), DMs the applicant (if on),
 * updates the review message. `by` is { id, tag }. Returns { app } or { error }.
 */
async function decide(guild, appId, { approve, by, reason = null }) {
  const app = await Application.findOne({ _id: appId, guildId: guild.id }).catch(() => null);
  if (!app) return { error: 'That application no longer exists.' };
  if (app.status !== 'PENDING') return { error: `This application was already ${app.status === 'APPROVED' ? 'approved' : 'denied'} by ${app.decidedByTag || 'staff'}.` };
  const form = (await getForm(guild.id, app.formId)) || formOf({ name: app.formName });
  app.status = approve ? 'APPROVED' : 'DENIED';
  app.decidedBy = by?.id || null;
  app.decidedByTag = by?.tag || null;
  app.decidedAt = new Date();
  app.reason = reason ? String(reason).slice(0, 500) : null;
  const member = await guild.members.fetch(app.userId).catch(() => null);
  const warnings = [];
  if (approve && form.review.approveRoleId) {
    if (!member) warnings.push("They've left the server, so no role was given.");
    else {
      const ok = await member.roles.add(form.review.approveRoleId, `Application approved by ${by?.tag || 'staff'}`).then(() => true, () => false);
      app.roleGiven = ok;
      if (!ok) warnings.push(`I couldn't give <@&${form.review.approveRoleId}> — check my role is above it and I have Manage Roles.`);
    }
  }
  if (form.review.dmApplicant) {
    const text = fill(approve ? form.review.approveMessage : form.review.denyMessage, { form, guild, user: { id: app.userId }, reason: app.reason });
    const user = member?.user || (await guild.client?.users?.fetch(app.userId).catch(() => null));
    const note = app.reason && !/\{reason\}/i.test(approve ? form.review.approveMessage : form.review.denyMessage) ? `\n**Note from the team:** ${app.reason}` : '';
    app.dmSent = user ? await user.send({ content: (text + note).slice(0, 2000), allowedMentions: { parse: [] } }).then(() => true, () => false) : false;
  }
  await app.save();
  const channel = guild.channels.cache.get(app.reviewChannelId);
  const message = await channel?.messages?.fetch(app.reviewMessageId).catch(() => null);
  if (message) await message.edit({ embeds: [await reviewEmbed(guild, app, member)], components: [reviewButtons(app)] }).catch(() => null);
  return { app: app.toObject(), warnings };
}

async function listApplications(guildId, { formId = null, status = null, limit = 100 } = {}) {
  const q = { guildId };
  if (formId) q.formId = formId;
  if (status) q.status = status;
  return (await Application.find(q).lean()).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, limit);
}

// ---------------------------------------------------------------- Buttons & modals

const ephemeral = (interaction, content) =>
  interaction.deferred || interaction.replied ? interaction.editReply({ content }) : interaction.reply({ content, ephemeral: true, allowedMentions: { parse: [] } });

async function handleApplicationButton(interaction) {
  const [, action, id] = interaction.customId.split(':');
  if (action === 'apply') {
    const form = await getForm(interaction.guildId, id);
    if (!form) return ephemeral(interaction, '❌ This application form no longer exists.');
    const check = await checkEligibility(interaction.member, form);
    if (!check.ok) return ephemeral(interaction, `❌ ${check.text}`);
    return interaction.showModal(applyModal(form));
  }
  if (action === 'ok' || action === 'no') {
    const app = await Application.findOne({ _id: id, guildId: interaction.guildId }).lean().catch(() => null);
    if (!app) return ephemeral(interaction, '❌ That application no longer exists.');
    const form = (await getForm(interaction.guildId, app.formId)) || formOf({ name: app.formName });
    if (!isReviewer(interaction.member, form)) return ephemeral(interaction, '❌ Only reviewers for this form can do that.');
    if (app.status !== 'PENDING') return ephemeral(interaction, `❌ Already ${app.status === 'APPROVED' ? 'approved' : 'denied'} by ${app.decidedByTag || 'staff'}.`);
    const approve = action === 'ok';
    const input = new TextInputBuilder().setCustomId('reason').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(500)
      .setPlaceholder(approve ? 'e.g. Welcome aboard! (sent to them if DMs are on)' : 'e.g. Please get a bit more active first (sent to them if DMs are on)');
    return interaction.showModal(
      new ModalBuilder()
        .setCustomId(`apm:${action}:${id}`)
        .setTitle(`${approve ? 'Approve' : 'Deny'} ${app.userTag || 'application'}`.slice(0, 45))
        .addLabelComponents(new LabelBuilder().setLabel('Note (optional)').setTextInputComponent(input))
    );
  }
  return ephemeral(interaction, '❌ Unknown button.');
}

async function handleApplicationModal(interaction) {
  const [, action, id] = interaction.customId.split(':');
  if (action === 'submit') {
    const form = await getForm(interaction.guildId, id);
    if (!form) return ephemeral(interaction, '❌ This application form no longer exists.');
    await interaction.deferReply({ ephemeral: true });
    const answers = form.questions.slice(0, MAX_QUESTIONS).map((q, i) => ({ question: q.label, answer: (interaction.fields.getTextInputValue(`q${i}`) || '').trim() }));
    const result = await submitApplication(interaction.member, form, answers);
    return interaction.editReply({ content: result.error ? `❌ ${result.error}` : `✅ Your **${form.name}** application was sent! You'll get a DM when it's reviewed.`, allowedMentions: { parse: [] } });
  }
  if (action === 'ok' || action === 'no') {
    const app = await Application.findOne({ _id: id, guildId: interaction.guildId }).lean().catch(() => null);
    const form = app && ((await getForm(interaction.guildId, app.formId)) || formOf({ name: app.formName }));
    if (!app || !isReviewer(interaction.member, form)) return ephemeral(interaction, '❌ Only reviewers for this form can do that.');
    await interaction.deferReply({ ephemeral: true });
    const reason = interaction.fields.getTextInputValue('reason')?.trim() || null;
    const result = await decide(interaction.guild, id, { approve: action === 'ok', by: { id: interaction.user.id, tag: interaction.user.tag || interaction.user.username }, reason });
    if (result.error) return interaction.editReply(`❌ ${result.error}`);
    const done = result.app.status === 'APPROVED' ? '✅ Approved' : '❌ Denied';
    const dm = result.app.dmSent === true ? ' They were sent a DM.' : result.app.dmSent === false ? " (Couldn't DM them — their DMs are closed.)" : '';
    return interaction.editReply({ content: `${done}.${dm}${result.warnings.length ? `\n⚠️ ${result.warnings.join(' ')}` : ''}`, allowedMentions: { parse: [] } });
  }
  return ephemeral(interaction, '❌ Unknown form.');
}

module.exports = {
  MAX_QUESTIONS,
  BUTTON_STYLES,
  formOf,
  cleanForm,
  listForms,
  getForm,
  createForm,
  saveForm,
  deleteForm,
  buildPanel,
  publishPanel,
  checkEligibility,
  applyModal,
  submitApplication,
  isReviewer,
  decide,
  listApplications,
  reviewEmbed,
  handleApplicationButton,
  handleApplicationModal
};
