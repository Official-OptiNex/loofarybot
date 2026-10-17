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
    bannedRoleId: c.bannedRoleId || null,
    bans: Array.isArray(c.bans) ? c.bans : [],
    allowSameUser: !!c.allowSameUser,
    mathAllowed: c.mathAllowed !== false,
    numbersOnly: c.numbersOnly !== false,
    slowmodeSeconds: Number.isFinite(c.slowmodeSeconds) ? Math.max(0, Math.min(21600, c.slowmodeSeconds)) : 1200,
    participants: Array.isArray(c.participants) ? c.participants : [],
    goalsHit: Math.max(0, c.goalsHit || 0),
    goals: goalSettings(c.goals)
  };
}

// ---------------------------------------------------------------- Hidden goals
//
// Every `every` numbers (15 by default) everyone who has counted in the current run gets XP: the first
// goal of a run pays baseXp, each later one stepXp more (100, 150, 200…, optionally capped). Bonus
// numbers (multiples of a bonus's `every`, e.g. 100) are goals too and pay the ladder + the bonus. A wrong number resets the run, the
// participants and the goal ladder. Nothing tells members where the goals are.

const GOAL_MESSAGE =
  '🎯 **Secret goal reached at {number}!** {people} counter{s} this run just got **+{xp} XP** each{bonusText}. Keep going… the next one’s a surprise 🤫';

function goalSettings(g = {}) {
  const num = (v, d) => (Number.isFinite(v) && v >= 0 ? v : d);
  return {
    enabled: !!g.enabled,
    every: Math.max(1, Math.floor(num(g.every, 15)) || 15),
    baseXp: num(g.baseXp, 100),
    stepXp: num(g.stepXp, 50),
    maxXp: num(g.maxXp, 0),
    bonuses: (Array.isArray(g.bonuses) ? g.bonuses : [{ every: 100, xp: 250 }, { every: 1000, xp: 2500 }])
      .map((b) => ({ every: Math.floor(Number(b?.every)), xp: Math.floor(Number(b?.xp)) }))
      .filter((b) => b.every >= 1 && b.xp > 0),
    message: g.message || null,
    ping: !!g.ping
  };
}

const isGoal = (goals, n) => n > 0 && (n % goals.every === 0 || goals.bonuses.some((b) => n % b.every === 0));
/** The next goal number after `current`. */
function nextGoal(goals, current) {
  for (let n = current + 1; n <= current + goals.every; n++) if (isGoal(goals, n)) return n;
  return current + goals.every;
}

/** The XP a goal at `n` pays (the `hit`-th goal of the run, 0-based). Returns { xp, base, bonus }. */
function goalReward(goals, n, hit) {
  let base = goals.baseXp + goals.stepXp * hit;
  if (goals.maxXp > 0) base = Math.min(base, goals.maxXp);
  const bonus = goals.bonuses.filter((b) => n % b.every === 0).reduce((t, b) => t + b.xp, 0);
  return { xp: base + bonus, base, bonus };
}

/** After an accepted count `n`: pays out a hidden goal if `n` is one (once — atomically claimed). */
async function maybeRewardGoal(message, n, goals) {
  if (!goals.enabled || !isGoal(goals, n)) return null;
  const before = await GuildConfig.findOneAndUpdate(
    { guildId: message.guild.id, 'counting.lastGoalAt': { $ne: n } },
    { $set: { 'counting.lastGoalAt': n }, $inc: { 'counting.goalsHit': 1 } },
    { new: false, projection: { counting: 1, levelingEnabled: 1 } }
  ).lean();
  if (!before) return null; // already paid (e.g. the same message seen twice)
  const people = [...new Set(before.counting?.participants || [])];
  if (!people.length || before.levelingEnabled === false) return null;
  const { xp, base, bonus } = goalReward(goals, n, Math.max(0, before.counting?.goalsHit || 0));
  if (xp <= 0) return null;
  const { adjustXp } = require('./leveling');
  for (const id of people) await adjustXp(message.guild, id, xp).catch(() => null);
  const fmt = (v) => v.toLocaleString('en-US');
  const mentions = people.map((id) => `<@${id}>`).join(' ');
  const text = (goals.message || GOAL_MESSAGE)
    .replace(/\{number\}/gi, fmt(n))
    .replace(/\{xp\}/gi, fmt(xp))
    .replace(/\{base\}/gi, fmt(base))
    .replace(/\{bonus\}/gi, fmt(bonus))
    .replace(/\{bonusText\}/gi, bonus ? ` (incl. a **+${fmt(bonus)}** bonus for ${fmt(n)}!)` : '')
    .replace(/\{people\}/gi, fmt(people.length))
    .replace(/\{s\}/gi, people.length === 1 ? '' : 's')
    .replace(/\{goal\}/gi, fmt((before.counting?.goalsHit || 0) + 1))
    .replace(/\{mentions\}/gi, mentions)
    .slice(0, 2000);
  await message.channel
    .send({ content: text, allowedMentions: goals.ping ? { users: people.slice(0, 100) } : { parse: [] } })
    .catch(() => null);
  return { xp, base, bonus, people };
}

