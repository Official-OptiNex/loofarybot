process.env.TOKEN='x';process.env.CLIENT_ID='x';process.env.MONGODB_URI='mongodb://x';
const root=require('path').join(__dirname,'..')+'/'; const assert=require('assert');
const crypto=require('crypto'); let forced=[]; const realRI=crypto.randomInt; crypto.randomInt=(n)=>forced.length?forced.shift()%n:realRI(n);
const { PermissionsBitField } = require(root+'node_modules/discord.js');
const L=require(root+'src/bot/cogs/modules/leveling');
const UserLevel=require(root+'src/database/models/UserLevel');
const GuildConfig=require(root+'src/database/models/GuildConfig');
const ActiveBet=require(root+'src/database/models/ActiveBet');
const Giveaway=require(root+'src/database/models/Giveaway');
const db=new Map(); const rec=(u)=>{ if(!db.has(u)) db.set(u,{userId:u,xp:0,level:0,freePlays:0,lastFreePlayGrantedAt:null}); return db.get(u); };
const cfg={guildId:'g',gamblingEnabled:true,gamblingHouseEdge:4,gamblingMinBet:10,gamblingDailyLimit:0,xpMultipliers:[],levelRoles:[],boosterPerks:{},save:async()=>{},markModified(){}};
L.getOrCreateConfig=async()=>cfg;
L.debitXp=async(g,u,a)=>{const r=rec(u);if(r.xp<a)return false;r.xp-=a;return true;};
const granted=[];
L.adjustXp=async(g,u,d)=>{const r=rec(u);r.xp=Math.max(0,r.xp+d);granted.push([u,d]);return{record:{xp:r.xp},oldLevel:0,newLevel:d>=500?3:0,roleFailures:[]};};
UserLevel.findOne=(q)=>({lean:async()=>({...rec(q.userId)})});
UserLevel.exists=async(q)=>db.has(q.userId);
const today=new Date().toISOString().slice(0,10);
UserLevel.updateOne=async(q,u,o)=>{
  if(Array.isArray(u)){ const r=rec(q.userId); const set=u[0].$set; if(set.gambleNetToday){ const day=set.gambleWinDay; const net=set.gambleNetToday.$cond[2]; r.gambleNetToday = r.gambleWinDay===day ? (r.gambleNetToday||0)+net : net; r.gambleWinDay=day; } return {modifiedCount:1}; }
  if(u.$setOnInsert){ rec(q.userId); return {}; }
  if(u.$set&&'boostPackageAt' in u.$set){ const r=rec(q.userId); const cutoff=q.$or[1].boostPackageAt.$lte; if(!r.boostPackageAt||r.boostPackageAt<=cutoff){ r.boostPackageAt=u.$set.boostPackageAt; return {modifiedCount:1}; } return {modifiedCount:0}; }
  const r=db.get(q.userId); if(r&&u.$inc&&r.gambleDay===q.gambleDay&&r.gamblesToday>0) r.gamblesToday+=u.$inc.gamblesToday; return {};
};
UserLevel.findOneAndUpdate=async(q,pipe)=>{const r=db.get(q.userId); if(!r) return null; const day=pipe[0].$set.gambleDay;
  const ok = r.gambleDay!==day || (r.gamblesToday||0) < q.$or[1].gamblesToday.$lt; if(!ok) return null;
  r.gamblesToday = r.gambleDay===day ? (r.gamblesToday||0)+1 : 1; r.gambleDay=day; return {gamblesToday:r.gamblesToday};};
