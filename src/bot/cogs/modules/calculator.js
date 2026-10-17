// Upgrade calculator for pets and guns: both use the same rarity scale, where 2 of a rarity merge into 1
// of the next, and new ones are summoned at the lowest rarity (D). From what the player owns and what they
// want, works out how many D summons they still need and what that costs.
const { EmbedBuilder } = require('discord.js');

const TIERS = ['d', 'c', 'b', 'a', 's', 'ss', 'sss', 'x', 'xx', 'xxx', 'z', 'zz', 'zzz'];
const label = (t) => TIERS[t].toUpperCase();
const MAX_COUNT = 1000; // per rarity, to keep typos from producing silly numbers

// What one D summon costs, per calculator.
const KINDS = {
  pets: { name: 'Pet', plural: 'pets', emoji: '🐾', color: 0xf1c40f, costPerD: 100, currencies: ['Pet Gems', 'Diamonds'] },
  guns: { name: 'Gun', plural: 'guns', emoji: '🔫', color: 0xed4245, costPerD: 100, currencies: ['Diamonds'] }
};

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
 * Plans reaching every wanted pet from what's owned. Goals are filled highest rarity first; each one
 * uses an owned pet of that rarity, else a spare higher one, else merges owned lower pets and buys the
 * rest as D summons (a rarity t pet is worth 2^t D). Returns
 * { goals: [{ tier, count, owned, upgraded, build: [{ used: counts, buyD }] }], buyD, leftover: counts }.
 */
function plan(have, want) {
  const left = have.slice();
  const goals = [];
  let buyD = 0;
  for (let t = TIERS.length - 1; t >= 0; t--) {
    if (!want[t]) continue;
    const g = { tier: t, count: want[t], owned: 0, upgraded: [], builds: 0, used: new Array(TIERS.length).fill(0), buyD: 0 };
    for (let k = 0; k < want[t]; k++) {
      if (left[t] > 0) { left[t]--; g.owned++; continue; }
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

/** The result embed (sent as the reply and by DM). */
function resultEmbed(kindKey, have, want, result, user = null) {
  const k = KINDS[kindKey];
  const cost = result.buyD * k.costPerD;
  const embed = new EmbedBuilder()
    .setColor(k.color)
    .setTitle(`${k.emoji} ${k.name} Calculator`)
    .setDescription(user ? `Results for <@${user.id}>` : null)
    .addFields(
      { name: `📦 Your ${k.plural}`, value: countsText(have) || `*No ${k.plural} yet*`, inline: false },
      { name: '🎯 Goal', value: countsText(want) || '*Nothing*', inline: false }
    );
  for (const g of result.goals) {
    const lines = [];
    if (g.owned) lines.push(`✅ ${fmt(g.owned)} already owned`);
    if (g.upgraded.length) lines.push(`✅ ${g.upgraded.length} covered by your higher ${g.upgraded.map(label).join(', ')}`);
    if (g.builds) {
      const used = countsText(g.used);
      lines.push(`🔨 ${fmt(g.builds)} to make${used ? ` — merges your ${used}` : ''}${g.buyD ? ` + **${fmt(g.buyD)}** new D` : ''}`);
    }
    embed.addFields({ name: `${label(g.tier)} ×${fmt(g.count)}`, value: lines.join('\n') || '—', inline: false });
  }
  const total = result.buyD
    ? `Summon **${fmt(result.buyD)}** D ${k.plural}\n` + k.currencies.map((c) => `💎 **${fmt(cost)}** ${c}`).join('\n**or** ')
    : '🎉 **Nothing!** You already have everything you need.';
  embed.addFields({ name: '💰 You need', value: total, inline: false });
  const spare = countsText(result.leftover);
  if (spare && result.goals.length) embed.addFields({ name: `🧺 ${k.name}s left over`, value: spare, inline: false });
  embed.setFooter({ text: `1 D summon = ${k.costPerD} ${k.currencies.join(' / ')} · 2 of a rarity merge into 1 of the next (D → C → … → ZZZ)` });
  return embed;
}

module.exports = { TIERS, KINDS, parseCounts, plan, resultEmbed, countsText, label };
