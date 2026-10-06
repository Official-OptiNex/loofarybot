// Counting game: members count up one number at a time in a chosen channel. The bot reacts ✅ to each
// correct number; a wrong number (or counting twice in a row) resets the count to 0. Tracks the best run.
// Fully automatic once a channel is picked (/counting setup or dashboard Engagement → Counting).
// Grief-proof: deleting or editing the latest count can't rewind or hide it — the bot re-posts an
// authoritative record and the stored number never changes.
const { PermissionFlagsBits } = require('discord.js');
const GuildConfig = require('../../../database/models/GuildConfig');

// Two people typing the same next number at the same moment: the slower one isn't punished.
const SAME_NUMBER_GRACE_MS = 3000;

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
//
// A safe maths evaluator for the counting channel. Supports PEMDAS (+ - * / % ^, brackets, unary
// signs), factorials (n!), roots (√, ∛, root(x,n)), a set of functions (sqrt, cbrt, abs, floor, ceil,
// round, trunc, sign, exp, ln, log, log2, log10, min, max, gcd, lcm, mod, pow, nCr/choose, nPr/perm,
// sin/cos/tan) and constants (pi/π, e, tau/τ, phi), plus bound-variable summation (∑/sum), product
// (∏/prod) and definite integral (∫/integral). It parses a maximal valid expression from the start of
// the message, so trailing chat ("3*4 nice") is ignored. No eval(); every loop and step is capped so a
// message can't tie up the bot.

const MAX_COUNT = 1e12;
const ITER_BUDGET = 100000; // total summation / product / integral steps allowed per expression

const CONSTS = { pi: Math.PI, e: Math.E, tau: Math.PI * 2, phi: (1 + Math.sqrt(5)) / 2 };
const FN1 = {
  sqrt: Math.sqrt, cbrt: Math.cbrt, abs: Math.abs, floor: Math.floor, ceil: Math.ceil, round: Math.round,
  trunc: Math.trunc, sign: Math.sign, exp: Math.exp, ln: Math.log, log2: Math.log2, log10: Math.log10,
  sin: Math.sin, cos: Math.cos, tan: Math.tan
};

const req = (v, n) => { if (v.length !== n) throw new Error('args'); };
const intArg = (v) => { if (!Number.isInteger(v)) throw new Error('int'); return v; };
const gcd2 = (a, b) => { a = Math.abs(a); b = Math.abs(b); while (b) { [a, b] = [b, a % b]; } return a; };
function factorial(n) {
  if (!Number.isInteger(n) || n < 0 || n > 170) throw new Error('factorial');
  let r = 1;
  for (let k = 2; k <= n; k++) r *= k;
  return r;
}
function nCr(n, k) {
  if (!Number.isInteger(n) || !Number.isInteger(k) || n < 0 || k < 0 || k > n) throw new Error('nCr');
  k = Math.min(k, n - k);
  if (k > 100000) throw new Error('nCr big');
  let r = 1;
  for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1);
  return Math.round(r);
}
function nPr(n, k) {
  if (!Number.isInteger(n) || !Number.isInteger(k) || n < 0 || k < 0 || k > n || k > 100000) throw new Error('nPr');
  let r = 1;
  for (let i = 0; i < k; i++) r *= n - i;
  return r;
}

// Tokeniser: numbers, names (functions/constants/variables), operators, and the root symbols. Stops at
// the first character it doesn't recognise, leaving the rest as trailing chat.
const NUM_RE = /^(?:\d+(?:\.\d+)?|\.\d+)/;
const NAME_RE = /^[A-Za-z_]\w*/;
function tokenize(str) {
  const tokens = [];
  let s = str;
  while (s.length && tokens.length < 400) {
    if (s[0] === ' ' || s[0] === '\t') { s = s.slice(1); continue; }
    let m = s.match(NUM_RE);
    if (m) { tokens.push({ t: 'num', v: Number(m[0]) }); s = s.slice(m[0].length); continue; }
    m = s.match(NAME_RE);
    if (m) { tokens.push({ t: 'name', v: m[0].toLowerCase() }); s = s.slice(m[0].length); continue; }
    if ('+-*/%^!(),'.includes(s[0]) || s[0] === '√' || s[0] === '∛') { tokens.push({ t: s[0] }); s = s.slice(1); continue; }
    break;
  }
  return tokens;
}

