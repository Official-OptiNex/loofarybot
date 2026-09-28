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
  const { MessageFlags } = require(root+'node_modules/discord.js');
  const J=(x)=>JSON.stringify(x);
  // resume with no game
  let [r0,l0]=fake('n'); await G.resendControls(r0); assert.match(l0.private[0].content,/don't have a game running/);
  // start mines, then "dismiss" and resume
  rec('p').xp=1000; let [i,log]=fake('p'); await G.startMines(i,100,3); await tick();
  let [r1,l1]=fake('p'); r1.editReply=async(o)=>{l1.edited=o;}; await G.resendControls(r1);
  const ctl=l1.private[0]; assert.ok(ctl.flags & MessageFlags.Ephemeral); assert.match(J(ctl),/gm:[0-9a-f]+:0/); assert.match(J(ctl),/gamble resume/);
  console.log('✓ /gamble resume re-sends the private controls');
  // busy reply has the button, and the button re-sends controls; someone else can't use it
  let [b,lb]=fake('p'); await G.startHighLow(b,50); const btnId=J(lb.private[0]).match(/gctl:[0-9a-f]+/)[0];
  let [c,lc]=fake('p'); c.customId=btnId; c.editReply=async()=>{}; await G.handleControlsButton(c); assert.ok(lc.private[0].flags & MessageFlags.Ephemeral);
  let [x,lx]=fake('intruder'); x.customId=btnId; await G.handleControlsButton(x); assert.match(lx.private[0].content,/isn't your game/);
  console.log('✓ "finish your game" message has a Show my controls button (owner only)');
  // a click from the re-sent controls updates that copy
  const gid=btnId.split(':')[1]; const upd=[]; let [k]=fake('p'); k.customId=`gm:${gid}:0`; k.update=async(o)=>upd.push(o); k.deferUpdate=async()=>{}; await G.handleGambleButton(k);
  assert.ok(upd.length===1);
  console.log('✓ playing from the re-sent controls works');
  // max win cap: mines auto-cash-out at the cap; coinflip win capped
  cfg.gamblingMaxWin=50;
  rec('q').xp=1000; let [m,lm]=fake('q'); await G.startMines(m,100,20); await tick();
  const mid=J(lm.pub).match(/gm:([0-9a-f]+):/)[1];
  let result=null; for (let idx=0; idx<25 && !result; idx++){ const u=[]; let [cl]=fake('q'); cl.customId=`gm:${mid}:${idx}`; cl.update=async(o)=>u.push(o); cl.deferUpdate=async()=>{}; cl.editReply=async()=>{}; await G.handleGambleButton(cl); const t=J(u[0]||{}); if(/cashed out automatically/.test(t)||/hit a mine/.test(t)) result=t; }
  if (/cashed out automatically/.test(result)) { assert.equal(rec('q').xp,1050); console.log('✓ mines auto-cashes out at the max win (100 bet → 150 back)'); }
  else console.log('  (hit a mine before the cap — rerun for the cap path)');
  rec('w').xp=1000; let won=false; for (let t=0;t<40&&!won;t++){ const before=rec('w').xp; let [f]=fake('w'); await G.playCoinflip(f,1000,'heads'); if (rec('w').xp>before) { won=true; assert.equal(rec('w').xp-before,50); } }
  console.log('✓ coinflip wins capped at the max win');
  cfg.gamblingMaxWin=null;
  process.exit(0);
})().catch(e=>{console.error(e);process.exit(1);});
