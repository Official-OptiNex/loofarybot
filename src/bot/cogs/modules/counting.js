// Counting game: members count up one number at a time in a chosen channel. The bot reacts ✅ to each
// correct number; a wrong number (or counting twice in a row) resets the count to 0. Tracks the best run.
// Fully automatic once a channel is picked (/counting setup or dashboard Engagement → Counting).
// Grief-proof: deleting or editing the latest count can't rewind or hide it — the bot re-posts an
// authoritative record and the stored number never changes.
const { PermissionFlagsBits } = require('discord.js');
const GuildConfig = require('../../../database/models/GuildConfig');

// Two people typing the same next number at the same moment: the slower one isn't punished.
const SAME_NUMBER_GRACE_MS = 3000;
const MAX_EXPRESSION = 40;

function countingSettings(config) {
  const c = (config && config.counting) || {};
  return {
    enabled: !!c.enabled,
    channelId: c.channelId || null,
    current: Math.max(0, c.current || 0),
    lastUserId: c.lastUserId || null,
    lastMessageId: c.lastMessageId || null,
    lastCountAt: c.lastCountAt ? new Date(c.lastCountAt) : null,
    record: Math.max(0, c.record || 0),
    resets: Math.max(0, c.resets || 0),
    lastResetBy: c.lastResetBy || null,
    allowSameUser: !!c.allowSameUser,
    mathAllowed: c.mathAllowed !== false,
    numbersOnly: c.numbersOnly !== false,
    slowmodeSeconds: Number.isFinite(c.slowmodeSeconds) ? Math.max(0, Math.min(21600, c.slowmodeSeconds)) : 1200
  };
}

// ---------------------------------------------------------------- Parsing (no eval)