// Recursive-descent parser → AST. Dangling operators at the end are backed out (try/restore) so a
// trailing bit of chat never fails the whole parse.
function parseExpr(tokens) {
  let i = 0;
  const eat = (t) => { if (tokens[i] && tokens[i].t === t) return tokens[i++]; throw new Error('expected ' + t); };
  function primary() {
    const tk = tokens[i];
    if (!tk) throw new Error('eof');
    if (tk.t === '(') { i++; const e = addsub(); eat(')'); return e; }
    if (tk.t === 'num') { i++; return { k: 'num', v: tk.v }; }
    if (tk.t === 'name') {
      i++;
      if (tokens[i] && tokens[i].t === '(') {
        i++;
        const args = [];
        if (tokens[i] && tokens[i].t !== ')') { args.push(addsub()); while (tokens[i] && tokens[i].t === ',') { i++; args.push(addsub()); } }
        eat(')');
        return { k: 'call', name: tk.v, args };
      }
      return { k: 'name', name: tk.v };
    }
    throw new Error('primary');
  }
  function postfix() { let e = primary(); while (tokens[i] && tokens[i].t === '!') { i++; e = { k: 'fact', x: e }; } return e; }
  function power() {
    const base = postfix();
    if (tokens[i] && tokens[i].t === '^') { const save = i; i++; let e; try { e = unary(); } catch { i = save; return base; } return { k: 'pow', l: base, r: e }; }
    return base;
  }
  function unary() {
    const tk = tokens[i];
    if (tk && (tk.t === '+' || tk.t === '-' || tk.t === '√' || tk.t === '∛')) { i++; return { k: 'unary', op: tk.t, x: unary() }; }
    return power();
  }
  function binLevel(ops, next) {
    let e = next();
    while (tokens[i] && ops.includes(tokens[i].t)) { const op = tokens[i].t; const save = i; i++; let r; try { r = next(); } catch { i = save; break; } e = { k: 'bin', op, l: e, r }; }
    return e;
  }
  const muldiv = () => binLevel(['*', '/', '%'], unary);
  const addsub = () => binLevel(['+', '-'], muldiv);
  return addsub(); // trailing tokens are intentionally ignored
}

function evalNode(node, env) {
  switch (node.k) {
    case 'num': return node.v;
    case 'name':
      if (env.vars.has(node.name)) return env.vars.get(node.name);
      if (node.name in CONSTS) return CONSTS[node.name];
      throw new Error('unknown ' + node.name);
    case 'unary': {
      const x = evalNode(node.x, env);
      if (node.op === '-') return -x;
      if (node.op === '+') return x;
      if (node.op === '√') { if (x < 0) throw new Error('√<0'); return Math.sqrt(x); }
      return Math.cbrt(x);
    }
    case 'fact': return factorial(evalNode(node.x, env));
    case 'pow': {
      const b = evalNode(node.l, env);
      const e = evalNode(node.r, env);
      if (Math.abs(e) > 1024) throw new Error('big exp');
      return b ** e;
    }
    case 'bin': {
      const l = evalNode(node.l, env);
      const r = evalNode(node.r, env);
      if (node.op === '+') return l + r;
      if (node.op === '-') return l - r;
      if (node.op === '*') return l * r;
      if (node.op === '/') { if (r === 0) throw new Error('/0'); return l / r; }
      if (r === 0) throw new Error('%0');
      return l % r;
    }
    case 'call': return evalCall(node, env);
  }
  throw new Error('node');
}

function spend(env, n) { env.budget -= n; if (env.budget < 0) throw new Error('too much work'); }

