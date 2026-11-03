// FAQ: the Q&A model (items → embed fields, chunked), add/remove/edit helpers, editor permission,
// the /faq (public post) and /faqedit (editor) commands, and the dashboard save/data/post route.
process.env.TOKEN = 'x';
process.env.CLIENT_ID = '123';
process.env.MONGODB_URI = 'mongodb://x';
const root = require('path').join(__dirname, '..') + '/';
const assert = require('assert');
const { Collection, PermissionsBitField, PermissionFlagsBits, ChannelType } = require(root + 'node_modules/discord.js');
const { store } = require('./helpers/memstore');
const GuildConfig = require(root + 'src/database/models/GuildConfig');
store(GuildConfig);
const faq = require(root + 'src/bot/cogs/modules/faq');

const member = (perms, roleIds = []) => ({ permissions: { has: (p) => perms.includes(p) }, roles: { cache: new Collection(roleIds.map((r) => [r, { id: r }])) } });

(async () => {
  await GuildConfig.create({ guildId: 'g', guides: { editorRoleIds: ['editor'] } });
  const guild = { id: 'g' };

  // ---- render: items become embed fields under a title
  const r1 = faq.renderEmbeds({ title: '', intro: 'Read me', color: '#5865f2', items: [{ q: 'Codes?', a: 'Yes, in #redeem' }] });
  assert.equal(r1.length, 1, 'one embed');
  assert.equal(r1[0].title, faq.DEFAULT_TITLE, 'falls back to the default title');
  assert.equal(r1[0].description, 'Read me', 'intro becomes the description');
  assert.equal(r1[0].fields[0].name, 'Codes?');
  assert.equal(r1[0].fields[0].value, 'Yes, in #redeem');
  console.log('✓ renderEmbeds: title + intro + a field per question');

  // chunking: >25 questions spill into a second embed (25 fields max per embed)
  const many = Array.from({ length: 30 }, (_, i) => ({ q: `Q${i}`, a: `A${i}` }));
  const r2 = faq.renderEmbeds({ items: many });
  assert.equal(r2.length, 2, 'splits into two embeds');
  assert.equal(r2[0].fields.length, 25, 'first embed holds 25');
  assert.equal(r2[1].fields.length, 5, 'rest go to the next');
  console.log('✓ renderEmbeds chunks past 25 questions into more embeds');

  assert.equal(faq.hasFaq({ items: [] }), false, 'empty is empty');
  assert.equal(faq.hasFaq({ items: [{ q: 'a', a: 'b' }] }), true, 'a question counts');
  assert.equal(faq.hasFaq({ intro: 'hi', items: [] }), true, 'intro alone counts');

  // ---- permission mirrors guide editors
  assert.equal(await faq.isEditor(member([], ['editor']), 'g'), true);
  assert.equal(await faq.isEditor(member([PermissionFlagsBits.ManageGuild]), 'g'), true);
  assert.equal(await faq.isEditor(member([], ['nope']), 'g'), false);
  console.log('✓ FAQ editors are guide editors + Manage Server / Admins');

  // ---- add / remove / edit
  assert.ok((await faq.addItem(guild, '', 'x', 'u')).error, 'needs a question');
  let res = await faq.addItem(guild, 'How do I rank up?', 'Chat to earn XP.', 'u');
  assert.ok(!res.error && res.faq.items.length === 1, 'added one');
  assert.ok((await faq.addItem(guild, 'how do i rank up?', 'dup', 'u')).error, 'rejects a duplicate question (case-insensitive)');
  await faq.addItem(guild, 'Can I redeem codes?', 'Yes — in #redeem.', 'u');
  assert.equal((await faq.getFaq('g')).items.length, 2, 'two now');

  res = await faq.editItem(guild, 'can i redeem codes?', { answer: 'Yes, post them in #redeem.' }, 'u');
  assert.ok(!res.error);
  assert.equal((await faq.getFaq('g')).items.find((it) => it.q === 'Can I redeem codes?').a, 'Yes, post them in #redeem.', 'answer updated');
  res = await faq.editItem(guild, 'how do i rank up?', { newQuestion: 'How do I level up?' }, 'u');
  assert.ok((await faq.getFaq('g')).items.some((it) => it.q === 'How do I level up?'), 'question reworded');
  assert.ok((await faq.editItem(guild, 'nope', { answer: 'x' }, 'u')).error, 'editing a missing question errors');

  const rem = await faq.removeItem(guild, 'How do I level up?', 'u');
  assert.ok(!rem.error && rem.removed === 1 && rem.faq.items.length === 1, 'removed one');
  assert.ok((await faq.removeItem(guild, 'ghost', 'u')).error, 'removing a missing question errors');
  console.log('✓ add / remove / edit manage entries (dup + missing guarded)');

  // ---- /faq (public) and /faqedit (editor) commands
  const { commands } = require(root + 'src/bot/commands/faq');
  const faqCmd = commands.find((c) => c.data.name === 'faq');
  const faqEditCmd = commands.find((c) => c.data.name === 'faqedit');
  assert.ok(faqCmd && faqEditCmd, 'both commands exist');
  assert.equal(faqEditCmd.data.toJSON().options.length, 4, 'faqedit has dashboard/add/remove/edit');

  // /faq posts publicly (not ephemeral) with embeds
  let posted = null;
  await faqCmd.execute({ guildId: 'g', reply: async (o) => { posted = o; } });
  assert.ok(posted && posted.embeds && posted.embeds.length && !posted.ephemeral, '/faq replies publicly with embeds');

  // /faq on an empty FAQ is a gentle ephemeral note
  await GuildConfig.updateOne({ guildId: 'g2' }, { $set: { guildId: 'g2' } }, { upsert: true });
  let note = null;
  await faqCmd.execute({ guildId: 'g2', reply: async (o) => { note = o; } });
  assert.ok(note.ephemeral && /set up/i.test(note.content), 'empty FAQ → ephemeral hint');

  // /faqedit is gated to editors
  const base = { guildId: 'g', guild, user: { id: 'u' }, options: { getSubcommand: () => 'add', getString: (n) => ({ question: 'New Q', answer: 'New A' }[n]) } };
  let denied = null;
  await faqEditCmd.execute({ ...base, member: member([], ['nope']), reply: async (o) => { denied = o; } });
  assert.ok(/Only guide editors/.test(denied.content), 'non-editor denied');
  let okReply = null;
  await faqEditCmd.execute({ ...base, member: member([], ['editor']), reply: async (o) => { okReply = o; } });
  assert.ok(/Added/.test(okReply.content), 'editor can add via /faqedit');
  console.log('✓ /faq posts publicly; empty is handled; /faqedit gated to editors');

  // ---- dashboard route
  const auth = require(root + 'src/web/utils/authMiddleware');
  auth.requireAuth = (q, s, n) => { q.session = { user: { id: 'u9' } }; n(); };
  auth.requireGuildAccess = (q, s, n) => { q.guild = routeGuild; q.access = { level: 'mod', pages: new Set(['faq']) }; n(); };
  auth.requirePage = () => (q, s, n) => n();
  require(root + 'src/web/utils/audit').auditTrail = (q, s, n) => n();

  const sent = [];
  const chan = { id: 'c1', type: ChannelType.GuildText, isTextBased: () => true, permissionsFor: () => new PermissionsBitField(PermissionsBitField.All), send: async (p) => { sent.push(p); return { id: 'm1', url: 'https://discord/x/m1' }; } };
  const routeGuild = { id: 'g', members: { me: { id: 'bot' } }, channels: { cache: new Collection([['c1', chan]]) } };

  const express = require(root + 'node_modules/express');
  const app = express();
  app.use(express.json());
  app.use('/dashboard', require(root + 'src/web/routes/faq'));
  const srv = app.listen(0);
  const baseUrl = `http://127.0.0.1:${srv.address().port}/dashboard/g/faq`;
  const call = async (method, path, body) => { const r = await fetch(baseUrl + path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, ...(await r.json()) }; };

  const data = await call('GET', '/data');
  assert.ok(data.ok && Array.isArray(data.faq.items), 'GET data returns the FAQ');

  const save = await call('POST', '/save', { faq: { title: 'Help', intro: '', color: '#ff0000', items: [{ q: 'Q1', a: 'A1' }] } });
  assert.ok(save.ok && save.faq.items.length === 1 && save.faq.color === '#ff0000', 'save persisted');
  assert.equal((await call('POST', '/save', { faq: { items: [] } })).status, 400, 'empty save rejected');

  const post = await call('POST', '/post', { faq: { title: 'Help', items: [{ q: 'Q1', a: 'A1' }] }, channelId: 'c1' });
  assert.ok(post.ok && post.url && sent.length === 1 && sent[0].embeds.length, 'post sent an embed');
  assert.equal((await call('POST', '/post', { faq: { items: [{ q: 'Q', a: 'A' }] }, channelId: '' })).status, 400, 'post needs a channel');
  console.log('✓ route: data / save (validated) / post (sends embed)');

  srv.close();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