// Evaluates + - * / ^ and brackets. Returns a number, or null for anything else.
function evaluate(expr) {
  const tokens = expr.match(/\d+(?:\.\d+)?|[-+*/^()]/g);
  if (!tokens || tokens.join('') !== expr.replace(/\s+/g, '')) return null;
  let i = 0;
  const peek = () => tokens[i];
  const take = () => tokens[i++];
  function primary() {
    const t = take();
    if (t === '(') {
      const v = sum();
      if (take() !== ')') throw new Error('bracket');
      return v;
    }
    if (t === '-') return -primary();
    if (t === '+') return primary();
    if (t !== undefined && /^\d/.test(t)) return Number(t);
    throw new Error('token');
  }
  function power() {
    const base = primary();
    if (peek() === '^') {
      take();
      const exp = power();
      if (Math.abs(exp) > 64) throw new Error('big');
      return base ** exp;
    }
    return base;
  }
  function product() {
    let v = power();
    while (peek() === '*' || peek() === '/') v = take() === '*' ? v * power() : v / power();
    return v;
  }
  function sum() {
    let v = product();
    while (peek() === '+' || peek() === '-') v = take() === '+' ? v + product() : v - product();
    return v;
  }
  try {
    const v = sum();
    return i === tokens.length && Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * The number a message counts as, or null when it isn't a count (normal chat is ignored).
 * Only the start of the message matters: "12 nice" counts as 12. With math on, "3*4" counts as 12.
 */
const MAX_COUNT = 1e12;

function plainNumber(text) {
  const m = text.match(/^(\d+)(?!\d|\.\d|\s*[-+*/^×÷])/);
  const n = m ? Number(m[1]) : null;
  return n !== null && n <= MAX_COUNT ? n : null;
}

function parseCount(content, mathAllowed = true) {
  const raw = String(content || '').trim();
  if (!mathAllowed) return plainNumber(raw);
  const text = raw.replace(/(\d)\s*[x×]\s*(?=[\d(])/g, '$1*').replace(/÷/g, '/');
  const m = text.match(/^[\d\s+\-*/^().]+/);
  if (!m || !/\d/.test(m[0])) return null;
  const expr = m[0].trim();
  const v = expr.length <= MAX_EXPRESSION ? evaluate(expr) : null;
  // Not a valid sum ("6 xd", "5 - my fav") — fall back to the plain number it starts with.
  if (v === null) return plainNumber(raw);
  if (!Number.isInteger(v) || v < 0 || v > MAX_COUNT) return null;
  return v;
}

// ---------------------------------------------------------------- Game

const react = (message, emoji) => message.react(emoji).catch(() => null);

/**
 * Called for every guild message. Returns true when the message was a count in the counting channel
 * (right or wrong), so it's handled here.
 */
async function handleCounting(message, config) {
  const s = countingSettings(config);
  if (!s.enabled || !s.channelId || message.channelId !== s.channelId) return false;
  if (message.author.bot || message.webhookId || message.system) return false;
  const n = parseCount(message.content, s.mathAllowed);
  if (n === null) {
    // Numbers-only: quietly remove normal chatter so the channel stays clean (staff are exempt so they
    // can still post notes). The count is never touched by non-numbers.
    const isStaff = message.member?.permissions?.has(PermissionFlagsBits.ManageMessages);
    if (s.numbersOnly && !isStaff && message.deletable !== false) {
      await message.delete().catch(() => null);
      return true;
    }
    return false; // just chatting (numbers-only off, or a staff message)
  }

  const userId = message.author.id;
  const filter = { guildId: message.guild.id, 'counting.channelId': s.channelId, 'counting.enabled': true, 'counting.current': n - 1 };
  if (!s.allowSameUser) filter['counting.lastUserId'] = { $ne: userId };
  const before = await GuildConfig.findOneAndUpdate(
    filter,
    {
      $set: { 'counting.current': n, 'counting.lastUserId': userId, 'counting.lastMessageId': message.id, 'counting.lastCountAt': new Date() },
      $max: { 'counting.record': n }
    },
    { new: false, projection: { counting: 1 } }
  ).lean();

  if (before) {
    // The best run from before this one started — passing it earns a 🏆 (once, on the number that beats it).
    const bestBefore = before.counting?.bestBefore || 0;
    if (n % 1000 === 0) await react(message, '🎉');
    else if (n % 100 === 0) await react(message, '💯');
    else await react(message, '✅');
    if (bestBefore > 0 && n === bestBefore + 1) await react(message, '🏆');
    return true;
  }

  // Not the next number (or the same person twice). Look at the live state to explain why.
  const fresh = countingSettings(await GuildConfig.findOne({ guildId: message.guild.id }, { counting: 1 }).lean());
  if (!fresh.enabled || fresh.channelId !== s.channelId) return false;

  // Someone else posted this exact number a moment ago — they were just faster. No reset.
  if (n === fresh.current && fresh.lastUserId !== userId && fresh.lastCountAt && Date.now() - fresh.lastCountAt.getTime() < SAME_NUMBER_GRACE_MS) {
    await react(message, '👀');
    return true;
  }

  // Counting twice in a row: don't let it reset the run (griefers love that). Just remove the extra
  // count and nudge them to wait their turn — the count stays exactly where it was.
  if (n === fresh.current + 1 && fresh.lastUserId === userId && !fresh.allowSameUser) {
    if (message.deletable !== false) await message.delete().catch(() => null);
    const warn = await message.channel
      .send({ content: `⏳ ${message.author}, take turns — wait for someone else to count **${(fresh.current + 1).toLocaleString('en-US')}**.`, allowedMentions: { parse: [] } })
      .catch(() => null);
    if (warn?.delete) setTimeout(() => warn.delete().catch(() => null), 8000);
    return true;
  }

  await react(message, '❌');
  if (fresh.current === 0) {
    await message.channel.send({ content: '⚠️ The count starts at **1**.', allowedMentions: { parse: [] } }).catch(() => null);
    return true;
  }

  // Reset — only if nobody else has moved the count since we looked.
  const reset = await GuildConfig.updateOne(
    { guildId: message.guild.id, 'counting.current': fresh.current },
    {
      $set: {
        'counting.current': 0,
        'counting.lastUserId': null,
        'counting.lastMessageId': null,
        'counting.lastResetBy': userId,
        'counting.bestBefore': Math.max(fresh.record, fresh.current)
      },
      $inc: { 'counting.resets': 1 }
    }
  );
  if (reset.modifiedCount !== 1) return true;
  const why = `said **${n.toLocaleString('en-US')}** — it was **${(fresh.current + 1).toLocaleString('en-US')}**`;
  await message.channel
    .send({
      content: `💥 ${message.author} ${why}. The count ended at **${fresh.current.toLocaleString('en-US')}** · best: **${Math.max(fresh.record, fresh.current).toLocaleString('en-US')}**. Start again from **1**!`,
      allowedMentions: { parse: [] }
    })
    .catch(() => null);
  return true;
}

// Tampering with the latest count (deleting or editing it) never touches the stored number, so the run
// already stands. We re-post the count as a bot message so it can't be erased or disguised in the
// channel, and make THAT message the authoritative last count (so it can't be quietly rewound by
// tampering again). `prefix` describes what happened; the next-number line is appended.
async function reassertCount(message, s, prefix) {
  const channel = message.channel || message.client?.channels.cache.get(message.channelId);
  if (!channel?.send) return;
  const record = await channel
    .send({ content: `${prefix} Next number is **${(s.current + 1).toLocaleString('en-US')}**.`, allowedMentions: { parse: [] } })
    .catch(() => null);
  // Pin the record to the bot's own message, but only if nobody has counted since (atomic guard).
  if (record?.id) {
    await GuildConfig.updateOne(
      { guildId: message.guildId, 'counting.lastMessageId': message.id, 'counting.current': s.current },
      { $set: { 'counting.lastMessageId': record.id } }
    ).catch(() => null);
  }
}

// Someone deleted the latest count to try to hide/rewind it. The grief ("say a number then delete it")
// simply doesn't work — the bot keeps the record.
async function handleCountDeleted(message) {
  if (!message.guildId) return;
  if (message.author?.bot) return; // our own re-post was removed — don't loop
  const config = await GuildConfig.findOne({ guildId: message.guildId }, { counting: 1 }).lean();
  const s = countingSettings(config);
  if (!s.enabled || message.channelId !== s.channelId || s.lastMessageId !== message.id) return;
  await reassertCount(message, s, `📌 <@${s.lastUserId}> counted **${s.current.toLocaleString('en-US')}** then deleted it — that count still stands.`);
}

// Someone edited the latest count to a different number (e.g. "39" → "38") to confuse people. The
// stored count is unchanged, so re-assert it. An edit that still reads as the right number (adding
// trailing text like "39 lol") is left alone.
async function handleCountEdited(_oldMessage, newMessage) {
  const message = newMessage;
  if (!message || !message.guildId) return;
  if (message.author?.bot) return; // our own re-post, or another bot
  const content = message.content;
  if (content == null) return; // partial / embed-load update — nothing we can judge
  const config = await GuildConfig.findOne({ guildId: message.guildId }, { counting: 1 }).lean();
  const s = countingSettings(config);
  if (!s.enabled || message.channelId !== s.channelId || s.lastMessageId !== message.id) return;
  if (parseCount(content, s.mathAllowed) === s.current) return; // still shows the right number — fine
  await reassertCount(message, s, `✏️ <@${s.lastUserId}> edited their count — it still stands at **${s.current.toLocaleString('en-US')}**.`);
}

/** Validates a settings update (from /counting or the dashboard). Returns { patch } or { error }. */
function cleanSettings(guild, input) {
  const patch = {};
  if (input.enabled !== undefined) patch['counting.enabled'] = !!input.enabled;
  if (input.channelId !== undefined) {
    const id = input.channelId ? String(input.channelId) : null;
    const ch = id ? guild.channels.cache.get(id) : null;
    if (id && (!ch || !ch.isTextBased() || ch.isThread())) return { error: 'Pick a text channel in this server.' };
    patch['counting.channelId'] = id;
  }
  if (input.allowSameUser !== undefined) patch['counting.allowSameUser'] = !!input.allowSameUser;
  if (input.mathAllowed !== undefined) patch['counting.mathAllowed'] = !!input.mathAllowed;
  if (input.numbersOnly !== undefined) patch['counting.numbersOnly'] = !!input.numbersOnly;
  if (input.slowmodeSeconds !== undefined && input.slowmodeSeconds !== null && input.slowmodeSeconds !== '') {
    const sm = Number.parseInt(input.slowmodeSeconds, 10);
    if (!(sm >= 0 && sm <= 21600)) return { error: 'Slowmode must be 0–21600 seconds (up to 6 hours).' };
    patch['counting.slowmodeSeconds'] = sm;
  }
  if (input.current !== undefined && input.current !== null && input.current !== '') {
    const n = Number.parseInt(input.current, 10);
    if (!(n >= 0 && n <= 1e9)) return { error: 'The count must be a whole number from 0.' };
    patch['counting.current'] = n;
    patch['counting.lastUserId'] = null;
    patch['counting.lastMessageId'] = null;
  }
  return { patch };
}

async function saveSettings(guild, input) {
  const { patch, error } = cleanSettings(guild, input);
  if (error) return { error };
  const current = await GuildConfig.findOne({ guildId: guild.id }, { counting: 1 }).lean();
  const channelId = patch['counting.channelId'] !== undefined ? patch['counting.channelId'] : current?.counting?.channelId;
  if ((patch['counting.enabled'] ?? current?.counting?.enabled) && !channelId) return { error: 'Pick a counting channel first.' };
  const update = { $set: patch };
  if (patch['counting.current'] !== undefined) update.$max = { 'counting.record': patch['counting.current'] };
  await GuildConfig.updateOne({ guildId: guild.id }, update, { upsert: true });
  const fresh = await GuildConfig.findOne({ guildId: guild.id }, { counting: 1 }).lean();
  const settings = countingSettings(fresh);
  // Keep the channel's slowmode matched to the setting (grief protection). Best effort — needs Manage Channels.
  if (settings.enabled && settings.channelId) {
    const ch = guild.channels.cache.get(settings.channelId);
    if (ch?.setRateLimitPerUser) await ch.setRateLimitPerUser(settings.slowmodeSeconds, 'Counting channel slowmode').catch(() => null);
  }
  return { settings };
}

function registerCountingEvents(client) {
  client.on('messageDelete', (message) => handleCountDeleted(message).catch(() => null));
  client.on('messageUpdate', (oldMessage, newMessage) => handleCountEdited(oldMessage, newMessage).catch(() => null));
}

module.exports = { registerCountingEvents, evaluate, parseCount, countingSettings, handleCounting, handleCountDeleted, handleCountEdited, cleanSettings, saveSettings };
