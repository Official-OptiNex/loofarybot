// /pat — headpats & friends: a subcommand per body part, each with a pool of responses, and optional
// @user targeting (which only ever pings the person being patted, never @everyone/roles).
process.env.TOKEN = 'x';
process.env.CLIENT_ID = '123';
process.env.MONGODB_URI = 'mongodb://x';
const root = require('path').join(__dirname, '..') + '/';
const assert = require('assert');
const pat = require(root + 'src/bot/commands/pat');

const json = pat.data.toJSON();
assert.equal(json.name, 'pat');
assert.ok(json.options.length >= 10 && json.options.length <= 25, `${json.options.length} subcommands (Discord allows 25)`);
assert.ok(json.options.every((o) => o.type === 1), 'all options are subcommands');
assert.ok(json.options.some((o) => o.name === 'head') && json.options.some((o) => o.name === 'random'), 'has head + random');
// Every part has a non-empty pool and every response is a non-empty string with no leftover {placeholders}.
for (const [part, def] of Object.entries(pat.PARTS)) {
  assert.ok(Array.isArray(def.responses) && def.responses.length >= 3, `${part} needs responses`);
  for (const r of def.responses) assert.ok(typeof r === 'string' && r.trim(), `${part}: empty response`);
}
console.log(`✓ builder: ${json.options.length} subcommands, ${Object.values(pat.PARTS).reduce((n, d) => n + d.responses.length, 0)} responses`);

const mk = (sub, user) => ({
  user: { id: 'u1', toString: () => '<@u1>' },
  options: { getSubcommand: () => sub, getUser: () => user || null },
  reply: async (o) => o
});

(async () => {
  // Solo pat: no action prefix, no pings, placeholders resolved to "you"/"your".
  const solo = await pat.execute(mk('head', null));
  assert.ok(solo.content && !/\{[tp]\}/.test(solo.content), 'placeholders filled');
  assert.ok(!/\*<@u1> pats/.test(solo.content), 'no action prefix when patting yourself');
  assert.deepEqual(solo.allowedMentions, { users: [] }, 'solo pat pings nobody');

  // Targeted pat: action prefix naming both, and only the target is pingable.
  const tgt = await pat.execute(mk('ears', { id: 'u2', toString: () => '<@u2>' }));
  assert.ok(/^\*<@u1> pats <@u2>'s ears\*/.test(tgt.content), 'prefix reads "X pats Y\'s ears"');
  assert.ok(!/\{[tp]\}/.test(tgt.content), 'placeholders filled for the target');
  assert.deepEqual(tgt.allowedMentions, { users: ['u2'] }, 'only the patted user is pinged');

  // Patting yourself by @mention is still treated as solo.
  const selfMention = await pat.execute(mk('head', { id: 'u1', toString: () => '<@u1>' }));
  assert.deepEqual(selfMention.allowedMentions, { users: [] }, 'self-mention = solo, no ping');

  // random resolves to a real part.
  for (let i = 0; i < 20; i++) {
    const r = await pat.execute(mk('random', null));
    assert.ok(r.content && !/\{[tp]\}/.test(r.content), 'random gives a filled response');
  }
  console.log('✓ execute: solo vs targeted formatting, ping scoping, self-mention, random');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
