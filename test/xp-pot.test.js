// Daily XP Pot: losses fill it (right up to the draw), the countdown post with top contributors,
// who counts as active, the draw and tiered payout, rollovers, an early /pot draw, and a missed draw.
process.env.TOKEN='x';process.env.CLIENT_ID='123';process.env.MONGODB_URI='mongodb://x';
const root=require('path').join(__dirname,'..')+'/'; const assert=require('assert');
const { PermissionsBitField, Collection } = require(root+'node_modules/discord.js');
const { store } = require('./helpers/memstore');
const M=(n)=>require(root+'src/database/models/'+n);
const rows={}; for (const n of ['GuildConfig','XpPot','UserLevel','GambleStats']) rows[n]=store(M(n));
// The real collection has a unique (guildId, day) index — upserting a second pot for a day fails.
const XpPot=M('XpPot'); const upd=XpPot.updateOne;
XpPot.updateOne=async(q,u,o={})=>{ if(o.upsert && q.day && !rows.XpPot.some(r=>Object.entries(q).every(([k,v])=>typeof v==='object'?(v.$in?v.$in.includes(r[k]):true):String(r[k])===String(v))) && rows.XpPot.some(r=>r.guildId===q.guildId&&r.day===q.day)) throw Object.assign(new Error('E11000 duplicate key'),{code:11000}); return upd(q,u,o); };
const crypto=require('crypto'); let forced=[]; const realRI=crypto.randomInt; crypto.randomInt=(a,b)=>forced.length?forced.shift():(b===undefined?realRI(a):realRI(a,b));
const P=require(root+'src/bot/cogs/modules/xpPot');

// ---- fake guild
const sent=[];
function channel(id){ const msgs=new Map(); let n=1; const ch={id,name:id,isTextBased:()=>true,isThread:()=>false,permissionsFor:()=>new PermissionsBitField(PermissionsBitField.All),
  send:async(p)=>{ const m={id:`${id}-${n++}`,payload:p,edits:[],edit:async(np)=>{m.payload={...m.payload,...np};m.edits.push(np);return m;}}; msgs.set(m.id,m); sent.push(m); return m; },
  messages:{fetch:async(mid)=>{ const m=msgs.get(mid); if(!m) throw new Error('Unknown'); return m; }}}; return ch; }
const member=(id,bot=false)=>({id,user:{id,bot}});
const members=new Collection(['ann','ben','cat','dan','bot1'].map(id=>[id,member(id,id==='bot1')]));
const guild={id:'g',name:'Lounge',channels:{cache:new Collection([['pot',channel('pot')]])},roles:{cache:new Collection([['r1',{id:'r1'}]])},
  members:{me:{id:'me'},cache:members,fetch:async(id)=>{ const m=members.get(id); if(!m) throw new Error('Unknown'); return m; }}};
const client={guilds:{cache:new Map([['g',guild]])}};
const pots=()=>rows.XpPot.filter(p=>p.guildId==='g').sort((a,b)=>a.day<b.day?-1:1);
const H=3600000, D=24*H;
const day0=Date.UTC(2027,4,10); // May 10 2027, 00:00 UTC
const at=(h,m=0)=>day0+h*H+m*60000;
const say=(user,t)=>P.noteChat({guild,author:{id:user,bot:user==='bot1'},createdTimestamp:t});
const dayKeyOf=(t)=>new Date(t).toISOString().slice(0,10);
const paid=[]; const adjustXp=async(g,u,d)=>paid.push([u,d]);

