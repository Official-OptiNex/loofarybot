process.env.TOKEN='x';process.env.CLIENT_ID='123';process.env.MONGODB_URI='mongodb://x';
const root=require('path').join(__dirname,'..')+'/'; const assert=require('assert');
require('mingo/init/system'); const { Aggregator, Query } = require('mingo');
const UserLevel=require(root+'src/database/models/UserLevel');
let rows=[];
const clone=(x)=>JSON.parse(JSON.stringify(x));
function apply(doc,u){ if(Array.isArray(u)) return new Aggregator(u).run([clone(doc)])[0]; const d=clone(doc); if(u.$set) Object.assign(d,u.$set); if(u.$inc) for(const [k,v] of Object.entries(u.$inc)) d[k]=(d[k]||0)+v; return d; }
const find=(q)=>rows.findIndex(r=>new Query(q).test(r));
UserLevel.findOneAndUpdate=async(q,u,o={})=>{ const i=find(q); if(i<0) return null; rows[i]=apply(rows[i],u); return rows[i]; };
UserLevel.updateOne=async(q,u,o={})=>{ let i=find(q); if(i<0){ if(!o.upsert) return {modifiedCount:0}; rows.push({_id:'id'+rows.length,...Object.fromEntries(Object.entries(q).filter(([k,v])=>typeof v!=='object'))}); i=rows.length-1; } rows[i]=apply(rows[i],u); return {modifiedCount:1}; };
UserLevel.findOne=(q)=>{ const r=rows[find(q)]; const p=Promise.resolve(r?{...r}:null); p.lean=async()=>r?clone(r):null; return p; };
UserLevel.exists=async(q)=>find(q)>=0;
UserLevel.create=async(d)=>{ rows.push({_id:'id'+rows.length,...d,xp:0,level:0}); return d; };
const L=require(root+'src/bot/cogs/modules/leveling');
const cfg={xpMultipliers:[],levelRoles:[]}; L.getOrCreateConfig=async()=>cfg;
const G=require(root+'src/bot/cogs/modules/gambling');
(async()=>{
  const guild={id:'g',members:{fetch:async()=>null,cache:new Map()}};
  // adjustXp: upsert fills defaults; never below 0
  await L.adjustXp(guild,'a',150,cfg); let a=rows.find(r=>r.userId==='a'); assert.equal(a.xp,150); assert.equal(a.level,1); assert.equal(a.lastMessageTimestamp,0); assert.ok(a.createdAt);
  await L.adjustXp(guild,'a',-1000,cfg); a=rows.find(r=>r.userId==='a'); assert.equal(a.xp,0); assert.equal(a.level,0);
  console.log('✓ adjustXp: new member gets defaults; XP never goes below 0; level follows');
  // takeDailyPlay (via exported internals through placeBet is heavy) — call through module scope
  const src=require('fs').readFileSync(root+'src/bot/cogs/modules/gambling.js','utf8');
  assert.ok(/async function takeDailyPlay/.test(src));
  const mod=require(root+'src/bot/cogs/modules/gambling');
  // reach takeDailyPlay by evaluating it with the same UserLevel
  const take=new Function('UserLevel','utcDay',src.slice(src.indexOf('async function takeDailyPlay'),src.indexOf('// Gives a play back'))+';return takeDailyPlay;')(UserLevel,()=>new Date().toISOString().slice(0,10));
  rows.push({_id:'pp',guildId:'g',userId:'p',xp:100,gambleDay:'2000-01-01',gamblesToday:9});
  let r1=await take('g','p',3); assert.deepEqual(r1,{ok:true,left:2},'new day resets to 1 play used');
  await take('g','p',3); let r3=await take('g','p',3); assert.deepEqual(r3,{ok:true,left:0}); let r4=await take('g','p',3); assert.deepEqual(r4,{ok:false});
  console.log('✓ daily plays: a new day starts at 1; the limit stops the 4th play (real Mongo operators)');
  // recordNet
  const rec=new Function('UserLevel','utcDay',src.slice(src.indexOf('async function recordNet'),src.indexOf('const netToday'))+';return recordNet;')(UserLevel,()=>'2026-09-27');
  const rn=src.slice(src.indexOf('async function recordNet'),src.indexOf('// ---------------------------------------------------------------- Lifetime stats'));
  const recordNet=new Function('UserLevel','utcDay',rn+';return recordNet;')(UserLevel,()=>'2026-09-27');
  const p=rows.find(r=>r.userId==='p'); p.gambleWinDay='2026-09-26'; p.gambleNetToday=900;
  await recordNet('g','p',200); assert.equal(p.gambleNetToday===900?rows.find(r=>r.userId==='p').gambleNetToday:rows.find(r=>r.userId==='p').gambleNetToday,200);
  await recordNet('g','p',-50); assert.equal(rows.find(r=>r.userId==='p').gambleNetToday,150); assert.equal(rows.find(r=>r.userId==='p').gambleWinDay,'2026-09-27');
  console.log('✓ win limit: yesterday’s winnings reset on a new day; today’s add up (wins and losses)');
  // /daily streaks
  const D=require(root+'src/bot/cogs/modules/daily');
  const day=(d)=>new Date(`2026-09-${d}T12:00:00Z`).getTime();
  let o=await D.claimDaily(guild,'d',day(10)); assert.equal(o.streak,1);
  o=await D.claimDaily(guild,'d',day(10)); assert.ok(o.alreadyClaimed);
  o=await D.claimDaily(guild,'d',day(11)); assert.equal(o.streak,2); o=await D.claimDaily(guild,'d',day(12)); assert.equal(o.streak,3); assert.equal(o.best,3);
  o=await D.claimDaily(guild,'d',day(14)); assert.equal(o.streak,1); assert.equal(o.best,3);
  console.log('✓ /daily: once per day, streak grows on consecutive days, resets after a gap, best streak kept');
  process.exit(0);
})().catch(e=>{console.error(e);process.exit(1);});
