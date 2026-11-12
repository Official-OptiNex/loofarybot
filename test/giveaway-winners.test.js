// When a giveaway with 2+ winners ends, the announcement and the ended embed number the winners
// (Winner 1, Winner 2, …) so a host can assign a different prize per place. A single winner stays plain.
process.env.TOKEN = 'x';
process.env.CLIENT_ID = '123';
process.env.MONGODB_URI = 'mongodb://x';
const root = require('path').join(__dirname, '..') + '/';
const assert = require('assert');
const { memModel } = require('./helpers/memmodel');
const Giveaway = require(root + 'src/database/models/Giveaway');
memModel(Giveaway);
const G = require(root + 'src/bot/cogs/modules/giveaways');

const sent = [];
const edits = [];
const channel = {
  guild: { id: 'g' },
  messages: { fetch: async () => ({ edit: async (o) => edits.push(o) }) },
  send: async (c) => sent.push(c)
};
const client = { channels: { fetch: async () => channel } };

const seed = (over) => Giveaway.create({ messageId: 'm' + Math.random(), channelId: 'c1', guildId: 'g', prize: 'Nitro', winnerCount: 1, endTimestamp: Date.now() - 1000, hostId: 'h', type: 'drop', emoji: '🎉', entries: [], ...over });

(async () => {
  // Three winners (a drop: winners are whoever claimed) → numbered list.
  let g = await seed({ prize: 'Big one', winnerCount: 3, entries: ['u1', 'u2', 'u3'] });
  await G.finishGiveaway(client, g);
  const msg = sent.at(-1);
  assert.ok(/\*\*Winner 1:\*\* <@u1>/.test(msg) && /\*\*Winner 2:\*\* <@u2>/.test(msg) && /\*\*Winner 3:\*\* <@u3>/.test(msg), 'congrats numbers each winner');
  assert.ok(/You won \*\*Big one\*\*/.test(msg), 'still names the prize');
  const desc = edits.at(-1).embeds[0].data.description;
  assert.ok(/\*\*Winner 1:\*\* <@u1>/.test(desc) && /\*\*Winner 3:\*\* <@u3>/.test(desc), 'ended embed numbers winners too');
  console.log('✓ 2+ winners are numbered (Winner 1 / Winner 2 / …) in the message and the embed');

  // Single winner → plain mention, no "Winner 1".
  sent.length = 0; edits.length = 0;
  g = await seed({ prize: 'Solo', winnerCount: 1, entries: ['solo'] });
  await G.finishGiveaway(client, g);
  const one = sent.at(-1);
  assert.equal(one, '🎉 Congratulations <@solo>! You won **Solo**!', 'single winner stays plain');
  assert.ok(!/Winner 1/.test(one), 'no numbering for a lone winner');
  assert.ok(/\*\*Winners:\*\* <@solo>/.test(edits.at(-1).embeds[0].data.description), 'embed shows the single winner inline');
  console.log('✓ a single winner is announced plainly (no numbering)');

  // No entries → the "no valid entries" path, unchanged.
  sent.length = 0; edits.length = 0;
  g = await seed({ prize: 'Empty', type: 'timed', entries: [] });
  await G.finishGiveaway(client, g);
  assert.ok(/no valid entries/i.test(sent.at(-1)), 'empty giveaway handled');
  console.log('✓ an empty giveaway still ends cleanly');

  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
