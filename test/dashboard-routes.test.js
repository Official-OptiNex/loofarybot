process.env.TOKEN='x';process.env.CLIENT_ID='123';process.env.MONGODB_URI='mongodb://x';
const root=require('path').join(__dirname,'..')+'/';
const assert=require('assert');
const express=require(root+'node_modules/express');
const { Collection, PermissionsBitField, PermissionFlagsBits } = require(root+'node_modules/discord.js');

// ---- tiny in-memory model stand-in
let idc=1;
function memModel(Model){
  const rows=[];
  const match=(r,q)=>Object.entries(q||{}).every(([k,v])=>{ if(k==='$expr')return true; const val=k.split('.').reduce((o,p)=>o?.[p],r); if(v&&typeof v==='object'&&!Array.isArray(v)){ if('$ne' in v) return Array.isArray(val)?!val.includes(v.$ne):val!==v.$ne; if('$lte' in v) return val<=v.$lte; return true;} return String(val)===String(v); });
  const wrap=(r)=>{ if(!r) return null; const d=Object.assign(Object.create({save:async function(){Object.assign(r,JSON.parse(JSON.stringify(plain(this))));return this;},toObject:function(){return JSON.parse(JSON.stringify(plain(this)));},deleteOne:async function(){rows.splice(rows.indexOf(r),1);}}),JSON.parse(JSON.stringify(r))); return d; };
  const plain=(d)=>Object.fromEntries(Object.keys(d).map(k=>[k,d[k]]));
  const q=(arr)=>{const p=Promise.resolve(arr); const o={sort:()=>o,limit:(n)=>{arr=arr.slice(0,n);return o;},lean:async()=>JSON.parse(JSON.stringify(arr)),then:(a,b)=>Promise.resolve(arr.map(wrap)).then(a,b)}; return o;};
  const apply=(r,u)=>{ if(u.$set) Object.assign(r,u.$set); if(u.$push) for(const k in u.$push) r[k].push(u.$push[k]); if(u.$pull) for(const k in u.$pull) r[k]=r[k].filter(v=>v!==u.$pull[k]); };
  Model.find=(qq)=>q(rows.filter(r=>match(r,qq)));
  Model.findOne=(qq)=>{const r=rows.find(r=>match(r,qq)); const p=Promise.resolve(wrap(r)); p.lean=async()=>r?JSON.parse(JSON.stringify(r)):null; return p;};
  Model.findById=(id)=>Model.findOne({_id:id});
  Model.create=async(d)=>{ const doc=new Model(d); const r={...doc.toObject(),_id:String(idc++)}; rows.push(r); return wrap(r); };
  Model.updateOne=async(qq,u)=>{const r=rows.find(r=>match(r,qq)); if(r) apply(r,u); return {modifiedCount:r?1:0};};
  Model.deleteOne=async(qq)=>{const i=rows.findIndex(r=>match(r,qq)); if(i>=0) rows.splice(i,1);};
  Model.findOneAndUpdate=async(qq,u)=>{const r=rows.find(r=>match(r,qq)); if(!r) return null; apply(r,u); return wrap(r);};
  Model.findOneAndDelete=async(qq)=>{const i=rows.findIndex(r=>match(r,qq)); if(i<0) return null; return rows.splice(i,1)[0];};
  Model.prototype.save=async function(){ const o=this.toObject(); o._id=String(o._id); const i=rows.findIndex(r=>r._id===o._id); if(i>=0) rows[i]=o; else rows.push(o); return this; };
  return rows;
}
const Giveaway=require(root+'src/database/models/Giveaway'); const gwRows=memModel(Giveaway);
const RRP=require(root+'src/database/models/ReactionRolePanel'); const rrRows=memModel(RRP);
const Poll=require(root+'src/database/models/Poll'); const pollRows=memModel(Poll);
const Reminder=require(root+'src/database/models/Reminder'); const remRows=memModel(Reminder);
const L=require(root+'src/bot/cogs/modules/leveling');
const xp={}; L.adjustXp=async(g,u,d)=>{xp[u]=Math.max(0,(xp[u]||0)+d);return{record:{xp:xp[u]},oldLevel:0,newLevel:1,roleFailures:[]};};
L.getOrCreateConfig=async()=>({lockdownOverwrites:[{channelId:'c1',targetId:'g1'}]});
const lockMod=require(root+'src/bot/cogs/modules/lockdown');
const lockCalls=[]; lockMod.lockdown=async(g,o)=>{lockCalls.push(['lock',o.channel?.id||null,o.reason,o.actor.tag]);return{locked:[1,2],failed:[]};};
lockMod.unlockdown=async(g,o)=>{lockCalls.push(['unlock',o.channel?.id||null]);return{unlocked:[1]};};
const UserLevel=require(root+'src/database/models/UserLevel'); UserLevel.updateOne=async()=>({}); 
const LC=require(root+'src/bot/cogs/modules/levelColors'); LC.onLevelChange=async()=>{};
const AuditEntry=require(root+'src/database/models/AuditEntry'); const audits=[]; AuditEntry.create=async(e)=>{audits.push(e);};
const GuildConfig=require(root+'src/database/models/GuildConfig'); GuildConfig.findOne=()=>({lean:async()=>({dashboardAccess:{modRoleIds:['modrole'],modPages:['giveaways']}})});