function evalCall(node, env) {
  const { name, args } = node;
  if (name === 'sum' || name === 'prod' || name === 'integral') {
    if (args.length !== 4 || args[0].k !== 'name') throw new Error(name);
    const v = args[0].name;
    const a = evalNode(args[1], env);
    const b = evalNode(args[2], env);
    if (!Number.isFinite(a) || !Number.isFinite(b)) throw new Error('range');
    const had = env.vars.has(v);
    const prev = env.vars.get(v);
    try {
      if (name === 'integral') {
        const N = 1000; spend(env, N);
        const h = (b - a) / N;
        const f = (x) => { env.vars.set(v, x); const y = evalNode(args[3], env); if (!Number.isFinite(y)) throw new Error('∫'); return y; };
        let s = f(a) + f(b);
        for (let k = 1; k < N; k++) s += (k % 2 ? 4 : 2) * f(a + k * h);
        const res = (s * h) / 3;
        const near = Math.round(res);
        return Math.abs(res - near) < 1e-6 ? near : res; // snap to an integer when we're basically on one
      }
      if (!Number.isInteger(a) || !Number.isInteger(b)) throw new Error('int range');
      const step = b >= a ? 1 : -1;
      spend(env, Math.abs(b - a) + 1);
      let acc = name === 'sum' ? 0 : 1;
      for (let x = a; step > 0 ? x <= b : x >= b; x += step) {
        env.vars.set(v, x);
        const t = evalNode(args[3], env);
        acc = name === 'sum' ? acc + t : acc * t;
        if (!Number.isFinite(acc)) throw new Error('overflow');
      }
      return acc;
    } finally {
      if (had) env.vars.set(v, prev);
      else env.vars.delete(v);
    }
  }
  const vals = args.map((a) => evalNode(a, env));
  if (FN1[name]) { req(vals, 1); return FN1[name](vals[0]); }
  switch (name) {
    case 'root': req(vals, 2); { const [x, r] = vals; if (r === 0) throw new Error('root0'); return x < 0 && Math.round(r) % 2 ? -(Math.abs(x) ** (1 / r)) : x ** (1 / r); }
    case 'pow': req(vals, 2); if (Math.abs(vals[1]) > 1024) throw new Error('big'); return vals[0] ** vals[1];
    case 'log': if (vals.length === 1) return Math.log10(vals[0]); req(vals, 2); return Math.log(vals[0]) / Math.log(vals[1]);
    case 'mod': req(vals, 2); if (vals[1] === 0) throw new Error('%0'); return vals[0] % vals[1];
    case 'min': if (!vals.length) throw new Error('min'); return Math.min(...vals);
    case 'max': if (!vals.length) throw new Error('max'); return Math.max(...vals);
    case 'gcd': if (vals.length < 2) throw new Error('gcd'); return vals.map(intArg).reduce((x, y) => gcd2(x, y));
    case 'lcm': if (vals.length < 2) throw new Error('lcm'); return vals.map(intArg).reduce((x, y) => { const g = gcd2(x, y); return g ? Math.abs((x / g) * y) : 0; });
    case 'ncr': case 'choose': case 'comb': req(vals, 2); return nCr(intArg(vals[0]), intArg(vals[1]));
    case 'npr': case 'perm': req(vals, 2); return nPr(intArg(vals[0]), intArg(vals[1]));
    case 'fact': case 'factorial': req(vals, 1); return factorial(intArg(vals[0]));
  }
  throw new Error('fn ' + name);
}

// Evaluates a maths expression. Returns a finite number, or null for anything that isn't valid maths.
function evaluate(expr) {
  try {
    const tokens = tokenize(String(expr).slice(0, 240));
    if (!tokens.length) return null;
    const ast = parseExpr(tokens);
    const v = evalNode(ast, { vars: new Map(), budget: ITER_BUDGET });
    return Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * The number a message counts as, or null when it isn't a count (normal chat is ignored).
 * Only the start matters: "12 nice" counts as 12. With math on, "3*4", "5!", "√144", "∑(i,1,5,i)" etc.
 */
function plainNumber(text) {
  const m = String(text).match(/^(\d+)(?!\d|\.\d|\s*[-+*/^×÷])/);
  const n = m ? Number(m[1]) : null;
  return n !== null && n <= MAX_COUNT ? n : null;
}

function parseCount(content, mathAllowed = true) {
  const raw = String(content || '').trim();
  if (!raw) return null;
  if (!mathAllowed) return plainNumber(raw);
  // Normalise the common maths symbols, then evaluate the start of the message.
  const pre = raw
    .replace(/(\d)\s*[x×·]\s*(?=[\d.(√∛])/gi, '$1*')
    .replace(/×/g, '*')
    .replace(/÷/g, '/')
    .replace(/−/g, '-')
    .replace(/[∑Σ]/g, 'sum')
    .replace(/∏/g, 'prod')
    .replace(/∫/g, 'integral');
  const v = evaluate(pre);
  // Not valid maths, or not a usable count (negative, fractional, too big) — fall back to a plain
  // number at the start ("12 nice" → 12), which is null for ordinary chat.
  if (v === null || !Number.isInteger(v) || v < 0 || v > MAX_COUNT) return plainNumber(raw);
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
