// FAQ: one saved message (text + up to 10 embeds) per server, built on the dashboard in the same
// visual / markdown / JSON editor as the Embed Builder (with #channel, @user and :emoji: autocomplete).
// `/faq show` posts it publicly; `/faq edit` opens the dashboard. It deliberately has none of the
// guides machinery (no forum, index, categories or approvals) — it's just a message you can post.
// Who may manage it: guide editors (the same editor roles as /guide) plus Manage Server / Admins.
const GuildConfig = require('../../../database/models/GuildConfig');
const EmbedJson = require('../../../web/static/js/embed-json');
const guides = require('./guides');

/** Normalized FAQ settings from a config doc: { message: { content, embeds }, channelId, updatedBy, updatedAt }. */
function faqSettings(config) {
  const f = (config && config.faq) || {};
  return {
    message: EmbedJson.normalizeMessage(f.message || { content: '', embeds: [] }),
    channelId: f.channelId || null,
    updatedBy: f.updatedBy || null,
    updatedAt: f.updatedAt || null
  };
}

/** True when there's something worth posting (text or at least one embed). */
function hasFaq(message) {
  const m = message || {};
  return !!((typeof m.content === 'string' && m.content.trim()) || (Array.isArray(m.embeds) && m.embeds.length));
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

/** Validate a message (Discord's limits) and persist it. Returns { error } or { message }. */
async function saveFaq(guild, { message, channelId }, userId) {
  const normalized = EmbedJson.normalizeMessage(message || { content: '', embeds: [] });
  const errors = EmbedJson.validateMessage(normalized);
  if (errors.length) return { error: errors[0] };
  if (!hasFaq(normalized)) return { error: 'Add some text or at least one embed before saving the FAQ.' };
  const set = { 'faq.message': normalized, 'faq.updatedBy': userId || null, 'faq.updatedAt': new Date() };
  if (channelId !== undefined) set['faq.channelId'] = channelId || null;
  await GuildConfig.updateOne({ guildId: guild.id }, { $set: set }, { upsert: true });
  return { message: normalized };
}

/** Remember the last channel the FAQ was posted to (without touching the message or its edit stamp). */
async function rememberChannel(guildId, channelId) {
  await GuildConfig.updateOne({ guildId }, { $set: { 'faq.channelId': channelId || null } }, { upsert: true }).catch(() => null);
}

/** The payload to hand to channel.send() — content pings normally, embeds never do. */
function toPayload(message) {
  const m = EmbedJson.normalizeMessage(message || { content: '', embeds: [] });
  return { content: m.content || null, embeds: m.embeds || [] };
}

module.exports = { faqSettings, hasFaq, getFaq, isEditor, saveFaq, rememberChannel, toPayload };