// ---------------------------------------------------------------- Parsing (no eval)
//
// A safe maths evaluator for the counting channel. Supports PEMDAS (+ - * / % ^ and **, brackets, unary
// signs), superscript powers (3², 2⁻¹), implicit multiplication (2(3), 2π, 2√9), factorials (n!), roots
// (√, ∛, ∜, ³√, root(x,n)), a set of functions (sqrt, cbrt, abs, floor, ceil, round, trunc, sign, exp,
// ln, log, log2, log10, min, max, gcd, lcm, mod / "a mod b", pow, nCr/choose, nPr/perm, sin/cos/tan) and
// constants (pi/π, e, tau/τ, phi/φ), plus bound-variable summation (∑/sum), product (∏/prod) and definite
// integral (∫/integral). Discord formatting (**5**), keycaps (5️⃣) and thousands separators (1,000) are
// understood, and results a hair off a whole number (floating point) snap to it.
// The maths must be the whole message, or be followed by chat after a space ("3*4 nice") or by
// punctuation/emoji ("5!", "5🔥"). If anything maths-like is left that we couldn't read ("2 3", "5th"),
// the message is unreadable — it gets ❓ and never counts as just the part we understood (or resets).
// No eval(); every loop and step (incl. factorials and nCr) is capped so a message can't tie up the bot.

const MAX_COUNT = 1e12;
const ITER_BUDGET = 100000; // total summation / product / integral steps allowed per expression

const CONSTS = { pi: Math.PI, e: Math.E, tau: Math.PI * 2, phi: (1 + Math.sqrt(5)) / 2 };
const FN1 = {
  sqrt: Math.sqrt, cbrt: Math.cbrt, abs: Math.abs, floor: Math.floor, ceil: Math.ceil, round: Math.round,
  trunc: Math.trunc, sign: Math.sign, exp: Math.exp, ln: Math.log, log2: Math.log2, log10: Math.log10,
  sin: Math.sin, cos: Math.cos, tan: Math.tan
};

const req = (v, n) => { if (v.length !== n) throw new Error('args'); };
const intArg = (v) => { v = snap(v); if (!Number.isInteger(v)) throw new Error('int'); return v; };
// Remainder that's never negative for a positive divisor (-7 mod 3 = 2), like in maths.
function modulo(a, b) {
  if (b === 0) throw new Error('%0');
  const r = a % b;
  return r !== 0 && (r < 0) !== (b < 0) ? r + b : r;
}
const gcd2 = (a, b) => { a = Math.abs(a); b = Math.abs(b); while (b) { [a, b] = [b, a % b]; } return a; };
function factorial(n, env) {
  n = snap(n);
  if (!Number.isInteger(n) || n < 0 || n > 170) throw new Error('factorial');
  if (env) spend(env, n);
  let r = 1;
  for (let k = 2; k <= n; k++) r *= k;
  return r;
}
function nCr(n, k, env) {
  if (!Number.isInteger(n) || !Number.isInteger(k) || n < 0 || k < 0 || k > n) throw new Error('nCr');
  k = Math.min(k, n - k);
  if (k > 100000) throw new Error('nCr big');
  if (env) spend(env, k);
  let r = 1;
  for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1);
  return Math.round(r);
}
function nPr(n, k, env) {
  if (!Number.isInteger(n) || !Number.isInteger(k) || n < 0 || k < 0 || k > n || k > 100000) throw new Error('nPr');
  if (env) spend(env, k);
  let r = 1;
  for (let i = 0; i < k; i++) r *= n - i;
  return r;
}

