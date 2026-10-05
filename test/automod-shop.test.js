// Auto-mod, the new server logs + storage clean-up, and the XP shop.
process.env.TOKEN='x';process.env.CLIENT_ID='123';process.env.MONGODB_URI='mongodb://x';
const root=require('path').join(__dirname,'..')+'/'; const assert=require('assert');
const { PermissionsBitField, PermissionFlagsBits, Collection } = require(root+'node_modules/discord.js');
const { store } = require('./helpers/memstore');
const M=(n)=>require(root+'src/database/models/'+n);
const rows={}; for (const n of ['GuildConfig','ModCase','LogEntry','ShopItem','ShopOwnership','UserLevel','ChatDrop','Poll','Giveaway','Ticket','XpPot']) rows[n]=store(M(n));
const logs=[]; const Logging=require(root+'src/bot/cogs/modules/logging');
const realSendLog=Logging.sendLog;
const LC=require(root+'src/bot/cogs/modules/levelColors'); LC.onLevelChange=async()=>{};

// ---- fake guild
const sent=[];
function channel(id){ const msgs=new Map(); const ch={id,name:id,guild:null,parentId:null,isTextBased:()=>true,isThread:()=>false,permissionsFor:()=>new PermissionsBitField(PermissionsBitField.All),toString(){return `<#${id}>`;},
  send:async(p)=>{ const m={id:`s${sent.length}`,payload:typeof p==='string'?{content:p}:p,deleted:false,delete:async()=>{m.deleted=true;}}; sent.push({ch:id,m}); return m; },
  bulkDelete:async(ids)=>{ ch.deletedIds.push(...ids); }, messages:{delete:async(id)=>{ ch.deletedIds.push(id); }}, deletedIds:[], msgs}; return ch; }
const roleSets={};
function member(id,{perms=[],position=1}={}){ roleSets[id]=roleSets[id]||new Set(); const bits=new PermissionsBitField(perms); let nick=null; const m={id,user:{id,bot:false,username:id,globalName:null,tag:id,displayAvatarURL:()=>'',send:async()=>({})},get nickname(){return nick;},displayName:id,
  permissions:bits,roles:{highest:{position},cache:{has:(r)=>roleSets[id].has(r)},add:async(r)=>{roleSets[id].add(r);},remove:async(r)=>{roleSets[id].delete(r);}},
  setNickname:async(n)=>{ nick=n; return m; },timeouts:[],timeout:async(ms)=>{m.timeouts.push(ms);},isCommunicationDisabled:()=>false,displayAvatarURL:()=>''}; return m; }
const members=new Collection([['ann',member('ann')],['ben',member('ben')],['mod',member('mod',{perms:[PermissionFlagsBits.ManageMessages]})],['vip',member('vip')]]);
const guild={id:'g',name:'Lounge',ownerId:'owner',vanityURLCode:'lounge',channels:{cache:new Collection()},emojis:{cache:new Collection([['111111111111111111',{id:'111111111111111111'}]])},
  roles:{cache:new Collection([['vipRole',{id:'vipRole',position:2,managed:false,permissions:new PermissionsBitField([])}],['adminRole',{id:'adminRole',position:3,managed:false,permissions:new PermissionsBitField([PermissionFlagsBits.Administrator])}],['colorRole',{id:'colorRole',position:4,managed:false,permissions:new PermissionsBitField([])}]])},
  members:{me:{id:'bot',permissions:new PermissionsBitField(PermissionsBitField.All),roles:{highest:{position:10}}},cache:members,fetch:async(id)=>{ const m=members.get(id); if(!m) throw new Error('Unknown'); return m; }},
  client:{users:{fetch:async()=>null}},bans:{fetch:async()=>null},fetchAuditLogs:async()=>({entries:new Collection()})};
