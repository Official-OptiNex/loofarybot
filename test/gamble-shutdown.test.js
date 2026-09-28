process.env.TOKEN='x';process.env.CLIENT_ID='x';process.env.MONGODB_URI='mongodb://x';
const root=require('path').join(__dirname,'..')+'/';
const assert=require('assert');
const L=require(root+'src/bot/cogs/modules/leveling');
const UserLevel=require(root+'src/database/models/UserLevel');
const ActiveBet=require(root+'src/database/models/ActiveBet');
const xp=new Map(); const bets=new Map();
const cfg={gamblingEnabled:true,gamblingHouseEdge:4,gamblingMinBet:10,gamblingDailyLimit:0,xpMultipliers:[],levelRoles:[]};
L.getOrCreateConfig=async()=>cfg;
L.debitXp=async(g,u,a)=>{const c=xp.get(u)||0;if(c<a)return false;xp.set(u,c-a);return true;};
L.adjustXp=async(g,u,d)=>{const o=xp.get(u)||0;xp.set(u,o+d);return{record:{xp:xp.get(u)},oldLevel:0,newLevel:0,roleFailures:[]};};
UserLevel.findOne=(q)=>({lean:async()=>({xp:xp.get(q.userId)||0,level:0})});
const delay=()=>new Promise(r=>setTimeout(r,5));
ActiveBet.create=async(d)=>{await delay();bets.set(d.gameId,d);return d;};
ActiveBet.deleteOne=async(q)=>{bets.delete(q.gameId);};
ActiveBet.updateOne=async(q,u)=>{const b=bets.get(q.gameId);if(b)b.amount=u.$set.amount;};
ActiveBet.findOneAndDelete=async(q)=>{const r=bets.get(q.gameId)||null; if(r) bets.delete(q.gameId); return r;}; ActiveBet.updateOne=async()=>{};
const G=require(root+'src/bot/cogs/modules/gambling');
function fake(user,extra={}){const out=[];return[{guildId:'g',guild:{id:'g'},channelId:'c',user:{id:user,toString:()=>`<@${user}>`},reply:async o=>out.push(o),deferReply:async()=>{},update:async o=>out.push(o),deferUpdate:async()=>{},fetchReply:async()=>({edit:async o=>out.push(o)}),...extra},out];}
(async()=>{
  for (const u of ['m','h','b']) xp.set(u,1000);
  const [mi,mo]=fake('m'); await G.startMines(mi,100,1);          // mines, no reveal yet → refund
  const [hi,ho]=fake('h'); await G.startHighLow(hi,100);          // high-low, no correct call → refund
  const [bi,bo]=fake('b'); await G.startBlackjack(bi,100);        // blackjack (maybe natural → already settled)
  await delay(); await delay();
  const bjSettled = !JSON.stringify(bo[0]).includes('Watching live');
  console.log('bet records before shutdown:', bets.size, bjSettled ? '(blackjack natural already settled)' : '');
  const n=await G.settleAllForShutdown();
  await delay();
  console.log('settled', n, 'games · xp:', Object.fromEntries(xp), '· bet records left:', bets.size);
  assert.equal(xp.get('m'),1000); assert.equal(xp.get('h'),1000); if(!bjSettled) assert.equal(xp.get('b'),1000);
  assert.equal(bets.size,0);
  // natural-blackjack race: create is slow, delete must not run first
  xp.set('r',1000); let naturals=0;
  for (let i=0;i<60;i++){ const [ri,ro]=fake('r'); await G.startBlackjack(ri,10); if(!JSON.stringify(ro[0]).includes('Watching live')) naturals++; else await G.settleAllForShutdown(); }
  await delay(); await delay();
  console.log('naturals', naturals, '· stray bet records:', bets.size); assert.equal(bets.size,0);
  console.log('✓ shutdown settles every open game and no stray bet records remain');
  process.exit(0);
})().catch(e=>{console.error(e);process.exit(1)});
