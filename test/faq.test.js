// FAQ: the saved message (text + up to 10 embeds), editor permission (shared with guides), and the
// dashboard route (save / data / post). The editor UI itself is the Embed Builder's, tested elsewhere.
process.env.TOKEN = 'x';
process.env.CLIENT_ID = '123';
process.env.MONGODB_URI = 'mongodb://x';
const root = require('path').join(__dirname, '..') + '/';
const assert = require('assert');
const { Collection, PermissionsBitField } = require(root + 'node_modules/discord.js');
const { store } = require('./helpers/memstore');
const GuildConfig = require(root + 'src/database/models/GuildConfig');
store(GuildConfig);
const faq = require(root + 'src/bot/cogs/modules/faq');

const member = (perms, roleIds = []) => ({
  permissions: { has: (p) => perms.includes(p) },
  roles: { cache: new Collection(roleIds.map((r) => [r, { id: r }])) }
});
const { PermissionFlagsBits } = require(root + 'node_modules/discord.js');

(async () => {
  await GuildConfig.create({ guildId: 'g', guides: { editorRoleIds: ['editor'] } });

  // ---- normalization helpers
  assert.equal(faq.hasFaq({ content: '', embeds: [] }), false, 'empty is empty');
  assert.equal(faq.hasFaq({ content: 'hi', embeds: [] }), true, 'text counts');
  assert.equal(faq.hasFaq({ content: '', embeds: [{ title: 'Q' }] }), true, 'an embed counts');
  const payload = faq.toPayload({ content: 'Read this', embeds: [{ title: 'Q1', description: 'A1', color: '#ff0000' }] });
  assert.equal(payload.content, 'Read this');
  assert.equal(payload.embeds.length, 1);
  assert.equal(payload.embeds[0].color, 0xff0000, 'hex color normalized to int');
  // Empty message → content becomes null (so Discord doesn't get an empty string).
  assert.equal(faq.toPayload({ embeds: [{ title: 'x' }] }).content, null);
  console.log('✓ hasFaq / toPayload normalize the message the way Discord expects');

  // ---- permission mirrors guide editors (editor role, or Manage Server / Admin)
  assert.equal(await faq.isEditor(member([], ['editor']), 'g'), true, 'editor role → yes');
  assert.equal(await faq.isEditor(member([PermissionFlagsBits.ManageGuild]), 'g'), true, 'Manage Server → yes');
  assert.equal(await faq.isEditor(member([PermissionFlagsBits.Administrator]), 'g'), true, 'Admin → yes');
  assert.equal(await faq.isEditor(member([], ['random']), 'g'), false, 'a random role → no');
  assert.equal(await faq.isEditor(null, 'g'), false, 'no member → no');
  console.log('✓ FAQ editors are guide editors + Manage Server / Admins');

  // ---- saveFaq validates then persists
  const guild = { id: 'g' };
  assert.ok((await faq.saveFaq(guild, { message: { content: '', embeds: [] } }, 'u1')).error, 'empty is rejected');
  // Each field is capped at 1024 chars, so to exceed the 6000-per-embed total we need several fields.
  const bigFields = Array.from({ length: 7 }, (_, i) => ({ name: `F${i}`, value: 'x'.repeat(1000) }));
  assert.ok((await faq.saveFaq(guild, { message: { embeds: [{ description: 'hi', fields: bigFields }] } }, 'u1')).error, 'an over-6000 embed is rejected');

  const ok = await faq.saveFaq(guild, { message: { content: 'Welcome!', embeds: [{ title: 'Can I redeem codes?', description: 'Yes — in #redeem.' }] } }, 'u1');
  assert.ok(!ok.error, 'a valid FAQ saves');
  const loaded = await faq.getFaq('g');
  assert.equal(loaded.message.content, 'Welcome!');
  assert.equal(loaded.message.embeds[0].title, 'Can I redeem codes?');
  assert.equal(loaded.updatedBy, 'u1', 'remembers who saved it');
  console.log('✓ saveFaq rejects empty / oversized and persists a valid FAQ; getFaq reads it back');

  // rememberChannel updates only the channel, not the message or editor
  await faq.rememberChannel('g', 'c2');
  const after = await faq.getFaq('g');
  assert.equal(after.channelId, 'c2');
  assert.equal(after.message.content, 'Welcome!', 'rememberChannel leaves the message alone');
  console.log('✓ rememberChannel stores the last channel without touching the message');

  // ---- dashboard route: save / data / post
  const auth = require(root + 'src/web/utils/authMiddleware');
  auth.requireAuth = (q, s, n) => { q.session = { user: { id: 'u9' } }; n(); };
  let currentAccess = { level: 'mod', pages: new Set(['faq']) };
  auth.requireGuildAccess = (q, s, n) => { q.guild = routeGuild; q.access = currentAccess; n(); };
  auth.requirePage = () => (q, s, n) => n();
  const audit = require(root + 'src/web/utils/audit');
  audit.auditTrail = (q, s, n) => n();

  const posted = [];
  const chan = (type) => ({
    id: 'c1',
    type,
    isTextBased: () => true,
    permissionsFor: () => new PermissionsBitField(PermissionsBitField.All),
    send: async (p) => { posted.push(p); return { id: 'm1', url: 'https://discord/x/m1' }; }
  });
  const { ChannelType } = require(root + 'node_modules/discord.js');
  const routeGuild = { id: 'g', members: { me: { id: 'bot' } }, channels: { cache: new Collection([['c1', chan(ChannelType.GuildText)]]) } };

  const express = require(root + 'node_modules/express');
  const app = express();
  app.use(express.json());
  app.use('/dashboard', require(root + 'src/web/routes/faq'));
  const srv = app.listen(0);
  const base = `http://127.0.0.1:${srv.address().port}/dashboard/g/faq`;
  const call = async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, ...(await r.json()) };
  };

  // GET data returns what we saved earlier
  const data = await call('GET', '/data');
  assert.ok(data.ok && data.message.content === 'Welcome!', 'GET data returns the saved FAQ');

  // POST save stores a new message
  const saveRes = await call('POST', '/save', { message: { content: 'Edited FAQ', embeds: [] } });
  assert.ok(saveRes.ok, 'save ok');
  assert.equal((await faq.getFaq('g')).message.content, 'Edited FAQ', 'save persisted');

  // POST save rejects an empty message
  const bad = await call('POST', '/save', { message: { content: '', embeds: [] } });
  assert.equal(bad.status, 400, 'empty save rejected');

  // POST post sends to the channel and saves
  const postRes = await call('POST', '/post', { message: { content: 'Posted FAQ', embeds: [{ title: 'Hi' }] }, channelId: 'c1' });
  assert.ok(postRes.ok && postRes.url, 'post ok with a url');
  assert.equal(posted.length, 1, 'the bot sent one message');
  assert.equal(posted[0].content, 'Posted FAQ');
  assert.equal((await faq.getFaq('g')).message.content, 'Posted FAQ', 'posting also saved');

  // POST post without a channel is a clear error
  const noChan = await call('POST', '/post', { message: { content: 'x' }, channelId: '' });
  assert.equal(noChan.status, 400, 'post needs a channel');
  console.log('✓ route: GET data, POST save (with validation) and POST post (sends + saves) all work');

  srv.close();
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
