// FAQ: a list of question → answer entries, rendered into an embed. Anyone can run /faq to post it in
// the current channel; guide editors manage it with /faqedit … or the dashboard's click-to-edit editor.
// Entries become embed fields (question = field name, answer = field value), chunked across embeds so a
// long FAQ still fits Discord's limits (25 fields and 6,000 characters per embed).
const GuildConfig = require('../../../database/models/GuildConfig');
const EmbedJson = require('../../../web/static/js/embed-json');
const guides = require('./guides');

const DEFAULT_TITLE = 'Frequently Asked Questions';
const LIMITS = { title: 256, intro: 4096, question: 256, answer: 1024, items: 100, embeds: 10, fieldsPerEmbed: 25, perEmbed: 5800 };
// A thin rule appended under each answer (except the last) so questions don't run together.
const DIVIDER = '────────────────────';

const str = (v, max) => (typeof v === 'string' ? v : v == null ? '' : String(v)).slice(0, max);

/** Normalized FAQ settings: { title, intro, color, items:[{q,a}], channelId, updatedBy, updatedAt }. */
function faqSettings(config) {
  const f = (config && config.faq) || {};
  const items = (Array.isArray(f.items) ? f.items : [])
    .map((it) => ({ q: str(it?.q, LIMITS.question).trim(), a: str(it?.a, LIMITS.answer) }))
    .filter((it) => it.q && it.a.trim())
    .slice(0, LIMITS.items);
  return {
    title: str(f.title, LIMITS.title),
    intro: str(f.intro, LIMITS.intro),
    color: f.color || '#5865f2',
    divider: f.divider !== false, // on by default
    items,
    channelId: f.channelId || null,
    updatedBy: f.updatedBy || null,
    updatedAt: f.updatedAt || null
  };
}

/** Something worth posting? (at least one Q&A, or an intro.) */
function hasFaq(f) {
  return !!(f && ((Array.isArray(f.items) && f.items.length) || (f.intro && f.intro.trim())));
}

/** Render the FAQ into one or more Discord embeds (questions become fields, chunked to fit the limits). */
function renderEmbeds(f) {
  const s = f.items ? f : faqSettings({ faq: f });
  const title = (s.title && s.title.trim() ? s.title : DEFAULT_TITLE).slice(0, LIMITS.title);
  const color = EmbedJson.colorToInt(s.color);
  const embeds = [];
  let cur = null;
  let len = 0;
  const open = (header) => {
    cur = { color: color == null ? undefined : color, fields: [] };
    if (header) {
      cur.title = title;
      if (s.intro && s.intro.trim()) cur.description = s.intro.slice(0, LIMITS.intro);
    }
    len = (cur.title || '').length + (cur.description || '').length;
    embeds.push(cur);
  };
  const divider = s.divider !== false;
  const foot = divider ? `\n${DIVIDER}` : '';
  open(true);
  s.items.forEach((it, i) => {
    const name = str(it.q, LIMITS.question) || '​';
    // Reserve room for the divider so a long answer + line still fits the 1024-char field limit.
    const last = i === s.items.length - 1;
    const value = (str(it.a, LIMITS.answer - (divider && !last ? foot.length : 0)) || '​') + (divider && !last ? foot : '');
    if (cur.fields.length >= LIMITS.fieldsPerEmbed || len + name.length + value.length > LIMITS.perEmbed) {
      if (embeds.length >= LIMITS.embeds) return;
      open(false);
    }
    cur.fields.push({ name, value });
    len += name.length + value.length;
  });
  return embeds.map((e) => EmbedJson.normalizeEmbed(e)).filter(Boolean);
}

/** The payload to hand to channel.send() / interaction.reply() — embeds only, no pings. */
function toPayload(f) {
  return { embeds: renderEmbeds(f) };
}

/** Load the saved FAQ for a guild. */
async function getFaq(guildId) {
  return faqSettings(await GuildConfig.findOne({ guildId }, { faq: 1 }).lean());
}

