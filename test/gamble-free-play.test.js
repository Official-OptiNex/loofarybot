process.env.TOKEN='x';process.env.CLIENT_ID='x';process.env.MONGODB_URI='mongodb://x';
const root=require('path').join(__dirname,'..')+'/';
const assert=require('assert');
const L=require(root+'src/bot/cogs/modules/leveling');
const UserLevel=require(root+'src/database/models/UserLevel');
const ActiveBet=require(root+'src/database/models/ActiveBet');
// in-memory player records
const db=new Map(); const rec=(u)=>{ if(!db.has(u)) db.set(u,{userId:u,xp:0,level:0,freePlays:0,lastFreePlayGrantedAt:null}); return db.get(u); };
const cfg={gamblingEnabled:true,gamblingHouseEdge:4,gamblingMinBet:10,gamblingDailyLimit:0,xpMultipliers:[],levelRoles:[]};
L.getOrCreateConfig=async()=>cfg;
L.debitXp=async(g,u,a)=>{const r=rec(u);if(r.xp<a)return false;r.xp-=a;return true;};
L.adjustXp=async(g,u,d)=>{const r=rec(u);r.xp=Math.max(0,r.xp+d);return{record:{xp:r.xp},oldLevel:0,newLevel:0,roleFailures:[]};};
UserLevel.findOne=(q)=>({lean:async()=>({...rec(q.userId)})});
UserLevel.updateOne=async(q,u)=>{
  const r=rec(q.userId);
  if (q.freePlays && q.freePlays.$gt!==undefined && !(r.freePlays>0)) return {modifiedCount:0};
  if (q.$and){ const okFp=!(r.freePlays>=1); const cutoff=q.$and[1].$or[1].lastFreePlayGrantedAt.$lte; const okCd=!r.lastFreePlayGrantedAt||r.lastFreePlayGrantedAt<=cutoff; if(!(okFp&&okCd)) return {modifiedCount:0}; }
  if (u.$inc) for (const k in u.$inc) r[k]+=u.$inc[k];
  if (u.$set) Object.assign(r,u.$set);
  return {modifiedCount:1};
};
const bets=new Map();
ActiveBet.create=async(d)=>{bets.set(d.gameId,{...d});return d;}; ActiveBet.deleteOne=async(q)=>{bets.delete(q.gameId);}; ActiveBet.updateOne=async(q,u)=>{Object.assign(bets.get(q.gameId)||{},u.$set);};
ActiveBet.findOneAndDelete=async(q)=>{const r=bets.get(q.gameId)||null; if(r) bets.delete(q.gameId); return r;}; ActiveBet.updateOne=async()=>{};
const G=require(root+'src/bot/cogs/modules/gambling');
function fake(user,extra={}){const out=[];return[{guildId:'g',guild:{id:'g'},channelId:'c',user:{id:user,toString:()=>`<@${user}>`},reply:async o=>out.push(o),deferReply:async()=>{},update:async o=>out.push(o),deferUpdate:async()=>{},fetchReply:async()=>({edit:async o=>out.push(o)}),...extra},out];}
const flip=async(u,bet)=>{const [i,o]=fake(u); await G.playCoinflip(i,bet,'heads'); return o[0].content || o[0].embeds[0].data.description;};
(async()=>{
  // 1. go broke → free play granted
  rec('p').xp=100;
  let txt; do { rec('p').xp=100; rec('p').freePlays=0; rec('p').lastFreePlayGrantedAt=null; txt=await flip('p',100); } while (!/You lost/.test(txt));
  assert.equal(rec('p').xp,0); assert.equal(rec('p').freePlays,1); assert.match(txt,/here's a free play/);
  console.log('✓ going broke grants a free play:\n   ', txt.split('\n').slice(-2).join(' | '));
  // 2. next gamble uses it (no XP needed)
  txt=await flip('p',50);
  assert.equal(rec('p').freePlays,0); assert.match(txt,/Free play!/);
  const won=/You won/.test(txt);
  if (won) { assert.equal(rec('p').xp,576); console.log('✓ free play won → +576 XP'); }
  else { assert.equal(rec('p').xp,0); assert.match(txt,/lost nothing/); assert.match(txt,/next free play unlocks <t:\d+:R>/); console.log('✓ free play lost → nothing lost, cooldown shown'); }
  // 3. broke, no token, on cooldown → refused with unlock time
  rec('p').xp=0; rec('p').freePlays=0;
  txt=await flip('p',50); assert.match(txt,/don't have/); assert.match(txt,/unlocks <t:/); console.log('✓ on cooldown: bet refused with unlock time');
  // 4. cooldown passed → failing bet grants one (covers players who were broke before this feature)
  rec('p').lastFreePlayGrantedAt=new Date(Date.now()-25*3600e3);
  txt=await flip('p',50); assert.match(txt,/here's a free play/); assert.equal(rec('p').freePlays,1); console.log('✓ after cooldown a broke player gets a new free play');
  // 5. mines on a free play, then restart → free play given back, no XP
  const [mi,mo]=fake('p'); await G.startMines(mi,100,3);
  assert.equal(rec('p').freePlays,0); assert.equal(rec('p').xp,0);
  const c0=mo[0].components[0]; const header=c0.content ?? c0.data.content; assert.match(header,/Free play!/); assert.match(header,/Bet:\*\* 300 XP/);
  const bet=[...bets.values()][0]; assert.equal(bet.paidAmount,0); assert.equal(bet.freePlay,true);
  await G.settleAllForShutdown(); await new Promise(r=>setTimeout(r,10));
  assert.equal(rec('p').freePlays,1); assert.equal(rec('p').xp,0); assert.equal(bets.size,0);
  console.log('✓ restart during a free play gives the free play back (no XP), bet record cleared');
  // 6. orphan free play refund after crash
  ActiveBet.find=()=>({lean:async()=>[{_id:1,gameId:'x',guildId:'g',userId:'q',kind:'mines',amount:300,paidAmount:0,freePlay:true,channelId:'c'}]});
  ActiveBet.findOneAndDelete=async()=>({});
  const sent=[]; const client={guilds:{cache:new Map([['g',{id:'g',channels:{cache:new Map([['c',{send:async p=>sent.push(p)}]])}}]])}};
  await G.refundOrphanedBets(client);
  assert.equal(rec('q').freePlays,1); assert.equal(rec('q').xp,0); console.log('✓ crash refund restores free play:', sent[0].content);
  // 7. normal player with XP never uses the token
  rec('r').xp=1000; rec('r').freePlays=1; await flip('r',100); assert.equal(rec('r').freePlays,1); console.log('✓ players who can afford the bet keep their free play');
  // 8. blackjack double on free play costs own XP
  rec('d').xp=300; rec('d').freePlays=1; rec('d').xp=0;
  process.exit(0);
})().catch(e=>{console.error(e);process.exit(1)});