// ---- fake discord
const sent=[]; const messages=new Map(); let mid=1000; let failNext=false;
function makeChannel(id,name){
  const ch={id,name,guild:null,isTextBased:()=>true,isThread:()=>false,toString:()=>`<#${id}>`,
    permissionsFor:()=>new PermissionsBitField(PermissionsBitField.All),
    send:async(o)=>{ if(failNext){failNext=false;throw new Error('Invalid emoji');} const m={id:String(mid++),url:`https://discord/${id}/${mid}`,payload:o,edit:async(p)=>{m.payload=p;m.edits=(m.edits||0)+1;},delete:async()=>{m.deleted=true;}}; messages.set(m.id,m); sent.push([id,o]); return m; },
    messages:{fetch:async(arg)=>{ if(typeof arg==='string') return messages.get(arg)||null; const c=new Collection(); c.set('x1',{id:'x1',author:{id:'u9'}}); c.set('x2',{id:'x2',author:{id:'u8'}}); return c; }},
    bulkDelete:async(list)=>new Collection(list.map(m=>[m.id,m]))};
  return ch;
}
const channels=new Collection([['c1',makeChannel('c1','general')],['c2',makeChannel('c2','news')]]);
const role=(id,name,pos)=>({id,name,position:pos,managed:false,toString:()=>`<@&${id}>`});
const roles=new Collection([['g1',role('g1','@everyone',0)],['r1',role('r1','Booster',1)],['rhigh',role('rhigh','Owner',50)],['modrole',role('modrole','Mod',2)]]);
const memberOf=(id,{admin=false,roleIds=[]}={})=>({id,displayName:'Mem'+id,user:{id,bot:id==='bot1'},roles:{cache:new Map(roleIds.map(r=>[r,true])),highest:{position:10}},permissions:new PermissionsBitField(admin?[PermissionFlagsBits.ManageGuild]:[])});
const members=new Map([['admin',memberOf('admin',{admin:true})],['mod',memberOf('mod',{roleIds:['modrole']})],['u9',memberOf('u9')],['bot1',memberOf('bot1')]]);
const guild={id:'g1',name:'G',channels:{cache:channels},roles:{cache:roles,everyone:roles.get('g1')},
  members:{cache:members,me:{permissions:new PermissionsBitField(PermissionsBitField.All),roles:{highest:{position:10}}},fetch:async(id)=>{const m=members.get(id); if(!m) throw new Error('unknown'); return m;}}};
channels.forEach(c=>c.guild=guild);
const client={guilds:{cache:new Map([['g1',guild]])},channels:{fetch:async(id)=>channels.get(id)||null}};

