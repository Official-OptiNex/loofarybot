// Daily XP Pot: losses fill it (right up to the draw), the countdown post with top contributors,
// who counts as active, the draw and payout, rollovers, an early /pot draw, and a missed draw.
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
const paid=[]; const adjustXp=async(g,u,d)=>paid.push([u,d]);

(async()=>{
  await M('GuildConfig').create({guildId:'g'});
  // ---- settings
  let r=await P.saveSettings(guild,{enabled:true}); assert.match(r.error,/channel/);
  r=await P.saveSettings(guild,{drawHour:24}); assert.match(r.error,/0–23/);
  r=await P.saveSettings(guild,{embed:{color:'blue'}}); assert.match(r.error,/hex color/);
  r=await P.saveSettings(guild,{enabled:true,channelId:'pot',pingRoleId:'r1'});
  assert.deepEqual([r.settings.drawHour,r.settings.countdownMinutes,r.settings.windowMinutes,r.settings.minMessages,r.settings.minPot,r.settings.sharePercent],[0,10,60,3,100,100]);
  assert.equal(P.nextDrawAt(at(15),0).getTime(),day0+D,'3pm → tonight at midnight');
  assert.equal(P.nextDrawAt(day0,0).getTime(),day0+D,'exactly midnight → the next one');
  assert.equal(P.nextDrawAt(at(15),20).getTime(),at(20));
  console.log('✓ settings validated; the pot is drawn at the end of the day (00:00 UTC by default)');

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

  // ---- countdown: posted 10 minutes before, with how it works + top 3 contributors
  await P.tick(client,at(23,49)); assert.equal(sent.length,0,'not yet');
  await P.tick(client,at(23,50));
  assert.equal(sent.length,1); const post=sent[0]; const e=post.payload.embeds[0].data;
  assert.equal(post.payload.content,'<@&r1>'); assert.equal(e.title,'💰 Daily XP Pot');
  assert.match(e.description,/How to win[\s\S]*3\+ messages in the last 60 minutes/);
  const field=(n)=>e.fields.find(f=>f.name.includes(n)).value;
  assert.match(field('Pot'),/2,550 XP/); assert.match(field('Draw'),/<t:\d+:R>/); assert.equal(field('Entered'),'1','ann has 3 by 23:50; dan only 2 so far');
  assert.equal(field('Top pot contributors'),'🥇 <@ben> — 1,200 XP\n🥈 <@ann> — 750 XP\n🥉 <@cat> — 300 XP');
  assert.equal(pots()[0].status,'posted');
  // Losses during the countdown still go in, and the post refreshes (at most every 30s).
  await P.addLoss('g','cat',1000,at(23,55)); assert.equal(pots()[0].amount,3550);
  await P.tick(client,at(23,50,)+10000); assert.equal(post.edits.length,0,'not every tick');
  await P.tick(client,at(23,56)); assert.equal(post.edits.length,1);
  assert.match(post.edits[0].embeds[0].data.fields.find(f=>f.name.includes('Pot')).value,/3,550 XP/);
  assert.match(post.edits[0].embeds[0].data.fields.find(f=>f.name.includes('Top')).value,/🥇 <@cat> — 1,300 XP/);
  console.log('✓ posted 10 min before the draw (ping, how-it-works, pot, live countdown, entrants, top 3); keeps collecting and updating until the draw');

  // ---- the draw
  forced=[1]; // entrants are ['ann','dan'] → dan
  const drawSs=require(root+'src/bot/cogs/modules/leveling'); const realAdj=drawSs.adjustXp; drawSs.adjustXp=adjustXp;
  await P.tick(client,day0+D+2000);
  assert.deepEqual(paid,[['dan',3550]]);
  p=pots()[0]; assert.equal(p.status,'done'); assert.equal(p.winnerId,'dan'); assert.equal(p.won,3550); assert.equal(p.entrants,2);
  const done=post.edits.at(-1).embeds[0].data; assert.match(done.title,/we have a winner/); assert.equal(done.fields[0].value,'<@dan>'); assert.match(done.fields[1].value,/3,550 XP/);
  const win=sent.at(-1).payload; assert.equal(win.content,'🎉 <@dan> won the **Daily XP Pot** — **3,550 XP**! 💰'); assert.deepEqual(win.allowedMentions,{users:['dan']});
  await P.tick(client,day0+D+20000); assert.equal(paid.length,1,'drawn once');
  // Losses right after the draw go into tomorrow's pot.
  await P.addLoss('g','ben',40,day0+D+60000); assert.equal(pots()[1].day,'2027-05-12'); assert.equal(pots()[1].amount,40);
  console.log('✓ at 00:00 a random active member wins the whole pot; the post turns into the result and the winner is pinged; later losses start tomorrow’s pot');

  // ---- small pot: never posted, quietly rolls over
  const n0=sent.length;
  await P.tick(client,day0+D+23*H+55*60000); assert.equal(sent.length,n0,'40 XP < 100 minimum → not posted');
  await P.tick(client,day0+2*D+1000); assert.equal(sent.length,n0,'rolled over silently');
  assert.equal(pots()[1].status,'rolled'); assert.equal(pots()[2].day,'2027-05-13'); assert.equal(pots()[2].amount,40); assert.equal(pots()[2].rolledOver,40);
  // Nobody active → rolls over (the posted message says so).
  await P.addLoss('g','ann',500,day0+2*D+H);
  await P.tick(client,day0+3*D-5*60000); const post2=sent.at(-1); assert.match(post2.payload.embeds[0].data.fields[0].value,/540 XP[\s\S]*40 rolled over/);
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
  const early=sent.at(-1); assert.match(early.payload.embeds[0].data.fields[0].value,/540 XP/);
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

  // ---- preview / customised embed
  await P.saveSettings(guild,{embed:{title:'🍀 Lucky Pot',description:'Pot: {pot} — drawn {draw}',color:'#00FF00',imageUrl:'https://x.y/banner.png',footer:'gl'}});
  const custom=P.buildEmbed({amount:1234,contributors:{a:5}},P.potSettings(rows.GuildConfig[0]),{entrants:4,drawAt:new Date(day0)}).data;
  assert.equal(custom.title,'🍀 Lucky Pot'); assert.match(custom.description,/^Pot: 1,234 — drawn <t:\d+:R>$/); assert.equal(custom.color,0x00ff00); assert.equal(custom.image.url,'https://x.y/banner.png'); assert.equal(custom.footer.text,'gl');
  assert.match((await P.saveSettings(guild,{embed:{imageUrl:'not a link'}})).error,/image link/);
  drawSs.adjustXp=realAdj;
  console.log('✓ the embed can be restyled (title, text with placeholders, color, images, footer)');
  process.exit(0);
})().catch(e=>{console.error(e);process.exit(1);});
