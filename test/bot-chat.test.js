// Bot Chat (dashboard → talk through the bot): the recent-message feed, sending, replying, the
// permission and length checks, and that it never mass-pings (@everyone/@here and roles are stripped).
process.env.TOKEN='x';process.env.CLIENT_ID='123';process.env.MONGODB_URI='mongodb://x';
const root=require('path').join(__dirname,'..')+'/'; const assert=require('assert');
const { PermissionsBitField, PermissionFlagsBits, Collection, ChannelType } = require(root+'node_modules/discord.js');

const me={ id: 'bot', user: { id: 'bot' } };
let perms = PermissionsBitField.All;
const sent = [];
let mid = 100;

function message(over={}) {
  const m = {
    id: String(mid++), guild: null, reference: null, attachments: new Collection(), stickers: new Collection(), embeds: [],
    author: { id: 'u1', username: 'ann', globalName: 'Ann', bot: false, displayAvatarURL: () => 'a.png' },
    member: { displayName: 'Ann' }, content: 'hello', createdTimestamp: 1700000000000, ...over
  };
  return m;
}
const history = new Collection();
function addHistory(m) { m.guild = guild; history.set(m.id, m); return m; }

const textChannel = {
  id: 'c1', name: 'general', type: ChannelType.GuildText, viewable: true, parent: null,
  isThread: () => false, permissionsFor: () => new PermissionsBitField(perms),
  messages: {
    fetch: async () => history,
    _sent: sent
  },
  send: async (payload) => { const m = message({ id: String(mid++), guild, content: payload.content, author: { id: 'bot', username: 'Loofary', bot: true, displayAvatarURL: () => 'b.png' }, member: null, reference: payload.reply ? { messageId: payload.reply.messageReference } : null }); sent.push(payload); return m; }
};
const voiceOnly = { id: 'c2', name: 'secret', type: ChannelType.GuildText, viewable: true, parent: null, isThread: () => false, permissionsFor: () => new PermissionsBitField(PermissionsBitField.Flags.ViewChannel) };
const guild = { id: '111', name: 'Lounge', channels: { cache: new Collection([['c1', textChannel], ['c2', voiceOnly]]) }, members: { me } };
textChannel.guild = guild; voiceOnly.guild = guild;
// Discord's fetch() returns newest → oldest, so insert the newest first.
addHistory(message({ id: '2', content: 'second', author: { id: 'bot', username: 'Loofary', bot: true, displayAvatarURL: () => 'b.png' }, member: null }));
addHistory(message({ id: '1', content: 'first' }));

(async () => {
  const auth = require(root+'src/web/utils/authMiddleware');
  assert.equal(auth.MOD_PAGES.botchat !== undefined, true, 'Bot Chat is a grantable page');
  let access = { level: 'admin', pages: null };
  auth.requireAuth = (q,s,n)=>n();
  auth.requireGuildAccess = (q,s,n)=>{ q.guild = guild; q.access = access; n(); };
  auth.requirePage = (page) => (q,s,n)=> (access.level === 'admin' || access.pages?.has(page) ? n() : s.status(403).json({ ok:false, error:'no page' }));
  const audit = require(root+'src/web/utils/audit'); audit.auditTrail = (q,s,n)=>n();
  const express = require(root+'node_modules/express'); const app = express(); app.use(express.json());
  app.use('/dashboard', require(root+'src/web/routes/botChat'));
  const srv = app.listen(0); const base = `http://127.0.0.1:${srv.address().port}/dashboard/111/botchat`;
  const get = async (p) => { const r = await fetch(base + p); return { status: r.status, ...await r.json() }; };
  const post = async (b) => { const r = await fetch(base + '/send', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(b) }); return { status: r.status, ...await r.json() }; };

  // Feed: recent messages oldest → newest, with the bot's own flagged as "self".
  let r = await get('/feed?channelId=c1');
  assert.equal(r.ok, true); assert.equal(r.messages.length, 2);
  assert.deepEqual(r.messages.map((m) => m.content), ['first', 'second']);
  assert.equal(r.messages[1].self, true, "the bot's own message is marked");
  assert.equal(r.messages[0].name, 'Ann');
  console.log('✓ feed returns a channel’s recent messages, oldest first, marking the bot’s own');

  // Feed needs the channel to be real and readable.
  assert.match((await get('/feed?channelId=nope')).error, /Pick a channel/);
  assert.match((await get('/feed?channelId=c2')).error, /can't talk in that channel/);

  // Sending as the bot.
  r = await post({ channelId: 'c1', content: 'Hello from staff' });
  assert.equal(r.ok, true); assert.equal(r.message.content, 'Hello from staff'); assert.equal(r.message.self, true);
  assert.equal(sent.at(-1).content, 'Hello from staff');
  assert.deepEqual(sent.at(-1).allowedMentions, { parse: ['users'] }, 'only user mentions ping — never @everyone/@here or roles');
  console.log('✓ sends as the bot and never mass-pings (@everyone/@here and roles are stripped)');

  // Replying sets the Discord reply reference.
  r = await post({ channelId: 'c1', content: 'replying', replyTo: '1' });
  assert.equal(r.ok, true); assert.deepEqual(sent.at(-1).reply, { messageReference: '1', failIfNotExists: false });
  console.log('✓ replies set the message reference');

  // Validation.
  assert.match((await post({ channelId: 'c1', content: '   ' })).error, /Type a message/);
  assert.match((await post({ channelId: 'c1', content: 'x'.repeat(2001) })).error, /at most 2000 characters/);
  assert.match((await post({ channelId: 'c2', content: 'hi' })).error, /can't talk in that channel/);
  console.log('✓ empty, too-long, and unusable-channel sends are refused');

  // Moderators without the page can't use it.
  access = { level: 'mod', pages: new Set(['leaderboard']) };
  assert.equal((await get('/feed?channelId=c1')).status, 403);
  assert.equal((await post({ channelId: 'c1', content: 'hi' })).status, 403);
  access = { level: 'mod', pages: new Set(['botchat']) };
  assert.equal((await get('/feed?channelId=c1')).ok, true, 'a mod granted the page can');
  console.log('✓ only admins or mods given the Bot Chat page can use it');

  srv.close(); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
