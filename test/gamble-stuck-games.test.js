process.env.TOKEN='x';process.env.CLIENT_ID='x';process.env.MONGODB_URI='mongodb://x';
const root=require('path').join(__dirname,'..')+'/'; const assert=require('assert');
const { PermissionsBitField } = require(root+'node_modules/discord.js');
const L=require(root+'src/bot/cogs/modules/leveling');
const UserLevel=require(root+'src/database/models/UserLevel');
const ActiveBet=require(root+'src/database/models/ActiveBet');
const db=new Map(); const rec=(u)=>{ if(!db.has(u)) db.set(u,{userId:u,xp:0,level:0,freePlays:0,lastFreePlayGrantedAt:null}); return db.get(u); };
const cfg={gamblingEnabled:true,gamblingHouseEdge:4,gamblingMinBet:10,gamblingDailyLimit:0,xpMultipliers:[],levelRoles:[]};
L.getOrCreateConfig=async()=>cfg;
L.debitXp=async(g,u,a)=>{const r=rec(u);if(r.xp<a)return false;r.xp-=a;return true;};
L.adjustXp=async(g,u,d)=>{const r=rec(u);r.xp=Math.max(0,r.xp+d);return{record:{xp:r.xp},oldLevel:0,newLevel:0,roleFailures:[]};};
UserLevel.findOne=(q)=>({lean:async()=>({...rec(q.userId)})});
UserLevel.updateOne=async()=>({modifiedCount:0});
// ActiveBet store
const bets=new Map(); let bid=1;
ActiveBet.create=async(d)=>{const r={...d,_id:bid++,createdAt:new Date(),updatedAt:new Date()};bets.set(d.gameId,r);return r;};
ActiveBet.updateOne=async(q,u)=>{const r=bets.get(q.gameId); if(r){Object.assign(r,u.$set);r.updatedAt=new Date();}};
ActiveBet.findOneAndDelete=async(q)=>{for(const [k,r] of bets){ if((q.gameId&&r.gameId===q.gameId)||(q._id!==undefined&&r._id===q._id)){bets.delete(k);return r;} } return null;};
ActiveBet.deleteOne=async(q)=>{bets.delete(q.gameId);};
ActiveBet.find=(q={})=>({lean:async()=>[...bets.values()].filter(r=>(!q.guildId||r.guildId===q.guildId)&&(!q.userId||r.userId===q.userId)&&(!q.updatedAt||r.updatedAt<q.updatedAt.$lt)).map(r=>({...r}))});
const realST=global.setTimeout; global.setTimeout=(fn,ms)=>ms>=60000?{ref(){},unref(){}}:realST(fn,ms);
const G=require(root+'src/bot/cogs/modules/gambling');
const sent=[]; const channel={send:async(p)=>sent.push(p)};
const guild={id:'g',channels:{cache:new Map([['c',channel]])}};
const client={guilds:{cache:new Map([['g',guild]])}};
function fake(user,{failReply=false,admin=false}={}){
  const log={calls:[],pub:null,private:[],deleted:false};
  const i={guildId:'g',guild,channelId:'c',client,user:{id:user,toString:()=>`<@${user}>`},deferred:false,replied:false,
    memberPermissions:new PermissionsBitField(admin?PermissionsBitField.All:0n),
    deferReply:async(o)=>{log.calls.push('defer');i.deferred=true;},
    reply:async(o)=>{log.calls.push('reply');i.replied=true;log.private.push(o);},
    editReply:async(o)=>{log.calls.push('edit'); if(failReply) throw new Error('Unknown interaction'); log.pub=o;},
    deleteReply:async()=>{log.deleted=true;},
    followUp:async(o)=>{log.calls.push('followUp');log.private.push(o);return{id:'e'};},
    fetchReply:async()=>({url:'https://discord.com/channels/g/c/1',edit:async()=>{}}),
    webhook:{editMessage:async()=>{}}};
  return [i,log];
}
const tick=()=>new Promise(r=>realST(r,20));
(async()=>{
  // 1) command acknowledges before any database work
  rec('a').xp=500; let [i,log]=fake('a'); await G.startMines(i,100,3); await tick();
  assert.equal(log.calls[0],'defer'); assert.ok(log.pub,'board posted via editReply'); assert.equal(rec('a').xp,400);
  console.log('✓ game commands answer Discord instantly ("thinking…"), then post the board');
  // 2) busy reply links the game and mentions sync
  let [i2,log2]=fake('a'); await G.startHighLow(i2,50);
  assert.match(log2.private[0].content,/Finish \[your mines game\]\(https:.*\) first — it ends by itself <t:\d+:R>.*\/gamble sync/);
  console.log('✓ "finish your game" message links the game, says when it ends, and points to /gamble sync');
  // 3) lost timer: game idle past timeout gets ended when you try again
  const gameA=[...bets.values()].find(b=>b.userId==='a');
  const live=require(root+'src/bot/cogs/modules/gambling'); // same module
  // age the in-memory game
  const games=[]; // reach in via sync of a different guild? use currentGame semantics by aging lastActive
  // find game object through a click-less path: expire via sweeper after aging
  ;(await (async()=>{ const m=require('module'); })());
  // Age it by manipulating Date.now
  const realNow=Date.now; Date.now=()=>realNow()+4*60*1000;
  let [i3,log3]=fake('a'); await G.startHighLow(i3,50); await tick();
  Date.now=realNow;
  assert.equal(log3.calls[0],'defer','new game allowed'); assert.equal(rec('a').xp,500-50,'mines stake refunded (100) then highlow bet taken (50)');
  console.log('✓ a game whose idle timer was lost is ended (and refunded) the moment you start a new one');
  // 4) board can't be posted → refunded immediately and unlocked
  rec('b').xp=300; let [i4,log4]=fake('b',{failReply:true}); await G.startMines(i4,100,3); await tick();
  assert.equal(rec('b').xp,300,'refunded right away'); assert.match(log4.private.at(-1).content,/couldn't be shown.*refunded/);
  let [i5,log5]=fake('b'); await G.startMines(i5,100,3); await tick(); assert.equal(log5.calls[0],'defer','can play again');
  console.log('✓ if Discord rejects the board, the bet is refunded immediately and the player can play again');
  // 5) failed bet after deferring → placeholder removed, private error
  rec('c').xp=5; let [i6,log6]=fake('c'); await G.startBlackjack(i6,100); await tick();
  assert.ok(log6.deleted); assert.equal(log6.private.at(-1).ephemeral,true); assert.match(log6.private.at(-1).content,/don't have/);
  console.log('✓ errors after "thinking…" replace it with a private message (nothing public left behind)');
  // 6) /gamble sync for yourself: live game ended + orphaned bet refunded + lock cleared
  bets.set('ghost',{gameId:'ghost',_id:bid++,guildId:'g',userId:'b',kind:'mines',amount:200,paidAmount:200,freePlay:false,channelId:'c',updatedAt:new Date(Date.now()-5*60e3)});
  const before=rec('b').xp;
  let r=await G.syncGames(client,'g','b'); await tick();
  assert.equal(r.ended.length,1); assert.equal(r.ended[0].status,'refunded'); assert.equal(r.refunded.length,1); assert.equal(r.refunded[0].paid,200);
  assert.equal(rec('b').xp,before+100+200); assert.ok(!bets.has('ghost'));
  console.log('✓ /gamble sync: ends your game (refund/cash-out) and refunds bets from games that vanished');
  r=await G.syncGames(client,'g','b'); assert.equal(r.ended.length+r.refunded.length,0); console.log('✓ running it again finds nothing (never pays twice)');
  // 7) double-refund protection: another bot copy already refunded the bet
  rec('d').xp=1000; let [i7]=fake('d'); await G.startMines(i7,100,3); await tick();
  const rd=[...bets.values()].find(b=>b.userId==='d'); bets.delete(rd.gameId); // "other instance" claimed it
  await G.syncGames(client,'g','d'); await tick(); assert.equal(rec('d').xp,900,'no second refund');
  console.log('✓ a bet already refunded by another copy of the bot is never paid out again');
  // 8) sweeper: old orphan refunded with a channel notice, recent record left alone
  bets.set('old',{gameId:'old',_id:bid++,guildId:'g',userId:'e',kind:'highlow',amount:70,paidAmount:70,channelId:'c',updatedAt:new Date(Date.now()-11*60e3)});
  bets.set('new',{gameId:'new',_id:bid++,guildId:'g',userId:'f',kind:'highlow',amount:70,paidAmount:70,channelId:'c',updatedAt:new Date()});
  await G.sweepStuckGames(client); assert.equal(rec('e').xp,70); assert.ok(bets.has('new')); assert.match(sent.at(-1).content,/<@e> your interrupted highlow game — your \*\*70 XP\*\* bet was refunded/);
  console.log('✓ minute sweep refunds abandoned bets (with a notice) and leaves fresh ones alone');
  // 9) startup refund skips bets touched in the last 2 minutes (old bot copy may still be playing them)
  const n=await G.refundOrphanedBets(client); assert.equal(n,0); assert.ok(bets.has('new'));
  console.log('✓ startup refund skips games that may still be running on the old copy during a redeploy');
  process.exit(0);
})().catch(e=>{console.error(e);process.exit(1);});
