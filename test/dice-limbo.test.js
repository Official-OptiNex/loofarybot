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
const C=require(root+'src/bot/commands/gamble');
const opts=(o)=>({getInteger:(k)=>o[k]??null,getNumber:(k)=>o[k]??null,getString:(k)=>o[k]??null,getSubcommand:()=>o.sub,getFocused:()=>o.focused??''});
(async()=>{
  cfg.gamblingDailyWinCap=0; cfg.gamblingDailyLimit=0;
  // RTP simulation (real RNG)
  const sim=async(label,fn,n)=>{ rec('s').xp=1e12; let spent=0, back=0; for(let k=0;k<n;k++){ const before=rec('s').xp; const [f]=fake('s'); await fn(f); const after=rec('s').xp; spent+=100; back+=after-before+100; } const rtp=back/spent; console.log(`  ${label} RTP ${rtp.toFixed(3)}`); return rtp; };
  for (const [t,d] of [[50,'under'],[10,'under'],[90,'over']]) { const r=await sim(`dice ${d} ${t}`,(f)=>G.playDice(f,100,t,d),20000); assert.ok(Math.abs(r-0.96)<0.06,`dice rtp ${r}`); }
  for (const t of [2,10]) { const r=await sim(`limbo ${t}x`,(f)=>G.playLimbo(f,100,t),t===10?60000:20000); assert.ok(Math.abs(r-0.96)<(t===10?0.1:0.05),`limbo rtp ${r}`); }
  console.log('✓ dice and limbo return ~96% at every target (4% edge)');
  // deterministic outcomes
  rec('d').xp=1000; forced=[4999]; let [f,l]=fake('d'); await G.playDice(f,100,50,'under'); assert.equal(rec('d').xp,1092); assert.match(J(l.pub),/rolled 49\.99/); assert.match(J(l.pub),/⚪/);
  forced=[5000]; [f,l]=fake('d'); await G.playDice(f,100,50,'under'); assert.equal(rec('d').xp,992); assert.match(J(l.pub),/You lost/);
  forced=[9000]; [f,l]=fake('d'); await G.playDice(f,100,90,'over'); assert.equal(rec('d').xp,992-100+960); 
  console.log('✓ dice: 49.99 wins under 50 (1.92x), 50.00 loses; 90.00 wins over 90 (9.60x)');
  [f,l]=fake('d'); await G.playDice(f,100,97,'under'); assert.match(l.private[0].content,/pick a target from \*\*1\*\* to \*\*95\*\*/);
  [f,l]=fake('d'); await G.playDice(f,100,2,'over'); assert.match(l.private[0].content,/For \*\*over\*\*/);
  console.log('✓ dice refuses targets outside a 1–95% chance (nothing is bet)');
  rec('m').xp=1000; forced=[48000000-1]; [f,l]=fake('m'); await G.playLimbo(f,100,2); assert.equal(rec('m').xp,1100); assert.match(J(l.pub),/Flew to \*\*2\.00x\*\*/);
  forced=[48000001]; [f,l]=fake('m'); await G.playLimbo(f,100,2); assert.equal(rec('m').xp,1000); assert.match(J(l.pub),/Stopped at \*\*1\.99x\*\*/);
  forced=[0]; [f,l]=fake('m'); await G.playLimbo(f,10,1000); assert.equal(rec('m').xp,1000-10+10000); assert.match(J(l.pub),/Limbo — 96,000,000x/);
  [f,l]=fake('m'); await G.playLimbo(f,100,1.001); assert.match(l.private[0].content,/1\.01x/);
  console.log('✓ limbo: result ≥ target pays target × bet; tiny U gives a huge result; bad targets refused');
  // caps apply
  cfg.gamblingDailyWinCap=1000; rec('c').xp=5000; forced=[0]; [f,l]=fake('c'); await G.playLimbo(f,100,1000); assert.equal(rec('c').xp,6000); assert.match(J(l.pub),/Capped by today's win limit/);
  cfg.gamblingDailyLimit=2; rec('p').xp=1000; for(let k=0;k<3;k++){[f,l]=fake('p'); await G.playDice(f,10,50,'under');} assert.match(l.private[0].content,/used all \*\*2\*\*/);
  cfg.gamblingDailyWinCap=0; cfg.gamblingDailyLimit=0;
  console.log('✓ daily win limit and daily plays apply to dice and limbo');
  // free play
  const upd=UserLevel.updateOne; UserLevel.updateOne=async(q,u,o)=>{ if(u&&u.$inc&&'freePlays' in u.$inc){ const r=rec(q.userId); if(r.freePlays>0){r.freePlays--; return {modifiedCount:1};} return {modifiedCount:0}; } return upd(q,u,o); };
  rec('fp').xp=0; rec('fp').freePlays=1; forced=[0]; [f,l]=fake('fp'); await G.playDice(f,500,50,'under'); assert.equal(rec('fp').xp,576); assert.match(J(l.pub),/Free play/);
  console.log('✓ a free play works in dice');
  // autocomplete
  let resp; const ac=(o)=>({guildId:'g',options:opts(o),respond:async(r)=>{resp=r;}});
  await C.autocomplete(ac({sub:'dice',focused:'33'})); assert.match(resp[0].name,/under 33 — 33% chance · pays 2\.91x/); assert.ok(resp.every(r=>r.name.length<=100));
  await C.autocomplete(ac({sub:'dice',direction:'over',focused:'99.5'})); assert.match(resp[0].name,/over 50/); assert.ok(!resp.some(r=>r.value===99.5)); assert.match(resp.find(r=>r.value===95).name,/5% chance · pays 19.20x/);
  await C.autocomplete(ac({sub:'limbo',focused:'7.5'})); assert.equal(resp[0].name,'7.5x — 12.80% chance');
  await C.autocomplete(ac({sub:'mines',focused:''})); assert.match(resp[0].name,/1 mine/);
  console.log('✓ autocomplete previews dice odds/payout (per direction), limbo chance; mines unchanged');
  process.exit(0);
})().catch(e=>{console.error(e);process.exit(1);});
