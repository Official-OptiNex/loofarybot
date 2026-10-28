// /loof servers & /loof leave — bot-owner-only global commands to see and leave the servers the bot
// is in (used to track down a server you didn't add).
process.env.TOKEN='x';process.env.CLIENT_ID='1';process.env.MONGODB_URI='mongodb://x';
const root=require('path').join(__dirname,'..')+'/'; const assert=require('assert');
const loof=require(root+'src/bot/commands/loof');
const OWNER='1545263092370243624'; // LOOFARY_USER_ID

function fakeInteraction(sub, { userId, serverId } = {}) {
  const calls = {};
  return {
    options: { getSubcommand: () => sub, getString: (k) => (k === 'server_id' ? serverId : null), getChannel: () => null, getRole: () => null, getInteger: () => null, getBoolean: () => null },
    user: { id: userId },
    memberPermissions: { has: () => false },
    guildId: 'g',
    reply: async (p) => { calls.reply = p; },
    deferReply: async () => { calls.deferred = true; },
    editReply: async (p) => { calls.edit = p; },
    _calls: calls
  };
}

(async () => {
  const { ChannelType, PermissionFlagsBits, Collection } = require(root + 'node_modules/discord.js');
  const left = [];
  // A guild whose first text channel can mint invites; `canInvite:false` → no invitable channel.
  const guild = (id, name, n, canInvite = true) => {
    const me = { id: 'bot' };
    const chan = {
      id: id + 'c', type: ChannelType.GuildText,
      permissionsFor: () => ({ has: (p) => canInvite && p === PermissionFlagsBits.CreateInstantInvite }),
      createInvite: async () => ({ code: 'inv' + id })
    };
    return { id, name, memberCount: n, members: { me }, channels: { cache: new Collection([[chan.id, chan]]) }, fetchOwner: async () => ({ user: { tag: 'owner#1' } }), leave: async () => { left.push(id); } };
  };
  const client = { guilds: { cache: new Map([['s1', guild('s1', 'Alpha', 10)], ['s2', guild('s2', 'Beta', 5, false)]]) } };

  // Non-owner is rejected for both.
  let i = fakeInteraction('servers', { userId: 'someone' });
  await loof.execute(i, client);
  assert.match(i._calls.reply.content, /bot-owner/, 'a non-owner cannot list servers');
  i = fakeInteraction('leave', { userId: 'someone', serverId: 's1' });
  await loof.execute(i, client);
  assert.match(i._calls.reply.content, /bot-owner/, 'a non-owner cannot make it leave');

  // Owner lists every guild (name, id, members).
  i = fakeInteraction('servers', { userId: OWNER });
  await loof.execute(i, client);
  const em = i._calls.edit.embeds[0].data;
  assert.match(em.title, /In 2 servers/);
  assert.match(em.description, /Alpha/); assert.match(em.description, /Beta/); assert.match(em.description, /s1/);
  console.log('✓ /loof servers: owner-only, lists every guild with id + members');

  // Owner leaves a guild by id.
  i = fakeInteraction('leave', { userId: OWNER, serverId: 's2' });
  await loof.execute(i, client);
  assert.deepEqual(left, ['s2'], 'left the right server');
  assert.match(i._calls.edit.content, /Left \*\*Beta\*\*/);

  // Unknown id → friendly error, nothing left.
  i = fakeInteraction('leave', { userId: OWNER, serverId: 'nope' });
  await loof.execute(i, client);
  assert.match(i._calls.edit.content, /not in a server/i);
  assert.deepEqual(left, ['s2'], 'an unknown id leaves nothing else');
  console.log('✓ /loof leave: owner-only, leaves by id, handles an unknown id');

  // Owner invite (all servers): a 1-use link where possible, a warning where not.
  i = fakeInteraction('invite', { userId: OWNER });
  await loof.execute(i, client);
  const inv = i._calls.edit.embeds[0].data;
  assert.match(inv.title, /One-time invites/);
  assert.match(inv.description, /discord\.gg\/invs1/, 'Alpha gets a one-time invite link');
  assert.match(inv.description, /Beta.*⚠️/s, 'Beta (no invite permission) is flagged, not linked');
  // Non-owner cannot.
  i = fakeInteraction('invite', { userId: 'someone' });
  await loof.execute(i, client);
  assert.match(i._calls.reply.content, /bot-owner/, 'a non-owner cannot make invites');
  // A specific unknown id.
  i = fakeInteraction('invite', { userId: OWNER, serverId: 'nope' });
  await loof.execute(i, client);
  assert.match(i._calls.edit.content, /not in a server/i);
  console.log('✓ /loof invite: owner-only, 1-use links, flags servers it can’t invite from');

  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
