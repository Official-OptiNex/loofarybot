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
const G=require(root+'src/bot/cogs/modules/gambling');
function fake(user,extra={}){const out=[];return[{guildId:'g',guild:{id:'g'},channelId:'c',user:{id:user,toString:()=>`<@${user}>`},reply:async o=>out.push(o),deferReply:async()=>{},update:async o=>out.push(o),deferUpdate:async()=>{},fetchReply:async()=>({edit:async o=>out.push(o)}),...extra},out];}
const { MessageFlags, ComponentType } = require(root+'node_modules/discord.js');
const buttons=(p)=>{const out=[];const walk=(n)=>{if(Array.isArray(n))return n.forEach(walk);if(!n||typeof n!=='object')return;const j=typeof n.toJSON==='function'?n.toJSON():n;if(j.type===ComponentType.Button)out.push(j);(j.components||[]).forEach(walk);};walk(p.components||[]);return out;};
function player(user){const log={public:[],private:[],followUp:null};const pub={edit:async(p)=>{log.public.push(p);}};
  const [i]=fake(user,{reply:async(p)=>{log.public.push(p);},fetchReply:async()=>pub,followUp:async(p)=>{log.followUp=p;return{id:'eph'};},webhook:{editMessage:async(m,p)=>log.private.push(p)}});return [i,log];}
(async()=>{
  for (const [kind,start] of [['mines',(i)=>G.startMines(i,100,3)],['highlow',(i)=>G.startHighLow(i,100)],['blackjack',(i)=>G.startBlackjack(i,100)]]) {
    const P='P'+kind; rec(P).xp=1000;
    let ia,log; for (let t=0;t<30;t++){ [ia,log]=player(P+t); rec(P+t).xp=1000; await start(ia); if (log.followUp) break; }
    const pub0=log.public[0];
    if (!log.followUp) { console.log(kind,': settled instantly (natural) — public shows result, no controls:', buttons(pub0).every(b=>b.disabled)); continue; }
    const pubBtns=buttons(pub0), privBtns=buttons(log.followUp);
    assert.ok(pubBtns.length>0 && pubBtns.every(b=>b.disabled),'public buttons all disabled');
    assert.ok(privBtns.some(b=>!b.disabled),'private has live buttons');
    assert.ok(log.followUp.flags & MessageFlags.Ephemeral,'controls are ephemeral');
    const note=JSON.stringify(pub0); assert.match(note,/Watching live — only <@P/);
    // B presses (would need to hack a disabled button) → still refused
    const id=privBtns.find(b=>!b.disabled).custom_id;
    let bReply=null; const [ib]=fake('B',{customId:id,reply:async(o)=>{bReply=o;}}); await G.handleGambleButton(ib); assert.match(bReply.content,/isn't your game/);
    // A plays from the private controls
    const updates=[]; const [ia2]=fake(ia.user.id,{customId:id,update:async(p)=>updates.push(p),deferUpdate:async()=>{},editReply:async()=>{}});
    await G.handleGambleButton(ia2);
    const mirrored=log.public.at(-1);
    assert.ok(log.public.length>=2,'public board mirrored after the click');
    assert.ok(buttons(mirrored).every(b=>b.disabled),'mirror still disabled');
    console.log(kind.padEnd(9),'✓ public board watch-only · private controls ephemeral · others refused · player click mirrored live');
  }
  // finished game: notes removed
  const payload={embeds:[{title:'x'}],components:[]};
  const done={finished:true,userId:'A'}; const v=G._test.spectatorView(done,payload); assert.equal(v.content,null);
  const live=G._test.spectatorView({finished:false,userId:'A'},{flags:MessageFlags.IsComponentsV2,components:[{type:10,content:'hi'}]}); assert.equal(live.components.at(-1).type,ComponentType.TextDisplay);
  console.log('✓ "watching live" note shows during play and is cleared when the game ends');
  process.exit(0);
})().catch(e=>{console.error(e);process.exit(1);});
