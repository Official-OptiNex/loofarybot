process.env.TOKEN='x';process.env.CLIENT_ID='123';process.env.MONGODB_URI='mongodb://x';
const root=require('path').join(__dirname,'..')+'/'; const assert=require('assert');
const { PermissionsBitField, Collection } = require(root+'node_modules/discord.js');
const { store } = require('./helpers/memstore');
const GuildConfig=require(root+'src/database/models/GuildConfig');
const ChatDrop=require(root+'src/database/models/ChatDrop');
const cfgRows=store(GuildConfig); const dropRows=store(ChatDrop);
const L=require(root+'src/bot/cogs/modules/leveling');
const xp={}; L.adjustXp=async(g,u,d)=>{ const old=Math.floor((xp[u]||0)/1000); xp[u]=(xp[u]||0)+d; return {oldLevel:old,newLevel:Math.floor(xp[u]/1000),roleFailures:[]}; };
L.getOrCreateConfig=async(guildId)=>{ let r=cfgRows.find(x=>x.guildId===guildId); if(!r){ await GuildConfig.create({guildId}); } return GuildConfig.findOne({guildId}); };
const crypto=require('crypto'); let forced=[]; const realRI=crypto.randomInt; crypto.randomInt=(a,b)=>{ if(forced.length) return forced.shift(); return b===undefined?realRI(a):realRI(a,b); };
const D=require(root+'src/bot/cogs/modules/chatDrops');

// fake guild / channels
const sent=[];
function channel(id){ const msgs=new Map(); let n=1; const ch={id,name:id,guild:null,isTextBased:()=>true,isThread:()=>false,permissionsFor:()=>new PermissionsBitField(PermissionsBitField.All),toString(){return `<#${id}>`;},
  send:async(p)=>{ const m={id:`${id}-${n++}`,payload:p,edits:[],deleted:false,edit:async(np)=>{m.payload=np;m.edits.push(np);return m;},delete:async()=>{m.deleted=true;msgs.delete(m.id);}}; msgs.set(m.id,m); sent.push({ch:id,m}); return m; },
  messages:{fetch:async(mid)=>{ const m=msgs.get(mid); if(!m) throw new Error('Unknown'); return m; }}, msgs}; return ch; }
const guild={id:'g',channels:{cache:new Collection()},members:{me:{id:'bot'},cache:new Collection()}};
for (const id of ['general','memes','quiet']) { const c=channel(id); c.guild=guild; guild.channels.cache.set(id,c); }
const client={guilds:{cache:new Map([['g',guild]])}};
const talk=(ch,n,bot=false)=>{ for(let i=0;i<n;i++) D.noteActivity({guild,channelId:ch,author:{bot},system:false}); };
function click(user,drop,msg){ const log=[]; const i={guildId:'g',guild,customId:`xpd:${drop._id}`,user:{id:user,bot:false},message:msg,reply:async(o)=>log.push(o)}; return [i,log]; }
const J=(x)=>JSON.stringify(x);
const lastDrop=()=>dropRows.at(-1);
const msgOf=(d)=>guild.channels.cache.get(d.channelId).msgs.get(d.messageId);

