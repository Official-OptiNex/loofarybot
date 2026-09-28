process.env.TOKEN='x';process.env.CLIENT_ID='1';process.env.MONGODB_URI='m';
const root=require('path').join(__dirname,'..')+'/'; const assert=require('assert');
const { PermissionsBitField, PermissionFlagsBits, Collection } = require(root+'node_modules/discord.js');
const ModCase=require(root+'src/database/models/ModCase'); const GuildConfig=require(root+'src/database/models/GuildConfig');
const LogEntry=require(root+'src/database/models/LogEntry'); LogEntry.create=async()=>{};
let cases=[]; let counter=0; let cfg={guildId:'g',warnEscalation:[],modDmEnabled:true,logsEnabled:false};
const match=(c,q)=>Object.entries(q).every(([k,v])=>{ if(v&&typeof v==='object'&&!Array.isArray(v)){ if('$ne' in v&&'$lte' in v) return c[k]!=null&&c[k]<=v.$lte; if('$gte' in v) return c[k]>=v.$gte; return true;} return c[k]===v; });
ModCase.create=async(d)=>{const c={...d,_id:cases.length+1,active:true,createdAt:new Date(),toObject(){return {...this};}}; cases.push(c); return c;};
ModCase.updateOne=async(q,u)=>{const c=cases.find(x=>x._id===q._id); if(c) Object.assign(c,u.$set);};
ModCase.updateMany=async(q,u)=>{cases.filter(c=>match(c,q)).forEach(c=>Object.assign(c,u.$set));};
ModCase.countDocuments=async(q)=>cases.filter(c=>match(c,q)).length;
ModCase.find=(q)=>{let arr=cases.filter(c=>match(c,q)); const o={sort:()=>{arr=[...arr].sort((a,b)=>b.caseId-a.caseId);return o;},skip:(n)=>{arr=arr.slice(n);return o;},limit:(n)=>{arr=arr.slice(0,n);return o;},lean:async()=>arr.map(c=>({...c}))}; return o;};
ModCase.findOne=async(q)=>{const c=cases.find(x=>match(x,q)); if(!c) return null; return Object.assign(Object.create({save:async function(){Object.assign(c,this);},toObject(){return {...c};}}),c);};
ModCase.findOneAndUpdate=(q,u)=>{const c=cases.find(x=>match(x,q)); if(c) Object.assign(c,u.$set); return {lean:async()=>c?{...c}:null};};
ModCase.deleteOne=async(q)=>{const i=cases.findIndex(x=>match(x,q)); if(i<0) return {deletedCount:0}; cases.splice(i,1); return {deletedCount:1};};
GuildConfig.findOneAndUpdate=async()=>({caseCounter:++counter});
GuildConfig.findOne=(q)=>({lean:async()=>cfg, then:(a,b)=>Promise.resolve(cfg).then(a,b)});
// fake guild
const dms=[]; const actions=[];
const role=(pos)=>({position:pos});
function member(id,{pos=1,perms=0n,bot=false,admin=false}={}){ let timedOut=false; return {id,displayName:'M'+id,user:{id,tag:'user'+id,bot,send:async(o)=>{dms.push([id,o.content]);return {};},displayAvatarURL:()=>''},
  roles:{highest:role(pos)},permissions:new PermissionsBitField(admin?PermissionsBitField.All:perms),
  timeout:async(ms,r)=>{actions.push(['timeout',id,ms]); timedOut=!!ms;},isCommunicationDisabled:()=>timedOut,kick:async()=>{actions.push(['kick',id]);}}; }
const MOD=member('mod',{pos:5,perms:PermissionFlagsBits.ModerateMembers|PermissionFlagsBits.KickMembers|PermissionFlagsBits.BanMembers});
const members=new Map([['mod',MOD],['u1',member('u1')],['u2',member('u2')],['high',member('high',{pos:9})],['owner',member('owner',{pos:1})],['adm',member('adm',{admin:true})],['helper',member('helper',{pos:3})]]);
const banned=new Set();
const guild={id:'g',name:'Test',ownerId:'owner',members:{me:{id:'bot',permissions:new PermissionsBitField(PermissionsBitField.All),roles:{highest:role(10)}},fetch:async(id)=>{const m=members.get(id); if(!m) throw new Error('unknown'); return m;},ban:async(id)=>{banned.add(id);actions.push(['ban',id]);},unban:async(id)=>{banned.delete(id);actions.push(['unban',id]);}},
  bans:{fetch:async(id)=>banned.has(id)?{}:null},client:{users:{fetch:async(id)=>({id,tag:'gone'+id,send:async()=>{throw new Error('closed');}})}},channels:{cache:new Map()}};
