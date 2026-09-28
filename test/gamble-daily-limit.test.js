process.env.TOKEN='x';process.env.CLIENT_ID='x';process.env.MONGODB_URI='mongodb://x';
const root=require('path').join(__dirname,'..')+'/'; const assert=require('assert');
const { PermissionsBitField } = require(root+'node_modules/discord.js');
const L=require(root+'src/bot/cogs/modules/leveling');
const UserLevel=require(root+'src/database/models/UserLevel');
const ActiveBet=require(root+'src/database/models/ActiveBet');
const db=new Map(); const rec=(u)=>{ if(!db.has(u)) db.set(u,{userId:u,xp:0,level:0,freePlays:0,lastFreePlayGrantedAt:null}); return db.get(u); };
const cfg={gamblingEnabled:true,gamblingHouseEdge:4,gamblingMinBet:10,xpMultipliers:[],levelRoles:[]};
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

// emulate the pipeline update used by takeDailyPlay
UserLevel.findOneAndUpdate=async(q,pipe)=>{const r=db.get(q.userId); if(!r) return null; const day=pipe[0].$set.gambleDay;
  const ok = r.gambleDay!==day || (r.gamblesToday||0) < q.$or[1].gamblesToday.$lt; if(!ok) return null;
  r.gamblesToday = r.gambleDay===day ? (r.gamblesToday||0)+1 : 1; r.gambleDay=day; return {gamblesToday:r.gamblesToday};};
UserLevel.exists=async(q)=>db.has(q.userId);
UserLevel.updateOne=async(q,u)=>{const r=db.get(q.userId); if(r&&u.$inc&&r.gambleDay===q.gambleDay&&r.gamblesToday>0) r.gamblesToday+=u.$inc.gamblesToday; return {};};
(async()=>{
  cfg.gamblingDailyLimit=3;
  rec('d').xp=10000; const outs=[];
  for (let n=0;n<4;n++){ let [f,l]=fake('d'); await G.playCoinflip(f,10,'heads'); outs.push(l); }
  assert.match(JSON.stringify(outs[0].pub),/\*\*2\*\* plays left today/); assert.match(JSON.stringify(outs[2].pub),/\*\*0\*\* plays left today/);
  assert.match(outs[3].private.at(-1).content,/used all \*\*3\*\* gambles for today.*<t:\d+:R>/);
  console.log('✓ limit of 3: plays counted down, 4th refused with the reset time');
  // failed bet gives the play back
  rec('e').xp=5; let [f2,l2]=fake('e'); await G.playCoinflip(f2,100,'heads'); assert.equal(db.get('e').gamblesToday,0);
  console.log('✓ a bet that fails (not enough XP) does not use a play');
  // new day resets
  db.get('d').gambleDay='2000-01-01'; let [f3,l3]=fake('d'); await G.playCoinflip(f3,10,'heads'); assert.match(JSON.stringify(l3.pub),/\*\*2\*\* plays left today/);
  console.log('✓ resets on a new day');
  // interactive game shows plays left when it ends; board failure gives the play back
  rec('g').xp=1000; let [f4,l4]=fake('g',{failReply:true}); await G.startMines(f4,100,3); await tick(); assert.equal(db.get('g').gamblesToday,0);
  console.log('✓ a game whose board could not be posted gives the play back');
  cfg.gamblingDailyLimit=0; rec('u').xp=1000; for(let n=0;n<12;n++){ let [f5,l5]=fake('u'); await G.playCoinflip(f5,10,'heads'); if(n===11) assert.doesNotMatch(JSON.stringify(l5.pub),/plays left/); }
  console.log('✓ 0 = unlimited');
  process.exit(0);
})().catch(e=>{console.error(e);process.exit(1);});
