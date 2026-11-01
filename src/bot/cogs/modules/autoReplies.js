// Auto-replies: watch every channel for keywords and reply automatically. Each trigger has its own
// keywords, match mode, response (text or a rich embed), and can ignore specific channels or roles.
// Config lives on GuildConfig.autoReplies, so the message handler reads it from the cached config with
// no extra database hit. See /autoreply and the dashboard Auto-Replies page.
const GuildConfig = require('../../../database/models/GuildConfig');
const UserLevel = require('../../../database/models/UserLevel');
const EmbedJson = require('../../../web/static/js/embed-json');
const { levelForXp } = require('./leveling');

const MATCH_MODES = ['word', 'contains', 'exact', 'starts', 'regex'];
const MAX_TRIGGERS = 50;

function autoRepliesSettings(config) {
  const a = (config && config.autoReplies) || {};
  return {
    enabled: !!a.enabled,
    cooldownSeconds: Number.isFinite(a.cooldownSeconds) ? Math.max(0, Math.min(3600, a.cooldownSeconds)) : 3,
    maxLevel: Number.isFinite(a.maxLevel) ? Math.max(0, Math.min(1000, a.maxLevel)) : 0, // only reply under this level (0 = everyone)
    triggers: (Array.isArray(a.triggers) ? a.triggers : []).map((t) => ({
      id: t.id,
      name: t.name || '',
      keywords: Array.isArray(t.keywords) ? t.keywords.filter(Boolean) : [],
      match: MATCH_MODES.includes(t.match) ? t.match : 'word',
      caseSensitive: !!t.caseSensitive,
      reply: t.reply !== false,
      deleteTrigger: !!t.deleteTrigger,
      response: t.response ?? null,
      requireAll: !!t.requireAll, // all keywords must appear (great for question phrasings), vs any one
      ignoreChannelIds: Array.isArray(t.ignoreChannelIds) ? t.ignoreChannelIds : [],
      ignoreRoleIds: Array.isArray(t.ignoreRoleIds) ? t.ignoreRoleIds : [],
      enabled: t.enabled !== false
    }))
  };
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Does one keyword hit the content, under the trigger's match mode?
function keywordHits(trigger, raw, text, content, flags) {
  const kw = trigger.caseSensitive ? raw : raw.toLowerCase();
  if (!kw) return false;
  switch (trigger.match) {
    case 'exact':
      return text.trim() === kw.trim();
    case 'starts':
      return text.trimStart().startsWith(kw);
    case 'contains':
      return text.includes(kw);
    case 'regex':
      try {
        return new RegExp(raw.slice(0, 200), flags).test(content.slice(0, 2000));
      } catch {
        return false; // invalid regex — ignore this keyword
      }
    case 'word':
    default: {
      // Whole-word match when the keyword is word-ish; otherwise fall back to substring.
      const re = /^[\w]+$/.test(kw) ? new RegExp(`\\b${escapeRe(kw)}\\b`, flags) : null;
      return re ? re.test(content.slice(0, 2000)) : text.includes(kw);
    }
  }
}

/**
 * Does `content` match this trigger? By default any one keyword hits; with `requireAll` every keyword
 * must appear (order-independent) — handy for question phrasings like "what are the codes to redeem?"
 * (keywords: codes, redeem). `requireAll` only applies to word/contains/regex (not exact/starts).
 */
function matchesTrigger(trigger, content) {
  if (!trigger.enabled || !trigger.keywords.length) return false;
  const text = trigger.caseSensitive ? content : content.toLowerCase();
  const flags = trigger.caseSensitive ? '' : 'i';
  const hit = (raw) => keywordHits(trigger, raw, text, content, flags);
  const all = trigger.requireAll && ['word', 'contains', 'regex'].includes(trigger.match);
  return all ? trigger.keywords.every(hit) : trigger.keywords.some(hit);
}

/** Fills {user} {username} {server} {channel} {count} in a response string. */
function renderText(str, message) {
  return String(str || '')
    .replace(/\{user\}/g, `<@${message.author.id}>`)
    .replace(/\{username\}/g, message.member?.displayName || message.author.username)
    .replace(/\{server\}/g, message.guild?.name || '')
    .replace(/\{channel\}/g, `<#${message.channel.id}>`)
    .replace(/\{count\}/g, String(message.guild?.memberCount || ''));
}

// Builds the Discord payload from a trigger's response (a string, or { content, embeds }).
function buildPayload(trigger, message) {
  const r = trigger.response;
  if (r && typeof r === 'object') {
    const msg = EmbedJson.normalizeMessage(r);
    const embeds = (msg.embeds || []).map((e) => ({ ...e, description: e.description ? renderText(e.description, message) : e.description, title: e.title ? renderText(e.title, message) : e.title }));
    return { content: msg.content ? renderText(msg.content, message) : '', embeds };
  }
  return { content: renderText(r, message), embeds: [] };
}

// Per trigger, per channel: don't fire again within cooldownSeconds (stops a reply storm).
const cooldowns = new Map();
function onCooldown(guildId, triggerId, channelId, seconds) {
  if (!seconds) return false;
  const key = `${guildId}:${triggerId}:${channelId}`;
  const now = Date.now();
  const until = cooldowns.get(key) || 0;
  if (now < until) return true;
  cooldowns.set(key, now + seconds * 1000);
  if (cooldowns.size > 5000) cooldowns.delete(cooldowns.keys().next().value);
  return false;
}

// True when the message author's XP level is below `maxLevel` (so auto-replies target newcomers).
async function memberUnderLevel(message, config, maxLevel) {
  if (!maxLevel) return true;
  const rec = await UserLevel.findOne({ guildId: message.guild.id, userId: message.author.id }, { xp: 1, level: 1 }).lean().catch(() => null);
  const level = rec ? (typeof rec.level === 'number' ? rec.level : levelForXp(rec.xp || 0, config?.levelXpBase)) : 0;
  return level < maxLevel;
}

/**
 * Checks a message against the guild's auto-reply triggers and replies to the first match.
 * Returns true when it replied. Never throws into the message handler.
 */
async function handleAutoReply(message, config) {
  if (!message.guild || message.author?.bot || message.webhookId || message.system) return false;
  const s = autoRepliesSettings(config);
  if (!s.enabled || !s.triggers.length) return false;
  const content = message.content || '';
  if (!content.trim()) return false;

  for (const trigger of s.triggers) {
    if (!trigger.enabled) continue;
    if (trigger.ignoreChannelIds.includes(message.channelId)) continue;
    if (trigger.ignoreRoleIds.length && message.member?.roles?.cache?.some((r) => trigger.ignoreRoleIds.includes(r.id))) continue;
    if (!matchesTrigger(trigger, content)) continue;
    // Optional: only reply to members under a level (newcomers). Checked once, only after a match.
    if (s.maxLevel && !(await memberUnderLevel(message, config, s.maxLevel))) return false;
    if (onCooldown(message.guild.id, trigger.id, message.channelId, s.cooldownSeconds)) return false;

    const payload = buildPayload(trigger, message);
    if (!payload.content.trim() && !payload.embeds.length) return false;
    const sent = { ...payload, allowedMentions: { parse: ['users'] } }; // reply can ping the author; never @everyone/@role
    try {
      if (trigger.reply && message.channel?.send) await message.reply({ ...sent, allowedMentions: { ...sent.allowedMentions, repliedUser: true } });
      else await message.channel.send(sent);
      if (trigger.deleteTrigger && message.deletable) await message.delete().catch(() => null);
    } catch {
      return false;
    }
    return true; // first match wins — only one auto-reply per message
  }
  return false;
}

// ---------------------------------------------------------------- settings / CRUD

const genId = () => Math.random().toString(36).slice(2, 8);

function cleanTrigger(input, guild) {
  const keywords = (Array.isArray(input.keywords) ? input.keywords : String(input.keywords || '').split(','))
    .map((k) => String(k).trim())
    .filter(Boolean)
    .slice(0, 25);
  if (!keywords.length) return { error: 'Add at least one keyword.' };
  const response = input.response;
  const hasText = typeof response === 'string' ? response.trim() : response && (response.content?.trim() || (response.embeds || []).length);
  if (!hasText) return { error: 'Add a response (text or an embed).' };
  const valid = (ids) => (Array.isArray(ids) ? ids.map(String).filter((id) => !guild || guild.channels.cache.has(id) || guild.roles.cache.has(id)) : []);
  return {
    trigger: {
      id: input.id || genId(),
      name: String(input.name || keywords[0]).slice(0, 80),
      keywords,
      match: MATCH_MODES.includes(input.match) ? input.match : 'word',
      caseSensitive: !!input.caseSensitive,
      reply: input.reply !== false,
      deleteTrigger: !!input.deleteTrigger,
      requireAll: !!input.requireAll,
      response: typeof response === 'string' ? response.slice(0, 2000) : EmbedJson.normalizeMessage(response),
      ignoreChannelIds: valid(input.ignoreChannelIds),
      ignoreRoleIds: valid(input.ignoreRoleIds),
      enabled: input.enabled !== false
    }
  };
}

async function addTrigger(guild, input) {
  const s = autoRepliesSettings(await GuildConfig.findOne({ guildId: guild.id }, { autoReplies: 1 }).lean());
  const editing = input.id && s.triggers.some((t) => t.id === input.id);
  if (!editing && s.triggers.length >= MAX_TRIGGERS) return { error: `You can have up to ${MAX_TRIGGERS} auto-replies.` };
  const { trigger, error } = cleanTrigger(input, guild);
  if (error) return { error };
  const triggers = editing ? s.triggers.map((t) => (t.id === trigger.id ? trigger : t)) : [...s.triggers, trigger];
  await GuildConfig.updateOne({ guildId: guild.id }, { $set: { 'autoReplies.triggers': triggers, 'autoReplies.enabled': true } }, { upsert: true });
  return { trigger, editing };
}

async function removeTrigger(guild, id) {
  const s = autoRepliesSettings(await GuildConfig.findOne({ guildId: guild.id }, { autoReplies: 1 }).lean());
  const trigger = s.triggers.find((t) => t.id === id);
  if (!trigger) return { error: 'No auto-reply with that ID.' };
  await GuildConfig.updateOne({ guildId: guild.id }, { $set: { 'autoReplies.triggers': s.triggers.filter((t) => t.id !== id) } });
  return { ok: true, trigger };
}

async function toggleTrigger(guild, id, on = null) {
  const s = autoRepliesSettings(await GuildConfig.findOne({ guildId: guild.id }, { autoReplies: 1 }).lean());
  const trigger = s.triggers.find((t) => t.id === id);
  if (!trigger) return { error: 'No auto-reply with that ID.' };
  const enabled = on === null ? !trigger.enabled : !!on;
  await GuildConfig.updateOne({ guildId: guild.id }, { $set: { 'autoReplies.triggers': s.triggers.map((t) => (t.id === id ? { ...t, enabled } : t)) } });
  return { ok: true, enabled, trigger };
}

async function saveSettings(guild, input) {
  const patch = {};
  if (input.enabled !== undefined) patch['autoReplies.enabled'] = !!input.enabled;
  if (input.cooldownSeconds !== undefined && input.cooldownSeconds !== null && input.cooldownSeconds !== '') {
    const c = Number.parseInt(input.cooldownSeconds, 10);
    if (!(c >= 0 && c <= 3600)) return { error: 'Cooldown must be 0–3600 seconds.' };
    patch['autoReplies.cooldownSeconds'] = c;
  }
  if (input.maxLevel !== undefined && input.maxLevel !== null && input.maxLevel !== '') {
    const m = Number.parseInt(input.maxLevel, 10);
    if (!(m >= 0 && m <= 1000)) return { error: 'Max level must be 0–1000 (0 = reply to everyone).' };
    patch['autoReplies.maxLevel'] = m;
  }
  await GuildConfig.updateOne({ guildId: guild.id }, { $set: patch }, { upsert: true });
  const fresh = await GuildConfig.findOne({ guildId: guild.id }, { autoReplies: 1 }).lean();
  return { settings: autoRepliesSettings(fresh) };
}

async function listTriggers(guildId) {
  return autoRepliesSettings(await GuildConfig.findOne({ guildId }, { autoReplies: 1 }).lean()).triggers;
}

module.exports = {
  MATCH_MODES,
  MAX_TRIGGERS,
  autoRepliesSettings,
  matchesTrigger,
  renderText,
  buildPayload,
  handleAutoReply,
  cleanTrigger,
  addTrigger,
  removeTrigger,
  toggleTrigger,
  saveSettings,
  listTriggers
};