const M=require(root+'src/bot/cogs/modules/modCases');
const mod={id:'mod',tag:'mod#1'};
(async()=>{
  let r=await M.performAction(guild,{type:'warn',userId:'u1',moderator:mod,moderatorMember:MOD,reason:'spam'});
  assert.equal(r.case.caseId,1); assert.equal(r.dmSent,true); assert.match(dms[0][1],/warned.*Test.*spam/s);
  console.log('✓ warn → case #1, DM sent with the reason');
  for (const [target,msg] of [['high',/at or above yours/],['owner',/owner/],['mod',/yourself/]]) { r=await M.performAction(guild,{type:'kick',userId:target,moderator:mod,moderatorMember:MOD}); assert.match(r.error,msg); }
  r=await M.performAction(guild,{type:'kick',userId:'u1',moderator:mod,moderatorMember:members.get('helper')}); assert.match(r.error,/Kick Members/);
  r=await M.performAction(guild,{type:'timeout',userId:'adm',moderator:mod,moderatorMember:MOD,durationMs:60000}); assert.match(r.error,/at or above yours|Administrators/);
  console.log('✓ refuses: higher role, owner, self, missing permission, admins');
  r=await M.performAction(guild,{type:'timeout',userId:'u2',moderator:mod,moderatorMember:MOD,durationMs:40*86400e3}); assert.equal(actions.at(-1)[2],28*86400e3,'capped at 28d');
  r=await M.performAction(guild,{type:'untimeout',userId:'u2',moderator:mod,moderatorMember:MOD}); assert.ok(!r.error); assert.equal(cases.find(c=>c.type==='timeout').active,false);
  r=await M.performAction(guild,{type:'untimeout',userId:'u2',moderator:mod,moderatorMember:MOD}); assert.match(r.error,/isn't timed out/);
  console.log('✓ timeout (capped at 28 days) and untimeout');
  // escalation: 2 warnings → 1h timeout, 3 → kick
  cfg.warnEscalation=[{count:2,action:'timeout',durationMs:3600e3},{count:3,action:'kick',durationMs:null}];
  r=await M.performAction(guild,{type:'warn',userId:'u1',moderator:mod,moderatorMember:MOD,reason:'again'});
  assert.equal(r.escalated.rule.count,2); assert.equal(r.escalated.case.type,'timeout'); assert.equal(r.escalated.case.auto,true);
  r=await M.performAction(guild,{type:'warn',userId:'u1',moderator:mod,moderatorMember:MOD,reason:'third'}); assert.equal(r.escalated.case.type,'kick');
  console.log('✓ escalation: 2 warnings → automatic 1h timeout, 3 → automatic kick');
  // revoke stops counting
  const warn1=cases.find(c=>c.type==='warn'); r=await M.revokeCase('g',warn1.caseId,'mod'); assert.ok(!r.error); assert.equal(await ModCase.countDocuments({guildId:'g',userId:'u1',type:'warn',active:true}),2);
  r=await M.revokeCase('g',warn1.caseId,'mod'); assert.match(r.error,/already revoked/);
  console.log('✓ revoking a warning stops it counting');
  // ban someone not in the server, temp ban, unban
  r=await M.performAction(guild,{type:'ban',userId:'999',moderator:mod,moderatorMember:MOD,reason:'raider',durationMs:3600e3,deleteMessageSeconds:86400});
  assert.ok(!r.error, r.error); assert.ok(banned.has('999')); assert.ok(r.case.expiresAt);
  const bc=cases.find(c=>c.type==='ban'); bc.expiresAt=new Date(Date.now()-1000);
  const client={guilds:{cache:new Map([['g',guild]])}}; await M.sweepTempBans(client);
  assert.ok(!banned.has('999')); assert.equal(cases.at(-1).type,'unban'); assert.equal(cases.at(-1).auto,true);
  r=await M.performAction(guild,{type:'unban',userId:'999',moderator:mod,moderatorMember:MOD}); assert.match(r.error,/isn't banned/);
  console.log('✓ ban by user ID, temporary ban lifted automatically when it ends');
  // listing / reason / delete
  const list=await M.listCases('g',{userId:'u1'}); assert.ok(list.total>=4);
  r=await M.updateReason('g',1,'edited'); assert.equal(cases.find(c=>c.caseId===1).reason,'edited');
  r=await M.deleteCase('g',1); assert.ok(!r.error); r=await M.deleteCase('g',1); assert.match(r.error,/doesn't exist/);
  console.log('✓ case list, edit reason, delete');
  cfg.modDmEnabled=false; dms.length=0; await M.performAction(guild,{type:'warn',userId:'u2',moderator:mod,moderatorMember:MOD,reason:'x'}); assert.equal(dms.length,0);
  console.log('✓ DMs can be turned off');
  process.exit(0);
})().catch(e=>{console.error(e);process.exit(1);});