(async()=>{
  await M('GuildConfig').create({guildId:'g'});
  // ---- settings
  let r=await P.saveSettings(guild,{enabled:true}); assert.match(r.error,/channel/);
  r=await P.saveSettings(guild,{drawHour:24}); assert.match(r.error,/0–23/);
  r=await P.saveSettings(guild,{embed:{color:'blue'}}); assert.match(r.error,/hex color/);
  r=await P.saveSettings(guild,{enabled:true,channelId:'pot',pingRoleId:'r1'});
  assert.deepEqual([r.settings.drawHour,r.settings.countdownMinutes,r.settings.windowMinutes,r.settings.minMessages,r.settings.minPot,r.settings.sharePercent,r.settings.maxPrize,r.settings.maxWinners,r.settings.maxPot,r.settings.rolloverPercent],[0,10,60,3,100,25,500,5,2000,50],'defaults sized against leveling (level 10 = 3,162 XP)');
  // The scenarios below were written for full-size pots: pin those settings explicitly.
  await P.saveSettings(guild,{sharePercent:100,maxPrize:3000,maxWinners:10,maxPot:10000,rolloverPercent:100});
  assert.match((await P.saveSettings(guild,{maxPrize:5})).error,/1st place prize/); assert.match((await P.saveSettings(guild,{maxWinners:26})).error,/Winners/);
  assert.equal(P.nextDrawAt(at(15),0).getTime(),day0+D,'3pm → tonight at midnight');
  assert.equal(P.nextDrawAt(day0,0).getTime(),day0+D,'exactly midnight → the next one');
  assert.equal(P.nextDrawAt(at(15),20).getTime(),at(20));
  console.log('✓ settings validated; the pot is drawn at the end of the day (00:00 UTC by default)');

  // ---- tiered prizes: 1st gets up to the top prize, each place after ≤70% of the one above, capped places
  const d=P.potSettings({xpPot:{maxPrize:3000,maxWinners:10}}); // the ladder maths at the old, bigger sizes
  const L=(a,n,o={})=>P.prizeLadder(a,n,{...d,...o});
  assert.deepEqual(L(800,5),{prizes:[800],leftover:0},'a small pot all goes to 1st');
  assert.deepEqual(L(3500,1),{prizes:[3000],leftover:500},'1st never gets more than the top prize');
  assert.deepEqual(L(5000,3),{prizes:[3000,2000],leftover:0});
  assert.deepEqual(L(20000,12),{prizes:[3000,2100,1470,1029,720,504,352,246,172,120],leftover:10287},'10 winners at most; the rest rolls over');
  assert.deepEqual(L(5,3),{prizes:[],leftover:5},'no prizes under 10 XP');
  assert.deepEqual(L(1000,0),{prizes:[],leftover:1000},'nobody entered');
  for (const [a,n,o] of [[1e7,25,{maxWinners:25}],[123456,7,{}],[999,25,{maxPrize:1000,maxWinners:25}],[50000,25,{maxPrize:10,maxWinners:25}]]) {
    const {prizes,leftover}=L(a,n,o);
    assert.ok(prizes[0]<=(o.maxPrize||3000)); assert.ok(prizes.length<=Math.min(n,o.maxWinners||10));
    for (let i=1;i<prizes.length;i++) assert.ok(prizes[i]<prizes[i-1] && prizes[i]>=10,'each place gets less than the one above');
    assert.equal(prizes.reduce((x,y)=>x+y,0)+leftover,a,'nothing is lost or made up');
  }
  assert.ok(L(1e9,25,{maxWinners:25}).prizes.reduce((x,y)=>x+y,0)<10000,'a huge pot still pays out under 10k a night');
  console.log('✓ tiered prizes: 1st ≤ 3,000, each place less than the one above, at most 10 winners, the rest rolls over');

  // ---- losses fill today's pot (via the real gambling stats hook)
  const G=require(root+'src/bot/cogs/modules/gambling');
  const realNow=Date.now; Date.now=()=>at(15);
  await P.addLoss('g','ann',500,at(15)); await P.addLoss('g','ben',1200,at(16)); await P.addLoss('g','cat',300,at(17)); await P.addLoss('g','ann',250,at(18)); await P.addLoss('g','dan',100,at(19));
  await P.addLoss('g','ann',0,at(19)); await P.addLoss('g','ann',-5,at(19));
  let p=pots()[0]; assert.equal(p.day,'2027-05-11'); assert.equal(p.amount,2350); assert.deepEqual(P.topContributors(p),[['ben',1200],['ann',750],['cat',300]]);
  await G.recordStats({guildId:'g',userId:'dan',kind:'coinflip',bet:200,staked:200,returned:0}).catch(()=>null);
  await G.recordStats({guildId:'g',userId:'dan',kind:'coinflip',bet:200,staked:200,returned:400}).catch(()=>null); // a win adds nothing
  await G.recordStats({guildId:'g',userId:'dan',kind:'coinflip',bet:300,staked:0,returned:0}).catch(()=>null); // free play: nothing paid, nothing lost
  await new Promise(r=>setTimeout(r,20));
  assert.equal(pots()[0].amount,2550,'a lost gamble adds its stake to the pot; wins and free plays don’t');
  Date.now=realNow;
  console.log('✓ gambling losses fill the pot (wins and free plays don’t); top 3 contributors tracked');

  // ---- activity in the last hour
  say('ann',at(23,10)); say('ann',at(23,10)+5000); say('ann',at(23,20)); say('ann',at(23,40)); // 3 counted (one too close)
  say('ben',at(23,15)); say('ben',at(23,16));                                                     // only 2
  say('cat',at(21)); say('cat',at(21,10)); say('cat',at(21,20));                                   // not in the last hour
  say('dan',at(23,5)); say('dan',at(23,30)); say('dan',at(23,55));
  say('bot1',at(23,1)); say('bot1',at(23,2)); say('bot1',at(23,3));
  const s=P.potSettings(rows.GuildConfig[0]);
  assert.deepEqual((await P.activeMembers(guild,s,new Date(day0+D))).sort(),['ann','dan'],'3+ messages ≥20s apart in the last hour; bots never');
  console.log('✓ active = 3+ messages (≥20s apart, so spamming doesn’t help) in the hour before the draw');

  // ---- who's entered: /pot entrants and the dashboard list
  let who=await P.potEntrants(guild,{now:at(23,56)});
  assert.deepEqual(who.entered.map(r=>[r.userId,r.messages]),[['ann',3],['dan',3]]); assert.deepEqual(who.close.map(r=>[r.userId,r.messages]),[['ben',2]]);
  assert.equal(who.windowOpen,true); assert.equal(who.estimated,false);
  assert.equal((await P.potEntrants(guild,{now:at(15)})).windowOpen,false,'before the last hour: "if drawn right now"');
  const potCmd=require(root+'src/bot/commands/pot');
  const run=async(user,last=null)=>{ let out; await potCmd.execute({guild,user:{id:user},memberPermissions:{has:()=>false},options:{getSubcommand:()=>'entrants',getBoolean:()=>last},reply:async(p)=>{out=p;}}); return out; };
  Date.now=()=>at(23,56);
  let r2=await run('ben'); let ed=r2.embeds[0].data;
  assert.equal(r2.ephemeral,true); assert.deepEqual(r2.allowedMentions,{parse:[]},'lists people without pinging them');
  assert.equal(ed.title,'🎟️ Daily XP Pot entrants — 2'); assert.match(ed.description,/You have \*\*2\/3\*\* messages\. 1 more/);
  assert.equal(ed.fields[0].name,'✅ Entered (2)'); assert.equal(ed.fields[0].value,'<@ann> (3) · <@dan> (3)'); assert.equal(ed.fields[1].value,'<@ben> (2/3)');
  assert.match((await run('ann')).embeds[0].data.description,/You're entered\*\* \(3 messages\)/);
  assert.match((await run('cat')).embeds[0].data.description,/not entered yet/);
  Date.now=realNow;
  console.log('✓ /pot entrants: who’s entered (with message counts), who’s almost in, and whether you are — without pinging anyone');

  // ---- countdown: posted 10 minutes before, with how it works + top 3 contributors
  await P.tick(client,at(23,49)); assert.equal(sent.length,0,'not yet');
  await P.tick(client,at(23,50));
  assert.equal(sent.length,1); const post=sent[0]; const e=post.payload.embeds[0].data;
  assert.equal(post.payload.content,'<@&r1>'); assert.equal(e.title,'💰 Daily XP Pot');
  assert.match(e.description,/How to win[\s\S]*3\+ messages in the last 60 minutes/);
  const field=(n)=>e.fields.find(f=>f.name.includes(n)).value;
  assert.match(field('Pot'),/^\*\*2,550\*\* \/ 10,000 XP$/); assert.match(field('Draw'),/<t:\d+:R>/); assert.equal(field('Entered'),'1','ann has 3 by 23:50; dan only 2 so far');
  assert.equal(field('Top pot contributors'),'🥇 <@ben> — 1,200 XP\n🥈 <@ann> — 750 XP\n🥉 <@cat> — 300 XP');
  assert.equal(pots()[0].status,'posted');
  assert.equal(field('Prizes right now'),'🥇 2,550','one person entered so far → one prize');
  // Losses during the countdown still go in, and the post refreshes (at most every 30s).
  await P.addLoss('g','cat',1000,at(23,55)); assert.equal(pots()[0].amount,3550);
  await P.tick(client,at(23,50,)+10000); assert.equal(post.edits.length,0,'not every tick');
  await P.tick(client,at(23,56)); assert.equal(post.edits.length,1);
  assert.match(post.edits[0].embeds[0].data.fields.find(f=>f.name.includes('Pot')).value,/3,550\*\* \/ 10,000 XP/);
  assert.match(post.edits[0].embeds[0].data.fields.find(f=>f.name.includes('Top')).value,/🥇 <@cat> — 1,300 XP/);
  console.log('✓ posted 10 min before the draw (ping, how-it-works, pot, live countdown, entrants, top 3); keeps collecting and updating until the draw');

  // ---- the draw
  forced=[1,0]; // entrants are ['ann','dan'] → dan picked first, then ann
  const drawSs=require(root+'src/bot/cogs/modules/leveling'); const realAdj=drawSs.adjustXp; drawSs.adjustXp=adjustXp;
  await P.tick(client,day0+D+2000);
  assert.deepEqual(paid,[['dan',3000],['ann',550]],'1st gets the top prize, 2nd the rest');
  p=pots()[0]; assert.equal(p.status,'done'); assert.equal(p.winnerId,'dan'); assert.equal(p.won,3550); assert.equal(p.leftover,0); assert.equal(p.entrants,2);
  assert.deepEqual(p.winners.map(w=>[w.userId,w.place,w.amount]),[['dan',1,3000],['ann',2,550]]);
  assert.deepEqual(p.entrantIds,['ann','dan'],'who was entered is saved with the pot');
  who=await P.potEntrants(guild,{last:true}); assert.deepEqual(who.entered.map(r=>[r.userId,r.won]),[['dan',3000],['ann',550]]);
  const lastRun=await (async()=>{ let out; await require(root+'src/bot/commands/pot').execute({guild,user:{id:'ben'},memberPermissions:{has:()=>false},options:{getSubcommand:()=>'entrants',getBoolean:()=>true},reply:async(x)=>{out=x;}}); return out.embeds[0].data; })();
  assert.match(lastRun.title,/2027-05-11 pot — 2/); assert.match(lastRun.description,/weren’t entered/); assert.equal(lastRun.fields[0].value,'<@dan> 🏆 3,000 · <@ann> 🏆 550');
  const done=post.edits.at(-1).embeds[0].data; assert.match(done.title,/we have a winner/);
  assert.equal(done.fields[0].name,'🏆 Winners'); assert.equal(done.fields[0].value,'🥇 <@dan> — **3,000 XP**\n🥈 <@ann> — **550 XP**'); assert.match(done.fields[1].value,/3,550 XP/);
  const win=sent.at(-1).payload; assert.equal(win.content,'🎉 The **Daily XP Pot** has been drawn: **3,550 XP** to 2 winners!\n🥇 <@dan> — **3,000 XP**\n🥈 <@ann> — **550 XP**'); assert.deepEqual(win.allowedMentions,{users:['dan','ann']});
  await P.tick(client,day0+D+20000); assert.equal(paid.length,2,'drawn once');
  // Losses right after the draw go into tomorrow's pot.
  await P.addLoss('g','ben',40,day0+D+60000); assert.equal(pots()[1].day,'2027-05-12'); assert.equal(pots()[1].amount,40);
  console.log('✓ at 00:00 active members win tiered prizes; the post lists every winner and they’re all pinged; later losses start tomorrow’s pot');

  // ---- small pot: never posted, quietly rolls over
  const n0=sent.length;
  await P.tick(client,day0+D+23*H+55*60000); assert.equal(sent.length,n0,'40 XP < 100 minimum → not posted');
  await P.tick(client,day0+2*D+1000); assert.equal(sent.length,n0,'rolled over silently');
  assert.equal(pots()[1].status,'rolled'); assert.equal(pots()[2].day,'2027-05-13'); assert.equal(pots()[2].amount,40); assert.equal(pots()[2].rolledOver,40);
  // Nobody active → rolls over (the posted message says so).
  await P.addLoss('g','ann',500,day0+2*D+H);
  await P.tick(client,day0+3*D-5*60000); const post2=sent.at(-1); assert.match(post2.payload.embeds[0].data.fields[0].value,/540\*\* \/ 10,000 XP[\s\S]*40 rolled over/);
  P._activity.clear(); rows.UserLevel.length=0;
  await P.tick(client,day0+3*D+1000); assert.match(post2.edits.at(-1).embeds[0].data.title,/rolled over/); assert.equal(pots()[3].amount,540); assert.equal(pots()[3].rolledOver,540);
  console.log('✓ pots under the minimum roll over quietly; nobody active → rolled over (and the post says why)');

  // ---- after a restart (no chat memory): members who earned chat XP in the last hour count
  await M('UserLevel').create({guildId:'g',userId:'cat',xp:10,level:0,lastMessageTimestamp:day0+4*D-20*60000});
  await M('UserLevel').create({guildId:'g',userId:'ben',xp:10,level:0,lastMessageTimestamp:day0+4*D-3*H});
  assert.deepEqual(await P.activeMembers(guild,s,new Date(day0+4*D)),['cat']);
  console.log('✓ after a restart, "active" falls back to members who earned chat XP in that hour');

  // ---- /pot draw: post now, draw after the countdown; not posted again at the usual time
  Date.now=()=>day0+3*D+10*H;
  forced=[0];
  const started=await P.startNow(guild,day0+3*D+10*H); assert.ok(started.ok,started.error); assert.equal(started.drawAt.getTime(),day0+3*D+10*H+10*60000);
  const early=sent.at(-1); assert.match(early.payload.embeds[0].data.fields[0].value,/540\*\* \//);
  assert.match((await P.startNow(guild,day0+3*D+10*H)).error,/already posted/);
  await P.tick(client,day0+3*D+10*H+11*60000); assert.deepEqual(paid.at(-1),['cat',540]);
  const n1=sent.length; await P.tick(client,day0+4*D-5*60000); assert.equal(sent.length,n1,'today’s pot was already drawn');
  Date.now=realNow;
  console.log('✓ /pot draw posts today’s pot now and draws it after the countdown; it isn’t posted again that night');

  // ---- missed draw (bot offline for over 12h) → rolled over, not drawn late
  await P.addLoss('g','ann',700,day0+5*D-H);
  await P.tick(client,day0+5*D+13*H); const missed=pots().find(x=>x.day==='2027-05-15'); assert.equal(missed.status,'rolled');
  assert.equal(pots().find(x=>x.day==='2027-05-16').rolledOver,700);
  console.log('✓ a draw missed by more than 12 hours rolls over instead');

  // ---- a big pot with lots of people: 10 places, strictly decreasing, the rest rolls over
  for (let i=0;i<12;i++) members.set('m'+i,member('m'+i));
  for (const x of rows.XpPot) if (['collecting','posted'].includes(x.status)) x.status='rolled'; // start clean
  const BIG=10*D;
  P._activity.clear();
  for (let i=0;i<12;i++) for (let k=0;k<3;k++) say('m'+i,day0+BIG-50*60000+k*60000);
  await M('XpPot').create({guildId:'g',day:dayKeyOf(day0+BIG),drawAt:new Date(day0+BIG),amount:20000,contributors:{ann:20000},status:'collecting'});
  await P.saveSettings(guild,{winMessage:'GG {winner}!',maxPot:50000}); // (above the usual 10k cap, to test the ladder)
  paid.length=0; forced=[];
  await P.tick(client,day0+BIG+1000);
  assert.deepEqual(paid.map(x=>x[1]),[3000,2100,1470,1029,720,504,352,246,172,120]); assert.equal(new Set(paid.map(x=>x[0])).size,10,'10 different people');
  const big=pots().find(x=>x.day===dayKeyOf(day0+BIG)); assert.equal(big.leftover,10287); assert.equal(big.won,9713);
  assert.equal(pots().find(x=>x.day===dayKeyOf(day0+BIG+D)).rolledOver,10287,'the rest rolls over to tomorrow');
  const gg=sent.at(-1).payload; assert.match(gg.content,/^GG <@m\d+>!\n🥇 <@m\d+> — \*\*3,000 XP\*\*[\s\S]*\*\*#10\*\* <@m\d+> — \*\*120 XP\*\*$/,'a custom message still lists every winner'); assert.equal(gg.allowedMentions.users.length,10);
  assert.match(gg.embeds[0].data.fields.find(f=>f.name.includes('Rolled')).value,/10,287 XP/);
  // Servers that saved the old single-winner message get the new one.
  rows.GuildConfig[0].xpPot.winMessage='🎉 {winner} won the **Daily XP Pot** — **{pot} XP**! 💰';
  assert.equal(P.potSettings(rows.GuildConfig[0]).winMessage,P.DEFAULT_WIN_MESSAGE);
  console.log('✓ a 20,000 XP pot with 12 active → 10 winners (3,000 → 120), 10,287 rolls over; every winner is pinged');

  // ---- the pot is capped (10,000 by default): when it's full it's drawn right away, whatever the time
  assert.match((await P.saveSettings(guild,{maxPot:50})).error,/pot cap/);
  await P.saveSettings(guild,{maxPot:10000,winMessage:''});
  const FULL=day0+20*D; const noon=FULL-12*H; // noon, 12h before that day's usual draw
  for (const x of rows.XpPot) if (['collecting','posted'].includes(x.status)) x.status='rolled';
  await P.addLoss('g','ann',6000,noon); await P.addLoss('g','ben',5500,noon+1000);
  const cur=()=>pots().find(x=>x.day===dayKeyOf(FULL)), nxt=()=>pots().find(x=>x.day===dayKeyOf(FULL+D));
  assert.equal(cur().amount,10000,'never more than the cap'); assert.deepEqual(P.topContributors(cur()),[['ann',6000],['ben',4000]]);
  assert.equal(nxt().amount,1500,'what doesn’t fit starts the next pot'); assert.deepEqual(P.topContributors(nxt()),[['ben',1500]]);
  P._activity.clear(); for (const u of ['ann','ben','cat']) for (let k=0;k<3;k++) say(u,noon-30*60000+k*60000);
  const nFull=sent.length;
  await P.tick(client,noon+2000);
  assert.equal(sent.length,nFull+1,'posted right away'); const fullPost=sent.at(-1).payload.embeds[0].data;
  assert.match(fullPost.fields[0].value,/10,000\*\* \/ 10,000 XP\n🔥 \*\*Full!\*\* Drawn early/); assert.equal(cur().status,'posted'); assert.equal(new Date(cur().drawAt).getTime(),noon+2000+10*60000);
  assert.match(fullPost.description,/tops out at \*\*10,000 XP\*\*/);
  await P.addLoss('g','cat',700,noon+5*60000); assert.equal(cur().amount,10000); assert.equal(nxt().amount,2200,'losses during the countdown go to the next pot too');
  paid.length=0; forced=[];
  await P.tick(client,noon+11*60000);
  assert.equal(cur().status,'done'); assert.deepEqual(paid.map(x=>x[1]),[3000,2100,1470],'3 active → 3 prizes, 1st capped at 3,000');
  assert.equal(nxt().amount,2200+3430,'the rest rolls over to the next pot'); assert.equal(nxt().rolledOver,3430);
  await P.tick(client,FULL-5*60000); assert.equal(nxt().status,'collecting','tonight’s draw is the next pot’s, which isn’t due yet');
  console.log('✓ the pot caps at 10,000 XP: once full it’s posted and drawn right away (10-min countdown), and the overflow starts the next pot');

  // ---- rebalanced: only part of what's left carries over; overflow never goes further than the next pot
  await P.saveSettings(guild,{maxPrize:500,maxWinners:5,maxPot:2000,rolloverPercent:50,sharePercent:25,winMessage:''});
  const RB=day0+40*D;
  for (const x of rows.XpPot) if (['collecting','posted'].includes(x.status)) x.status='rolled';
  const rb=P.potSettings(rows.GuildConfig[0]);
  assert.deepEqual(P.prizeLadder(2000,12,rb),{prizes:[500,350,245,171,119],leftover:615},'full pot: 1,385 XP paid out at most');
  assert.equal(P.describeLadder(2000,12,rb).text,'🥇 500 · 🥈 350 · 🥉 245 · **#4** 171 · **#5** 119\n-# +307 XP carries over to tomorrow');
  await P.addLoss('g','ann',4000,RB-6*H); // 25% → 1,000 XP
  assert.equal(pots().find(x=>x.day===dayKeyOf(RB)).amount,1000,'only 25% of a loss goes in');
  await P.addLoss('g','ben',40000,RB-6*H); // 10,000 XP: 1,000 fills this pot, 2,000 the next, the rest is gone
  assert.equal(pots().find(x=>x.day===dayKeyOf(RB)).amount,2000); assert.equal(pots().find(x=>x.day===dayKeyOf(RB+D)).amount,2000);
  assert.equal(pots().find(x=>x.day===dayKeyOf(RB+2*D)),undefined,'never spills further than the next pot');
  P._activity.clear(); for (const u of ['m0','m1','m2','m3','m4','m5']) for (let k=0;k<3;k++) say(u,RB-6*H-30*60000+k*60000);
  paid.length=0; forced=[];
  await P.tick(client,RB-6*H+1000); await P.tick(client,RB-6*H+11*60000); // full → drawn early
  assert.deepEqual(paid.map(x=>x[1]),[500,350,245,171,119]);
  assert.equal(pots().find(x=>x.day===dayKeyOf(RB+D)).amount,2000,'next pot was already full: the carry-over doesn’t push it past the cap');
  // Nobody active → only half carries over.
  for (const x of rows.XpPot) if (['collecting','posted'].includes(x.status)) x.status='rolled';
  await M('XpPot').create({guildId:'g',day:dayKeyOf(RB+5*D),drawAt:new Date(RB+5*D),amount:800,status:'collecting'});
  P._activity.clear(); rows.UserLevel.length=0;
  await P.tick(client,RB+5*D+1000);
  assert.equal(pots().find(x=>x.day===dayKeyOf(RB+6*D)).amount,400,'nobody won: 50% of 800 carries over, the rest is gone');
  console.log('✓ rebalanced: 25% of losses, 500 XP top prize, 5 winners, 2,000 cap; only 50% of leftovers carry over, overflow reaches the next pot at most');

  // ---- servers still on the old defaults are moved to the new ones; oversized open pots are trimmed
  const cfg0=rows.GuildConfig[0];
  cfg0.xpPot={...cfg0.xpPot,sharePercent:100,maxPrize:3000,maxWinners:10,maxPot:10000,balanceVersion:undefined};
  await M('GuildConfig').create({guildId:'custom',xpPot:{enabled:true,maxPrize:800,maxPot:5000}}); rows.GuildConfig.find(c=>c.guildId==='custom').xpPot.balanceVersion=undefined;
  await M('XpPot').create({guildId:'g',day:'2030-01-01',drawAt:new Date(Date.UTC(2030,0,1)),amount:9000,rolledOver:8000,status:'collecting'});
  await P.rebalance();
  assert.deepEqual([cfg0.xpPot.sharePercent,cfg0.xpPot.maxPrize,cfg0.xpPot.maxWinners,cfg0.xpPot.maxPot,cfg0.xpPot.balanceVersion],[25,500,5,2000,2]);
  const kept=rows.GuildConfig.find(c=>c.guildId==='custom').xpPot; assert.deepEqual([kept.maxPrize,kept.maxPot],[800,5000],'values someone chose themselves are kept');
  const big2=pots().find(x=>x.day==='2030-01-01'); assert.deepEqual([big2.amount,big2.rolledOver],[2000,2000],'an oversized open pot is trimmed to the new cap');
  await P.rebalance(); assert.equal(cfg0.xpPot.maxPrize,500,'runs once');
  console.log('✓ servers on the old defaults move to the rebalanced ones (custom values kept); oversized open pots are trimmed');

  // ---- after the rebalance: pots queued far ahead (old 30-day spill), all full at the cap, swallowed
  //      every new loss. They're cleared at startup, full pots are drawn one at a time, and the
  //      pot view shows where new losses go while the current pot is full.
  for (const x of rows.XpPot) if (['collecting','posted'].includes(x.status)) x.status='rolled';
  await P.saveSettings(guild,{sharePercent:75,maxPot:2000});
  const ST=day0+60*D, noonST=ST-12*H; const stPots=()=>pots().filter(x=>x.day>=dayKeyOf(ST)&&x.day<=dayKeyOf(ST+9*D));
  for (let i=0;i<6;i++) await M('XpPot').create({guildId:'g',day:dayKeyOf(ST+i*D),drawAt:new Date(ST+i*D),amount:2000,rolledOver:2000,status:'collecting'});
  await P.addLoss('g','ann',1000,noonST);
  assert.deepEqual(stPots().map(x=>x.amount),[2000,2000,2000,2000,2000,2000],'(the bug) every pot full → the loss went nowhere');
  assert.equal(await P.clearFarPots(noonST),4,'only tonight’s pot and the one after are kept');
  assert.deepEqual(stPots().map(x=>x.day),[dayKeyOf(ST),dayKeyOf(ST+D)]);
  // Only the first full pot starts its countdown; the one behind it waits its turn.
  const nPosts=sent.length; await P.tick(client,noonST+1000); await P.tick(client,noonST+20000);
  assert.equal(sent.length,nPosts+1,'one countdown at a time'); assert.equal(pots().find(x=>x.day===dayKeyOf(ST+D)).status,'collecting');
  let view=await P.currentPot(guild,noonST+30000); assert.equal(view.pot.day,dayKeyOf(ST)); assert.equal(view.next.amount,2000);
  assert.match(P.buildEmbed(view.pot,view.settings,{entrants:0,drawAt:view.drawAt,next:view.next}).data.fields.find(f=>f.name.includes('Next')).value,/2,000\*\* \/ 2,000 XP — new losses go here now \(full too/);
  // Once tonight's pot is drawn, the next one (full) starts; after that, losses fill the pot again.
  P._activity.clear(); for (const u of ['m0','m1','m2']) for (let k=0;k<3;k++) say(u,noonST-30*60000+k*60000);
  await P.tick(client,noonST+11*60000); assert.equal(pots().find(x=>x.day===dayKeyOf(ST)).status,'done');
  await P.tick(client,noonST+11*60000+15000); assert.equal(pots().find(x=>x.day===dayKeyOf(ST+D)).status,'posted','the next full pot starts its countdown');
  await P.addLoss('g','ben',1000,noonST+12*60000);
  view=await P.currentPot(guild,noonST+12*60000);
  const after=pots().find(x=>x.day===dayKeyOf(ST+2*D));
  assert.equal(after.contributors.get ? after.contributors.get('ben') : after.contributors.ben,750,'75% of the loss lands in the pot after it');
  assert.equal(view.next.amount,after.amount,'and /pot view shows that pot filling');
  console.log('✓ pots queued far ahead are cleared; full pots are drawn one at a time; /pot view shows the next pot filling while the current one is full');

  // ---- preview / customised embed
  await P.saveSettings(guild,{embed:{title:'🍀 Lucky Pot',description:'Pot: {pot} — drawn {draw}',color:'#00FF00',imageUrl:'https://x.y/banner.png',footer:'gl'}});
  const custom=P.buildEmbed({amount:1234,contributors:{a:5}},P.potSettings(rows.GuildConfig[0]),{entrants:4,drawAt:new Date(day0)}).data;
  assert.equal(custom.title,'🍀 Lucky Pot'); assert.match(custom.description,/^Pot: 1,234 — drawn <t:\d+:R>$/); assert.equal(custom.color,0x00ff00); assert.equal(custom.image.url,'https://x.y/banner.png'); assert.equal(custom.footer.text,'gl');
  assert.match((await P.saveSettings(guild,{embed:{imageUrl:'not a link'}})).error,/image link/);
  drawSs.adjustXp=realAdj;
  console.log('✓ the embed can be restyled (title, text with placeholders, color, images, footer)');
  process.exit(0);
})().catch(e=>{console.error(e);process.exit(1);});
