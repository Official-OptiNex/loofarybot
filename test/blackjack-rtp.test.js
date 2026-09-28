process.env.TOKEN='x';process.env.CLIENT_ID='x';process.env.MONGODB_URI='mongodb://x';
const root=require('path').join(__dirname,'..')+'/';
const assert=require('assert');
const L=require(root+'src/bot/cogs/modules/leveling');
const UserLevel=require(root+'src/database/models/UserLevel');
const xp=new Map();
const cfg={gamblingEnabled:true,gamblingHouseEdge:4,gamblingMinBet:10,gamblingDailyLimit:0,xpMultipliers:[],levelRoles:[]};
L.getOrCreateConfig=async()=>cfg;
L.debitXp=async(g,u,a)=>{const c=xp.get(u)||0;if(c<a)return false;xp.set(u,c-a);return true;};
L.adjustXp=async(g,u,d)=>{const o=xp.get(u)||0;xp.set(u,Math.max(0,o+d));return{record:{xp:xp.get(u)},oldLevel:L.levelForXp(o),newLevel:L.levelForXp(xp.get(u)),roleFailures:[]};};
UserLevel.findOne=()=>({lean:async()=>({xp:xp.get('u1')||0,level:L.levelForXp(xp.get('u1')||0)})});
const ActiveBet=require(root+'src/database/models/ActiveBet'); const bets=new Map();
ActiveBet.create=async(d)=>{bets.set(d.gameId,d);return d;}; ActiveBet.updateOne=async()=>{}; ActiveBet.deleteOne=async(q)=>{bets.delete(q.gameId);};
ActiveBet.findOneAndDelete=async(q)=>{const r=bets.get(q.gameId)||null; if(r) bets.delete(q.gameId); return r;};
UserLevel.updateOne=async()=>({modifiedCount:0});
const G=require(root+'src/bot/cogs/modules/gambling');
const J=(c)=>(c&&c.toJSON?c.toJSON():c);
function fake(extra={}){const out=[];const i={guildId:'g',guild:{id:'g'},channelId:'c',user:{id:'u1',toString:()=>'<@u1>'},reply:async o=>out.push(o),deferReply:async()=>{},update:async o=>out.push(o),deferUpdate:async()=>out.push('defer'),fetchReply:async()=>({edit:async()=>{}}),followUp:async o=>{out.push(o);return{id:'e'};},webhook:{editMessage:async()=>{}},editReply:async()=>{},...extra};return[i,out];}
(async()=>{
  assert.equal(G.handValue([{value:1},{value:13}]).total,21);
  assert.deepEqual(G.handValue([{value:1},{value:1},{value:9}]),{total:21,soft:true});
  assert.equal(G.handValue([{value:10},{value:6},{value:1},{value:5}]).total,22);
  xp.set('u1',1e9); let spent=0, back=0, outcomes={};
  for(let n=0;n<2000;n++){
    const before=xp.get('u1'); const [i,out]=fake(); await G.startBlackjack(i,100);
    let msg=out.at(-1); let bet=100;
    const emb=()=>J(msg.embeds[0]);
    let guard=0;
    while(!J(msg.components[0]).components[0].disabled && guard++<20){
      const id=J(msg.components[0]).components[0].custom_id.split(':')[1];
      const total=Number(emb().fields[1].name.match(/You — (\d+)/)[1]);
      const up=Number(emb().fields[0].name.match(/Dealer — (\d+)/)[1]);
      // basic-ish strategy
      let action = total<=11 ? (total>=10 && up<10 && n%2===0 ? 'double':'hit') : total>=17 ? 'stand' : (up>=7 ? 'hit' : 'stand');
      if(action==='double' && J(msg.components[0]).components[2].disabled) action='hit';
      if(action==='double') bet=200;
      const [bi,bo]=fake({customId:`bj:${id}:${action}`}); await G.handleGambleButton(bi); msg=bo.at(-1);
      msg.components.forEach(r=>J(r));
    }
    const txt=emb().fields.at(-1).value; assert.match(txt,/Balance:/);
    const key=(txt.match(/\*\*(Blackjack!|You win!|Dealer busts|Push|Dealer wins\.|Bust!|Dealer has blackjack\.)/)||[])[1]; outcomes[key]=(outcomes[key]||0)+1;
    spent+=bet; back+=xp.get('u1')-before+bet;
  }
  console.log('blackjack RTP', (back/spent).toFixed(4), outcomes);
  // double with insufficient funds
  xp.set('u1',150); const [i,out]=fake(); await G.startBlackjack(i,100);
  const ctl=out.at(-1); if(!J(ctl.components[0]).components[2].disabled){ const id=J(ctl.components[0]).components[0].custom_id.split(':')[1]; const [bi,bo]=fake({customId:`bj:${id}:double`}); await G.handleGambleButton(bi); assert.match(bo[0].content,/need another/); console.log('✓ double blocked without funds'); }
  // coinflip balance line
  xp.set('u1',500); const [ci,co]=fake(); await G.playCoinflip(ci,100,'heads'); assert.match(J(co[0].embeds[0]).description,/Balance:\*\* `\d/); console.log(J(co[0].embeds[0]).description.split('\n').at(-1));
  process.exit(0);
})().catch(e=>{console.error(e);process.exit(1)});