const app=express(); app.use(express.json()); app.locals.discordClient=client;
let who='admin';
app.use((req,res,next)=>{req.session={user:{id:who,username:who},guilds:[{id:'g1',permissions:'0'}]};next();});
app.use('/api',require(root+'src/web/routes/manage'));
const server=app.listen(0); const base=`http://127.0.0.1:${server.address().port}/api/guilds/g1/`;
const call=async(method,path,body)=>{const r=await fetch(base+path,{method,headers:{'content-type':'application/json'},body:body?JSON.stringify(body):undefined}); return {status:r.status,body:await r.json()};};

(async()=>{
  // giveaways
  let r=await call('POST','giveaways',{type:'timed',channelId:'c1',prize:'Nitro',duration:'1h',winners:2,ping:'everyone',color:'green',emoji:'🎁',requirements:{roleId:'r1',minLevel:'5',minDaysInServer:''}});
  assert.equal(r.status,200,JSON.stringify(r.body)); const gid=r.body.giveaway.messageId;
  assert.equal(sent.at(-1)[1].content,'@everyone'); assert.equal(gwRows[0].requirements.minLevel,5); assert.equal(gwRows[0].colorHex,'#57F287'); assert.equal(gwRows[0].hostId,'admin');
  assert.equal((await call('POST','giveaways',{channelId:'c1',prize:'x',duration:'nope'})).status,400);
  assert.equal((await call('POST','giveaways',{channelId:'zz',prize:'x',duration:'1h'})).status,400);
  assert.equal((await call('POST','giveaways',{channelId:'c1',prize:'',duration:'1h'})).status,400);
  r=await call('POST','giveaways',{type:'drop',channelId:'c2',prize:'Key',winners:2}); assert.equal(r.status,200); const did=r.body.giveaway.messageId;
  assert.equal(gwRows[1].emoji,'⚡'); assert.ok(gwRows[1].endTimestamp-Date.now()>23*3600e3,'drop defaults to 24h');
  failNext=true; r=await call('POST','giveaways',{channelId:'c1',prize:'x',duration:'1h',emoji:'bad'}); assert.equal(r.status,400); assert.match(r.body.error,/emoji/);
  console.log('✓ create giveaways + validation');
  r=await call('GET','giveaways'); assert.equal(r.body.running.length,2); assert.equal(r.body.running[0].hostName,'Memadmin');
  r=await call('POST',`giveaways/${gid}`,{prize:'Nitro Pro',winners:3,duration:'2h',description:'hi',color:'#123456',emoji:'🎉',requirements:{}});
  assert.equal(r.status,200); const g0=gwRows.find(g=>g.messageId===gid); assert.equal(g0.prize,'Nitro Pro'); assert.equal(g0.winnerCount,3); assert.equal(g0.requirements.roleId,null); assert.ok(messages.get(gid).edits>=1);
  assert.ok(Math.abs(g0.endTimestamp-(Date.now()+7200e3))<5000);
  console.log('✓ edit giveaway');
  // enter people then end
  g0.entries=['u9','admin']; 
  r=await call('POST',`giveaways/${gid}/end`); assert.equal(r.status,200); assert.equal(r.body.giveaway.ended,true); assert.equal(r.body.giveaway.winners.length,2);
  assert.equal((await call('POST',`giveaways/${gid}/end`)).status,400);
  assert.equal((await call('POST',`giveaways/${gid}`,{prize:'x'})).status,400,'cannot edit ended');
  r=await call('POST',`giveaways/${gid}/reroll`); assert.equal(r.status,200); assert.ok(['u9','admin'].includes(r.body.winner.id)); assert.equal(g0.winners.length,3);
  r=await call('POST',`giveaways/${did}/reroll`); assert.equal(r.status,400,'drop not ended');
  r=await call('DELETE',`giveaways/${gid}`); assert.equal(r.status,200); assert.ok(messages.get(gid).deleted); assert.equal(gwRows.find(g=>g.messageId===gid),undefined);
  assert.equal((await call('DELETE',`giveaways/nope`)).status,404);
  console.log('✓ end / reroll / delete');

  // bonus entries + entrants
  r=await call('POST','giveaways',{type:'timed',channelId:'c1',prize:'Bonus prize',duration:'1h',winners:1,bonusEntries:[{roleId:'r1',extra:3},{roleId:'nope',extra:2},{roleId:'r1',extra:1}]});
  assert.equal(r.status,200); const bgw=gwRows.find(g=>g.prize==='Bonus prize'); assert.deepEqual(bgw.bonusEntries,[{roleId:'r1',extra:3}]);
  bgw.entries=['u9','admin'];
  r=await call('GET',`giveaways/${bgw.messageId}/entrants`); assert.equal(r.body.total,2); assert.equal(r.body.entrants[0].name,'Memu9');
  r=await call('DELETE',`giveaways/${bgw.messageId}/entrants/u9`); assert.equal(r.status,200); assert.deepEqual(bgw.entries,['admin']);
  r=await call('DELETE',`giveaways/${bgw.messageId}/entrants/u9`); assert.equal(r.status,404);
  r=await call('POST',`giveaways/${bgw.messageId}`,{prize:'Bonus prize',winners:1,bonusEntries:[]}); assert.deepEqual(bgw.bonusEntries,[]);
  console.log('✓ bonus entries saved/cleaned, entrant list, remove entrant, bonus removed on edit');
  // reaction roles
  r=await call('POST','reactionroles',{channelId:'c1',title:'Pings',mode:'select',roles:[{roleId:'r1',label:'Boost',emoji:'🚀'},{roleId:'r1'},{roleId:'nope'}]});
  assert.equal(r.status,200,JSON.stringify(r.body)); assert.equal(rrRows[0].roles.length,1); assert.equal(rrRows[0].mode,'select');
  const pid=r.body.panel.messageId;
  r=await call('POST','reactionroles',{channelId:'c1',title:'Bad',roles:[{roleId:'rhigh'}]}); assert.equal(r.status,400); assert.match(r.body.error,/@Owner/);
  r=await call('POST',`reactionroles/${pid}`,{title:'Pings v2',mode:'buttons',roles:[]}); assert.equal(r.status,200); assert.equal(rrRows[0].title,'Pings v2'); assert.ok(messages.get(pid).edits>=1);
  r=await call('DELETE',`reactionroles/${pid}`); assert.equal(r.status,200); assert.equal(rrRows.length,0);
  console.log('✓ reaction role panels');

  // polls & reminders
  r=await call('POST','polls',{channelId:'c1',question:'Q?',options:['A','B','A',''],duration:'1h',anonymous:true});
  assert.equal(r.status,200,JSON.stringify(r.body)); assert.deepEqual(pollRows[0].options,['A','B']); assert.equal(pollRows[0].anonymous,true);
  assert.equal((await call('POST','polls',{channelId:'c1',question:'Q',options:['A']})).status,400);
  assert.equal((await call('POST','polls',{channelId:'c1',question:'Q',options:['A','B'],duration:'40d'})).status,400);
  r=await call('POST',`polls/${r.body.poll.messageId}/end`); assert.equal(r.status,200); assert.equal(pollRows[0].ended,true);
  r=await call('GET','polls'); assert.equal(r.body.closed.length,1);
  r=await call('POST','reminders',{channelId:'c2',message:'hey',in:'2h'}); assert.equal(r.status,200); assert.equal(remRows[0].target,'channel'); assert.equal(remRows[0].userId,'admin');
  assert.equal((await call('POST','reminders',{channelId:'c2',message:'hey',in:'10s'})).status,400);
  r=await call('GET','reminders'); assert.equal(r.body.reminders.length,1);
  assert.equal((await call('DELETE',`reminders/${'f'.repeat(24)}`)).status,404);
  assert.equal((await call('DELETE',`reminders/notanid`)).status,404);
  console.log('✓ polls + reminders');

  // moderation
  r=await call('GET','moderation'); assert.deepEqual(r.body.locked,[{id:'c1',name:'general'}]);
  r=await call('POST','moderation/lockdown',{reason:'raid'}); assert.equal(r.body.locked,2); assert.deepEqual(lockCalls.at(-1),['lock',null,'raid','admin (dashboard)']);
  r=await call('POST','moderation/lockdown',{channelId:'c2'}); assert.deepEqual(lockCalls.at(-1).slice(0,3),['lock','c2','Lockdown']);
  r=await call('POST','moderation/unlock',{channelId:null}); assert.equal(r.body.unlocked,1);
  r=await call('POST','moderation/purge',{channelId:'c1',count:5,userId:'u9'}); assert.equal(r.body.deleted,1);
  r=await call('POST','moderation/purge',{channelId:'c1',count:500}); assert.equal(r.status,400);
  console.log('✓ lockdown / purge');

  // member xp
  r=await call('POST','levels/member-xp',{userId:'u9',action:'give',amount:300}); assert.equal(r.body.xp,300);
  r=await call('POST','levels/member-xp',{userId:'u9',action:'take',amount:100}); assert.equal(r.body.xp,200);
  r=await call('POST','levels/member-xp',{userId:'u9',action:'reset'}); assert.equal(r.body.xp,0);
  assert.equal((await call('POST','levels/member-xp',{userId:'bot1',action:'give',amount:1})).status,400);
  assert.equal((await call('POST','levels/member-xp',{userId:'ghost',action:'give',amount:1})).status,400);
  console.log('✓ member XP');

  // permissions: moderator with only the giveaways page
  who='mod';
  assert.equal((await call('GET','giveaways')).status,200);
  for (const p of ['reactionroles','polls','reminders','moderation']) assert.equal((await call('GET',p)).status,403,p);
  assert.equal((await call('POST','levels/member-xp',{userId:'u9',action:'reset'})).status,403);
  who='u9'; assert.equal((await call('GET','giveaways')).status,403);
  console.log('✓ page permissions');

  await new Promise(r=>setTimeout(r,50));
  console.log('audit entries:', audits.length, '|', audits.slice(0,4).map(a=>a.action).join(' / '));
  // slash command paths still work through the shared helpers
  const GW=require(root+'src/bot/cogs/modules/giveaways');
  const replies=[]; const inter={guildId:'g1',user:{id:'admin'},deferred:true,editReply:async(o)=>replies.push(o.content)};
  await GW.launchGiveaway(client,{interaction:inter,channel:channels.get('c1'),durationMs:60000,winnerCount:1,prize:'Cmd prize',pingRole:roles.get('r1'),colorHex:'#5865F2',emoji:'🎉',customDesc:'x'});
  assert.match(replies.at(-1),/Giveaway started/); assert.equal(sent.at(-1)[1].content,'<@&r1>');
  const loof=require(root+'src/bot/commands/loof');
  const cmdG=gwRows.find(g=>g.prize==='Cmd prize'); cmdG.entries=['u9'];
  const opts=(sub,msgId)=>({getSubcommand:()=>sub,getString:()=>msgId,getInteger:()=>null,getRole:()=>null,getBoolean:()=>null});
  const mk=(sub,id,guildId='g1')=>({guildId,user:{id:'1545263092370243624'},memberPermissions:null,options:opts(sub,id),deferReply:async function(){this.deferred=true;},editReply:async(o)=>replies.push(o.content)});
  await loof.execute(mk('end',cmdG.messageId,'other-guild'),client); assert.match(replies.at(-1),/not found/,'cross-guild end blocked');
  await loof.execute(mk('end',cmdG.messageId),client); assert.match(replies.at(-1),/ended early/);
  await loof.execute(mk('reroll',cmdG.messageId),client); assert.match(replies.at(-1),/New winner: <@u9>/);
  await loof.execute(mk('delete',cmdG.messageId,'other-guild'),client); assert.match(replies.at(-1),/not found/);
  await loof.execute(mk('delete',cmdG.messageId),client); assert.match(replies.at(-1),/Deleted/);
  console.log('✓ /loof start · end · reroll · delete (and cross-server IDs are rejected)');
  server.close(); process.exit(0);
})().catch(e=>{console.error(e);process.exit(1);});
