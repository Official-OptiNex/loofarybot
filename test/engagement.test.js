// Birthdays, counting and the starboard — plus the giveaway requirement checklist.
process.env.TOKEN='x';process.env.CLIENT_ID='123';process.env.MONGODB_URI='mongodb://x';
const root=require('path').join(__dirname,'..')+'/'; const assert=require('assert');
const { PermissionsBitField, Collection } = require(root+'node_modules/discord.js');
const { store } = require('./helpers/memstore');
const GuildConfig=require(root+'src/database/models/GuildConfig');
const Birthday=require(root+'src/database/models/Birthday');
const StarboardPost=require(root+'src/database/models/StarboardPost');
const cfgRows=store(GuildConfig); const bdRows=store(Birthday); const sbRows=store(StarboardPost);
const L=require(root+'src/bot/cogs/modules/leveling');
const xp={}; L.adjustXp=async(g,u,d)=>{ xp[u]=(xp[u]||0)+d; return {oldLevel:0,newLevel:0,roleFailures:[]}; };
const B=require(root+'src/bot/cogs/modules/birthdays');
const C=require(root+'src/bot/cogs/modules/counting');
const S=require(root+'src/bot/cogs/modules/starboard');

// ---- fake guild
const sent=[];
function channel(id, extra={}){ const msgs=new Map(); let n=1; const ch={id,name:id,nsfw:false,guild:null,isTextBased:()=>true,isThread:()=>false,permissionsFor:()=>new PermissionsBitField(PermissionsBitField.All),toString(){return `<#${id}>`;},
  send:async(p)=>{ const m={id:`${id}-${n++}`,payload:typeof p==='string'?{content:p}:p,deleted:false,edit:async(np)=>{m.payload=np;return m;},delete:async()=>{m.deleted=true;msgs.delete(m.id);}}; msgs.set(m.id,m); sent.push({ch:id,m}); return m; },
  permissionOverwrites:{edit:async(role,opts)=>{ ch.overwrites=ch.overwrites||{}; ch.overwrites[role.id||role]={...(ch.overwrites[role.id||role]||{}),...opts}; return ch; }},
  messages:{fetch:async(mid)=>{ const m=msgs.get(mid); if(!m) throw new Error('Unknown'); return m; }}, msgs, ...extra}; return ch; }
const roleLog=[];
function member(id, bot=false){ const roles=new Set(); return {id,user:{id,bot,username:id},displayName:id,joinedTimestamp:Date.now()-5*864e5,roles:{cache:{has:(r)=>roles.has(r)},add:async(r)=>{roles.add(r);roleLog.push(['add',id,r]);},remove:async(r)=>{roles.delete(r);roleLog.push(['remove',id,r]);}}}; }
const members=new Collection([['ann',member('ann')],['ben',member('ben')],['cat',member('cat')],['botty',member('botty',true)]]);
const guild={id:'g',name:'Loofary Lounge',channels:{cache:new Collection()},roles:{cache:new Collection([['bdrole',{id:'bdrole',position:1,managed:false}],['boost',{id:'boost',position:2,managed:true}]]),create:async({name,color})=>{ const r={id:'cban',name,color:color||0,position:3,managed:false,toString(){return `<@&cban>`;}}; guild.roles.cache.set(r.id,r); return r; }},emojis:{cache:new Collection()},
  members:{me:{id:'bot',permissions:new PermissionsBitField(PermissionsBitField.All),roles:{highest:{position:10}}},cache:members,fetch:async(id)=>{ const m=members.get(id); if(!m) throw new Error('Unknown Member'); return m; }}};
for (const id of ['general','count','stars','memes','secret']) { const c=channel(id); c.guild=guild; guild.channels.cache.set(id,c); }
const client={guilds:{cache:new Map([['g',guild]])},user:{id:'bot'},channels:{cache:guild.channels.cache}};
const cfg=()=>cfgRows.find(r=>r.guildId==='g');

