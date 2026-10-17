// Upgrade calculator for pets and guns: both use the same rarity scale, where 2 of a rarity merge into 1
// of the next, and new ones are summoned at the lowest rarity (D). From what the player owns and what they
// want, works out how many D summons they still need and what that costs.
const { EmbedBuilder } = require('discord.js');

const TIERS = ['d', 'c', 'b', 'a', 's', 'ss', 'sss', 'x', 'xx', 'xxx', 'z', 'zz', 'zzz'];
const label = (t) => TIERS[t].toUpperCase();
const MAX_COUNT = 1000; // per rarity, to keep typos from producing silly numbers

// The default calculators — each server can change these on the dashboard (Engagement → Calculator).
// Pets / guns: what one D summon costs. Fish come from random draws instead: odds per rarity (index 0 = D).
const KINDS = {
  pets: { enabled: true, name: 'Pet', plural: 'pets', emoji: '🐾', color: 0xf1c40f, costPerD: 100, currencies: ['Pet Gems', 'Diamonds'] },
  guns: { enabled: true, name: 'Gun', plural: 'guns', emoji: '🔫', color: 0xed4245, costPerD: 100, currencies: ['Diamonds'] },
  fish: {
    enabled: true, name: 'Fish', plural: 'fish', emoji: '🐟', color: 0x1abc9c,
    draws: {
      free: { perDay: 5, odds: [0.6, 0.3, 0.1] },
      epic: { cost: 200, currency: 'Diamonds', odds: [0, 0.6, 0.3, 0.1] }
    }
  }
};
const KIND_KEYS = Object.keys(KINDS);

const clone = (o) => JSON.parse(JSON.stringify(o));
const padOdds = (odds) => Array.from({ length: TIERS.length }, (_, t) => Number(odds?.[t]) || 0);
// "C 60% · B 30% · A 10%"
const oddsText = (odds) => odds.map((p, t) => (p > 0 ? `${label(t)} ${+(p * 100).toFixed(2)}%` : null)).filter(Boolean).join(' · ');

/** This server's calculators: the defaults with its dashboard overrides applied. */
function kindsFor(config) {
  const o = (config && config.calculator) || {};
  const out = clone(KINDS);
  for (const key of KIND_KEYS) {
    const k = out[key], v = o[key] || {};
    if (typeof v.enabled === 'boolean') k.enabled = v.enabled;
    if (v.name) k.name = v.name;
    if (v.plural) k.plural = v.plural;
    if (v.emoji) k.emoji = v.emoji;
    if (k.draws) {
      if (Number.isFinite(v.freePerDay)) k.draws.free.perDay = v.freePerDay;
      if (Array.isArray(v.freeOdds)) k.draws.free.odds = padOdds(v.freeOdds);
      if (Number.isFinite(v.epicCost)) k.draws.epic.cost = v.epicCost;
      if (v.epicCurrency) k.draws.epic.currency = v.epicCurrency;
      if (Array.isArray(v.epicOdds)) k.draws.epic.odds = padOdds(v.epicOdds);
    } else {
      if (Number.isFinite(v.costPerD)) k.costPerD = v.costPerD;
      if (Array.isArray(v.currencies) && v.currencies.length) k.currencies = v.currencies;
    }
  }
  return out;
}

/**
 * Checks dashboard input ({ pets: {...}, guns: {...}, fish: {...} }, odds in percent) and returns
 * { error } or { value } — the overrides to store (odds as fractions).
 */
