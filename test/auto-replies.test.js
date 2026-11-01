// Auto-replies: keyword matching across all channels, channel/role exclusions, cooldown, placeholders,
// and the add/remove/toggle/settings CRUD.
process.env.TOKEN='x';process.env.CLIENT_ID='123';process.env.MONGODB_URI='mongodb://x';
const root=require('path').join(__dirname,'..')+'/'; const assert=require('assert');
const { Collection } = require(root+'node_modules/discord.js');
const { store } = require('./helpers/memstore');
const GuildConfig=require(root+'src/database/models/GuildConfig');
store(GuildConfig);
const A=require(root+'src/bot/cogs/modules/autoReplies');

// ---- fake message
function message(content, { channelId='c1', roleIds=[], bot=false } = {}) {
  const m = { content, author:{ id:'u1', bot, username:'Ann' }, member:{ displayName:'Ann', roles:{ cache:new Collection(roleIds.map((r)=>[r,{id:r}])) } },
    guild:{ id:'g', name:'Lounge', memberCount:42 }, guildId:'g', channelId, deletable:true, deleted:false,
    channel:{ id:channelId, send:async(p)=>{ m._sent=p; return { id:'r1' }; } }, delete:async()=>{ m.deleted=true; },
    reply:async(p)=>{ m._reply=p; return { id:'r1' }; } };
  return m;
}
const cfg=()=>GuildConfig.findOne({guildId:'g'}).lean();

(async () => {
  await GuildConfig.create({ guildId:'g' });
  const guild={ id:'g', channels:{ cache:new Collection([['c1',{id:'c1'}],['c2',{id:'c2'}]]) }, roles:{ cache:new Collection([['vip',{id:'vip'}]]) } };

  // ---- matching modes
  const base={ enabled:true, caseSensitive:false, ignoreChannelIds:[], ignoreRoleIds:[] };
  assert.equal(A.matchesTrigger({...base,match:'word',keywords:['hi']},'oh hi there'),true,'whole word hit');
  assert.equal(A.matchesTrigger({...base,match:'word',keywords:['hi']},'this'),false,'not a partial word');
  assert.equal(A.matchesTrigger({...base,match:'contains',keywords:['gg']},'ggwp'),true,'contains hit');
  assert.equal(A.matchesTrigger({...base,match:'exact',keywords:['ping']},'ping'),true,'exact hit');
  assert.equal(A.matchesTrigger({...base,match:'exact',keywords:['ping']},'ping!'),false,'exact miss');
  assert.equal(A.matchesTrigger({...base,match:'starts',keywords:['!help']},'!help me'),true,'starts hit');
  assert.equal(A.matchesTrigger({...base,match:'regex',keywords:['h+i']},'hhhi'),true,'regex hit');
  assert.equal(A.matchesTrigger({...base,match:'word',keywords:['HI'],caseSensitive:true},'hi'),false,'case-sensitive respects case');
  // requireAll: every keyword must appear (question phrasings) — order-independent
  const codes={...base,match:'contains',keywords:['codes','redeem'],requireAll:true};
  assert.equal(A.matchesTrigger(codes,'what are the codes we can redeem?'),true,'requireAll: both words present → hit');
  assert.equal(A.matchesTrigger(codes,'redeem the codes please'),true,'requireAll is order-independent');
  assert.equal(A.matchesTrigger(codes,'nice codes'),false,'requireAll: missing a keyword → no hit');
  assert.equal(A.matchesTrigger({...codes,requireAll:false},'nice codes'),true,'default (any) still fires on one keyword');
  console.log('✓ matching: word/contains/exact/starts/regex, case sensitivity, requireAll (all keywords)');

  // ---- add a trigger (enables the system)
  let r=await A.addTrigger(guild,{ name:'Greet', keywords:'hi, hello', response:'Hey {user} in {channel}!' });
  assert.ok(!r.error,r.error); const id=r.trigger.id;
  assert.equal((await cfg()).autoReplies.enabled,true,'adding a trigger turns the system on');

  // ---- handler replies with placeholders, as a reply
  let m=message('well hello everyone');
  assert.equal(await A.handleAutoReply(m, await cfg()), true, 'a matching message gets a reply');
  assert.match(m._reply.content, /Hey <@u1> in <#c1>!/, 'placeholders filled');
  assert.deepEqual(m._reply.allowedMentions.parse, ['users'], 'never pings @everyone/@role');

  // ---- cooldown: same trigger, same channel, immediately → no second reply
  m=message('hi again');
  assert.equal(await A.handleAutoReply(m, await cfg()), false, 'cooldown blocks a rapid repeat');

  // ---- exclusions: channel + role
  await A.saveSettings(guild,{ cooldownSeconds:0 }); // drop cooldown for the rest
  r=await A.addTrigger(guild,{ id, name:'Greet', keywords:'hi, hello', response:'hey', ignoreChannelIds:['c2'], ignoreRoleIds:['vip'] });
  assert.ok(!r.error);
  assert.equal(await A.handleAutoReply(message('hi', { channelId:'c2' }), await cfg()), false, 'excluded channel is ignored');
  assert.equal(await A.handleAutoReply(message('hi', { roleIds:['vip'] }), await cfg()), false, 'excluded role is ignored');
  assert.equal(await A.handleAutoReply(message('hi', { channelId:'c1' }), await cfg()), true, 'still fires elsewhere');

  // ---- bots never trigger it
  assert.equal(await A.handleAutoReply(message('hi', { bot:true }), await cfg()), false, 'bot messages are ignored');

  // ---- delete_trigger option
  r=await A.addTrigger(guild,{ id, keywords:'hi', response:'bye', deleteTrigger:true, reply:false });
  m=message('hi'); await A.handleAutoReply(m, await cfg());
  assert.equal(m.deleted, true, 'delete_trigger removes the message');
  assert.equal(m._sent.content, 'bye', 'plain send when reply is off');

  // ---- toggle off → no reply; master switch off → no reply
  await A.toggleTrigger(guild, id, false);
  assert.equal(await A.handleAutoReply(message('hi'), await cfg()), false, 'a disabled trigger does nothing');
  await A.toggleTrigger(guild, id, true);
  await A.saveSettings(guild,{ enabled:false });
  assert.equal(await A.handleAutoReply(message('hi'), await cfg()), false, 'master switch off disables everything');

  // ---- remove
  await A.saveSettings(guild,{ enabled:true });
  await A.removeTrigger(guild, id);
  assert.equal((await A.listTriggers('g')).length, 0, 'trigger removed');
  console.log('✓ handler: replies+placeholders, cooldown, channel/role excludes, bots skipped, delete/toggle/remove');

  // ---- validation
  assert.match((await A.addTrigger(guild,{ keywords:'', response:'x' })).error, /keyword/i, 'needs a keyword');
  assert.match((await A.addTrigger(guild,{ keywords:'hi', response:'' })).error, /response/i, 'needs a response');
  assert.match((await A.saveSettings(guild,{ cooldownSeconds:99999 })).error, /Cooldown/, 'cooldown bounds');
  console.log('✓ validation: keyword + response required, cooldown bounded');

  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