for (const id of ['general','memes']) { const c=channel(id); c.guild=guild; guild.channels.cache.set(id,c); }
for (const m of members.values()) m.guild=guild;
const client={guilds:{cache:new Map([['g',guild]])},fetchInvite:async(code)=>{ if(code==='friends') return {guild:{id:'g'}}; if(code==='dead') throw new Error('Unknown Invite'); return {guild:{id:'other'}}; }};
const cfg=()=>rows.GuildConfig.find(r=>r.guildId==='g');
let mid=1;
function msg(user,content,ch='general',extra={}){ const c=guild.channels.cache.get(ch); return {id:`m${mid++}`,guild,guildId:'g',client,channelId:ch,channel:c,content,author:members.get(user).user,member:members.get(user),mentions:{users:new Collection(),roles:new Collection()},system:false,webhookId:null,reacts:[],react:async function(e){this.reacts.push(e);},...extra}; }

(async()=>{
  await M('GuildConfig').create({guildId:'g',levelingEnabled:true,gamblingEnabled:true,gamblingDailyLimit:10});
  const A=require(root+'src/bot/cogs/modules/automod');

  // ================================================================ Auto-mod: detection
  assert.equal(A.wallReason('hi\nthere'),null);
  assert.match(A.wallReason(Array(8).fill('BUY NOW').join('\n')),/same line 8 times/);
  assert.match(A.wallReason(Array(40).fill('spam').join(' ')),/same word 40 times/);
  assert.match(A.wallReason('a'.repeat(60)),/repeated/);
  assert.equal(A.wallReason('```\n'+Array(50).fill('x = 1').join('\n')+'\n```'),null,'code blocks are fine');
  assert.match(A.wallReason(Array.from({length:35},(_,i)=>`line ${i}`).join('\n')),/35 lines/);
  assert.equal(A.wallReason('The quick brown fox jumps over the lazy dog. '.repeat(3)),null,'normal repeated sentence is fine');
  assert.deepEqual(A.inviteCodes('join discord.gg/abc and https://discord.com/invite/xyz'),['abc','xyz']);
  assert.ok(A.capsRatio('HELLO EVERYONE HOW ARE YOU').ratio>0.95);
  console.log('✓ detection: text walls (lines, repeated lines/words/chars — code blocks ok), invite codes, caps ratio');

  // ================================================================ Auto-mod: enforcement
  let r=await A.saveSettings(guild,{enabled:true,rules:{flood:{messages:0}}}); assert.match(r.error,/Flood messages must be 3–30/);
  r=await A.saveSettings(guild,{enabled:true,exemptRoleIds:['vipRole','nope']}); assert.equal(r.settings.enabled,true); assert.deepEqual(r.settings.exemptRoleIds,['vipRole']);
  assert.equal(r.settings.warnings,2); assert.equal(r.settings.muteMinutes,60);
  const general=guild.channels.cache.get('general');

  // A fast talker: 6 different messages quickly is fine.
  for (let i=0;i<6;i++) assert.equal(await A.handleAutomod(msg('ann',`msg ${i} something`),cfg()),false);
  assert.equal(rows.ModCase.length,0);
  // 7th within 5s → flood: burst deleted, warning 1/2.
  assert.equal(await A.handleAutomod(msg('ann','and another'),cfg()),true);
  assert.equal(general.deletedIds.length,7,'whole burst removed');
  let c=rows.ModCase.at(-1); assert.equal(c.type,'warn'); assert.equal(c.source,'automod'); assert.match(c.reason,/Auto-mod: message spam \(7 messages in 5s\)/);
  assert.match(sent.at(-1).m.payload.content,/slow down.*Warning \*\*1\/2\*\*/);
  // More spam right away doesn't stack strikes (one burst = one strike) — but is still removed.
  assert.equal(await A.handleAutomod(msg('ann','BUY '.repeat(40)),cfg()),true); assert.equal(rows.ModCase.length,1);
  A._lastStrike.clear();
  // Repeats: same text 4× → warning 2/2.
  for (let i=0;i<3;i++) assert.equal(await A.handleAutomod(msg('ann','free nitro here'),cfg()),false);
  assert.equal(await A.handleAutomod(msg('ann','Free   NITRO here'),cfg()),true,'case/space differences still count as the same');
  c=rows.ModCase.at(-1); assert.equal(c.type,'warn'); assert.match(c.reason,/repeated messages/); assert.match(sent.at(-1).m.payload.content,/Warning \*\*2\/2\*\* — next time is a 1h mute/);
  A._lastStrike.clear();
  // Third strike → 1 hour timeout.
  const mentions=new Collection(['a','b','c','d','e'].map(id=>[id,{id}]));
  assert.equal(await A.handleAutomod(msg('ann','hey <@a> <@b> <@c> <@d> <@e>',undefined,{mentions:{users:mentions,roles:new Collection()}}),cfg()),true);
  c=rows.ModCase.at(-1); assert.equal(c.type,'timeout'); assert.equal(c.durationMs,3600000); assert.deepEqual(members.get('ann').timeouts,[3600000]);
  assert.match(sent.at(-1).m.payload.content,/mass-mention.*Muted for \*\*1h\*\*/);
  A._lastStrike.clear();
  // After the mute the count starts over: next strike is warning 1 again.
  assert.equal(await A.handleAutomod(msg('ann','come to discord.gg/party'),cfg()),true);
  c=rows.ModCase.at(-1); assert.equal(c.type,'warn'); assert.match(c.reason,/invite link/); assert.match(sent.at(-1).m.payload.content,/Warning \*\*1\/2\*\*/);
  console.log('✓ 7 msgs/5s flood, repeats, mention spam, invites → warning 1/2, 2/2, then a 1h timeout; one burst = one strike; count resets after the mute');

  assert.equal(await A.handleAutomod(msg('ben','our invite: discord.gg/friends and discord.gg/lounge'),cfg()),false,'invites to this server are fine');
  assert.equal(await A.handleAutomod(msg('mod','@everyone discord.gg/other'),cfg()),false,'staff skip auto-mod');
  roleSets.vip.add('vipRole'); assert.equal(await A.handleAutomod(msg('vip','discord.gg/other'),cfg()),false,'exempt role');
  assert.equal(await A.handleAutomod(msg('ben','hey @everyone look'),cfg()),true,'@everyone attempt without permission');
  const before=rows.ModCase.length; await A.saveSettings(guild,{enabled:false}); assert.equal(await A.handleAutomod(msg('ben','discord.gg/other'),cfg()),false); assert.equal(rows.ModCase.length,before);
  await A.saveSettings(guild,{enabled:true});
  await new Promise((r)=>setTimeout(r,20)); // logs are written in the background
  const amLogs=rows.LogEntry.filter(l=>l.type==='automod'); assert.ok(amLogs.length>=5); assert.match(amLogs[0].summary,/auto-mod: message spam → warning 1\/2/);
  console.log('✓ own-server invites, staff and exempt roles are left alone; @everyone attempts caught; off means off; every catch is logged');

  // ================================================================ Server logs
  const S=require(root+'src/bot/cogs/modules/serverLogs');
  assert.deepEqual(S.diffLines({name:'a',nsfw:false},{name:'b',nsfw:false},[['name','Name'],['nsfw','NSFW']]),['**Name:** a → b']);
  const pd=S.permDiff(PermissionFlagsBits.SendMessages, PermissionFlagsBits.SendMessages|PermissionFlagsBits.BanMembers); assert.deepEqual(pd,{added:['BanMembers'],removed:[]});
  const handlers={}; S.registerServerLogEvents({on:(e,f)=>handlers[e]=f,guilds:client.guilds});
  for (const e of ['messageDeleteBulk','guildMemberUpdate','guildBanAdd','guildBanRemove','channelCreate','channelDelete','channelUpdate','roleCreate','roleDelete','roleUpdate','threadCreate','threadDelete','threadUpdate','inviteCreate','inviteDelete','emojiCreate','emojiDelete','emojiUpdate','stickerCreate','stickerDelete','stickerUpdate','guildUpdate']) assert.ok(handlers[e],e);
  const n0=rows.LogEntry.length;
  const oldM={partial:false,nickname:'Ann',communicationDisabledUntilTimestamp:null,premiumSince:null,avatar:null};
  const newM={guild,user:members.get('ann').user,nickname:'Annie',communicationDisabledUntilTimestamp:Date.now()+60000,communicationDisabledUntil:new Date(Date.now()+60000),premiumSince:new Date(),avatar:null,toString:()=>'<@ann>'};
  await handlers.guildMemberUpdate(oldM,newM);
  const got=rows.LogEntry.slice(n0).map(l=>[l.type,l.summary]);
  assert.deepEqual(got.map(g=>g[0]),['members','members','members']); assert.match(got[0][1],/nickname: Ann → Annie/); assert.match(got[1][1],/timed out until/); assert.equal(got[2][1],'started boosting');
  await handlers.roleUpdate({name:'Mods',color:0,hoist:false,mentionable:false,permissions:{bitfield:0n}},{guild,id:'r',name:'Moderators',color:0xff0000,hoist:true,mentionable:false,permissions:{bitfield:PermissionFlagsBits.KickMembers},toString:()=>'<@&r>'});
  assert.match(rows.LogEntry.at(-1).summary,/updated role @Moderators: Name: Mods → Moderators; Color: default → #ff0000; Shown separately: no → yes; Permissions added: KickMembers/);
  const nPos=rows.LogEntry.length; await handlers.roleUpdate({name:'x',color:0,permissions:{bitfield:0n},position:1},{guild,id:'r',name:'x',color:0,permissions:{bitfield:0n},position:2}); assert.equal(rows.LogEntry.length,nPos,'position-only changes are skipped');
  const bulk=new Collection([['1',{partial:false,author:{id:'ann',tag:'ann'},content:'hi',createdTimestamp:1}],['2',{partial:false,author:{id:'ben',tag:'ben'},content:'yo',createdTimestamp:2}]]);
  await handlers.messageDeleteBulk(bulk,guild.channels.cache.get('general'));
  assert.equal(rows.LogEntry.at(-1).type,'bulkDelete'); assert.match(rows.LogEntry.at(-1).before,/ann: hi\n.*ben: yo/);
  await handlers.guildBanAdd({guild,user:{id:'bad',tag:'bad#1',displayAvatarURL:()=>''}}); assert.equal(rows.LogEntry.at(-1).type,'bans');
  await handlers.guildUpdate({name:'Old',verificationLevel:1},{id:'g',...guild,name:'Lounge',verificationLevel:2,members:guild.members,channels:guild.channels});
  assert.match(rows.LogEntry.at(-1).summary,/Name: Old → Lounge; Verification level: 1 → 2/);
  await S.logCommand({guild,guildId:'g',user:members.get('ben').user,commandName:'shop',toString:()=>'/shop buy item:xyz',channelId:'general',channel:guild.channels.cache.get('general')});
  assert.equal(rows.LogEntry.at(-1).type,'commands'); assert.equal(rows.LogEntry.at(-1).summary,'used /shop buy item:xyz');
  cfg().logEvents={...(cfg().logEvents||{}),commands:false}; const nOff=rows.LogEntry.length; await S.logCommand({guild,guildId:'g',user:members.get('ben').user,commandName:'x',toString:()=>'/x'}); assert.equal(rows.LogEntry.length,nOff,'switched-off events are not stored');
  const LOG_EVENTS=Logging.LOG_EVENTS; assert.ok(Object.keys(LOG_EVENTS).length<=25,'fits in a slash-command choice list');
  for (const k of Object.keys(LOG_EVENTS)) assert.ok(M('LogEntry').schema.path('type').enumValues.includes(k),k);
  console.log('✓ logs: nicknames/timeouts/boosts, role edits (with permission diff), purges with a transcript, bans, server settings, slash commands — each can be switched off');

  // ================================================================ Storage clean-up
  const St=require(root+'src/bot/cogs/modules/storage');
  const now=Date.now(); const day=864e5; rows.LogEntry.length=0;
  for (const [g,age] of [['g',5],['g',20],['g',40],['g2',20],['g2',40],['g3',8]]) rows.LogEntry.push({_id:`l${g}${age}`,guildId:g,type:'voice',createdAt:new Date(now-age*day).toISOString()});
  await M('GuildConfig').create({guildId:'g3',logRetentionDays:7});
  cfg().logRetentionDays=14;
  const removed=await St.pruneLogs(now);
  assert.deepEqual(rows.LogEntry.map(l=>l._id).sort(),['lg220','lg5'],'g keeps 14d, g2 default 30d, g3 7d');
  rows.ChatDrop.push({_id:'d1',guildId:'g',status:'closed',createdAt:new Date(now-40*day).toISOString()},{_id:'d2',guildId:'g',status:'closed',createdAt:new Date(now-2*day).toISOString()});
  rows.Poll.push({_id:'p1',guildId:'g',ended:true,endTimestamp:now-100*day},{_id:'p2',guildId:'g',ended:false,endTimestamp:null});
  rows.Ticket.push({_id:'t1',guildId:'g',status:'CLOSED',closedAt:new Date(now-200*day).toISOString(),transcript:[{content:'old'}]},{_id:'t2',guildId:'g',status:'CLOSED',closedAt:new Date(now-2*day).toISOString(),transcript:[{content:'new'}]});
  const other=await St.pruneOther(now);
  assert.deepEqual(rows.ChatDrop.map(d=>d._id),['d2']); assert.deepEqual(rows.Poll.map(p=>p._id),['p2']); assert.equal(rows.Ticket[0].transcript.length,0); assert.equal(rows.Ticket[1].transcript.length,1);
  assert.equal(removed,4); assert.equal(other.transcripts,1);
  console.log('✓ storage: each server keeps its chosen log history (7/14/30…), old drops/polls removed, old ticket transcripts trimmed');

  // ================================================================ XP shop
  const Shop=require(root+'src/bot/cogs/modules/shop');
  const UserLevel=M('UserLevel');
  await UserLevel.create({guildId:'g',userId:'ann',xp:20000,level:10}); await UserLevel.create({guildId:'g',userId:'ben',xp:500,level:2});
  const items=await Shop.listItems('g'); assert.deepEqual(items.map(i=>i.key),['autoreact','xpboost','gambles','nicktag','nickname','badge','loofa']);
  assert.equal((await Shop.listItems('g')).length,7,'starter items are added once');
  const byKey=(k)=>items.find(i=>i.key===k); const id=(k)=>String(byKey(k)._id);
  const ann=members.get('ann'); const ben=members.get('ben');

  let b=await Shop.buy(guild,ben,id('autoreact')); assert.match(b.error,/costs \*\*2,500 XP\*\* — you have \*\*500\*\*/);
  b=await Shop.buy(guild,ann,id('autoreact')); assert.ok(b.ok,b.error); assert.match(b.message,/Auto-react.*🔥/);
  assert.equal(rows.UserLevel.find(u=>u.userId==='ann').xp,17500);
  b=await Shop.buy(guild,ann,id('autoreact')); assert.match(b.error,/already own/);
  // Auto-react with a cooldown.
  const m1=msg('ann','hello'); await Shop.handleShopMessage(m1,cfg()); assert.deepEqual(m1.reacts,['🔥']);
  const m2=msg('ann','again'); await Shop.handleShopMessage(m2,cfg()); assert.deepEqual(m2.reacts,[],'cooldown');
  let cu=await Shop.customize(guild,ann,id('autoreact'),{emoji:'not an emoji'}); assert.match(cu.error,/one emoji/);
  cu=await Shop.customize(guild,ann,id('autoreact'),{emoji:'<:loofa:111111111111111111>'}); assert.ok(cu.ok); assert.equal(cu.custom.emoji,'<:loofa:111111111111111111>');
  cu=await Shop.customize(guild,ann,id('autoreact'),{emoji:'<:other:222222222222222222>'}); assert.match(cu.error,/one emoji/,'custom emoji must be from this server');
  let t=await Shop.toggle(guild,ann,id('autoreact')); assert.equal(t.active,false);
  Shop._caches.lastReact.clear(); const m3=msg('ann','quiet'); await Shop.handleShopMessage(m3,cfg()); assert.deepEqual(m3.reacts,[],'switched off');
  await Shop.toggle(guild,ann,id('autoreact'),true); Shop._caches.lastReact.clear(); const m4=msg('ann','loud'); await Shop.handleShopMessage(m4,cfg()); assert.deepEqual(m4.reacts,['<:loofa:111111111111111111>']);
  console.log('✓ shop: starter items, can’t overspend, auto-react with cooldown, own emoji (this server’s custom ones too), toggle on/off');

  // XP boost stacks time and multiplies chat XP.
  b=await Shop.buy(guild,ann,id('xpboost')); assert.ok(b.ok);
  const o1=rows.ShopOwnership.find(o=>o.type==='xpBoost'); const end1=new Date(o1.expiresAt).getTime(); assert.ok(Math.abs(end1-(Date.now()+24*3600e3))<5000);
  b=await Shop.buy(guild,ann,id('xpboost')); assert.ok(b.ok,'boosts can be bought again'); assert.ok(Math.abs(new Date(o1.expiresAt).getTime()-(end1+24*3600e3))<5000,'second one adds 24h');
  assert.equal(await Shop.boostMultiplier('g','ann'),1.5); assert.equal(await Shop.boostMultiplier('g','ben'),1);
  // Extra gambles lift today's limit.
  const Ul=rows.UserLevel.find(u=>u.userId==='ann'); Ul.gambleDay=new Date().toISOString().slice(0,10); Ul.gamblesToday=10;
  b=await Shop.buy(guild,ann,id('gambles')); assert.ok(b.ok,b.error); assert.equal(Ul.gamblesToday,7,'3 plays back today');
  console.log('✓ XP boost ×1.5 (buying again adds 24h), +3 gambles gives plays back today');

  // Badge: fully customisable, shows as flair.
  b=await Shop.buy(guild,ann,id('badge')); assert.ok(b.ok);
  cu=await Shop.customize(guild,ann,id('badge'),{text:'Night Owl <@123> https://x.y',emoji:'🦉',color:'ff00aa'}); assert.ok(cu.ok); assert.deepEqual([cu.custom.text,cu.custom.emoji,cu.custom.color],['Night Owl','🦉','#FF00AA']);
  cu=await Shop.customize(guild,ann,id('badge'),{color:'blue'}); assert.match(cu.error,/hex color/);
  let fl=(await Shop.flair('g',['ann','ben'])); assert.deepEqual(fl.get('ann').badge,{emoji:'🦉',text:'Night Owl',color:'#FF00AA'}); assert.equal(fl.get('ben'),undefined);
  // Nickname tag: added, swapped, removed (original nick restored).
  b=await Shop.buy(guild,ann,id('nicktag')); assert.ok(b.ok,b.error); assert.equal(ann.nickname,'⭐ ann');
  await Shop.customize(guild,ann,id('nicktag'),{emoji:'🌙'}); assert.equal(ann.nickname,'🌙 ann');
  await Shop.toggle(guild,ann,id('nicktag'),false); assert.equal(ann.nickname,null,'back to no nickname');
  // Limited collectible.
  rows.UserLevel.find(u=>u.userId==='ann').xp=50000;
  const loofa=byKey('loofa'); rows.ShopItem.find(i=>String(i._id)===String(loofa._id)).sold=9;
  b=await Shop.buy(guild,ann,id('loofa')); assert.ok(b.ok); b=await Shop.buy(guild,ben,id('loofa')); assert.match(b.error,/sold out/);
  fl=await Shop.flair('g','ann'); assert.deepEqual(fl.get('ann').collectibles.map(c=>c.name),['Golden Loofa']);
  // Nickname change: needs a name, sets the server nickname (whitespace collapsed), and is repeatable.
  b=await Shop.buy(guild,ann,id('nickname')); assert.match(b.error,/Tell me the nickname/,'a nickname is required');
  b=await Shop.buy(guild,ann,id('nickname'),{nickname:'  Cool   Cat  '}); assert.ok(b.ok,b.error); assert.equal(ann.nickname,'Cool Cat');
  b=await Shop.buy(guild,ann,id('nickname'),{nickname:'Second Name'}); assert.ok(b.ok,'repeatable — buy again to change again'); assert.equal(ann.nickname,'Second Name');
  console.log('✓ custom badge (title/emoji/color, links & mentions stripped) as rank flair, nickname tag on/swap/off, nickname change (needs a name, repeatable), limited stock sells out');

  // Staff items: role (timed), validation.
  let ci=Shop.cleanItem(guild,{type:'role',name:'Admin?',price:5,config:{roleId:'adminRole'}}); assert.match(ci.error,/Administrator/);
  ci=Shop.cleanItem(guild,{type:'role',name:'Color',price:'abc',config:{roleId:'colorRole'}}); assert.match(ci.error,/Price/);
  ci=Shop.cleanItem(guild,{type:'role',name:'VIP for a day',emoji:'💎',price:2000,minLevel:5,config:{roleId:'vipRole',durationHours:24}}); assert.ok(ci.item); assert.equal(ci.item.maxPerUser,1);
  const roleItem=await M('ShopItem').create({...ci.item,guildId:'g'});
  roleSets.ben.clear(); rows.UserLevel.find(u=>u.userId==='ben').xp=5000;
  b=await Shop.buy(guild,ben,String(roleItem._id)); assert.match(b.error,/Level 5/);
  rows.UserLevel.find(u=>u.userId==='ben').level=6;
  b=await Shop.buy(guild,ben,String(roleItem._id)); assert.ok(b.ok,b.error); assert.ok(roleSets.ben.has('vipRole'));
  await Shop.toggle(guild,ben,String(roleItem._id),false); assert.ok(!roleSets.ben.has('vipRole'),'hide the role');
  await Shop.toggle(guild,ben,String(roleItem._id),true); assert.ok(roleSets.ben.has('vipRole'));
  rows.ShopOwnership.find(o=>o.itemId===String(roleItem._id)).expiresAt=new Date(Date.now()-1000).toISOString();
  assert.equal(await Shop.sweepExpired(client),1); assert.ok(!roleSets.ben.has('vipRole'),'timed role taken back'); assert.ok(!rows.ShopOwnership.some(o=>o.itemId===String(roleItem._id)),'and can be bought again');
  // Gift from staff: free, logged.
  const xpBefore=rows.UserLevel.find(u=>u.userId==='ben').xp;
  b=await Shop.buy(guild,ben,id('badge'),{free:true,by:'Ada (dashboard)'}); assert.ok(b.ok); assert.equal(rows.UserLevel.find(u=>u.userId==='ben').xp,xpBefore);
  await new Promise((r)=>setTimeout(r,20)); // the purchase log is written in the background
  assert.match(rows.LogEntry.filter(l=>l.type==='shop').at(-1).summary,/was given Custom badge by Ada/);
  const own=rows.ShopOwnership.find(o=>o.userId==='ben'&&o.type==='badge'); assert.ok((await Shop.removeOwned(guild,own._id)).ok); assert.ok(!rows.ShopOwnership.some(o=>o._id===own._id));
  // Shop closed.
  cfg().shopEnabled=false; b=await Shop.buy(guild,ann,id('xpboost')); assert.match(b.error,/closed/); cfg().shopEnabled=true;
  console.log('✓ staff role items (no admin roles, level gate, hide/show, timed roles expire), free gifts logged, take away, closed shop');

  // Race: two buys of the last collectible at once → only one wins, loser keeps XP.
  const last=await M('ShopItem').create({guildId:'g',type:'collectible',name:'Last One',emoji:'💠',price:100,stock:1,maxPerUser:1});
  rows.UserLevel.find(u=>u.userId==='ben').xp=1000;
  const [x1,x2]=await Promise.all([Shop.buy(guild,ann,String(last._id)),Shop.buy(guild,ben,String(last._id))]);
  assert.equal([x1,x2].filter(x=>x.ok).length,1); assert.equal(rows.ShopItem.find(i=>String(i._id)===String(last._id)).sold,1);
  const loser=x1.ok?'ben':'ann'; const loserXp=rows.UserLevel.find(u=>u.userId===loser).xp; assert.ok(loser==='ben'?loserXp===1000:loserXp>0);
  console.log('✓ two members buying the last one at the same moment: exactly one gets it');

  // ================================================================ Dashboard routes
  const express=require(root+'node_modules/express'); const auth=require(root+'src/web/utils/authMiddleware');
  auth.requireAuth=(q,s2,n)=>n(); auth.requireGuildAccess=(q,s2,n)=>{q.guild=guild;q.access={level:'admin',pages:null};n();}; auth.requirePage=()=>(q,s2,n)=>n();
  const audit=require(root+'src/web/utils/audit'); audit.auditTrail=(q,s2,n)=>n();
  const app=express(); app.use(express.json()); app.use((q,s2,n)=>{q.session={user:{id:'admin',username:'ada'}};n();}); app.use('/api',require(root+'src/web/routes/manage'));
  const srv=app.listen(0); const base=`http://127.0.0.1:${srv.address().port}/api/guilds/g`;
  const j=async(path,body,method)=>{ const res=await fetch(base+path,{method:method||(body?'POST':'GET'),headers:{'content-type':'application/json'},body:body?JSON.stringify(body):undefined}); return {status:res.status,...await res.json()}; };
  let d=await j('/moderation/automod'); assert.equal(d.settings.enabled,true); assert.ok(d.recent.length>=4); assert.deepEqual(d.missingPerms,[]);
  let res=await j('/moderation/automod',{warnings:3,muteMinutes:30,rules:{caps:{enabled:true,percent:90}}}); assert.equal(res.settings.warnings,3); assert.equal(res.settings.caps.enabled,true); assert.equal(res.settings.caps.percent,90);
  d=await j('/shop'); assert.ok(d.items.length>=7); assert.ok(d.totals.spent>0); assert.equal(d.types.badge.toggle,true);
  const badgeRow=d.items.find(i=>i.key==='badge'); assert.ok(badgeRow.owners>=1);
  res=await j('/shop/items',{type:'collectible',name:'Rubber Duck',emoji:'🦆',price:250,description:'Quack.'}); assert.equal(res.ok,true); const duck=res.item.id;
  res=await j('/shop/items/'+duck,{name:'Rubber Duck',emoji:'🦆',price:300,enabled:false,type:'role'}); assert.equal(res.item.type,'collectible','kind cannot change'); assert.equal(res.item.enabled,false);
  res=await j('/shop/items',{type:'role',name:'Nope',price:1,config:{roleId:'adminRole'}}); assert.equal(res.status,400);
  res=await j('/shop/member/ben/give',{itemId:duck}); assert.equal(res.ok,true);
  d=await j('/shop/member/ben'); assert.ok(d.owned.some(o=>o.name==='Rubber Duck'));
  res=await j('/shop/items/'+duck,null,'DELETE'); assert.equal(res.removedFrom,1); assert.ok(!rows.ShopOwnership.some(o=>o.itemId===duck));
  rows.ShopItem.splice(rows.ShopItem.findIndex(i=>i.key==='gambles'),1); res=await j('/shop/restore',{}); assert.equal(res.added,1);
  srv.close();
  console.log('✓ dashboard: auto-mod settings + recent catches; shop items add/edit/hide/delete (owners lose it), gifts, member view, restore starter items');
  process.exit(0);
})().catch(e=>{console.error(e);process.exit(1);});