(async()=>{
  await GuildConfig.create({guildId:'g'});

  // ================================================================ Birthdays
  assert.match(B.validDate(2,30).error,/February only has 29 days/);
  assert.match(B.validDate(13,1).error,/month/);
  assert.deepEqual(B.validDate(2,29),{month:2,day:29});
  const now=new Date(Date.UTC(2027,1,28,15)); // Feb 28 2027 (not a leap year), 15:00 UTC
  assert.deepEqual(B.datesFor(now),[{month:2,day:28},{month:2,day:29}]);
  assert.deepEqual(B.datesFor(new Date(Date.UTC(2028,1,28))),[{month:2,day:28}]); // leap year: Feb 29 gets its own day
  assert.equal(B.daysUntil(3,1,now),1); assert.equal(B.daysUntil(2,28,now),0); assert.equal(B.daysUntil(2,27,now),364); // next Feb 27 is in 2028
  console.log('✓ dates: validation, Feb 29 celebrated on Feb 28 outside leap years, days-until wraps to next year');

  let r=await B.saveSettings(guild,{enabled:true}); assert.match(r.error,/channel/);
  r=await B.saveSettings(guild,{roleId:'boost'}); assert.match(r.error,/managed/);
  r=await B.saveSettings(guild,{enabled:true,channelId:'general',roleId:'bdrole',xpGift:250,announceHour:14,message:'🎂 HBD {users} from {server}! ({count})'});
  assert.equal(r.settings.enabled,true); assert.equal(r.settings.xpGift,250);
  await B.setBirthday('g','ann',2,28); await B.setBirthday('g','ben',2,29); await B.setBirthday('g','cat',7,4);
  await B.setBirthday('g','gone',2,28); await B.setBirthday('g','botty',2,28);
  assert.match((await B.setBirthday('g','ann',4,31)).error,/April only has 30/);
  const up=await B.upcoming('g',{guild,now}); assert.deepEqual(up.map(u=>u.userId),['ann','ben','cat']); // left members and bots skipped
  console.log('✓ settings validated (no managed roles), birthdays saved, upcoming list sorted and skips members who left');

  await B.tick(client,new Date(Date.UTC(2027,1,28,13))); assert.equal(sent.length,0,'before the post hour: nothing');
  await B.tick(client,new Date(Date.UTC(2027,1,27,15))); assert.equal(sent.length,0,'nobody on Feb 27');
  assert.notEqual(cfg().birthdays.lastRunDay,'2027-02-27','a day with no birthdays isn’t used up (a birthday saved later that day still gets its post)');
  await B.tick(client,now);
  assert.equal(sent.length,1); const post=sent[0].m.payload;
  assert.match(post.embeds[0].data.description,/^🎂 HBD <@ann> and <@ben> from Loofary Lounge! \(2\)/);
  assert.match(post.embeds[0].data.description,/\+250 XP.*<@&bdrole> for the day/);
  assert.deepEqual(post.allowedMentions,{users:['ann','ben']});
  assert.equal(xp.ann,250); assert.equal(xp.ben,250); assert.equal(xp.botty,undefined);
  assert.deepEqual(roleLog,[['add','ann','bdrole'],['add','ben','bdrole']]);
  await B.tick(client,new Date(now.getTime()+3600e3)); await Promise.all([B.tick(client,now),B.tick(client,now)]);
  assert.equal(sent.length,1,'once a day, even with overlapping ticks');
  console.log('✓ one post at the chosen hour for everyone celebrating (bots/leavers skipped), XP gift + role, never twice a day');

  await B.removeExpiredRoles(client,new Date(now.getTime()+23*3600e3)); assert.equal(roleLog.length,2);
  await B.removeExpiredRoles(client,new Date(now.getTime()+25*3600e3));
  assert.deepEqual(roleLog.slice(2),[['remove','ann','bdrole'],['remove','ben','bdrole']]);
  assert.ok(bdRows.every(b=>!b.roleGivenAt));
  console.log('✓ birthday role taken back after 24 hours');

  // ================================================================ Counting
  r=await C.saveSettings(guild,{enabled:true}); assert.match(r.error,/channel/);
  r=await C.saveSettings(guild,{enabled:true,channelId:'count'}); assert.equal(r.settings.allowSameUser,false);
  assert.equal(r.settings.numbersOnly,true,'numbers-only on by default'); assert.equal(r.settings.slowmodeSeconds,1200,'20-min slowmode by default');
  const countCh=guild.channels.cache.get('count');
  let mid=1;
  function msg(user,content,ch=countCh,staff=false){ const reacts=[]; const m={id:`m${mid++}`,guild,guildId:'g',channelId:ch.id,channel:ch,content,author:{id:user,bot:false,toString:()=>`<@${user}>`},member:{permissions:{has:()=>staff}},deletable:true,deleted:false,delete:async()=>{m.deleted=true;},system:false,webhookId:null,react:async(e)=>reacts.push(e),reacts}; return m; }
  const count=async(user,content,staff=false)=>{ const m=msg(user,content,countCh,staff); const handled=await C.handleCounting(m,cfg()); return {m,handled}; };

  let x=await count('ann','1'); assert.deepEqual(x.m.reacts,['✅']);
  x=await count('ben','2 lol'); assert.deepEqual(x.m.reacts,['✅']); assert.equal(cfg().counting.current,2);
  x=await count('ann','hello!'); assert.equal(x.handled,true); assert.equal(x.m.deleted,true,'normal chatter is deleted (numbers only)'); assert.equal(cfg().counting.current,2);
  x=await count('ann','nice run!',true); assert.equal(x.handled,false); assert.equal(x.m.deleted,false,'staff can still talk');
  x=await count('ann','(1+2)*1'); assert.deepEqual(x.m.reacts,['✅']); assert.equal(cfg().counting.current,3); // last user: ann
  console.log('✓ counting: right numbers ✅ (sums + trailing chat ok), chatter deleted, staff exempt');

  // Full-maths evaluator: PEMDAS, factorials, roots, nCr/nPr, functions, summation/product/integral,
  // trailing chat ignored, and hostile input can't tie up the bot or count as junk.
  for (const [inp,exp] of [['3*4',12],['(2+3)*4-1',19],['10%3',1],['2^10',1024],['7!/5!',42],['5!',120],
    ['√144',12],['∛27',3],['sqrt(225)',15],['root(27,3)',3],['nCr(6,2)',15],['choose(10,3)',120],['nPr(5,2)',20],
    ['gcd(12,18)',6],['lcm(4,6)',12],['floor(7.9)',7],['abs(-9)',9],['∑(i,1,5,i)',15],['sum(i,1,10,i)',55],
    ['prod(i,1,5,i)',120],['integral(x,0,3,2*x)',9],['log(1000)',3],['log(8,2)',3],['max(3,7,2)',7],
    ['3*4 nice try',12],['12 nice',12],['3 x 4',12],['2+2',4]])
    assert.equal(C.parseCount(inp),exp,`maths: ${inp}`);
  for (const inp of ['hello!','2*pi','-5','1.5','sqrt(2)','sum(i,1,100000000,i)','1-800-273','not a number'])
    assert.equal(C.parseCount(inp),null,`not a usable count: ${inp}`);
  assert.equal(C.parseCount('99999!'),99999,'an over-170 factorial just falls back to the number typed');
  assert.equal(C.parseCount('5!',false),5,'maths off: "5!" is just the plain 5');
  // Long maths is read in full, never cut off partway (a 1,800-character "14+983-983+…" once counted as 705).
  const longSum='14'+'+983-983+742-742+615-615'.repeat(70); assert.equal(C.parseCount(longSum),14,'long sums are read to the end');
  assert.equal(C.parseCount('1'+'+1-1'.repeat(1100)),null,'over the length limit: not counted at all, rather than partly');
  assert.equal(C.parseCount('('.repeat(3000)+'5'+')'.repeat(3000)),null,'absurd nesting is rejected safely');
  const t0=Date.now(); for (let k=0;k<500;k++) C.parseCount('sum(i,1,1000,prod(j,1,1000,j))'); assert.ok(Date.now()-t0<1000,'hostile maths stays cheap');
  console.log('✓ counting maths: PEMDAS, factorials, roots, nCr/nPr, functions, ∑/∏/∫; junk ignored; capped against abuse');

  // Counting twice in a row: deleted, NOT a reset — griefers can't wipe the run.
  let before=sent.length;
  x=await count('ann','4'); assert.deepEqual(x.m.reacts,[]); assert.equal(x.m.deleted,true); assert.equal(cfg().counting.current,3,'run kept'); assert.equal(cfg().counting.resets,0);
  assert.match(sent.at(-1).m.payload.content,/take turns.*count \*\*4\*\*/i); assert.equal(sent.length,before+1);
  console.log('✓ counting twice is deleted, not a reset — the run survives a griefer');

  // A same-number tie is forgiven; a genuinely wrong number still resets (and records the best run).
  x=await count('ben','4'); assert.deepEqual(x.m.reacts,['✅']); assert.equal(cfg().counting.current,4); // last user: ben
  x=await count('cat','4'); assert.deepEqual(x.m.reacts,['👀'],'same number a moment later: too slow, no reset'); assert.equal(cfg().counting.current,4);
  x=await count('ann','9'); assert.deepEqual(x.m.reacts,['❌']); assert.equal(cfg().counting.current,0,'wrong number resets'); assert.equal(cfg().counting.resets,1); assert.equal(cfg().counting.record,4);
  assert.match(sent.at(-1).m.payload.content,/said \*\*9\*\* — it was \*\*5\*\*/);
  console.log('✓ a same-number tie is forgiven; a wrong number still resets and records the best run');

  // Trophy when the previous best (4) is beaten; 💯 milestone.
  for (const [u,n] of [['ann','1'],['ben','2'],['cat','3'],['ann','4']]) x=await count(u,n);
  assert.deepEqual(x.m.reacts,['✅'],'up to the old best (4) — no trophy yet');
  x=await count('ben','5'); assert.deepEqual(x.m.reacts,['✅','🏆'],'passing the best run (4) earns a trophy');
  console.log('✓ trophy when the best run is beaten');

  r=await C.saveSettings(guild,{current:99}); assert.equal(r.settings.current,99); assert.equal(r.settings.record,99);
  x=await count('ben','100'); assert.deepEqual(x.m.reacts,['💯']);
  await C.handleCountDeleted({guildId:'g',channelId:'count',channel:countCh,id:x.m.id});
  const record=sent.at(-1).m;
  assert.match(record.payload.content,/<@ben> counted \*\*100\*\* then deleted it — that count still stands\. Next number is \*\*101\*\*/);
  assert.equal(cfg().counting.current,100,'deleting your count never rewinds the run');
  assert.equal(cfg().counting.lastMessageId,record.id,'the bot re-post becomes the authoritative record');
  // The bot's own re-post being deleted must not loop into another re-post.
  const afterRecord=sent.length; await C.handleCountDeleted({guildId:'g',channelId:'count',channel:countCh,id:record.id,author:{bot:true}}); assert.equal(sent.length,afterRecord,'a deleted bot record does not re-post');
  const beforeOther=sent.length; await C.handleCountDeleted({guildId:'g',channelId:'count',channel:countCh,id:'old'}); assert.equal(sent.length,beforeOther);
  x=await C.handleCounting(msg('ann','1',guild.channels.cache.get('general')),cfg()); assert.equal(x,false,'other channels untouched');
  // Race: two people send 101 at the same moment — only one counts.
  const [p1,p2]=[msg('ann','101'),msg('cat','101')]; await Promise.all([C.handleCounting(p1,cfg()),C.handleCounting(p2,cfg())]);
  assert.equal(cfg().counting.current,101); assert.deepEqual([p1.reacts,p2.reacts].map(a=>a[0]).sort(),['✅','👀']);
  // The same message delivered twice (two bot instances during a deploy) counts once and never resets.
  const resets0=cfg().counting.resets; const dupe=msg('ben','102');
  assert.equal(await C.handleCounting(dupe,cfg()),true); assert.equal(await C.handleCounting(dupe,cfg()),true);
  assert.deepEqual(dupe.reacts,['✅'],'no ❌ on the second delivery'); assert.equal(cfg().counting.current,102); assert.equal(cfg().counting.resets,resets0);
  await C.saveSettings(guild,{current:101}); // back to 101 for the edit checks below
  console.log('✓ set the count, 💯 milestones, deleting the latest count posts the next number, simultaneous counts can’t both win');

  // Editing your count to a different number can't rewind or disguise it either ("39" → "38").
  x=await count('ben','102'); assert.deepEqual(x.m.reacts,['✅']); assert.equal(cfg().counting.current,102);
  await C.handleCountEdited({},{...x.m,content:'88'});
  const edited=sent.at(-1).m;
  assert.match(edited.payload.content,/<@ben> edited their count — it still stands at \*\*102\*\*\. Next number is \*\*103\*\*/);
  assert.equal(cfg().counting.current,102,'editing your count never rewinds the run');
  assert.equal(cfg().counting.lastMessageId,edited.id,'the edit re-post becomes the authoritative record');
  // An edit that still reads as the right number (added trailing text like "102 lol") is left alone.
  x=await count('ann','103'); const okq=sent.length; await C.handleCountEdited({},{...x.m,content:'103 nice'}); assert.equal(sent.length,okq,'an edit that keeps the number is not corrected');
  console.log('✓ editing a count can’t rewind or disguise it; harmless trailing-text edits are ignored');

  // 67+67 easter egg: the count still advances (67+67 = 134), but the message is swapped for a bot roast.
  assert.ok(C.isSixtySeven('67+67') && C.isSixtySeven('67 + 67') && C.isSixtySeven('67+67 lol'),'detects the meme (with spaces / trailing chat)');
  assert.ok(!C.isSixtySeven('67+670') && !C.isSixtySeven('67+68') && !C.isSixtySeven('134'),'only 67+67, not lookalikes');
  r=await C.saveSettings(guild,{current:133}); assert.equal(r.settings.current,133);
  const sixBefore=sent.length;
  x=await count('ben','67+67');
  assert.equal(cfg().counting.current,134,'67+67 still counts as 134');
  assert.equal(x.m.deleted,true,'their 67+67 message is removed');
  assert.deepEqual(x.m.reacts,[],'no ✅ react — it is replaced by the bot post');
  const roast=sent.at(-1).m; assert.equal(sent.length,sixBefore+1);
  assert.match(roast.payload.content,/<@ben> typed `67\+67` — the count is \*\*134\*\*/);
  assert.deepEqual(roast.payload.allowedMentions,{users:['ben']},'only the counter is pinged');
  assert.equal(cfg().counting.lastMessageId,roast.id,'the bot post becomes the authoritative record (delete handler won’t re-assert)');
  const afterRoast=sent.length; await C.handleCountDeleted({guildId:'g',channelId:'count',channel:countCh,id:x.m.id,author:{id:'ben',bot:false}});
  assert.equal(sent.length,afterRoast,'deleting the original 67+67 message does not trigger a re-post');
  console.log('✓ 67+67 easter egg: counts as 134, message swapped for a @-roast, record re-pointed so grief-protection is clean');
  await C.saveSettings(guild,{current:103}); // restore the count for the dashboard checks below

  // ---- Counting bans: auto role + channel block, permanent/timed, reuse, unban, status, sweeper
  roleLog.length=0;
  const countCh2=guild.channels.cache.get('count');
  let bx=await C.banUser(guild,'ann',{by:'mod#1'}); // permanent
  assert.ok(!bx.error, bx.error); assert.equal(bx.until,null);
  assert.ok(guild.roles.cache.get(bx.roleId),'a 🔇 Counting Banned role was auto-created');
  assert.deepEqual(roleLog.at(-1),['add','ann',bx.roleId],'the role is added to the member automatically');
  assert.equal(countCh2.overwrites[bx.roleId].SendMessages,false,'the counting channel denies Send Messages for the ban role');
  assert.equal(cfg().counting.bannedRoleId,bx.roleId); assert.equal(cfg().counting.bans.length,1);
  assert.equal(cfg().counting.bans[0].userId,'ann'); assert.equal(cfg().counting.bans[0].until,null,'a permanent ban has no end time');
  const rolesBefore=guild.roles.cache.size;
  bx=await C.banUser(guild,'ben',{durationMs:60*60*1000}); // timed
  assert.equal(guild.roles.cache.size,rolesBefore,'the same ban role is reused, not re-created');
  assert.ok(bx.until,'a timed ban stores an end time'); assert.equal(cfg().counting.bans.length,2);
  bx=await C.banUser(guild,'ben',{durationMs:2*60*60*1000}); // re-ban updates, no duplicate
  assert.equal(cfg().counting.bans.filter(b=>b.userId==='ben').length,1,'a repeat ban updates the record, not duplicates it');
  assert.match((await C.banUser(guild,'bot',{})).error,/myself/,'the bot can’t ban itself');
  // Unban removes the role + record; unbanning someone not banned is a gentle no-op.
  roleLog.length=0;
  let ux=await C.unbanUser(guild,'ann');
  assert.equal(ux.wasBanned,true); assert.deepEqual(roleLog.at(-1),['remove','ann',cfg().counting.bannedRoleId]);
  assert.ok(!cfg().counting.bans.some(b=>b.userId==='ann'),'the ban record is removed');
  assert.equal((await C.unbanUser(guild,'cat')).wasBanned,false,'unbanning a non-banned member is a no-op');
  // Sweeper lifts only timed bans that have run out.
  cfg().counting.bans.find(b=>b.userId==='ben').until=new Date(Date.now()-1000).toISOString();
  roleLog.length=0;
  const lifted=await C.sweepCountingBans(client, Date.now());
  assert.equal(lifted,1,'one expired ban is lifted');
  assert.deepEqual(roleLog.at(-1),['remove','ben',cfg().counting.bannedRoleId],'the role is taken back when the timed ban ends');
  assert.equal(cfg().counting.bans.length,0,'no bans remain after the sweep');
  console.log('✓ counting bans: auto role + channel block, permanent/timed, role reuse, unban, sweeper lifts expired');

  // Secret goals: every N numbers everyone in the run gets XP; the ladder climbs per goal; bonus numbers
  // are goals too; a wrong number resets participants + ladder; a goal never pays twice.
  r=await C.saveSettings(guild,{goals:{enabled:true,every:3,baseXp:100,stepXp:50,maxXp:0,bonuses:[{every:5,xp:1000}],message:'GOAL {number}: +{xp} for {people} ({mentions}) #{goal}'}});
  assert.ok(!r.error,r.error); assert.equal(r.settings.goals.every,3);
  assert.match((await C.saveSettings(guild,{goals:{every:0}})).error,/Goal spacing/);
  const savedCount={...cfg().counting};
  Object.assign(cfg().counting,{current:0,lastUserId:null,lastMessageId:null,participants:[],goalsHit:0,lastGoalAt:0});
  for (const k of Object.keys(xp)) delete xp[k];
  const sentBeforeGoals=sent.length;
  await count('ann','1'); await count('ben','2');
  assert.deepEqual(cfg().counting.participants,['ann','ben'],'who counted this run');
  const g3=await count('ann','3'); assert.deepEqual(g3.m.reacts,['✅']);
  assert.deepEqual(xp,{ann:100,ben:100},'first goal pays the base to everyone in the run');
  assert.equal(sent.at(-1).m.payload.content,'GOAL 3: +100 for 2 (<@ann> <@ben>) #1'); assert.deepEqual(sent.at(-1).m.payload.allowedMentions,{parse:[]},'no pings unless switched on');
  await count('cat','4');
  await count('ben','5'); assert.equal(xp.cat,150+1000,'5 is a bonus number: ladder (150) + bonus (1000)'); assert.equal(xp.ann,100+1150);
  await count('ann','6'); assert.equal(xp.cat,1150+200,'next ladder step: 200');
  // the same goal message delivered twice (deploy overlap) pays once
  const goalDupe=msg('ben','6'); cfg().counting.current=5; cfg().counting.lastUserId='cat'; await C.handleCounting(goalDupe,cfg());
  assert.equal(xp.cat,1350,'a goal never pays twice'); cfg().counting.current=6; cfg().counting.lastUserId='ann';
  // wrong number → new run: participants + ladder reset
  await count('cat','99'); assert.deepEqual(cfg().counting.participants,[]); assert.equal(cfg().counting.goalsHit,0);
  await count('ben','1'); await count('cat','2'); await count('ben','3');
  assert.equal(xp.ann,1250+200,'ann (not in the new run) gets nothing more'); assert.equal(xp.ben,1250+200+100,'ladder restarts at the base');
  assert.ok(sent.length>sentBeforeGoals);
  await C.saveSettings(guild,{goals:{enabled:false}});
  Object.assign(cfg().counting,{current:savedCount.current,lastUserId:savedCount.lastUserId,lastMessageId:savedCount.lastMessageId,record:savedCount.record,resets:savedCount.resets,bestBefore:savedCount.bestBefore});
  console.log('✓ secret goals: XP to everyone in the run, ladder + bonus numbers, pays once, resets with the run');

  // ================================================================ Starboard
  r=await S.saveSettings(guild,{enabled:true}); assert.match(r.error,/channel/);
  r=await S.saveSettings(guild,{emoji:'hello'}); assert.match(r.error,/single emoji/);
  r=await S.saveSettings(guild,{enabled:true,channelId:'stars',threshold:3,ignoredChannelIds:['secret','nope']}); assert.deepEqual(r.settings.ignoredChannelIds,['secret']);
  assert.ok(S.emojiMatches({name:'⭐',id:null},'⭐')); assert.ok(!S.emojiMatches({name:'🌟',id:null},'⭐')); assert.ok(S.emojiMatches({name:'x',id:'55'},'<:x:55>'));
  const starCh=guild.channels.cache.get('stars');
  const memes=guild.channels.cache.get('memes');
  const original={id:'orig1',guildId:'g',guild,channelId:'memes',channel:memes,client,content:'look at this',author:{id:'ann',bot:false,displayAvatarURL:()=>null,username:'ann'},member:{displayName:'Ann'},attachments:new Collection(),embeds:[],createdTimestamp:Date.now(),url:'https://discord.com/channels/g/memes/orig1',partial:false};
  let starrers=[];
  const reaction=(msgObj=original,emoji={name:'⭐',id:null})=>({partial:false,emoji,message:msgObj,count:starrers.length,users:{fetch:async()=>new Collection(starrers.map(id=>[id,{id,bot:id==='botty'}]))}});
  const posts=()=>[...starCh.msgs.values()];
  starrers=['ann','ben']; await S.handleReaction(reaction()); assert.equal(posts().length,0,'author self-star does not count: 1 star');
  starrers=['ann','ben','cat','botty']; await S.handleReaction(reaction()); assert.equal(posts().length,0,'bots do not count: 2 stars');
  starrers=['ann','ben','cat','dan']; await Promise.all([S.handleReaction(reaction()),S.handleReaction(reaction()),S.handleReaction(reaction())]);
  assert.equal(posts().length,1,'three reactions at once → one post'); assert.match(posts()[0].payload.content,/⭐ \*\*3\*\* · <#memes>/);
  assert.equal(posts()[0].payload.embeds[0].data.description,'look at this'); assert.match(JSON.stringify(posts()[0].payload.embeds[0].data.fields),/Jump to message/);
  starrers=['ben','cat','dan','eve','fay','gus','hal','ivy','jo','kim','lu']; await S.handleReaction(reaction());
  assert.match(posts()[0].payload.content,/🌟 \*\*11\*\*/); assert.equal(sbRows[0].stars,11);
  starrers=['ben']; await S.handleReaction(reaction()); assert.equal(posts().length,0,'below the bar → removed'); assert.equal(sbRows.length,0);
  starrers=['ben','cat','dan']; await S.handleReaction(reaction()); assert.equal(posts().length,1,'back on the board');
  await S.handleMessageDeleted({guildId:'g',id:'orig1',client}); assert.equal(posts().length,0); assert.equal(sbRows.length,0);
  await S.handleReaction(reaction(original,{name:'🔥',id:null})); assert.equal(posts().length,0,'other emoji ignored');
  const secret={...original,id:'s1',channelId:'secret',channel:guild.channels.cache.get('secret')}; await S.handleReaction(reaction(secret)); assert.equal(posts().length,0,'ignored channel');
  const botPost={...original,id:'b1',author:{id:'bot',bot:true}}; await S.handleReaction(reaction(botPost)); assert.equal(posts().length,0,"bot's own posts");
  const nsfw={...original,id:'n1',channel:{...memes,nsfw:true}}; await S.handleReaction(reaction(nsfw)); assert.equal(posts().length,0,'nsfw stays off a normal starboard');
  console.log('✓ starboard: threshold, no self/bot stars, one post under a click race, live count + tier icon, drops off below the bar, follows deletes, ignores other emoji/channels/bot/nsfw');

  // ================================================================ Dashboard routes
  const express=require(root+'node_modules/express'); const auth=require(root+'src/web/utils/authMiddleware');
  auth.requireAuth=(q,s2,n)=>n(); auth.requireGuildAccess=(q,s2,n)=>{q.guild=guild;q.access={level:'admin',pages:null};n();}; auth.requirePage=()=>(q,s2,n)=>n();
  const audit=require(root+'src/web/utils/audit'); audit.auditTrail=(q,s2,n)=>n();
  const app=express(); app.use(express.json()); app.use((q,s2,n)=>{q.session={user:{id:'admin',username:'ada'}};n();}); app.use('/api',require(root+'src/web/routes/manage'));
  const srv=app.listen(0); const base=`http://127.0.0.1:${srv.address().port}/api/guilds/g`;
  const j=async(path,body)=>{ const res=await fetch(base+path,{method:body?'POST':'GET',headers:{'content-type':'application/json'},body:body?JSON.stringify(body):undefined}); return {status:res.status,...await res.json()}; };
  let d=await j('/engagement');
  assert.equal(d.birthdays.settings.channelId,'general'); assert.equal(d.birthdays.saved,5); assert.deepEqual(d.birthdays.upcoming.map(u=>u.userId).sort(),['ann','ben','cat']);
  assert.equal(d.counting.settings.current,103); assert.equal(d.starboard.settings.threshold,3); assert.deepEqual(d.starboard.top,[]);
  let res=await j('/engagement/starboard',{threshold:5,emoji:'🔥',selfStar:true}); assert.equal(res.ok,true); assert.equal(res.settings.threshold,5); assert.equal(res.settings.emoji,'🔥');
  res=await j('/engagement/starboard',{threshold:0}); assert.equal(res.status,400); assert.match(res.error,/1–100/);
  res=await j('/engagement/birthdays',{roleId:'boost'}); assert.equal(res.status,400);
  assert.equal(d.calculator.settings.pets.costPerD,100,'calculator settings load with the defaults');
  res=await j('/engagement/calculator',{pets:{enabled:true,costPerD:25,currencies:['Gold']}}); assert.equal(res.ok,true); assert.equal(res.settings.pets.costPerD,25);
  res=await j('/engagement/calculator',{fish:{freePerDay:5,epicCost:200,freeOdds:[50],epicOdds:[100]}}); assert.equal(res.status,400); assert.match(res.error,/total 100%/);
  const n=sent.length; res=await j('/engagement/counting',{current:500}); assert.equal(res.settings.current,500);
  assert.match(sent.at(-1).m.payload.content,/set the count to \*\*500\*\*\. The next number is \*\*501\*\*/); assert.equal(sent.length,n+1);
  res=await j('/engagement/hacks',{}); assert.equal(res.status,404); res=await j('/engagement/__proto__',{}); assert.equal(res.status,404);
  srv.close();
  console.log('✓ dashboard: GET shows all three sections; saves validate; setting the count tells the channel; unknown sections 404');

  // ================================================================ Giveaway requirement checklist
  const G=require(root+'src/bot/cogs/modules/giveaways');
  const UserLevel=require(root+'src/database/models/UserLevel'); store(UserLevel); await UserLevel.create({guildId:'g',userId:'ann',level:3,xp:10});
  const m={...members.get('ann'),guild,joinedTimestamp:Date.now()-2*864e5};
  const reason=await G.checkRequirements(m,{requirements:{roleId:'boost',minDaysInServer:7,minLevel:5}});
  assert.equal(reason,"You don't meet the requirements for this giveaway:\n❌ Have the <@&boost> role\n❌ Be in the server for **7 days** (you're at 2)\n❌ Be **Level 5+** (you're Level 3)");
  const partial=await G.checkRequirements(m,{requirements:{minDaysInServer:1,minLevel:5}});
  assert.match(partial,/✅ Be in the server for \*\*1 day\*\* \(you're at 2\)\n❌ Be \*\*Level 5\+\*\*/);
  assert.equal(await G.checkRequirements(m,{requirements:{minDaysInServer:1,minLevel:2}}),null);
  console.log('✓ giveaway entry blocked with a full ✅/❌ checklist of every requirement');
  process.exit(0);
})().catch(e=>{console.error(e);process.exit(1);});