// ---- Reading what people type
//
// Before parsing, a message is normalised: Discord formatting around the number (**5**, *3*, ||5||,
// `5`, # headings, > quotes) is removed; keycap emoji (5️⃣, 🔟) become digits; superscript powers
// become ^ (3² → 3^(2), 2⁻¹ → 2^(-1)); fancy/fullwidth characters are simplified (NFKC); and maths
// symbols map to operators (× ✕ ⋅ ∙ → *, ÷ → /, − – → -, ** → ^, π τ φ → pi tau phi, ∑ Σ → sum,
// ∏ → prod, ∫ → integral, ³√ → ∛, ⁴√ → ∜). Thousands separators (1,000) are dropped.

const SUPERSCRIPT = { '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9', '⁺': '+', '⁻': '-', '⁽': '(', '⁾': ')' };
// Function names a message may start with (so "sqrt(16)" is maths, but "hello(" is chat).
const FUNCTIONS = new Set([...Object.keys(FN1), 'root', 'pow', 'log', 'mod', 'min', 'max', 'gcd', 'lcm', 'ncr', 'choose', 'comb', 'npr', 'perm', 'fact', 'factorial', 'sum', 'prod', 'integral']);

function stripMarkdown(s) {
  let prev;
  do {
    prev = s;
    s = s.replace(/^(?:#{1,3}|-#|>{1,3})\s+/, '').trim(); // headings, subtext, quotes
    // A formatted chunk at the start: **5**, *3*(-1*-1)*, __5__, ~~5~~, ||5||, `5` (rest of the message kept).
    s = s.replace(/^(\*{1,3}|_{1,2}|~~|\|\||`+)(.+?)\1(?!\S)/s, '$2').trim();
  } while (s !== prev);
  return s;
}

function normalize(raw) {
  let s = stripMarkdown(String(raw || '').trim());
  s = s
    .replace(/([0-9])️?⃣/g, '$1') // keycaps 5️⃣
    .replace(/🔟/g, '10')
    .replace(/²√/g, '√')
    .replace(/³√/g, '∛')
    .replace(/⁴√/g, '∜')
    .replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁽⁾]+/g, (m) => `^(${[...m].map((c) => SUPERSCRIPT[c]).join('')})`)
    .normalize('NFKC')
    .replace(/\*\*/g, '^')
    .replace(/(\d|\))\s*[x×·]\s*(?=[\d.(√∛∜])/gi, '$1*')
    .replace(/[×✕✖⨯⋅∙]/g, '*')
    .replace(/[÷∕⁄]/g, '/')
    .replace(/[−–‐‑﹣]/g, '-')
    .replace(/π/g, 'pi')
    .replace(/τ/g, 'tau')
    .replace(/[φϕ]/g, 'phi')
    .replace(/[∑Σ]/g, 'sum')
    .replace(/∏/g, 'prod')
    .replace(/∫/g, 'integral')
    .replace(/([\w)!.])\s+mod\s+(?=[\w(.√∛∜+-])/gi, '$1 % ') // "17 mod 5"
    // 1,000 / 12,345,678 → digits (not inside function arguments like gcd(12,180)).
    .replace(/(^|[\s+\-*/^])(\d{1,3}(?:,\d{3})+)(?![\d,]|\.\d)/g, (_, pre, n) => pre + n.replace(/,/g, ''));
  return s;
}

// Does the message start like maths (a number, a bracket, a root, a sign before one, or a function call)?
function looksLikeMaths(s) {
  if (/^(?:[\d.(√∛∜]|[+-]\s*[\d.(√∛∜])/.test(s)) return true;
  const m = s.match(/^([a-z]\w*)\s*\(/i);
  if (m && FUNCTIONS.has(m[1].toLowerCase())) return true;
  return /^(?:pi|tau|phi|e)\s*[-+*/^%(]/i.test(s);
}

// What may follow the maths: nothing, chat after a space ("12 nice", "5 (finally)"), or punctuation /
// emoji glued on ("5.", "5?", "5🔥"). More maths, digits or letters glued on means we couldn't read it
// all ("3 2", "5th", "3²" if it weren't supported) — never count just the part we understood.
function trailingOk(rest) {
  if (!rest) return true;
  if (/^\s/.test(rest)) {
    const t = rest.trimStart();
    if (!t || /^\(\s*[a-z]/i.test(t)) return true;
    return !/^[\d+\-*/%^!=.,()√∛∜]/.test(t);
  }
  return /^[.,!?:;~…'"]+(?:\s|$)/.test(rest) || /^[^\w\s+\-*/%^=().,√∛∜]/u.test(rest);
}

// Tokeniser: numbers (incl. 1.5, .5, 2e3), names (functions/constants/variables), operators and the
// root symbols. Each token remembers where it ends and whether whitespace came before it.
const NUM_RE = /^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/i;
const NAME_RE = /^[A-Za-z_]\w*/;
// Long enough for any Discord message (4000 characters with Nitro). Maths that hits a limit counts as
// unreadable, rather than counting whatever part of it fit.
const MAX_EXPR_CHARS = 4000;
const MAX_TOKENS = 2500;
function tokenize(str) {
  const tokens = [];
  let pos = 0;
  let ws = false;
  while (pos < str.length) {
    if (tokens.length >= MAX_TOKENS) throw new Error('too long');
    const s = str.slice(pos);
    if (/^\s/.test(s)) { pos++; ws = true; continue; }
    let m = s.match(NUM_RE);
    let tk = null;
    if (m) tk = { t: 'num', v: Number(m[0]), len: m[0].length };
    else if ((m = s.match(NAME_RE))) tk = { t: 'name', v: m[0].toLowerCase(), len: m[0].length };
    else if ('+-*/%^!(),√∛∜'.includes(s[0])) tk = { t: s[0], len: 1 };
    else break;
    tokens.push({ ...tk, ws, end: pos + tk.len });
    pos += tk.len;
    ws = false;
  }
  return tokens;
}

// Recursive-descent parser → { ast, used } (how many tokens the expression used). Dangling operators at
// the end are backed out (try/restore); the caller decides whether what's left over is fine.
// Implicit multiplication works when things are written together: 2(3), (2)(3), 2pi, 2√9, 3x.
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
    if (tk && (tk.t === '+' || tk.t === '-' || tk.t === '√' || tk.t === '∛' || tk.t === '∜')) { i++; return { k: 'unary', op: tk.t, x: unary() }; }
    return power();
  }
  // Written-together multiplication: the next token touches this one and starts a new factor.
  const implicitNext = () => {
    const tk = tokens[i];
    if (!tk || tk.ws) return false;
    if (tk.t === '(' || tk.t === '√' || tk.t === '∛' || tk.t === '∜' || tk.t === 'num') return true;
    return tk.t === 'name' && (tk.v in CONSTS || FUNCTIONS.has(tk.v) || tk.v.length === 1);
  };
  function muldiv() {
    let e = unary();
    for (;;) {
      const tk = tokens[i];
      if (tk && ['*', '/', '%'].includes(tk.t)) {
        const save = i; i++;
        let r; try { r = unary(); } catch { i = save; break; }
        e = { k: 'bin', op: tk.t, l: e, r };
      } else if (implicitNext()) {
        const save = i;
        let r; try { r = unary(); } catch { i = save; break; }
        e = { k: 'bin', op: '*', l: e, r };
      } else break;
    }
    return e;
  }
  function addsub() {
    let e = muldiv();
    while (tokens[i] && (tokens[i].t === '+' || tokens[i].t === '-')) {
      const op = tokens[i].t; const save = i; i++;
      let r; try { r = muldiv(); } catch { i = save; break; }
      e = { k: 'bin', op, l: e, r };
    }
    return e;
  }
  const ast = addsub();
  return { ast, used: i };
}
// Floating-point maths is slightly off at times (0.1+0.2+0.7 = 0.9999999999999999, 4.35*100 =
// 434.99999999999994, √2² = 2.0000000000000004): anything within a hair of a whole number is that number.
function snap(v) {
  if (!Number.isFinite(v)) return v;
  const near = Math.round(v);
  return Math.abs(v - near) <= 1e-9 * Math.max(1, Math.abs(v)) ? near : v;
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
      if (node.op === '∜') { if (x < 0) throw new Error('∜<0'); return Math.sqrt(Math.sqrt(x)); }
      return Math.cbrt(x);
    }
    case 'fact': return factorial(evalNode(node.x, env), env);
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
      return modulo(l, r);
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
    case 'mod': req(vals, 2); return modulo(vals[0], vals[1]);
    case 'min': if (!vals.length) throw new Error('min'); return Math.min(...vals);
    case 'max': if (!vals.length) throw new Error('max'); return Math.max(...vals);
    case 'gcd': if (vals.length < 2) throw new Error('gcd'); return vals.map(intArg).reduce((x, y) => gcd2(x, y));
    case 'lcm': if (vals.length < 2) throw new Error('lcm'); return vals.map(intArg).reduce((x, y) => { const g = gcd2(x, y); return g ? Math.abs((x / g) * y) : 0; });
    case 'ncr': case 'choose': case 'comb': req(vals, 2); return nCr(intArg(vals[0]), intArg(vals[1]), env);
    case 'npr': case 'perm': req(vals, 2); return nPr(intArg(vals[0]), intArg(vals[1]), env);
    case 'fact': case 'factorial': req(vals, 1); return factorial(intArg(vals[0]), env);
  }
  throw new Error('fn ' + name);
}

// Evaluates a whole maths expression (already normalised). Returns a number, or null when it isn't
// valid maths or something is left over that we couldn't read.
function evaluate(expr) {
  const r = evalPrefix(String(expr));
  return r && trailingOk(r.rest) ? r.value : null;
}

// Parses and evaluates the maths at the start of `str`: { value, rest } (rest = the text after it), or null.
function evalPrefix(str) {
  try {
    if (str.length > MAX_EXPR_CHARS) return null;
    const tokens = tokenize(str);
    if (!tokens.length) return null;
    const { ast, used } = parseExpr(tokens);
    const value = snap(evalNode(ast, { vars: new Map(), budget: ITER_BUDGET }));
    if (!Number.isFinite(value)) return null;
    return { value, rest: str.slice(tokens[used - 1].end) };
  } catch {
    return null;
  }
}

/**
 * Reads a counting message. Returns:
 * - { n } — the number it counts as ("12 nice" → 12; with maths on "3*4", "3²", "5!", "√144", "2(3)"…),
 * - { bad, value? } — it looks like a count but isn't a usable one: 'unreadable' (maths we can't read, or
 *   more maths/letters glued on), 'fraction' (3.5), 'negative', 'huge' (over a trillion). Never resets.
 * - null — ordinary chat.
 */
function readCount(content, mathAllowed = true) {
  const s = normalize(content);
  if (!s) return null;
  if (!mathAllowed) {
    const m = s.match(/^\d+/);
    if (!m) return null;
    const n = Number(m[0]);
    if (!trailingOk(s.slice(m[0].length))) return { bad: 'unreadable' };
    return n <= MAX_COUNT ? { n } : { bad: 'huge' };
  }
  if (!looksLikeMaths(s)) return null;
  const r = evalPrefix(s);
  // "100!" / "99999!" — a factorial too big to be a count is just the excited number typed.
  const excited = s.match(/^(\d+)!+$/);
  if (excited && (!r || r.value > MAX_COUNT)) return Number(excited[1]) <= MAX_COUNT ? { n: Number(excited[1]) } : { bad: 'huge' };
  if (!r || !trailingOk(r.rest)) return { bad: 'unreadable' };
  if (r.value < 0) return { bad: 'negative', value: r.value };
  if (!Number.isInteger(r.value)) return { bad: 'fraction', value: r.value };
  if (r.value > MAX_COUNT) return { bad: 'huge', value: r.value };
  return { n: r.value };
}

/** The number a message counts as, or null (chat, or not a usable count). */
function parseCount(content, mathAllowed = true) {
  const r = readCount(content, mathAllowed);
  return r && r.n !== undefined ? r.n : null;
}

// ---------------------------------------------------------------- Game

const react = (message, emoji) => message.react(emoji).catch(() => null);

// The "6-7" brainrot meme. Someone writing 67+67 (= 134) as their count gets gently roasted: we remove
// their message, @ them, state the real count, and add a cringe line. Matches "67+67", "67 + 67",
// "67+67 lol" — but not "67+670". (Only fires when it's accepted as the next count; math must be on.)
const SIXTY_SEVEN_RE = /^\s*67\s*\+\s*67(?![\d.])/;
const isSixtySeven = (content) => SIXTY_SEVEN_RE.test(String(content || ''));
const SIXTY_SEVEN_LINES = [
  "that's cringe 💀 we don't do that here",
  '6-7 💀 please touch some grass',
  'certified cringe moment 🫠',
  'the brainrot is real 😬 go outside',
  'nobody says that anymore 💀',
  'caught in 4k being cringe 📸'
];
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

/**
 * Called for every guild message. Returns true when the message was a count in the counting channel
 * (right or wrong), so it's handled here.
 */
async function handleCounting(message, config) {
  const s = countingSettings(config);
  if (!s.enabled || !s.channelId || message.channelId !== s.channelId) return false;
  if (message.author.bot || message.webhookId || message.system) return false;
  const read = readCount(message.content, s.mathAllowed);
  if (read && read.bad) {
    // Looks like a count but isn't one we can use (unreadable maths, 3.5, a negative…). It doesn't
    // count and never resets the run — just say why and leave the message.
    await react(message, '❓');
    const value = Number.isFinite(read.value) ? +read.value.toPrecision(6) : null;
    const why = {
      unreadable: s.mathAllowed ? "I couldn't read that maths" : 'maths is off here — type the plain number',
      fraction: `that works out to **${value}** — counts are whole numbers`,
      negative: `that works out to **${value}** — counts can't be negative`,
      huge: "that number's way too big"
    }[read.bad];
    const hint = await message.channel
      .send({ content: `❓ ${message.author}, ${why}. It didn't count (no reset) — try writing it another way.`, allowedMentions: { parse: [] } })
      .catch(() => null);
    if (hint?.delete) setTimeout(() => hint.delete().catch(() => null), 10000);
    return true;
  }
  const n = read ? read.n : null;
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
      $max: { 'counting.record': n },
      $addToSet: { 'counting.participants': userId } // counted this run → shares the hidden goals
    },
    { new: false, projection: { counting: 1 } }
  ).lean();

  if (before) {
    // 67+67 easter egg: the count still stands, but swap their message for a bot post that roasts the meme.
    if (isSixtySeven(message.content)) {
      const record = await message.channel
        .send({
          content: `😹 ${message.author} typed \`67+67\` — the count is **${n.toLocaleString('en-US')}**, and ${pick(SIXTY_SEVEN_LINES)}`,
          allowedMentions: { users: [userId] }
        })
        .catch(() => null);
      // Make the bot post the authoritative last count BEFORE deleting theirs, so the delete handler
      // (which keys off lastMessageId) sees the new record and doesn't re-assert.
      if (record?.id) {
        await GuildConfig.updateOne(
          { guildId: message.guild.id, 'counting.lastMessageId': message.id, 'counting.current': n },
          { $set: { 'counting.lastMessageId': record.id } }
        ).catch(() => null);
      }
      if (message.deletable !== false) await message.delete().catch(() => null);
      await maybeRewardGoal(message, n, s.goals);
      return true;
    }
    // The best run from before this one started — passing it earns a 🏆 (once, on the number that beats it).
    const bestBefore = before.counting?.bestBefore || 0;
    if (n % 1000 === 0) await react(message, '🎉');
    else if (n % 100 === 0) await react(message, '💯');
    else await react(message, '✅');
    if (bestBefore > 0 && n === bestBefore + 1) await react(message, '🏆');
    await maybeRewardGoal(message, n, s.goals);
    return true;
  }

  // Not the next number (or the same person twice). Look at the live state to explain why.
  const fresh = countingSettings(await GuildConfig.findOne({ guildId: message.guild.id }, { counting: 1 }).lean());
  if (!fresh.enabled || fresh.channelId !== s.channelId) return false;
  // This exact message is already the accepted count — a duplicate delivery (e.g. two bot instances
  // overlapping during a deploy). Never judge it a second time.
  if (fresh.lastMessageId === message.id) return true;

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
        'counting.bestBefore': Math.max(fresh.record, fresh.current),
        // A new run: nobody has counted in it yet, and the goal ladder starts over.
        'counting.participants': [],
        'counting.goalsHit': 0,
        'counting.lastGoalAt': 0
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
  if (input.goals !== undefined && input.goals !== null) {
    const g = input.goals;
    const int = (v, min, max, what) => {
      const n = Number(v);
      if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${what} must be a whole number from ${min} to ${max.toLocaleString('en-US')}.`);
      return n;
    };
    try {
      if (g.enabled !== undefined) patch['counting.goals.enabled'] = !!g.enabled;
      if (g.every !== undefined) patch['counting.goals.every'] = int(g.every, 1, 100000, 'Goal spacing');
      if (g.baseXp !== undefined) patch['counting.goals.baseXp'] = int(g.baseXp, 0, 1e6, 'Base XP');
      if (g.stepXp !== undefined) patch['counting.goals.stepXp'] = int(g.stepXp, 0, 1e6, 'XP added per goal');
      if (g.maxXp !== undefined) patch['counting.goals.maxXp'] = int(g.maxXp || 0, 0, 1e7, 'XP cap');
      if (g.bonuses !== undefined) {
        if (!Array.isArray(g.bonuses)) throw new Error('Bonuses must be a list.');
        patch['counting.goals.bonuses'] = g.bonuses
          .filter((b) => b && (b.every !== '' || b.xp !== ''))
          .slice(0, 10)
          .map((b) => ({ every: int(b.every, 1, 1e9, 'A bonus’s “every”'), xp: int(b.xp, 1, 1e7, 'A bonus’s XP') }));
      }
      if (g.message !== undefined) patch['counting.goals.message'] = String(g.message || '').trim().slice(0, 1500) || null;
      if (g.ping !== undefined) patch['counting.goals.ping'] = !!g.ping;
    } catch (err) {
      return { error: err.message };
    }
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
    // If the channel moved, carry the counting-ban block over to the new one so bans still apply.
    const role = settings.bannedRoleId && guild.roles.cache.get(settings.bannedRoleId);
    if (role) await applyBanOverwrite(guild, role, settings.channelId);
  }
  return { settings };
}

// ---------------------------------------------------------------- Counting bans
//
// Block a member from the counting channel without touching their access anywhere else: the bot keeps
// one dedicated "🔇 Counting Banned" role that's denied Send Messages / Add Reactions in the counting
// channel, and adds that role to the member. It's all automatic — the role and the channel permission
// are created on first use. Bans can be permanent or timed; timed ones are lifted by a sweeper (which
// re-checks on every startup, so they survive restarts).

const BAN_ROLE_NAME = '🔇 Counting Banned';
const BAN_OVERWRITE = { SendMessages: false, AddReactions: false, SendMessagesInThreads: false };

/** Finds (or creates) the counting-ban role and remembers its id. Returns { role } or { error }. */
async function ensureBanRole(guild) {
  const s = countingSettings(await GuildConfig.findOne({ guildId: guild.id }, { counting: 1 }).lean());
  let role = (s.bannedRoleId && guild.roles.cache.get(s.bannedRoleId)) || guild.roles.cache.find((r) => r.name === BAN_ROLE_NAME && !r.managed);
  if (!role) {
    if (!guild.members.me?.permissions?.has(PermissionFlagsBits.ManageRoles)) return { error: 'I need the **Manage Roles** permission to create the counting-ban role.' };
    role = await guild.roles.create({ name: BAN_ROLE_NAME, color: 0x4e5058, mentionable: false, reason: 'Counting ban role' }).catch(() => null);
    if (!role) return { error: 'I couldn’t create the counting-ban role.' };
  }
  if (role.id !== s.bannedRoleId) await GuildConfig.updateOne({ guildId: guild.id }, { $set: { 'counting.bannedRoleId': role.id } }, { upsert: true });
  return { role };
}

/** Denies the ban role in the counting channel. Best effort — needs Manage Channels/Roles. */
async function applyBanOverwrite(guild, role, channelId) {
  const channel = channelId && guild.channels.cache.get(channelId);
  if (channel?.permissionOverwrites?.edit) await channel.permissionOverwrites.edit(role, BAN_OVERWRITE, { reason: 'Counting ban' }).catch(() => null);
}

/** Bans a member from the counting channel. `durationMs` null = permanent. Returns { until } or { error }. */
async function banUser(guild, userId, { durationMs = null, by = null } = {}) {
  const s = countingSettings(await GuildConfig.findOne({ guildId: guild.id }, { counting: 1 }).lean());
  if (!s.channelId) return { error: 'Set up a counting channel first with `/counting setup`.' };
  if (userId === guild.members.me?.id) return { error: 'I can’t ban myself from counting.' };
  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) return { error: 'That member isn’t in the server.' };
  const { role, error } = await ensureBanRole(guild);
  if (error) return { error };
  if (role.position >= (guild.members.me?.roles?.highest?.position ?? 0)) {
    return { error: `My highest role must be **above** ${role} so I can assign it — move it up in **Server Settings → Roles**.` };
  }
  await applyBanOverwrite(guild, role, s.channelId);
  await member.roles.add(role.id, by ? `Counting ban by ${by}` : 'Counting ban').catch(() => null);
  const until = durationMs ? new Date(Date.now() + durationMs) : null;
  // One record per user — a repeat ban just updates the timing.
  await GuildConfig.updateOne({ guildId: guild.id }, { $pull: { 'counting.bans': { userId } } });
  await GuildConfig.updateOne({ guildId: guild.id }, { $push: { 'counting.bans': { userId, until, by, at: new Date() } } }, { upsert: true });
  return { until, roleId: role.id };
}

/** Lifts a member's counting ban (removes the role + record). Returns { wasBanned }. */
async function unbanUser(guild, userId) {
  const s = countingSettings(await GuildConfig.findOne({ guildId: guild.id }, { counting: 1 }).lean());
  const member = await guild.members.fetch(userId).catch(() => null);
  const wasBanned = s.bans.some((b) => b.userId === userId) || !!(s.bannedRoleId && member?.roles.cache.has(s.bannedRoleId));
  if (s.bannedRoleId && member) await member.roles.remove(s.bannedRoleId, 'Counting unban').catch(() => null);
  await GuildConfig.updateOne({ guildId: guild.id }, { $pull: { 'counting.bans': { userId } } });
  return { wasBanned };
}

/** Lifts every timed counting ban that has run out. Runs on a timer (and once on startup). */
async function sweepCountingBans(client, now = Date.now()) {
  // Every guild that has a counting-ban role set (a tiny set); expired bans are filtered below.
  const due = await GuildConfig.find({ 'counting.bannedRoleId': { $ne: null } }, { guildId: 1, counting: 1 }).lean();
  let lifted = 0;
  for (const cfg of due) {
    const guild = client.guilds.cache.get(cfg.guildId);
    const roleId = cfg.counting?.bannedRoleId;
    for (const b of (cfg.counting?.bans || []).filter((x) => x.until && new Date(x.until).getTime() <= now)) {
      if (guild && roleId) {
        const member = await guild.members.fetch(b.userId).catch(() => null);
        if (member) await member.roles.remove(roleId, 'Counting ban expired').catch(() => null);
      }
      await GuildConfig.updateOne({ guildId: cfg.guildId }, { $pull: { 'counting.bans': { userId: b.userId } } });
      lifted++;
    }
  }
  return lifted;
}

function startCountingBanSweeper(client) {
  sweepCountingBans(client).catch(() => null); // catch any that expired while the bot was offline
  const timer = setInterval(() => sweepCountingBans(client).catch(console.error), 60 * 1000);
  timer.unref?.();
  return timer;
}

function registerCountingEvents(client) {
  client.on('messageDelete', (message) => handleCountDeleted(message).catch(() => null));
  client.on('messageUpdate', (oldMessage, newMessage) => handleCountEdited(oldMessage, newMessage).catch(() => null));
}

module.exports = {
  registerCountingEvents,
  evaluate,
  normalize,
  readCount,
  parseCount,
  countingSettings,
  goalSettings,
  goalReward,
  isGoal,
  nextGoal,
  maybeRewardGoal,
  handleCounting,
  handleCountDeleted,
  handleCountEdited,
  cleanSettings,
  saveSettings,
  isSixtySeven,
  ensureBanRole,
  banUser,
  unbanUser,
  sweepCountingBans,
  startCountingBanSweeper
};