function cleanSettings(input) {
  const value = {};
  const text = (v, max) => String(v ?? '').trim().slice(0, max);
  const num = (v, min, max, what) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${what} must be a number from ${min} to ${max.toLocaleString('en-US')}.`);
    return n;
  };
  const odds = (arr, what) => {
    if (!Array.isArray(arr)) throw new Error(`${what}: missing odds.`);
    const pct = padOdds(arr).map((p, t) => num(p, 0, 100, `${what} ${label(t)} chance`));
    const sum = pct.reduce((a, b) => a + b, 0);
    if (Math.abs(sum - 100) > 0.01) throw new Error(`${what} chances add up to ${+sum.toFixed(2)}% — they need to total 100%.`);
    return pct.map((p) => p / 100);
  };
  try {
    for (const key of KIND_KEYS) {
      const v = input?.[key];
      if (!v || typeof v !== 'object') continue;
      const def = KINDS[key];
      const out = { enabled: v.enabled !== false };
      out.name = text(v.name, 32) || def.name;
      out.plural = text(v.plural, 32) || def.plural;
      out.emoji = text(v.emoji, 64) || def.emoji;
      if (def.draws) {
        out.freePerDay = Math.floor(num(v.freePerDay, 0, 1000, 'Free draws per day'));
        out.freeOdds = odds(v.freeOdds, 'Free draw');
        out.epicCost = num(v.epicCost, 1, 1e9, 'Epic draw cost');
        out.epicCurrency = text(v.epicCurrency, 32) || def.draws.epic.currency;
        out.epicOdds = odds(v.epicOdds, 'Epic draw');
      } else {
        out.costPerD = num(v.costPerD, 0, 1e9, `${out.name} cost per D`);
        const cur = (Array.isArray(v.currencies) ? v.currencies : String(v.currencies || '').split(/[,\n]/)).map((c) => text(c, 32)).filter(Boolean).slice(0, 5);
        out.currencies = cur.length ? cur : def.currencies;
      }
      value[key] = out;
    }
  } catch (err) {
    return { error: err.message };
  }
  if (KIND_KEYS.every((k) => value[k] && value[k].enabled === false)) return { error: 'Keep at least one calculator switched on.' };
  return { value };
}

/** Saves dashboard input; returns { error } or { settings } (the server's calculators). */
async function saveSettings(guild, input) {
  const GuildConfig = require('../../../database/models/GuildConfig');
  if (input && input.reset) {
    await GuildConfig.updateOne({ guildId: guild.id }, { $set: { calculator: {} } }, { upsert: true });
    return { settings: kindsFor({}) };
  }
  const { error, value } = cleanSettings(input);
  if (error) return { error };
  const existing = (await GuildConfig.findOne({ guildId: guild.id }, { calculator: 1 }).lean())?.calculator || {};
  const merged = { ...existing, ...value };
  await GuildConfig.updateOne({ guildId: guild.id }, { $set: { calculator: merged } }, { upsert: true });
  return { settings: kindsFor({ calculator: merged }) };
}

/** The average value of one draw, in D (a rarity-t fish is worth 2^t D). */
const drawValue = (odds) => odds.reduce((sum, p, t) => sum + p * 2 ** t, 0);

// The smallest / biggest a single draw can be worth, in D.
const drawMin = (odds) => 2 ** odds.findIndex((p) => p > 0);
const drawMax = (odds) => 2 ** (odds.length - 1 - [...odds].reverse().findIndex((p) => p > 0));

/**
 * For draw-based kinds: how many epic draws (and Diamonds) or days of free draws cover `needD` —
 * on average, with the best luck (every draw the top rarity) and the worst (every draw the lowest).
 */
function drawPlan(kind, needD) {
  const { free, epic } = kind.draws;
  const epicD = drawValue(epic.odds); // 3.2 D per epic draw
  const dayD = drawValue(free.odds) * free.perDay; // 8 D per day of free draws
  const epicDraws = Math.ceil(needD / epicD);
  const best = Math.ceil(needD / drawMax(epic.odds));
  const worst = Math.ceil(needD / drawMin(epic.odds));
  return {
    epicD, dayD, epicDraws, diamonds: epicDraws * epic.cost, perD: epic.cost / epicD,
    epicBest: best, diamondsBest: best * epic.cost, epicWorst: worst, diamondsWorst: worst * epic.cost,
    freeDays: Math.ceil(needD / dayD),
    freeDaysBest: Math.ceil(needD / (drawMax(free.odds) * free.perDay)),
    freeDaysWorst: Math.ceil(needD / (drawMin(free.odds) * free.perDay))
  };
}

const fmt = (n) => Number(n).toLocaleString('en-US');
const countsText = (counts) =>
  counts
    .map((n, t) => (n ? `**${label(t)}** ×${fmt(n)}` : null))
    .filter(Boolean)
    .reverse()
    .join(' · ');

/**
 * Reads a list like "b 2, sss 2", "2x B, 2x SSS", "b=2 sss=2" or "3x zzz\n2 xxx" into counts per rarity
 * (index 0 = D). A rarity with no number counts as 1. Returns { counts, unknown: [unreadable bits] }.
 */
function parseCounts(text) {
  const counts = new Array(TIERS.length).fill(0);
  const unknown = [];
  const raw = String(text || '').toLowerCase().trim();
  if (!raw || /^(none|nothing|0|-)$/.test(raw)) return { counts, unknown };
  const isTier = (w) => TIERS.includes(w);
  const num = (w) => {
    const m = w.match(/^x?(\d+)x?$/);
    return m ? Number(m[1]) : null;
  };
  const add = (tier, n, src) => {
    if (n === null || !Number.isFinite(n)) return unknown.push(src);
    counts[TIERS.indexOf(tier)] = Math.min(MAX_COUNT, counts[TIERS.indexOf(tier)] + n);
  };
  // Entries split by commas / new lines / ";" / "and" / "+"; within an entry, pair a rarity with its number.
  const entries = raw.split(/\s*(?:[,;\n+&]|\band\b)\s*/).filter(Boolean);
  for (const entry of entries) {
    let words = entry.split(/[^a-z0-9]+/).filter(Boolean);
    // "2 x b": a lone "x" next to a number is a multiplier, not the X rarity.
    if (words.length === 3 && words[1] === 'x' && (num(words[0]) !== null || num(words[2]) !== null)) words = [words[0], words[2]];
    // Several pairs on one line without commas ("b 2 sss 2" / "2 b 2 sss").
    const pairs = [];
    for (let i = 0; i < words.length; ) {
      const a = words[i], b = words[i + 1];
      if (isTier(a) && b !== undefined && num(b) !== null && !isTier(b)) { pairs.push([a, num(b)]); i += 2; }
      else if (num(a) !== null && b !== undefined && isTier(b)) { pairs.push([b, num(a)]); i += 2; }
      else if (isTier(a)) { pairs.push([a, 1]); i += 1; }
      else { unknown.push(a); i += 1; }
    }
    for (const [tier, n] of pairs) add(tier, n, entry);
  }
  return { counts, unknown };
}

/**
 * Plans reaching every wanted pet from what's owned. Owned pets of a wanted rarity count first; then
 * goals are filled highest rarity first from a spare higher pet, else by merging owned lower pets and
 * buying the rest as D summons (a rarity t pet is worth 2^t D). Returns
 * { goals: [{ tier, count, owned, upgraded, build: [{ used: counts, buyD }] }], buyD, leftover: counts }.
 */
function plan(have, want) {
  const left = have.slice();
  // Pets that already match a goal count for it first (the total is the same either way, but this reads right).
  const owned = want.map((n, t) => Math.min(n, left[t]));
  owned.forEach((n, t) => (left[t] -= n));
  const goals = [];
  let buyD = 0;
  for (let t = TIERS.length - 1; t >= 0; t--) {
    if (!want[t]) continue;
    const g = { tier: t, count: want[t], owned: owned[t], upgraded: [], builds: 0, used: new Array(TIERS.length).fill(0), buyD: 0 };
    for (let k = owned[t]; k < want[t]; k++) {
      const higher = left.findIndex((n, i) => i > t && n > 0); // a spare better one already does the job
      if (higher !== -1) { left[higher]--; g.upgraded.push(higher); continue; }
      // Merge owned lower pets (largest first — always fits exactly, they're powers of two) and buy the rest.
      let need = 2 ** t;
      for (let i = t - 1; i >= 0 && need > 0; i--) {
        const take = Math.min(left[i], Math.floor(need / 2 ** i));
        left[i] -= take;
        g.used[i] += take;
        need -= take * 2 ** i;
      }
      g.builds++;
      g.buyD += need;
    }
    buyD += g.buyD;
    goals.push(g);
  }
  return { goals, buyD, leftover: left };
}

/** The result embed (sent as the reply and by DM). `kinds` = this server's calculators (kindsFor). */
function resultEmbed(kindKey, have, want, result, user = null, kinds = KINDS) {
  const k = kinds[kindKey];
  const cost = result.buyD * k.costPerD;
  const embed = new EmbedBuilder()
    .setColor(k.color)
    .setTitle(`${k.emoji} ${k.name} Calculator`)
    .setDescription(user ? `Results for <@${user.id}>` : null)
    .addFields(
      { name: `📦 Your ${k.plural}`, value: countsText(have) || `*No ${k.plural} yet*`, inline: false },
      { name: '🎯 Goal', value: countsText(want) || '*Nothing*', inline: false }
    );
  const newD = k.draws ? 'D-worth from draws' : 'new D';
  for (const g of result.goals) {
    const lines = [];
    if (g.owned) lines.push(`✅ ${fmt(g.owned)} already owned`);
    if (g.upgraded.length) lines.push(`✅ ${g.upgraded.length} covered by your higher ${g.upgraded.map(label).join(', ')}`);
    if (g.builds) {
      const used = countsText(g.used);
      lines.push(`🔨 ${fmt(g.builds)} to make${used ? ` — merges your ${used}` : ''}${g.buyD ? ` + **${fmt(g.buyD)}** ${newD}` : ''}`);
    }
    embed.addFields({ name: `${label(g.tier)} ×${fmt(g.count)}`, value: lines.join('\n') || '—', inline: false });
  }
  let total;
  if (!result.buyD) total = '🎉 **Nothing!** You already have everything you need.';
  else if (k.draws) {
    const d = drawPlan(k, result.buyD);
    const cur = k.draws.epic.currency || 'Diamonds';
    total =
      `**${fmt(result.buyD)}** D-worth of ${k.plural}.\n` +
      `💎 **Epic draws:**\n` +
      `🍀 Best luck: **${fmt(d.epicBest)}** draws = **${fmt(d.diamondsBest)}** ${cur}\n` +
      `📊 Average: **${fmt(d.epicDraws)}** draws ≈ **${fmt(d.diamonds)}** ${cur}\n` +
      `💀 Worst luck: **${fmt(d.epicWorst)}** draws = **${fmt(d.diamondsWorst)}** ${cur}\n` +
      (d.dayD > 0
        ? `**or** 🎣 **Free daily draws only:** ~**${fmt(d.freeDays)}** days (best ${fmt(d.freeDaysBest)} · worst ${fmt(d.freeDaysWorst)})\n` +
          `-# Every day of free draws saves ~${fmt(Math.round(d.dayD * d.perD))} ${cur} of epic draws.`
        : '');
  } else total = `Summon **${fmt(result.buyD)}** D ${k.plural}\n` + k.currencies.map((c) => `💎 **${fmt(cost)}** ${c}`).join('\n**or** ');
  embed.addFields({ name: '💰 You need', value: total, inline: false });
  const spare = countsText(result.leftover);
  if (spare && result.goals.length) embed.addFields({ name: `🧺 ${k.name}s left over`, value: spare, inline: false });
  embed.setFooter({
    text: k.draws
      ? `Epic draw ${fmt(k.draws.epic.cost)} ${k.draws.epic.currency || 'Diamonds'}: ${oddsText(k.draws.epic.odds)} (avg ${+drawValue(k.draws.epic.odds).toFixed(2)} D) · ${k.draws.free.perDay ? `Free: ${k.draws.free.perDay}/day, ${oddsText(k.draws.free.odds)} (avg ${+drawValue(k.draws.free.odds).toFixed(2)} D) · ` : ''}Luck varies — these are averages`
      : `1 D summon = ${k.costPerD} ${k.currencies.join(' / ')} · 2 of a rarity merge into 1 of the next (D → C → … → ZZZ)`
  });
  return embed;
}

module.exports = { TIERS, KINDS, KIND_KEYS, kindsFor, cleanSettings, saveSettings, oddsText, parseCounts, plan, resultEmbed, countsText, label, drawValue, drawMin, drawMax, drawPlan };
