// Server Stats channels: settings, name formatting, the computed context (members/online/boosts/top
// XP), and syncing the channels (create → rename → remove) with a fake guild.
process.env.TOKEN='x';process.env.CLIENT_ID='1';process.env.MONGODB_URI='mongodb://x';
const root=require('path').join(__dirname,'..')+'/'; const assert=require('assert');
const { Collection, ChannelType, PermissionsBitField } = require(root+'node_modules/discord.js');
const { store } = require('./helpers/memstore');
const GuildConfig=require(root+'src/database/models/GuildConfig'); store(GuildConfig);
const UserLevel=require(root+'src/database/models/UserLevel'); store(UserLevel);
const S=require(root+'src/bot/cogs/modules/serverStats');

// ---- fake guild + client
let cid=1; const created=[];
function makeChannel(opts){ const ch={ id:`c${cid++}`, name:opts.name, type:opts.type, parent:opts.parent||null, deleted:false,
  setName:async(n)=>{ch.name=n;return ch;}, setPosition:async()=>ch, delete:async()=>{ch.deleted=true;guild.channels.cache.delete(ch.id);} };
  return ch; }
const guild={ id:'g', memberCount:233, premiumTier:1, premiumSubscriptionCount:2,
  roles:{ everyone:{id:'everyone'}, cache:new Collection([['everyone',{}],['r1',{}],['r2',{}]]) }, // 3 → roleCount 2
  channels:{ cache:new Collection(), create:async(opts)=>{ const ch=makeChannel(opts); guild.channels.cache.set(ch.id,ch); created.push(ch); return ch; } },
  members:{ me:{ permissions:new PermissionsBitField(PermissionsBitField.All) } } };
let restCalls=0;
const client={ guilds:{ cache:new Collection([['g',guild]]) }, rest:{ get:async()=>{ restCalls++; return { approximate_presence_count:42, approximate_member_count:233 }; } } };
const cfg=()=> GuildConfig.findOne({guildId:'g'}).lean();

(async()=>{
  await GuildConfig.create({guildId:'g'});
  await UserLevel.create({guildId:'g',userId:'ann',xp:14250,level:20});
  await UserLevel.create({guildId:'g',userId:'ben',xp:9000,level:15});

  // ---- settings: defaults, bad keys dropped
  let s=S.serverStatsSettings({});
  assert.deepEqual(s.enabledStats,['members','online','boosts','highestxp'],'sensible defaults');
  assert.equal(s.enabled,false);
  s=S.serverStatsSettings({serverStats:{enabledStats:['members','bogus','roles']}});
  assert.deepEqual(s.enabledStats,['members','roles'],'unknown stat keys are dropped');
  console.log('✓ settings: defaults and validation');

  // ---- context + name formatting
  const ctx=await S.computeContext(client,guild,['members','online','boosts','highestxp','roles','channels']);
  assert.deepEqual([ctx.memberCount,ctx.online,ctx.boostTier,ctx.boostCount,ctx.roleCount],[233,42,1,2,2]);
  assert.equal(ctx.highestXp,14250,'top XP from the leaderboard');
  const name=(k)=>S.channelName(S.STAT_DEFS.find(d=>d.key===k),ctx);
  assert.equal(name('members'),'👥 Members: 233');
  assert.equal(name('online'),'🟢 Online: 42');
  assert.equal(name('boosts'),'🚀 Boosts: Lvl 1 (2)');
  assert.equal(name('highestxp'),'🏆 Top XP: 14,250');
  console.log('✓ context (members/online/boosts/top XP/roles/channels) and channel-name formatting');

  // online is only fetched when the stat is shown
  restCalls=0; await S.computeContext(client,guild,['members','boosts']); assert.equal(restCalls,0,'no REST call when Online is hidden');
  restCalls=0; await S.computeContext(client,guild,['online']); assert.equal(restCalls,1,'one REST call when Online is shown');
  console.log('✓ the live online count is only fetched when the Online stat is enabled');

  // ---- sync creates the category + a channel per enabled stat
  await S.saveSettings(guild,{enabled:true,enabledStats:['members','online','boosts','highestxp']});
  let r=await S.syncChannels(client,guild);
  assert.equal(r.created,4,'one channel per enabled stat'); assert.equal(r.removed,0);
  const cat=created.find(c=>c.type===ChannelType.GuildCategory);
  assert.ok(cat && cat.name==='📊 Server Stats','a stats category at the top');
  const voice=created.filter(c=>c.type===ChannelType.GuildVoice);
  assert.equal(voice.length,4); assert.ok(voice.every(c=>c.parent===cat.id),'channels live under the category');
  assert.ok(voice.find(c=>c.name==='👥 Members: 233')); assert.ok(voice.find(c=>c.name==='🟢 Online: 42'));
  const stored=(await cfg()).serverStats; assert.equal(Object.keys(stored.channels).length,4); assert.equal(stored.categoryId,cat.id);
  console.log('✓ setup creates the category and a view-only channel per enabled stat');

  // ---- a second sync renames (members changed) instead of recreating
  guild.memberCount=240;
  r=await S.syncChannels(client,guild);
  assert.equal(r.created,0,'no new channels'); assert.equal(r.renamed,1,'only Members changed');
  assert.ok(guild.channels.cache.find(c=>c.name==='👥 Members: 240'));
  console.log('✓ a refresh renames changed channels and leaves the rest alone');

  // ---- turning a stat off removes just that channel
  await S.saveSettings(guild,{enabledStats:['members','online','boosts']}); // drop highestxp
  r=await S.syncChannels(client,guild);
  assert.equal(r.removed,1,'the Top XP channel is removed'); assert.equal(r.created,0);
  assert.ok(!guild.channels.cache.find(c=>c.name.startsWith('🏆')));
  assert.equal(Object.keys((await cfg()).serverStats.channels).length,3);
  console.log('✓ hiding a stat deletes just its channel');

  // ---- remove all tears everything down
  await S.removeAll(guild);
  assert.equal(guild.channels.cache.filter(c=>c.type===ChannelType.GuildVoice||c.type===ChannelType.GuildCategory).size,0,'all stat channels gone');
  assert.equal(Object.keys((await cfg()).serverStats.channels).length,0); assert.equal((await cfg()).serverStats.categoryId,null);
  console.log('✓ remove deletes every stat channel and the category');

  // ---- sweep only touches enabled guilds, and needs Manage Channels
  guild.members.me.permissions=new PermissionsBitField(); // no perms
  await S.saveSettings(guild,{enabled:true});
  r=await S.syncChannels(client,guild); assert.match(r.error,/Manage Channels/,'refuses without the permission');
  console.log('✓ sync refuses without Manage Channels');

  process.exit(0);
})().catch(e=>{console.error(e);process.exit(1);});