const bets=new Map(); let bid=1;
ActiveBet.create=async(d)=>{const r={...d,_id:bid++,createdAt:new Date(),updatedAt:new Date()};bets.set(d.gameId,r);return r;};
ActiveBet.updateOne=async(q,u)=>{const r=bets.get(q.gameId); if(r){Object.assign(r,u.$set);}};
ActiveBet.findOneAndDelete=async(q)=>{for(const [k,r] of bets){ if(r.gameId===q.gameId){bets.delete(k);return r;} } return null;};
ActiveBet.deleteOne=async(q)=>{bets.delete(q.gameId);};
ActiveBet.find=()=>({lean:async()=>[]});
let dropDay=null; GuildConfig.updateOne=async(q,u)=>{ if(dropDay!==u.$set.boosterDropDay){dropDay=u.$set.boosterDropDay;return{modifiedCount:1};} return{modifiedCount:0}; };
GuildConfig.findOne=()=>({lean:async()=>({boosterPerks:cfg.boosterPerks}),catch(){return this;}});
const realST=global.setTimeout; global.setTimeout=(fn,ms)=>ms>=60000?{ref(){},unref(){}}:realST(fn,ms);
const G=require(root+'src/bot/cogs/modules/gambling');
const B=require(root+'src/bot/cogs/modules/boosterPerks');
const GW=require(root+'src/bot/cogs/modules/giveaways');
const sent=[]; const channel={isTextBased:()=>true,send:async(p)=>{sent.push(p);return{}}};
const guild={id:'g',name:'Loof',channels:{cache:new Map([['c',channel],['ann',channel]])},members:{cache:new Map(),fetch:async()=>null}};
const client={guilds:{cache:new Map([['g',guild]])}};
function fake(user,{booster=false}={}){
  const log={pub:null,private:[]};
  const i={guildId:'g',guild,channelId:'c',client,user:{id:user,toString:()=>`<@${user}>`},member:{premiumSince:booster?new Date():null},deferred:false,replied:false,
    memberPermissions:new PermissionsBitField(0n),
    deferReply:async()=>{i.deferred=true;}, reply:async(o)=>{i.replied=true;log.private.push(o);},
    editReply:async(o)=>{log.pub=o;}, deleteReply:async()=>{}, followUp:async(o)=>{log.private.push(o);return{id:'e'};},
    fetchReply:async()=>({url:'u',edit:async()=>{}}), webhook:{editMessage:async()=>{}}};
  return [i,log];
}
const J=(x)=>JSON.stringify(x); const tick=()=>new Promise(r=>realST(r,20));
(async()=>{
  // 1. coinflip win capped by today's remaining room
  rec('w').xp=10000; Object.assign(rec('w'),{gambleWinDay:today,gambleNetToday:900});
  forced=[0]; let [f,l]=fake('w'); await G.playCoinflip(f,500,'heads');
  assert.equal(rec('w').xp,10000-500+600); assert.match(J(l.pub),/Capped by today's win limit/); assert.match(J(l.pub),/Daily win limit reached/);
  assert.equal(rec('w').gambleNetToday,1000);
  [f,l]=fake('w'); await G.playCoinflip(f,10,'heads'); assert.match(l.private[0].content,/that's this server's daily limit/); assert.equal(rec('w').xp,10100);
  console.log('✓ a 500 bet at +900 today pays only +100 more; the next bet is refused until midnight UTC');
  // 2. losses make room again (net, not gross)
  Object.assign(rec('w'),{gambleNetToday:1000}); rec('w').gambleNetToday=-500;
  forced=[0]; [f,l]=fake('w'); await G.playCoinflip(f,1000,'heads'); assert.equal(rec('w').gambleNetToday,420); assert.match(J(l.pub),/Won today: \*\*\+420\*\* \/ 1,000 XP/);
  console.log('✓ counts net winnings: after losing 500, a 1000 coinflip win (+920) is paid in full');
  // 3. the "500 XP → level 13" scenario: all-in coinflips, forced wins
  rec('z').xp=500; for(let n=0;n<6;n++){ forced=[0]; const [g1]=fake('z'); await G.playCoinflip(g1,rec('z').xp,'heads'); }
  assert.equal(rec('z').xp,1500); console.log('✓ six all-in wins in a row from 500 XP now stop at 1,500 XP (was ~27,000)');
  // 4. mines auto-cashes out at the daily cap
  rec('m').xp=5000; Object.assign(rec('m'),{gambleWinDay:today,gambleNetToday:950});
  let [mi,ml]=fake('m'); forced=[0,1,2]; await G.startMines(mi,1000,3); await tick();
  const mid=J(ml.pub).match(/gm:([0-9a-f]+):/)[1]; const u=[]; let [cl]=fake('m'); cl.customId=`gm:${mid}:10`; cl.update=async(o)=>u.push(o); cl.deferUpdate=async()=>{}; cl.editReply=async()=>{};
  await G.handleGambleButton(cl); assert.match(J(u[0]),/Reached today's win limit/); assert.equal(rec('m').xp,5000-1000+1050); assert.equal(rec('m').gambleNetToday,1000);
  console.log('✓ mines cashes out automatically when a gem would pass today\'s limit (+50 left → 1,050 back)');
  // 5. cap 0 = off
  cfg.gamblingDailyWinCap=0; rec('o').xp=100000; Object.assign(rec('o'),{gambleWinDay:today,gambleNetToday:50000}); forced=[0]; [f,l]=fake('o'); await G.playCoinflip(f,1000,'heads'); assert.equal(rec('o').xp,100000+920); delete cfg.gamblingDailyWinCap;
  console.log('✓ daily_win_cap 0 turns it off');
  // 6. boosters get extra daily plays
  cfg.gamblingDailyLimit=3; rec('b').xp=1000; rec('n').xp=1000;
  [f,l]=fake('b',{booster:true}); await G.playCoinflip(f,10,'heads'); assert.match(J(l.pub),/\*\*7\*\* plays left today/);
  for(let n=0;n<4;n++){[f,l]=fake('n'); await G.playCoinflip(f,10,'heads');} assert.match(l.private[0].content,/used all \*\*3\*\* gambles.*boosters get \*\*\+5\*\*/s);
  cfg.boosterPerks={enabled:false}; rec('b').gamblesToday=3; [f,l]=fake('b',{booster:true}); await G.playCoinflip(f,10,'heads'); assert.match(l.private[0]?.content||'',/used all \*\*3\*\*/); cfg.boosterPerks={};
  cfg.gamblingDailyLimit=0;
  console.log('✓ boosters get +5 gambles a day (and non-boosters are told about it); off when perks are off');
  // 7. giveaway tickets
  const role=(ids)=>({cache:{has:(id)=>ids.includes(id)}});
  const g={type:'timed',bonusEntries:[{roleId:'vip',extra:3}]};
  assert.equal(GW.weightFor({roles:role([]),premiumSince:new Date()},g,2),3);
  assert.equal(GW.weightFor({roles:role(['vip']),premiumSince:new Date()},g,2),4);
  assert.equal(GW.weightFor({roles:role([]),premiumSince:null},g,2),1);
  assert.equal(await GW.boosterExtraFor('g',{type:'timed'}),2); assert.equal(await GW.boosterExtraFor('g',{type:'timed',boosterEntries:0}),0); assert.equal(await GW.boosterExtraFor('g',{type:'drop'}),0);
  assert.match(GW.describeBonus({boosterEntries:2,bonusEntries:[]}),/Server boosters \+2/);
  const mem=(id,boost,bot=false)=>({id,premiumSince:boost?new Date():null,user:{bot},roles:role([]),toString:()=>`<@${id}>`});
  guild.members.fetch=async(q)=>{ if(q&&q.user) return new Map(q.user.map(id=>[id,mem(id,id.startsWith('b'))])); return null; };
  const w=await GW.entryWeights(guild,{type:'timed',bonusEntries:[]},['b1','x1']); assert.equal(w.get('b1'),3); assert.equal(w.get('x1'),1);
  console.log('✓ giveaways: boosters get +2 tickets (best bonus counts; not in drops; old giveaways use the server setting)');
  // 8. daily booster drop
  guild.members.fetch=async()=>null; guild.members.cache=new Map([['b1',mem('b1',true)],['b2',mem('b2',true)],['x',mem('x',false)],['bot',mem('bot',true,true)]]);
  guild.members.cache.filter=function(fn){return new Map([...this].filter(([k,v])=>fn(v)));};
  cfg.boosterPerks={channelId:'ann'}; granted.length=0; sent.length=0;
  const r1=await B.runDailyDrop(guild); assert.equal(r1.count,2); assert.deepEqual(granted,[['b1',100],['b2',100]]); assert.match(J(sent[0]),/Daily booster drop/);
  const r2=await B.runDailyDrop(guild); assert.ok(r2.skipped); assert.equal(granted.length,2);
  console.log('✓ daily drop: each booster (not bots/non-boosters) gets 100 XP once a day, announced');
  // 9. thank-you package on boost, once per 30 days; partial old member ignored
  granted.length=0; sent.length=0; const listeners={}; B.registerBoostListener({on:(e,fn)=>listeners[e]=fn});
  const dm=[]; const nm={id:'p1',guild,premiumSince:new Date(),user:{bot:false},toString:()=>'<@p1>',send:async(m)=>dm.push(m)};
  await listeners.guildMemberUpdate({partial:true,premiumSince:null},nm); assert.equal(granted.length,0);
  await listeners.guildMemberUpdate({partial:false,premiumSince:null},nm); assert.deepEqual(granted,[['p1',500]]); assert.match(J(sent[0]),/Thanks for boosting/); assert.match(dm[0].content,/500 XP/);
  await listeners.guildMemberUpdate({partial:false,premiumSince:null},nm); assert.equal(granted.length,1);
  console.log('✓ boosting gives a 500 XP thank-you package + DM, once per 30 days (reboosting can\'t farm it)');
  process.exit(0);
})().catch(e=>{console.error(e);process.exit(1);});
