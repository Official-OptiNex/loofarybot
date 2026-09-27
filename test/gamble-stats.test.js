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
require('mingo/init/system'); const { Aggregator } = require('mingo');
const GambleStats=require(root+'src/database/models/GambleStats');
const statRows=[];
GambleStats.updateOne=async(q,pipe,o)=>{ let r=statRows.find(x=>x.guildId===q.guildId&&x.userId===q.userId); const i=r?statRows.indexOf(r):-1; const [out]=new Aggregator(pipe).run([r?JSON.parse(JSON.stringify(r)):{...q}]); if(i>=0) statRows[i]=out; else statRows.push(out); return {modifiedCount:1}; };
GambleStats.findOne=(q)=>({lean:async()=>JSON.parse(JSON.stringify(statRows.find(x=>x.guildId===q.guildId&&x.userId===q.userId)||null))});
GambleStats.aggregate=async(p)=>new Aggregator(p).run(JSON.parse(JSON.stringify(statRows)));
GambleStats.find=(q)=>{ let arr=statRows.filter(x=>x.guildId===q.guildId&&Object.entries(q).every(([k,v])=>k==='guildId'||(v.$gt!==undefined?x[k]>v.$gt:true))); const o={sort(s){const [[k,d]]=Object.entries(s); arr=[...arr].sort((a,b)=>(a[k]-b[k])*d); return o;},limit(n){arr=arr.slice(0,n);return o;},lean:async()=>arr}; return o; };
const C=require(root+'src/bot/commands/gamble');
const st=(u)=>statRows.find(x=>x.userId===u);
(async()=>{
  cfg.gamblingDailyWinCap=0; cfg.gamblingDailyLimit=0;
  rec('p').xp=100000;
  // coinflip: win, win, win, loss
  for (const r of [0,0,0,1]) { forced=[r]; const [f]=fake('p'); await G.playCoinflip(f,100,'heads'); }
  let s=st('p'); assert.equal(s.games,4); assert.equal(s.wins,3); assert.equal(s.losses,1); assert.equal(s.wagered,400); assert.equal(s.net,3*92-100);
  assert.equal(s.bestStreak,3); assert.equal(s.streak,-1); assert.equal(s.worstStreak,1); assert.equal(s.biggestWin,92); assert.equal(s.biggestWinGame,'coinflip'); assert.equal(s.byGame.coinflip.games,4); assert.equal(s.byGame.coinflip.net,176);
  // limbo big win becomes the biggest win
  forced=[0]; let [f]=fake('p'); await G.playLimbo(f,10,50); s=st('p'); assert.equal(s.biggestWin,490); assert.equal(s.biggestWinGame,'limbo'); assert.equal(s.biggestWinMultiplier,50); assert.equal(s.streak,1);
  // losses in a row
  for (let k=0;k<3;k++){ forced=[9999]; [f]=fake('p'); await G.playDice(f,100,50,'under'); } s=st('p'); assert.equal(s.streak,-3); assert.equal(s.worstStreak,3); assert.equal(s.byGame.dice.games,3); assert.equal(s.byGame.dice.wins,0);
  console.log('✓ coinflip/limbo/dice results: games, W/L, wagered, net, biggest win (game + multiplier), streaks, per-game');
  // mines loss via the real board, and a refunded game doesn't count
  forced=[0,1,2]; let [m,ml]=fake('p'); await G.startMines(m,200,3); await tick();
  const mid=J(ml.pub).match(/gm:([0-9a-f]+):/)[1]; let [cl]=fake('p'); cl.customId=`gm:${mid}:0`; cl.update=async()=>{}; cl.deferUpdate=async()=>{}; cl.editReply=async()=>{}; await G.handleGambleButton(cl);
  s=st('p'); assert.equal(s.byGame.mines.games,1); assert.equal(s.byGame.mines.net,-200);
  const gamesBefore=s.games; [m,ml]=fake('p'); await G.startMines(m,100,3); await tick(); await G.settleAllForShutdown(); assert.equal(st('p').games,gamesBefore);
  console.log('✓ interactive games count when they finish; games refunded by a restart are not counted');
  // free play counts as a free play, not wagered
  rec('fp').xp=0; rec('fp').freePlays=1; const upd=UserLevel.updateOne; UserLevel.updateOne=async(q,u,o)=>{ if(u&&u.$inc&&'freePlays' in u.$inc){ const r=rec(q.userId); if(r.freePlays>0){r.freePlays--; return {modifiedCount:1};} return {modifiedCount:0}; } return upd(q,u,o); };
  forced=[1]; [f]=fake('fp'); await G.playCoinflip(f,500,'heads'); s=st('fp'); assert.equal(s.freePlays,1); assert.equal(s.wagered,0); assert.equal(s.losses,1); assert.equal(s.net,0);
  UserLevel.updateOne=upd;
  console.log('✓ a lost free play counts as a loss and a free play, with nothing wagered');
  // /gamble stats
  const opts=(o)=>({getSubcommand:()=>'stats',getUser:(k)=>o[k]??null,getBoolean:(k)=>o[k]??null});
  const run=async(user,o={})=>{ const [i,log]=fake(user); i.user.username=user; i.user.displayAvatarURL=()=>null; i.options=opts(o); await C.execute(i); return log.private[0].embeds[0].data; };
  let e=await run('p'); const t=J(e);
  assert.match(t,/p's gambling stats/); assert.match(t,/Win rate","value":"\d+%/); assert.match(t,/Biggest win","value":"\*\*\+490 XP\*\* · 🚀 Limbo 50\.00x/); assert.match(t,/🥶 4 losses in a row\\nBest: 3W · Worst: 4L/); assert.match(t,/💣 Mines — 1 game · 0% won · −200 XP/);
  e=await run('nobody'); assert.match(e.description,/haven't played any games yet/);
  e=await run('p',{user:{id:'fp',username:'fp',displayAvatarURL:()=>null}}); assert.match(J(e),/fp's gambling stats/);
  e=await run('p',{server:true}); assert.match(e.description,/games by \*\*2\*\* players/); assert.match(J(e.fields),/🥇 <@p>/);
  console.log('✓ /gamble stats (you, another member, nobody yet) and server:true (totals + top players)');
  process.exit(0);
})().catch(e=>{console.error(e);process.exit(1);});
