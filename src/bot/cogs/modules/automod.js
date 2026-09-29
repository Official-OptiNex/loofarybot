// Auto-mod: catches spam without being twitchy about fast talkers. Rules: message floods, the same
// message over and over, text walls, mass mentions, invites to other servers, and (optional) link
// and caps spam. The offending messages are deleted and the member gets a strike — the first
// strikes are warnings, the next one is a timeout (default: 2 warnings, then a 1 hour mute).
const { EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const GuildConfig = require('../../../database/models/GuildConfig');
const ModCase = require('../../../database/models/ModCase');
const { sendLog } = require('./logging');

const RULES = {
  flood: { label: 'Message spam', emoji: '🌊', notice: 'slow down — that’s a lot of messages at once' },
  duplicates: { label: 'Repeated messages', emoji: '🔁', notice: 'please don’t send the same message over and over' },
  walls: { label: 'Text wall', emoji: '🧱', notice: 'please don’t post walls of repeated text' },
  mentions: { label: 'Mention spam', emoji: '📣', notice: 'please don’t mass-mention people' },
  invites: { label: 'Invite link', emoji: '🔗', notice: 'invites to other servers aren’t allowed here' },
  links: { label: 'Link spam', emoji: '🌐', notice: 'too many links in one message' },
  caps: { label: 'Caps spam', emoji: '🔠', notice: 'please ease up on the caps' }
};

const INVITE_RE = /(?:https?:\/\/)?(?:www\.)?(?:discord(?:app)?\.com\/invite|discord\.gg|dsc\.gg)\/([\w-]{2,32})/gi;
const LINK_RE = /https?:\/\/[^\s<>]+/gi;
const STRIKE_COOLDOWN_MS = 15 * 1000; // one burst of spam = one strike
const HISTORY_MS = 2 * 60 * 1000;
const INVITE_CACHE_MS = 60 * 60 * 1000;

const history = new Map(); // `${guildId}:${userId}` -> [{ id, channelId, ts, norm }]
const lastStrike = new Map(); // `${guildId}:${userId}` -> ts
const inviteCache = new Map(); // code -> { guildId, at }

function automodSettings(config) {
  const a = (config && config.automod) || {};
  const num = (v, d, min, max) => Math.min(Math.max(Number.isFinite(Number(v)) && v !== null ? Number(v) : d, min), max);
  return {
    enabled: !!a.enabled,
    flood: { enabled: a.flood?.enabled !== false, messages: num(a.flood?.messages, 7, 3, 30), seconds: num(a.flood?.seconds, 5, 2, 60) },
    duplicates: { enabled: a.duplicates?.enabled !== false, count: num(a.duplicates?.count, 4, 2, 20), seconds: num(a.duplicates?.seconds, 30, 5, 300) },
    walls: { enabled: a.walls?.enabled !== false, maxLines: num(a.walls?.maxLines, 30, 5, 200) },
    mentions: { enabled: a.mentions?.enabled !== false, max: num(a.mentions?.max, 5, 2, 50), everyone: a.mentions?.everyone !== false },
    invites: { enabled: a.invites?.enabled !== false },
    links: { enabled: !!a.links?.enabled, max: num(a.links?.max, 4, 1, 30) },
    caps: { enabled: !!a.caps?.enabled, percent: num(a.caps?.percent, 80, 50, 100), minLength: num(a.caps?.minLength, 15, 5, 200) },
    warnings: num(a.warnings, 2, 0, 10),
    muteMinutes: num(a.muteMinutes, 60, 1, 40320),
    strikeResetHours: num(a.strikeResetHours, 24, 1, 720),
    notify: a.notify !== false,
    exemptRoleIds: Array.isArray(a.exemptRoleIds) ? a.exemptRoleIds : [],
    exemptChannelIds: Array.isArray(a.exemptChannelIds) ? a.exemptChannelIds : []
  };
}

// ---------------------------------------------------------------- Detection (pure, easy to test)

const normalize = (text) => String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
const stripCode = (text) => String(text || '').replace(/```[\s\S]*?```/g, ' ');

/** Why a single message is a text wall, or null. Code blocks are left alone. */
function wallReason(content, maxLines = 30) {
  const text = stripCode(content);
  const lines = text.split('\n');
  if (lines.length > maxLines) return `${lines.length} lines`;
  const filled = lines.map((l) => normalize(l)).filter(Boolean);
  if (filled.length >= 6 && new Set(filled).size <= 2) return `the same line ${filled.length} times`;
  const words = normalize(text).split(' ').filter(Boolean);
  if (words.length >= 30 && new Set(words).size <= 3) return `the same word ${words.length} times`;
  if (text.length >= 50 && /(.{1,10}?)\1{24,}/s.test(text.replace(/\s+/g, ''))) return 'one thing repeated over and over';
  return null;
}

function capsRatio(content) {
  const letters = String(content || '').replace(/<a?:\w+:\d+>|<[@#][!&]?\d+>|https?:\/\/\S+/g, '').match(/\p{L}/gu) || [];
  if (!letters.length) return { letters: 0, ratio: 0 };
  const upper = letters.filter((c) => c !== c.toLowerCase() && c === c.toUpperCase()).length;
  return { letters: letters.length, ratio: upper / letters.length };
}

const inviteCodes = (content) => [...String(content || '').matchAll(INVITE_RE)].map((m) => m[1]);

// Which server an invite points to (cached). null when it can't be resolved (expired/invalid).
async function inviteGuildId(client, code) {
  const hit = inviteCache.get(code);
  if (hit && Date.now() - hit.at < INVITE_CACHE_MS) return hit.guildId;
  const invite = await client.fetchInvite(code).catch(() => null);
  const guildId = invite?.guild?.id || null;
  inviteCache.set(code, { guildId, at: Date.now() });
  return guildId;
}

/** Checks one message against the per-message rules. Returns { rule, detail } or null. */
async function checkMessage(message, s) {
  const content = message.content || '';
  if (s.invites.enabled) {
    const codes = inviteCodes(content);
    for (const code of codes) {
      if (message.guild.vanityURLCode && code.toLowerCase() === message.guild.vanityURLCode.toLowerCase()) continue;
      const target = await inviteGuildId(message.client, code);
      if (target !== message.guild.id) return { rule: 'invites', detail: `discord.gg/${code}` };
    }
  }
  if (s.mentions.enabled) {
    const users = message.mentions?.users?.filter((u) => u.id !== message.author.id).size || 0;
    const roles = message.mentions?.roles?.size || 0;
    if (users + roles >= s.mentions.max) return { rule: 'mentions', detail: `${users + roles} mentions in one message` };
    if (s.mentions.everyone && /@(everyone|here)\b/.test(content) && !message.member?.permissions.has(PermissionFlagsBits.MentionEveryone)) {
      return { rule: 'mentions', detail: 'tried to ping @everyone/@here' };
    }
  }
  if (s.walls.enabled) {
    const why = wallReason(content, s.walls.maxLines);
    if (why) return { rule: 'walls', detail: why };
  }
  if (s.links.enabled) {
    const links = (content.match(LINK_RE) || []).length;
    if (links >= s.links.max) return { rule: 'links', detail: `${links} links in one message` };
  }
  if (s.caps.enabled) {
    const { letters, ratio } = capsRatio(content);
    if (letters >= s.caps.minLength && ratio * 100 >= s.caps.percent) return { rule: 'caps', detail: `${Math.round(ratio * 100)}% capitals` };
  }
  return null;
}

/** Adds the message to the member's recent history and checks the flood / duplicate rules. */
function checkHistory(key, message, s, now = Date.now()) {
  const list = (history.get(key) || []).filter((m) => now - m.ts < HISTORY_MS);
  const entry = { id: message.id, channelId: message.channelId, ts: now, norm: normalize(message.content) };
  list.push(entry);
  history.set(key, list);

  if (s.duplicates.enabled && entry.norm) {
    const same = list.filter((m) => m.norm === entry.norm && now - m.ts <= s.duplicates.seconds * 1000);
    if (same.length >= s.duplicates.count) return { rule: 'duplicates', detail: `the same message ${same.length} times`, messages: same };
  }
  if (s.flood.enabled) {
    const burst = list.filter((m) => now - m.ts <= s.flood.seconds * 1000);
    if (burst.length >= s.flood.messages) return { rule: 'flood', detail: `${burst.length} messages in ${s.flood.seconds}s`, messages: burst };
  }
  return null;
}

function isExempt(message, s) {
  if (s.exemptChannelIds.includes(message.channelId) || (message.channel?.parentId && s.exemptChannelIds.includes(message.channel.parentId))) return true;
  const member = message.member;
  if (!member) return false;
  if (member.permissions?.has(PermissionFlagsBits.ManageMessages) || member.permissions?.has(PermissionFlagsBits.Administrator)) return true;
  return s.exemptRoleIds.some((id) => member.roles?.cache?.has(id));
}

// ---------------------------------------------------------------- Punishment

/** Strikes this member has had recently (auto-mod warnings since their last auto-mod timeout). */
async function recentStrikes(guildId, userId, s, now = Date.now()) {
  const since = new Date(now - s.strikeResetHours * 3600000);
  const lastMute = await ModCase.findOne({ guildId, userId, source: 'automod', type: 'timeout', createdAt: { $gte: since } }).sort({ createdAt: -1 }).lean();
  const from = lastMute ? new Date(lastMute.createdAt) : since;
  return ModCase.countDocuments({ guildId, userId, source: 'automod', type: 'warn', active: true, createdAt: { $gte: from } });
}

async function deleteMessages(message, refs) {
  const byChannel = new Map();
  for (const r of refs) byChannel.set(r.channelId, [...(byChannel.get(r.channelId) || []), r.id]);
  for (const [channelId, ids] of byChannel) {
    const channel = message.guild.channels.cache.get(channelId) || (channelId === message.channelId ? message.channel : null);
    if (!channel) continue;
    if (ids.length > 1 && channel.bulkDelete) await channel.bulkDelete(ids, true).catch(() => null);
    else await channel.messages?.delete(ids[0]).catch(() => null);
  }
}

async function punish(message, s, hit) {
  const guild = message.guild;
  const key = `${guild.id}:${message.author.id}`;
  const refs = hit.messages?.length ? hit.messages : [{ id: message.id, channelId: message.channelId }];
  await deleteMessages(message, refs);
  history.set(key, []); // start fresh so the next message isn't counted as the same burst

  const now = Date.now();
  if (now - (lastStrike.get(key) || 0) < STRIKE_COOLDOWN_MS) return { action: 'deleted' };
  lastStrike.set(key, now);

  const rule = RULES[hit.rule];
  const strikes = await recentStrikes(guild.id, message.author.id, s, now);
  const mute = strikes >= s.warnings;
  const { performAction } = require('./modCases');
  const result = await performAction(guild, {
    type: mute ? 'timeout' : 'warn',
    userId: message.author.id,
    moderator: null,
    reason: `Auto-mod: ${rule.label.toLowerCase()} (${hit.detail})`,
    durationMs: mute ? s.muteMinutes * 60000 : null,
    auto: true,
    source: 'automod'
  });
  const action = result.error ? 'failed' : mute ? 'timeout' : 'warn';

  if (s.notify && message.channel?.send) {
    const muteText = s.muteMinutes % 60 === 0 ? `${s.muteMinutes / 60}h` : `${s.muteMinutes}m`;
    const tail = action === 'timeout'
      ? ` Muted for **${muteText}**.`
      : action === 'warn'
        ? ` Warning **${strikes + 1}/${s.warnings}**${strikes + 1 >= s.warnings ? ` — next time is a ${muteText} mute` : ''}.`
        : '';
    const notice = await message.channel
      .send({ content: `${rule.emoji} ${message.author}, ${rule.notice}.${tail}`, allowedMentions: { users: [message.author.id] } })
      .catch(() => null);
    if (notice) setTimeout(() => notice.delete().catch(() => null), 8000);
  }

  const embed = new EmbedBuilder()
    .setColor(action === 'timeout' ? '#ED4245' : '#F0B232')
    .setAuthor({ name: `${message.author.tag ?? message.author.username} (${message.author.id})`, iconURL: message.author.displayAvatarURL?.({ size: 64 }) || undefined })
    .setDescription(`${rule.emoji} **Auto-mod: ${rule.label}** in ${message.channel}\n${hit.detail}`)
    .addFields(
      { name: 'Action', value: action === 'timeout' ? `⏳ Timed out ${s.muteMinutes} min` : action === 'warn' ? `⚠️ Warning ${strikes + 1}/${s.warnings}` : `❌ ${result.error || 'failed'}`, inline: true },
      { name: 'Messages removed', value: String(refs.length), inline: true }
    );
  if (message.content) embed.addFields({ name: 'Message', value: message.content.slice(0, 1000) });
  sendLog(guild, 'automod', embed, {
    entry: {
      userId: message.author.id,
      userTag: message.author.tag ?? message.author.username,
      userAvatar: message.author.displayAvatarURL?.({ size: 64 }) || '',
      channelId: message.channelId,
      channelName: message.channel?.name || '',
      before: (message.content || '').slice(0, 1000),
      summary: `auto-mod: ${rule.label.toLowerCase()} → ${action === 'timeout' ? `timed out ${s.muteMinutes}m` : action === 'warn' ? `warning ${strikes + 1}/${s.warnings}` : 'action failed'}`,
      details: { rule: hit.rule, detail: hit.detail, action, removed: refs.length, error: result.error || null }
    }
  }).catch(() => null);
  return { action, strikes: strikes + 1, error: result.error || null };
}

/**
 * Called for every guild message. Returns true when auto-mod removed it (so it earns no XP etc.).
 */
async function handleAutomod(message, config) {
  if (!message.guild || message.author?.bot || message.webhookId || message.system) return false;
  const s = automodSettings(config);
  if (!s.enabled || isExempt(message, s)) return false;
  const key = `${message.guild.id}:${message.author.id}`;
  const hit = (await checkMessage(message, s)) || checkHistory(key, message, s);
  if (!hit) return false;
  await punish(message, s, hit);
  return true;
}

// Forget idle members so memory stays small.
setInterval(() => {
  const now = Date.now();
  for (const [key, list] of history) if (!list.length || now - list.at(-1).ts > HISTORY_MS) history.delete(key);
  for (const [key, ts] of lastStrike) if (now - ts > STRIKE_COOLDOWN_MS) lastStrike.delete(key);
  for (const [code, v] of inviteCache) if (now - v.at > INVITE_CACHE_MS) inviteCache.delete(code);
}, 5 * 60 * 1000).unref?.();

// ---------------------------------------------------------------- Settings

/** Validates a settings update (dashboard or /automod). Returns { patch } or { error }. */
function cleanSettings(guild, input) {
  const patch = {};
  const whole = (v, min, max, label) => {
    const n = Number.parseInt(v, 10);
    if (!(n >= min && n <= max)) throw new Error(`${label} must be ${min}–${max}.`);
    return n;
  };
  try {
    if (input.enabled !== undefined) patch['automod.enabled'] = !!input.enabled;
    const r = input.rules || {};
    const bool = (path, v) => v !== undefined && (patch[`automod.${path}`] = !!v);
    bool('flood.enabled', r.flood?.enabled);
    if (r.flood?.messages !== undefined) patch['automod.flood.messages'] = whole(r.flood.messages, 3, 30, 'Flood messages');
    if (r.flood?.seconds !== undefined) patch['automod.flood.seconds'] = whole(r.flood.seconds, 2, 60, 'Flood seconds');
    bool('duplicates.enabled', r.duplicates?.enabled);
    if (r.duplicates?.count !== undefined) patch['automod.duplicates.count'] = whole(r.duplicates.count, 2, 20, 'Repeats');
    if (r.duplicates?.seconds !== undefined) patch['automod.duplicates.seconds'] = whole(r.duplicates.seconds, 5, 300, 'Repeat window');
    bool('walls.enabled', r.walls?.enabled);
    if (r.walls?.maxLines !== undefined) patch['automod.walls.maxLines'] = whole(r.walls.maxLines, 5, 200, 'Max lines');
    bool('mentions.enabled', r.mentions?.enabled);
    if (r.mentions?.max !== undefined) patch['automod.mentions.max'] = whole(r.mentions.max, 2, 50, 'Mentions');
    bool('mentions.everyone', r.mentions?.everyone);
    bool('invites.enabled', r.invites?.enabled);
    bool('links.enabled', r.links?.enabled);
    if (r.links?.max !== undefined) patch['automod.links.max'] = whole(r.links.max, 1, 30, 'Links');
    bool('caps.enabled', r.caps?.enabled);
    if (r.caps?.percent !== undefined) patch['automod.caps.percent'] = whole(r.caps.percent, 50, 100, 'Caps %');
    if (input.warnings !== undefined) patch['automod.warnings'] = whole(input.warnings, 0, 10, 'Warnings before a mute');
    if (input.muteMinutes !== undefined) patch['automod.muteMinutes'] = whole(input.muteMinutes, 1, 40320, 'Mute length (minutes)');
    if (input.strikeResetHours !== undefined) patch['automod.strikeResetHours'] = whole(input.strikeResetHours, 1, 720, 'Strike reset (hours)');
    if (input.notify !== undefined) patch['automod.notify'] = !!input.notify;
    if (input.exemptRoleIds !== undefined) patch['automod.exemptRoleIds'] = [...new Set((input.exemptRoleIds || []).map(String))].filter((id) => guild.roles.cache.has(id)).slice(0, 25);
    if (input.exemptChannelIds !== undefined) patch['automod.exemptChannelIds'] = [...new Set((input.exemptChannelIds || []).map(String))].filter((id) => guild.channels.cache.has(id)).slice(0, 50);
  } catch (err) {
    return { error: err.message };
  }
  return { patch };
}

async function saveSettings(guild, input) {
  const { patch, error } = cleanSettings(guild, input);
  if (error) return { error };
  await GuildConfig.updateOne({ guildId: guild.id }, { $set: patch }, { upsert: true });
  const fresh = await GuildConfig.findOne({ guildId: guild.id }, { automod: 1 }).lean();
  return { settings: automodSettings(fresh) };
}

function missingPermissions(guild) {
  const me = guild.members.me;
  const need = [['ManageMessages', 'Manage Messages'], ['ModerateMembers', 'Timeout Members']];
  return need.filter(([flag]) => !me?.permissions.has(PermissionFlagsBits[flag])).map(([, label]) => label);
}

/** Recent auto-mod actions for the dashboard. */
async function recentActions(guildId, limit = 15) {
  return ModCase.find({ guildId, source: 'automod' }).sort({ createdAt: -1 }).limit(limit).lean();
}

module.exports = {
  RULES,
  automodSettings,
  normalize,
  wallReason,
  capsRatio,
  inviteCodes,
  checkMessage,
  checkHistory,
  isExempt,
  recentStrikes,
  punish,
  handleAutomod,
  cleanSettings,
  saveSettings,
  missingPermissions,
  recentActions,
  _history: history,
  _lastStrike: lastStrike
};