/** May this member manage the FAQ? Same as guide editors: an editor role, or Manage Server / Admin. */
async function isEditor(member, guildId) {
  if (!member) return false;
  const s = guides.guidesSettings(await GuildConfig.findOne({ guildId }, { guides: 1 }).lean());
  return guides.isEditor(member, s);
}

/** Validate the whole FAQ (title/intro/color/items) and persist it. Returns { error } or { faq }. */
async function saveFaq(guild, input = {}, userId) {
  const items = (Array.isArray(input.items) ? input.items : [])
    .map((it) => ({ q: str(it?.q, LIMITS.question).trim(), a: str(it?.a, LIMITS.answer) }))
    .filter((it) => it.q && it.a.trim());
  if (items.length > LIMITS.items) return { error: `Up to ${LIMITS.items} questions.` };
  const faqDoc = {
    title: str(input.title, LIMITS.title),
    intro: str(input.intro, LIMITS.intro),
    color: EmbedJson.intToHex(EmbedJson.colorToInt(input.color)) || '#5865f2',
    divider: input.divider !== false,
    items
  };
  if (!hasFaq(faqDoc)) return { error: 'Add at least one question (or some intro text) before saving.' };
  const set = { 'faq.title': faqDoc.title, 'faq.intro': faqDoc.intro, 'faq.color': faqDoc.color, 'faq.divider': faqDoc.divider, 'faq.items': faqDoc.items, 'faq.updatedBy': userId || null, 'faq.updatedAt': new Date() };
  await GuildConfig.updateOne({ guildId: guild.id }, { $set: set }, { upsert: true });
  return { faq: faqSettings({ faq: faqDoc }) };
}

/** Add a Q&A entry. Returns { error } or { faq }. */
async function addItem(guild, question, answer, userId) {
  const q = str(question, LIMITS.question).trim();
  const a = str(answer, LIMITS.answer).trim();
  if (!q || !a) return { error: 'Give both a question and an answer.' };
  const cur = await getFaq(guild.id);
  if (cur.items.length >= LIMITS.items) return { error: `The FAQ already has the maximum ${LIMITS.items} questions.` };
  if (cur.items.some((it) => it.q.toLowerCase() === q.toLowerCase())) return { error: 'There is already a question with that exact text — edit it instead.' };
  return saveFaq(guild, { ...cur, items: [...cur.items, { q, a }] }, userId);
}

/** Remove a Q&A entry by its exact question text. Returns { error } or { faq, removed }. */
async function removeItem(guild, question, userId) {
  const cur = await getFaq(guild.id);
  const q = str(question, LIMITS.question).trim().toLowerCase();
  const kept = cur.items.filter((it) => it.q.toLowerCase() !== q);
  if (kept.length === cur.items.length) return { error: 'No question matched that — pick one from the list.' };
  const res = await saveFaq(guild, { ...cur, items: kept }, userId);
  return res.error ? res : { ...res, removed: cur.items.length - kept.length };
}

/** Edit an entry found by its current question text: change its answer and/or question. */
async function editItem(guild, question, { newQuestion, answer }, userId) {
  const cur = await getFaq(guild.id);
  const q = str(question, LIMITS.question).trim().toLowerCase();
  const idx = cur.items.findIndex((it) => it.q.toLowerCase() === q);
  if (idx < 0) return { error: 'No question matched that — pick one from the list.' };
  const items = cur.items.map((it, i) =>
    i === idx
      ? {
          q: newQuestion != null && String(newQuestion).trim() ? str(newQuestion, LIMITS.question).trim() : it.q,
          a: answer != null && String(answer).trim() ? str(answer, LIMITS.answer) : it.a
        }
      : it
  );
  return saveFaq(guild, { ...cur, items }, userId);
}

/** Remember the last channel the FAQ was posted to (without touching the content). */
async function rememberChannel(guildId, channelId) {
  await GuildConfig.updateOne({ guildId }, { $set: { 'faq.channelId': channelId || null } }, { upsert: true }).catch(() => null);
}

module.exports = { DEFAULT_TITLE, LIMITS, faqSettings, hasFaq, renderEmbeds, toPayload, getFaq, isEditor, saveFaq, addItem, removeItem, editItem, rememberChannel };