(async()=>{
  // ---- settings
  await GuildConfig.create({guildId:'g'});
  let r=await D.saveSettings(guild,{enabled:true,channelIds:['general','memes'],minXp:500,maxXp:100}); assert.match(r.error,/XP per drop/);
  r=await D.saveSettings(guild,{enabled:true,channelIds:['nope']}); assert.match(r.error,/not a text channel/);
  r=await D.saveSettings(guild,{minMinutes:2}); assert.match(r.error,/at least 5 minutes/);
  r=await D.saveSettings(guild,{enabled:true,channelIds:['general','memes'],minXp:100,maxXp:100,minActivity:3,claimSeconds:60});
  assert.equal(r.settings.enabled,true); const firstNext=r.settings.nextDropAt.getTime(); assert.ok(firstNext>Date.now()+29*60e3&&firstNext<=Date.now()+90*60e3+1000);
  r=await D.saveSettings(guild,{enabled:true,channelIds:['general','memes'],minXp:120,maxXp:120}); assert.equal(r.settings.nextDropAt.getTime(),firstNext);
  console.log('✓ settings validated; saving again keeps the scheduled time (only turning on / changing timing reschedules)');

  // ---- scheduler: waits for activity, then drops in an active channel
  cfgRows[0].chatDrops.nextDropAt=new Date(Date.now()-1000).toISOString(); const due=cfgRows[0].chatDrops.nextDropAt;
  talk('general',5,true); await D.tick(client); assert.equal(dropRows.length,0,'bots don’t count as activity');
  talk('general',2); await D.tick(client); assert.equal(dropRows.length,0,'not enough activity yet');
  assert.equal(cfgRows[0].chatDrops.nextDropAt,due,'waiting keeps the due time');
  talk('general',1); forced=[0,0,0,0]; await D.tick(client); // next-drop delay, channel, amount, winners (0 → 1 winner)
  assert.equal(dropRows.length,1); let d=lastDrop(); assert.equal(d.channelId,'general'); assert.equal(d.amount,120); assert.equal(d.winners,1); assert.ok(d.messageId);
  const nd=new Date(cfgRows[0].chatDrops.nextDropAt).getTime(); assert.ok(nd>Date.now()+29*60e3,'next drop scheduled');
  const m=msgOf(d); assert.match(J(m.payload.embeds[0]),/XP Drop!.*\*\*120 XP\*\* for the first person to click/);
  cfgRows[0].chatDrops.nextDropAt=new Date(Date.now()-1000).toISOString(); talk('memes',5); await D.tick(client); assert.equal(dropRows.length,1,'one open drop at a time');
  console.log('✓ drops wait for real chat activity (bots ignored), land in an active channel, schedule the next one, and never overlap');

  // ---- claim (1 winner)
  let [c1,l1]=click('alice',d,m); let [c2,l2]=click('bob',d,m); let [c3,l3]=click('carl',d,m);
  await Promise.all([D.handleDropButton(c1),D.handleDropButton(c2),D.handleDropButton(c3)]);
  const winners=dropRows[0].claimedBy; assert.equal(winners.length,1); assert.equal(xp[winners[0]],120);
  const losers=[l1,l2,l3].filter(l=>/Too slow/.test(l[0].content)); assert.equal(losers.length,2);
  assert.equal(dropRows[0].status,'closed'); assert.match(J(m.payload),/claimed/); assert.equal(m.payload.components[0].toJSON().components[0].disabled,true);
  const congrats=sent.at(-1); assert.equal(congrats.ch,'general'); const ct=congrats.m.payload.embeds[0].data; assert.match(ct.description,/^🎉 <@\w+> grabbed \*\*120 XP\*\*!$/); assert.ok(!ct.title); assert.deepEqual(congrats.m.payload.allowedMentions,{parse:[]});
  console.log('✓ three people click at once → exactly one winner gets the XP; the drop closes and a one-line congrats is posted (no ping)');

  // ---- claim (2 winners) + repeat click
  let s=D.dropSettings(cfgRows[0]); forced=[0,80]; d=await D.postDrop(guild.channels.cache.get('memes'),s); assert.equal(d.winners,2);
  const m2=msgOf(d); [c1,l1]=click('alice',d,m2); await D.handleDropButton(c1);
  assert.match(J(m2.payload.components[0].toJSON()),/Claim \(1 left\)/);
  [c1,l1]=click('alice',d,m2); await D.handleDropButton(c1); assert.match(l1[0].content,/already grabbed/);
  [c2,l2]=click('bob',d,m2); await D.handleDropButton(c2); assert.match(l2[0].content,/grabbed \*\*120 XP\*\*/);
  assert.match(sent.at(-1).m.payload.embeds[0].data.description,/<@alice> and <@bob> grabbed \*\*120 XP\*\* each!/);
  console.log('✓ 2-winner drop: button counts down, same person can’t claim twice, congrats names both');

  // ---- expiry
  forced=[0,0]; d=await D.postDrop(guild.channels.cache.get('general'),s); const m3=msgOf(d);
  dropRows.at(-1).expiresAt=new Date(Date.now()-1000).toISOString(); const before=sent.length; await D.sweepExpired(client);
  assert.ok(m3.deleted); assert.equal(sent.length,before); assert.equal(dropRows.at(-1).status,'closed');
  forced=[0,95]; d=await D.postDrop(guild.channels.cache.get('general'),s); assert.equal(d.winners,3); const m4=msgOf(d);
  [c1]=click('dave',d,m4); await D.handleDropButton(c1); dropRows.at(-1).expiresAt=new Date(Date.now()-1000).toISOString(); await D.sweepExpired(client);
  assert.match(sent.at(-1).m.payload.embeds[0].data.description,/<@dave> grabbed/); assert.ok(!m4.deleted);
  [c2,l2]=click('erin',d,m4); await D.handleDropButton(c2); assert.match(l2[0].content,/Too slow|expired/);
  console.log('✓ unclaimed drops are deleted quietly; partly-claimed drops close with a congrats; late clicks are refused');

  // ---- leveling off / drops off
  cfgRows[0].levelingEnabled=false; cfgRows[0].chatDrops.nextDropAt=new Date(Date.now()-1000).toISOString(); talk('general',5); const n=dropRows.length; await D.tick(client); assert.equal(dropRows.length,n);
  cfgRows[0].levelingEnabled=true; await D.saveSettings(guild,{enabled:false}); await D.tick(client); assert.equal(dropRows.length,n);
  console.log('✓ no drops when leveling or chat drops are off');

  // ---- level-up shows in the claim reply
  await D.saveSettings(guild,{enabled:true,minXp:2000,maxXp:2000}); s=D.dropSettings(cfgRows[0]); forced=[0,0]; d=await D.postDrop(guild.channels.cache.get('general'),s);
  [c1,l1]=click('zed',d,msgOf(d)); await D.handleDropButton(c1); assert.match(l1[0].content,/Level 2/);
  console.log('✓ claim reply shows a level-up');

  // ---- /xpdrop
  const C=require(root+'src/bot/commands/xpdrop');
  const cmd=(sub,opts={})=>{ const log=[]; const i={guildId:'g',guild,channel:guild.channels.cache.get('general'),options:{getSubcommand:()=>sub,getChannel:(k)=>opts[k]??null,getInteger:(k)=>opts[k]??null,getBoolean:(k)=>opts[k]??null},reply:async(o)=>log.push(o)}; return [i,log]; };
  let [x,xl]=cmd('setup',{channel:guild.channels.cache.get('quiet'),min_xp:50,max_xp:75}); await C.execute(x); assert.match(xl[0].content,/Chat drops are on\*\* in <#quiet>.*50–75 XP/s);
  [x,xl]=cmd('now',{channel:guild.channels.cache.get('memes')}); await C.execute(x); assert.match(xl[0].content,/Dropped \*\*\d+ XP\*\*/);
  [x,xl]=cmd('status'); await C.execute(x); assert.match(J(xl[0].embeds[0]),/Chat drops — on/);
  [x,xl]=cmd('toggle',{enabled:false}); await C.execute(x); assert.match(xl[0].content,/off/);
  console.log('✓ /xpdrop setup · now · status · toggle');
  process.exit(0);
})().catch(e=>{console.error(e);process.exit(1);});
