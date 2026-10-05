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
  messages:{fetch:async(mid)=>{ const m=msgs.get(mid); if(!m) throw new Error('Unknown'); return m; }}, msgs, ...extra}; return ch; }
const roleLog=[];
function member(id, bot=false){ const roles=new Set(); return {id,user:{id,bot,username:id},displayName:id,joinedTimestamp:Date.now()-5*864e5,roles:{cache:{has:(r)=>roles.has(r)},add:async(r)=>{roles.add(r);roleLog.push(['add',id,r]);},remove:async(r)=>{roles.delete(r);roleLog.push(['remove',id,r]);}}}; }
const members=new Collection([['ann',member('ann')],['ben',member('ben')],['cat',member('cat')],['botty',member('botty',true)]]);
const guild={id:'g',name:'Loofary Lounge',channels:{cache:new Collection()},roles:{cache:new Collection([['bdrole',{id:'bdrole',position:1,managed:false}],['boost',{id:'boost',position:2,managed:true}]])},emojis:{cache:new Collection()},
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
  assert.match(sent.at(-1).m.payload.content,/<@ben> deleted their count \(\*\*100\*\*\)\. The next number is \*\*101\*\*/);
  const beforeOther=sent.length; await C.handleCountDeleted({guildId:'g',channelId:'count',channel:countCh,id:'old'}); assert.equal(sent.length,beforeOther);
  x=await C.handleCounting(msg('ann','1',guild.channels.cache.get('general')),cfg()); assert.equal(x,false,'other channels untouched');
  // Race: two people send 101 at the same moment — only one counts.
  const [p1,p2]=[msg('ann','101'),msg('cat','101')]; await Promise.all([C.handleCounting(p1,cfg()),C.handleCounting(p2,cfg())]);
  assert.equal(cfg().counting.current,101); assert.deepEqual([p1.reacts,p2.reacts].map(a=>a[0]).sort(),['✅','👀']);
  console.log('✓ set the count, 💯 milestones, deleting the latest count posts the next number, simultaneous counts can’t both win');

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
  assert.equal(d.counting.settings.current,101); assert.equal(d.starboard.settings.threshold,3); assert.deepEqual(d.starboard.top,[]);
  let res=await j('/engagement/starboard',{threshold:5,emoji:'🔥',selfStar:true}); assert.equal(res.ok,true); assert.equal(res.settings.threshold,5); assert.equal(res.settings.emoji,'🔥');
  res=await j('/engagement/starboard',{threshold:0}); assert.equal(res.status,400); assert.match(res.error,/1–100/);
  res=await j('/engagement/birthdays',{roleId:'boost'}); assert.equal(res.status,400);
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
