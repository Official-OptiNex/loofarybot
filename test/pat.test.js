// /pat [part] [user] — a `part` autocomplete field (named parts, hyper-specific ones, or free text),
// optional @user that only ever pings the patted person, and a one-pat-per-user-per-minute cooldown.
process.env.TOKEN = 'x';
process.env.CLIENT_ID = '123';
process.env.MONGODB_URI = 'mongodb://x';
const root = require('path').join(__dirname, '..') + '/';
const assert = require('assert');
const pat = require(root + 'src/bot/commands/pat');

// ---- builder: options, not subcommands
const json = pat.data.toJSON();
assert.equal(json.name, 'pat');
const part = json.options.find((o) => o.name === 'part');
const user = json.options.find((o) => o.name === 'user');
assert.ok(part && part.type === 3 && part.autocomplete, 'part is a string option with autocomplete');
assert.ok(user && user.type === 6, 'user is a user option');
assert.ok(!json.options.some((o) => o.type === 1), 'no subcommands (so there is no 25-part cap)');

// ---- data: named pools + a big pile of specific parts + a shared pool that uses {part}
assert.ok(Object.keys(pat.PARTS).length >= 20, 'plenty of named parts');
for (const [p, def] of Object.entries(pat.PARTS)) {
  assert.ok(def.responses.length >= 3 && def.responses.every((r) => typeof r === 'string' && r.trim()), `${p} responses`);
}
assert.ok(pat.SPECIFIC.length >= 40, 'lots of hyper-specific parts');
assert.ok(pat.SPECIFIC.some((p) => /pinky toe/i.test(p)), 'includes "left foot pinky toe"-style parts');
assert.ok(pat.SPECIFIC_RESPONSES.every((r) => r.includes('{part}')), 'specific responses weave in the part name');
console.log(`✓ builder + data: ${Object.keys(pat.PARTS).length} named parts, ${pat.SPECIFIC.length} specific, ${Object.values(pat.PARTS).reduce((n, d) => n + d.responses.length, 0) + pat.SPECIFIC_RESPONSES.length} responses`);

// ---- autocomplete
(async () => {
  const acOf = async (q) => { let out; await pat.autocomplete({ options: { getFocused: () => q }, respond: async (c) => { out = c; } }); return out; };
  const toe = await acOf('toe');
  assert.ok(toe.length && toe.length <= 25 && toe.every((c) => /toe/i.test(c.name)), 'searching "toe" returns toe parts (≤25)');
  assert.ok((await acOf('')).length === 25, 'empty query still offers a full page of suggestions');
  assert.ok((await acOf('head')).some((c) => c.value === 'head'), 'named parts show up too');
  console.log('✓ autocomplete filters the part list');

  // ---- execute: formatting, ping scoping, freeform parts
  const mk = (partVal, target, uid = 'u1') => ({ user: { id: uid, toString: () => `<@${uid}>` }, options: { getString: () => partVal, getUser: () => target || null }, reply: async (o) => o });
  const run = (partVal, target, uid) => { pat._cooldowns.clear(); return pat.execute(mk(partVal, target, uid)); };

  const solo = await run('head', null);
  assert.ok(solo.content && !/\{(part|[tp])\}/.test(solo.content), 'placeholders filled');
  assert.deepEqual(solo.allowedMentions, { users: [] }, 'solo pat pings nobody');

  const tgt = await run('ears', { id: 'u2', toString: () => '<@u2>' });
  assert.ok(/^\*<@u1> pats <@u2>'s ears\*/.test(tgt.content), 'prefix reads "X pats Y\'s ears"');
  assert.deepEqual(tgt.allowedMentions, { users: ['u2'] }, 'only the patted user is pinged');

  // a hyper-specific / freeform part gets woven into the response and the prefix verbatim
  const specific = await run('left foot pinky toe', { id: 'u2', toString: () => '<@u2>' });
  assert.ok(/left foot pinky toe/.test(specific.content), 'the exact part text appears');
  assert.ok(!/\{part\}/.test(specific.content), 'no leftover {part}');
  const free = await run('third nostril', null);
  assert.ok(/third nostril/.test(free.content), 'totally made-up parts work too');

  // no part → a random named part
  for (let i = 0; i < 10; i++) { const r = await run('', null); assert.ok(r.content && !/\{(part|[tp])\}/.test(r.content)); }
  console.log('✓ execute: named / specific / freeform / random, ping scoping');

  // ---- cooldown: one pat per user per minute; others unaffected
  pat._cooldowns.clear();
  const first = await pat.execute(mk('head', null, 'cA'));
  assert.ok(!first.ephemeral, 'first pat goes through');
  const again = await pat.execute(mk('head', null, 'cA'));
  assert.ok(again.ephemeral && /again in \*\*\d+s\*\*/.test(again.content), 'same user within a minute is told to wait');
  const other = await pat.execute(mk('head', null, 'cB'));
  assert.ok(!other.ephemeral, 'a different user can still pat');
  // once the window passes, the first user can pat again
  pat._cooldowns.set('cA', Date.now() - pat.COOLDOWN_MS - 1);
  assert.ok(!(await pat.execute(mk('head', null, 'cA'))).ephemeral, 'the cooldown lifts after a minute');
  console.log('✓ cooldown: 1 pat/user/min, per-user (others unaffected), lifts after the window');

  // ---- creepy pool: can surface on any pat, placeholders still fill
  assert.ok(pat.CREEPY.length >= 8 && pat.CREEPY.every((r) => typeof r === 'string' && r.trim()), 'creepy pool present');
  const realRandom = Math.random;
  Math.random = () => 0; // forces the creepy branch (0 < CREEPY_CHANCE) and picks CREEPY[0]
  try {
    const creepy = await run('left foot pinky toe', null);
    const expect = pat.CREEPY[0].replace(/\{part\}/g, 'left foot pinky toe').replace(/\{t\}/g, 'you').replace(/\{p\}/g, 'your');
    assert.equal(creepy.content, expect, 'a creepy line can answer the pat, with the part woven in');
    assert.ok(!/\{(part|[tp])\}/.test(creepy.content), 'creepy lines fill placeholders too');
  } finally { Math.random = realRandom; }
  console.log('✓ creepy: an occasional unsettling response can answer any pat 👁️');

  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
