// Link safety (Auto-mod → Unsafe links): the offline link checker, and how auto-mod handles a hit —
// scam links mute straight away, unapproved links (allowlist mode) are removed without a strike,
// and links edited into a message are caught too.
process.env.TOKEN='x';process.env.CLIENT_ID='123';process.env.MONGODB_URI='mongodb://x';
const root=require('path').join(__dirname,'..')+'/'; const assert=require('assert');
const { PermissionsBitField, PermissionFlagsBits, Collection } = require(root+'node_modules/discord.js');
const { store } = require('./helpers/memstore');
const M=(n)=>require(root+'src/database/models/'+n);
const rows={}; for (const n of ['GuildConfig','ModCase','LogEntry','UserLevel']) rows[n]=store(M(n));
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
  const L=require(root+'src/bot/cogs/modules/linkSafety');
  const verdict=(c,o={})=>{ const r=L.checkContent(c,o); return r?(r.scam?'scam':r.unapproved?'unapproved':'unsafe'):'ok'; };
  // ---- the checker
  const cases=[
    ['https://www.youtube.com/watch?v=x','ok'],['look https://youtu.be/abc','ok'],['https://clips.twitch.tv/abc','ok'],['https://github.com/a/b','ok'],
    ['https://tenor.com/view/x','ok'],['https://example.org/blog','ok'],['https://nitropack.io','ok'],['https://discord.js.org/docs','ok'],
    ['https://steamcommunity.com/id/x','ok'],['[youtube.com](https://youtu.be/x)','ok'],['[click here](https://example.org)','ok'],['no links here','ok'],
    ['https://discord-nitro.gift/claim','scam'],['https://dlscord.com/nitro','scam'],['https://steamcommunlty.com/tradeoffer/new','scam'],
    ['https://rob1ox.com/games','scam'],['https://xn--dscord-6ya.com','scam'],['https://discord.com@evil.ru/','scam'],
    ['[discord.com/gift](https://evil.ru/x)','scam'],['free nitro for everyone https://some-site.com/claim','scam'],
    ['https://bit.ly/3abc','unsafe'],['http://192.168.1.4/x','unsafe'],['https://cdn.discordapp.com/attachments/1/2/game.exe','unsafe'],['https://my.zip','unsafe']
  ];
  for (const [c,want] of cases) assert.equal(verdict(c),want,c);
  assert.equal(verdict('https://bit.ly/3abc',{shorteners:false}),'ok'); assert.equal(verdict('https://x.org/a.exe',{files:false}),'ok');
  assert.equal(verdict('https://example.org/x',{mode:'allowlist'}),'unapproved'); assert.equal(verdict('https://sub.example.org/x',{mode:'allowlist',allow:['example.org']}),'ok');
  assert.equal(verdict('https://youtube.com/x',{block:['youtube.com']}),'unsafe','the block list wins over well-known sites');
  assert.deepEqual(L.cleanDomains(['https://www.Example.com/path','example.com','not a domain','sub.site.co.uk']),['example.com','sub.site.co.uk']);
  console.log('✓ link checker: well-known sites fine; fake Discord/Steam/Roblox, lookalikes, disguised links, "free Nitro" scams, shorteners, IPs, downloads caught');

  // ---- auto-mod: what happens to the sender
  await M('GuildConfig').create({guildId:'g'});
  const A=require(root+'src/bot/cogs/modules/automod');
  let r=await A.saveSettings(guild,{enabled:true});
  assert.equal(r.settings.unsafeLinks.enabled,true,'on by default once auto-mod is on'); assert.equal(r.settings.unsafeLinks.mode,'unsafe'); assert.equal(r.settings.unsafeLinks.scamMute,true);
  const general=guild.channels.cache.get('general');
  assert.equal(await A.handleAutomod(msg('ann','check this https://www.youtube.com/watch?v=dQw4w9WgXcQ'),cfg()),false,'safe link stays');
  assert.equal(await A.handleAutomod(msg('ann','https://bit.ly/abc'),cfg()),true);
  let c=rows.ModCase.at(-1); assert.equal(c.type,'warn'); assert.match(c.reason,/unsafe link \(bit\.ly — a link shortener/);
  A._lastStrike.clear();
  assert.equal(await A.handleAutomod(msg('ben','FREE NITRO https://discord-nitro.gift/claim'),cfg()),true);
  c=rows.ModCase.at(-1); assert.equal(c.userId,'ben'); assert.equal(c.type,'timeout','a scam link mutes straight away (no warnings first)');
  assert.equal(members.get('ben').timeouts.at(-1),60*60000);
  assert.ok(general.deletedIds.length>=2,'messages removed');
  assert.equal(await A.handleAutomod(msg('mod','https://bit.ly/abc'),cfg()),false,'staff skip auto-mod');
  console.log('✓ auto-mod: unsafe link → removed + warning; scam link → removed + muted straight away; staff skip it');

  // Allowlist mode: other sites are removed with a note, no strike.
  r=await A.saveSettings(guild,{rules:{unsafeLinks:{mode:'allowlist',allow:['Example.org','junk'],scamMute:false}}});
  assert.deepEqual(r.settings.unsafeLinks.allow,['example.org']);
  const before=rows.ModCase.length; A._lastStrike.clear();
  assert.equal(await A.handleAutomod(msg('vip','see https://randomblog.net/post'),cfg()),true);
  assert.equal(rows.ModCase.length,before,'no strike for an unapproved link'); assert.match(sent.at(-1).m.payload.content,/only approved sites.*randomblog\.net/);
  assert.equal(await A.handleAutomod(msg('vip','see https://docs.example.org/x and https://twitch.tv/x'),cfg()),false,'approved + well-known sites are fine');
  assert.equal(await A.handleAutomod(msg('vip','https://dlscord.com/nitro'),cfg()),true); assert.equal(rows.ModCase.at(-1).type,'warn','scam mute turned off → a normal strike');
  assert.match((await A.saveSettings(guild,{rules:{unsafeLinks:{mode:'everything'}}})).error,/Link mode/);
  console.log('✓ allowlist mode: other sites removed with a note and no strike; approved/well-known sites fine; scam mute can be turned off');

  // Edits: a harmless message edited into a scam link is caught; unchanged text (embed unfurl) is ignored.
  await A.saveSettings(guild,{rules:{unsafeLinks:{mode:'unsafe',scamMute:true}}}); A._lastStrike.clear();
  const old=msg('ann','hey all'); const edited={...old,content:'hey all https://steamcommunlty.com/gift'};
  assert.equal(await A.handleAutomodEdit(old,{...old}),false,'nothing changed');
  assert.equal(await A.handleAutomodEdit(old,edited),true); assert.equal(rows.ModCase.at(-1).type,'timeout');
  console.log('✓ links edited into a message are caught too');

  // ---- adult / NSFW sites: on by default, a big list + .xxx/.porn TLDs + obvious words; NSFW channels skip it
  assert.ok(L.NSFW_DOMAINS.length>=400,'a big built-in list');
  for (const u of ['https://www.pornhub.com/view_video.php?viewkey=1','https://onlyfans.com/x','https://de.xhamster.com','https://nhentai.net/g/1','https://rule34.xxx/','https://anything.porn','https://free-porn-tube.net','https://p0rnhub-clips.net','https://hot-milfs.org','https://sexcams24.biz','https://nude-pics.net','https://reddit.com/r/gonewild/comments/x','https://www.reddit.com/r/NSFW_GIF'])
    assert.equal(L.checkContent(u)?.reason,'an adult (NSFW) site',u);
  for (const u of ['https://essex.ac.uk','https://www.middlesex.edu','https://unisex-clothing.com','https://denuded-trees.org','https://www.reddit.com/r/gaming','https://reddit.com/r/Essex','https://en.wikipedia.org/wiki/Pornography','https://github.com/xxxxx/repo'])
    assert.equal(L.checkContent(u),null,u);
  assert.equal(L.checkContent('https://pornhub.com',{nsfw:false}),null); assert.equal(L.checkContent('https://pornhub.com',{allow:['pornhub.com']}),null,'the approved list wins');
  r=await A.saveSettings(guild,{rules:{unsafeLinks:{mode:'unsafe'}}}); assert.equal(r.settings.unsafeLinks.nsfw,true,'on by default');
  A._lastStrike.clear(); const n0=rows.ModCase.length;
  assert.equal(await A.handleAutomod(msg('vip','lol https://www.xvideos.com/video123'),cfg()),true);
  assert.equal(rows.ModCase.length,n0+1); assert.equal(rows.ModCase.at(-1).type,'warn','a normal strike, not the scam mute'); assert.match(sent.at(-1).m.payload.content,/🔞 .*adult \(NSFW\) links aren’t allowed here/);
  const nsfwRoom=guild.channels.cache.get('memes'); nsfwRoom.nsfw=true; A._lastStrike.clear();
  assert.equal(await A.handleAutomod(msg('vip','https://www.xvideos.com/video123','memes'),cfg()),false,'channels marked NSFW skip the adult check');
  assert.equal(await A.handleAutomod(msg('vip','https://bit.ly/abc','memes'),cfg()),true,'…but the other checks still apply there');
  nsfwRoom.nsfw=false;
  r=await A.saveSettings(guild,{rules:{unsafeLinks:{nsfw:false}}}); assert.equal(r.settings.unsafeLinks.nsfw,false);
  A._lastStrike.clear(); assert.equal(await A.handleAutomod(msg('vip','https://www.xvideos.com/video123'),cfg()),false,'can be turned off');
  console.log('✓ adult / NSFW links removed by default (list, .xxx/.porn, words, NSFW subreddits) with a 🔞 note; NSFW channels skip it; can be turned off');
  process.exit(0);
})().catch(e=>{console.error(e);process.exit(1);});
