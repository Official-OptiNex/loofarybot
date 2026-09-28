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
UserLevel.updateOne=async(q,u)=>{ if(u.$set) Object.assign(rec(q.userId),u.$set); return {modifiedCount:1}; };
const cmd=require(root+'src/bot/commands/gamble');
const tick=()=>new Promise(r=>realST(r,20));
function ci(user,everyone,admin){const out={};const i={guildId:'g',guild,channelId:'c',client,user:{id:user},memberPermissions:new PermissionsBitField(admin?PermissionsBitField.All:0n),
  options:{getSubcommand:()=>'sync',getBoolean:(n)=>n==='everyone'?everyone:null},deferReply:async()=>{i.deferred=true;},reply:async(o)=>{out.reply=o;},editReply:async(o)=>{out.edit=o;}};return[i,out];}
(async()=>{
  let [i,o]=ci('z',true,false); await cmd.execute(i); assert.match(o.reply.content,/Only members with \*\*Manage Server\*\*/);
  [i,o]=ci('z',false,false); await cmd.execute(i); assert.match(o.edit.content,/Nothing was stuck — you can start a new game/);
  bets.set('g1',{gameId:'g1',_id:1,guildId:'g',userId:'p1',kind:'mines',amount:100,paidAmount:100,channelId:'c',updatedAt:new Date(Date.now()-5*60e3)});
  bets.set('g2',{gameId:'g2',_id:2,guildId:'g',userId:'p2',kind:'blackjack',amount:0,paidAmount:0,freePlay:true,channelId:'c',updatedAt:new Date(Date.now()-5*60e3)});
  [i,o]=ci('admin',true,true); await cmd.execute(i); await tick();
  console.log(o.edit.content);
  assert.equal(rec('p1').xp,100); assert.equal(rec('p2').freePlays,1); assert.equal(bets.size,0);
  console.log('✓ /gamble sync: non-admins can only fix themselves; admins fix everyone with a summary');
  process.exit(0);
})().catch(e=>{console.error(e);process.exit(1);});
