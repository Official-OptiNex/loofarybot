// The Bubble Factory idle game: the economy maths, collecting, buying upgrades, cashing bubbles out
// to XP (daily-capped), settings validation, and the leaderboard.
process.env.TOKEN='x';process.env.CLIENT_ID='123';process.env.MONGODB_URI='mongodb://x';process.env.CONFIG_CACHE_MS='0';
const root=require('path').join(__dirname,'..')+'/'; const assert=require('assert');
const { Collection } = require(root+'node_modules/discord.js');
const { store } = require('./helpers/memstore');
const M=(n)=>require(root+'src/database/models/'+n);
const rows={}; for (const n of ['GuildConfig','IdleFactory','UserLevel']) rows[n]=store(M(n));
const I=require(root+'src/bot/cogs/modules/idleGame');

const guild={ id:'g', members:{ cache:new Collection([['ann',{displayName:'Ann'}]]) } };
const H=3600000;

(async()=>{
  // ---- pure maths
  const s=I.idleSettings({idleGame:{enabled:true}});
  assert.deepEqual([s.baseRate,s.offlineHours,s.bubblesPerXp,s.dailyXpCap],[60,8,10,300]);
  const st={upgrades:new Map(),bank:0,lifetime:0,lastTick:0};
  assert.equal(I.ratePerHour(st,s),60);
  st.upgrades.set('scrubber',5); st.upgrades.set('shine',3);
  assert.equal(I.ratePerHour(st,s),Math.round((60+150)*1.3),'flat upgrades then the shine multiplier');
  assert.deepEqual([0,1,2].map((l)=>I.upgradeCost('scrubber',l)),[100,155,241],'geometric cost curve');
  assert.equal(I.offlineCapHours({upgrades:new Map([['tub',3]])},s),8+6,'bigger tub extends offline storage');
  const now=Date.UTC(2027,0,2,12);
  assert.equal(I.pendingBubbles({upgrades:new Map(),lastTick:now-2*H},s,now),120,'2h at 60/hr');
  assert.equal(I.pendingBubbles({upgrades:new Map(),lastTick:now-100*H},s,now),8*60,'capped at the offline window (8h)');
  assert.equal(I.pendingBubbles({upgrades:new Map(),lastTick:0},s,now),0,'a brand-new factory has nothing pending');
  assert.equal(I.xpLeftToday({cashoutDay:'2027-01-02',cashoutXpToday:120},s,now),180);
  assert.equal(I.xpLeftToday({cashoutDay:'2027-01-01',cashoutXpToday:300},s,now),300,'yesterday’s cash-outs don’t count today');
  console.log('✓ economy maths: rate (flat + shine), geometric costs, offline cap, pending, daily cap left');

  // ---- settings validation
  assert.match(I.cleanSettings({dailyXpCap:-1}).error,/Daily XP cap/);
  assert.match(I.cleanSettings({offlineHours:0}).error,/Offline storage/);
  await M('GuildConfig').create({guildId:'g'});
  let r=await I.saveSettings(guild,{enabled:true,dailyXpCap:300,bubblesPerXp:10,baseRate:60,offlineHours:8});
  assert.equal(r.settings.enabled,true);
  console.log('✓ settings validated and saved');

  // ---- collect banks pending bubbles
  let f=await I.getFactory('g','ann'); f.lastTick=now-4*H; await f.save();
  let c=await I.collect('g','ann',s,now);
  assert.equal(c.gained,240); assert.equal(c.state.bank,240); assert.equal(c.state.lifetime,240);
  c=await I.collect('g','ann',s,now); assert.equal(c.gained,0,'nothing new right after collecting');
  console.log('✓ collect banks the pending bubbles (and nothing extra right after)');

  // ---- buying upgrades spends the (already-collected) bank, and does NOT auto-collect pending
  f=await I.getFactory('g','ann'); f.bank=1000; f.lastTick=now-4*H; await f.save(); // 240 pending, uncollected
  let b=await I.buyUpgrade('g','ann','scrubber',s,now);
  assert.equal(b.newLevel,1); assert.equal(b.cost,100); assert.equal(b.state.bank,900,'spent from bank; pending left untouched');
  assert.equal(I.pendingBubbles(b.state,s,now),360,'4h still pending (lastTick not reset), now at the upgraded 90/hr rate');
  assert.equal(I.ratePerHour(b.state,s),90,'rate went up');
  b=await I.buyUpgrade('g','ann','jets',s,now); assert.match(b.error,/costs/); assert.equal(b.state.bank,900,'a buy you can’t afford changes nothing');
  // Maxing a capped upgrade.
  f=await I.getFactory('g','ann'); f.bank=1e9; f.upgrades={tub:12}; f.markModified('upgrades'); await f.save();
  b=await I.buyUpgrade('g','ann','tub',s,now); assert.match(b.error,/maxed/);
  console.log('✓ upgrades spend the bank, raise the rate, and respect cost and max level');

  // ---- cashing out → XP, capped per day
  const paid=[]; const adjustXp=async(gu,u,d)=>paid.push([u,d]);
  f=await I.getFactory('g','ann'); f.bank=5000; f.upgrades={}; f.markModified('upgrades'); f.cashoutDay=null; f.cashoutXpToday=0; f.lastTick=now-4*H; await f.save(); // 240 pending, uncollected
  let out=await I.cashout(guild,'ann',s,{now,adjustXp});
  assert.equal(out.xp,300,'capped at the 300 XP/day limit'); assert.equal(out.spent,3000); assert.equal(out.state.bank,2000,'cashed out from the bank only');
  assert.equal(I.pendingBubbles(out.state,s,now),240,'pending bubbles are NOT auto-cashed — collect first');
  assert.deepEqual(paid.at(-1),['ann',300]);
  out=await I.cashout(guild,'ann',s,{now,adjustXp}); assert.match(out.error,/today's cash-out cap/i);
  // Next day the cap resets. (Pin bank/lastTick so no new bubbles accrue over the gap.)
  const tmr=now+24*H; f=await I.getFactory('g','ann'); f.bank=2000; f.lastTick=tmr; await f.save();
  out=await I.cashout(guild,'ann',s,{now:tmr,adjustXp});
  assert.equal(out.xp,200,'2000 🫧 ÷ 10 = 200 XP, under the cap'); assert.equal(out.state.bank,0);
  // Cash-out can be turned off.
  out=await I.cashout(guild,'ann',{...s,dailyXpCap:0},{now:tmr,adjustXp}); assert.match(out.error,/turned off/);
  console.log('✓ cash-out converts 🫧 → XP at the set rate, capped per day, resets at midnight, and can be disabled');

  // ---- admin: give / take / reset
  let g1=await I.adminAdjustBubbles('g','ann',500);
  assert.equal(g1.applied,500); assert.equal(g1.state.bank>=500,true,'giving adds to the bank');
  const lifeBefore=g1.state.lifetime;
  let t1=await I.adminAdjustBubbles('g','ann',-100);
  assert.equal(t1.applied,-100,'taking removes from the bank');
  assert.equal(t1.state.lifetime,lifeBefore,'taking does not lower lifetime');
  let t2=await I.adminAdjustBubbles('g','ann',-1e9);
  assert.equal(t2.state.bank,0,'bank never goes below 0');
  await I.resetFactory('g','ann');
  const fresh=await I.getFactory('g','ann');
  assert.equal(fresh.bank,0); assert.equal(fresh.lifetime,0,'reset wipes the factory');
  console.log('✓ admin give/take clamps at 0 (lifetime unaffected by takes), and reset wipes a factory');

  // ---- leaderboard
  await M('IdleFactory').create({guildId:'g',userId:'ben',lifetime:50000,bank:0,upgrades:{scrubber:3}});
  const top=await I.leaderboard(guild,{now,limit:5});
  assert.equal(top[0].userId,'ben'); assert.equal(top[0].lifetime,50000); assert.equal(top[0].rate,60+90);
  assert.equal(top[1].name,'Ann');
  console.log('✓ leaderboard ranks factories by lifetime bubbles');

  // ---- the embed builds
  const em=I.factoryEmbed(await I.getFactory('g','ann'),s,{name:'Ann',now}).data;
  assert.match(em.title,/Ann's Bubble Factory/); assert.ok(em.fields.find((x)=>x.name.includes('Bank')));
  console.log('✓ the factory embed builds');
  process.exit(0);
})().catch((e)=>{console.error(e);process.exit(1);});
