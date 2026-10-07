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
  assert.equal(I.pendingBubbles({active:true,upgrades:new Map(),lastTick:now-2*H},s,now),120,'2h at 60/hr');
  assert.equal(I.pendingBubbles({active:true,upgrades:new Map(),lastTick:now-100*H},s,now),8*60,'capped at the offline window (8h)');
  assert.equal(I.pendingBubbles({active:true,upgrades:new Map(),lastTick:0},s,now),0,'a brand-new factory has nothing pending');
  assert.equal(I.pendingBubbles({active:false,upgrades:new Map(),lastTick:now-2*H},s,now),0,'a paused/never-started factory makes nothing');
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

  // ---- start / stop (the factory is opt-in and makes nothing until started)
  let f0=await I.getFactory('g','ann');
  assert.equal(!!f0.active,false,'a brand-new factory is not running yet');
  f0.lastTick=now-4*H; await f0.save();
  assert.equal((await I.collect('g','ann',s,now)).gained,0,'a stopped factory banks nothing');
  const started=await I.startFactory('g','ann',now);
  assert.equal(started.already,false); assert.equal(started.state.active,true,'start turns it on and resets accrual');
  const stopped=await I.stopFactory('g','ann');
  assert.equal(stopped.state.active,false,'stop pauses it (bank kept)');
  assert.equal((await I.stopFactory('g','ann')).already,true,'stopping an already-paused factory is a no-op');
  console.log('✓ start/stop: opt-in, resets accrual on start, pauses on stop');

  // ---- collect banks pending bubbles (once running)
  let f=await I.getFactory('g','ann'); f.active=true; f.lastTick=now-4*H; await f.save();
  let c=await I.collect('g','ann',s,now);
  assert.equal(c.gained,240); assert.equal(c.state.bank,240); assert.equal(c.state.lifetime,240);
  c=await I.collect('g','ann',s,now); assert.equal(c.gained,0,'nothing new right after collecting');
  console.log('✓ collect banks the pending bubbles (and nothing extra right after)');

  // ---- buying upgrades spends the (already-collected) bank, and does NOT auto-collect pending
  f=await I.getFactory('g','ann'); f.active=true; f.bank=1000; f.lastTick=now-4*H; await f.save(); // 240 pending, uncollected
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
  f=await I.getFactory('g','ann'); f.active=true; f.bank=5000; f.upgrades={}; f.markModified('upgrades'); f.cashoutDay=null; f.cashoutXpToday=0; f.lastTick=now-4*H; await f.save(); // 240 pending, uncollected
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

  // ---- "tub is full" alert sweep: DM the owner once, fall back to a channel, never repeat
  await M('IdleFactory').create({guildId:'g',userId:'cara',active:true,lastTick:now-100*H,upgrades:{}}); // full (8h cap)
  const dmed=[]; const posted=[];
  const chan={ isTextBased:()=>true, send:async(m)=>posted.push(m.content) };
  const sweepGuild={ id:'g', name:'Guild', channels:{ cache:new Collection([['chan',chan]]) } };
  let openDms=true;
  const fakeClient={
    guilds:{ cache:new Collection([['g',sweepGuild]]) },
    users:{ fetch:async(uid)=>{ if(!openDms) throw new Error('DMs closed'); return { send:async(m)=>dmed.push([uid,m.content]) }; } }
  };
  let n=await I.runFullAlertSweep(fakeClient,now);
  assert.equal(n,1,'one full factory notified'); assert.equal(dmed.at(-1)[0],'cara','DM went to the owner');
  n=await I.runFullAlertSweep(fakeClient,now);
  assert.equal(n,0,'already-notified factory is not pinged again');
  // Channel fallback when DMs are closed.
  await M('IdleFactory').create({guildId:'g',userId:'dan',active:true,lastTick:now-100*H,upgrades:{}});
  await M('GuildConfig').updateOne({guildId:'g'},{$set:{'idleGame.fullAlertChannelId':'chan'}});
  openDms=false;
  n=await I.runFullAlertSweep(fakeClient,now);
  assert.equal(n,1,'full factory with closed DMs still reached'); assert.match(posted.at(-1),/<@dan>/,'posted in the fallback channel');
  console.log('✓ full-tub sweep DMs once, falls back to a channel, and never double-pings');

  // ---- leaderboard
  await M('IdleFactory').create({guildId:'g',userId:'ben',lifetime:50000,bank:0,upgrades:{scrubber:3}});
  const top=await I.leaderboard(guild,{now,limit:5});
  assert.equal(top[0].userId,'ben'); assert.equal(top[0].lifetime,50000); assert.equal(top[0].rate,60+90);
  assert.ok(top.find((r)=>r.userId==='ann' && r.name==='Ann'),'member display names resolve from the guild cache');
  console.log('✓ leaderboard ranks factories by lifetime bubbles');

  // ---- the embed builds
  const em=I.factoryEmbed(await I.getFactory('g','ann'),s,{name:'Ann',now}).data;
  assert.match(em.title,/Ann's Bubble Factory/); assert.ok(em.fields.find((x)=>x.name.includes('Bank')));
  console.log('✓ the factory embed builds');

  // ---- configurable upgrades (per-guild cost / effect / max / enabled)
  const gg={id:'g'};
  const freshCfg=async()=>I.idleSettings(await M('GuildConfig').findOne({guildId:'g'}).lean());
  let up=await I.setUpgrade(gg,'scrubber',{baseCost:50,effect:100});
  assert.equal(up.upgrade.baseCost,50); assert.equal(up.upgrade.rate,100,'effect maps to the rate field');
  let s2=await freshCfg();
  assert.equal(I.upgradeCost('scrubber',0,s2.upgradeById),50,'override base cost is used');
  assert.equal(I.ratePerHour({active:true,upgrades:{scrubber:1}},s2),60+100,'override effect used in the rate');
  await I.setUpgrade(gg,'tub',{effect:5}); await I.setUpgrade(gg,'shine',{effect:20});
  s2=await freshCfg();
  assert.equal(I.offlineCapHours({upgrades:{tub:3}},s2),8+15,'tub effect (5h) × level 3');
  assert.equal(I.ratePerHour({active:true,upgrades:{shine:2}},s2),Math.round(60*(1+0.2*2)),'shine effect 20%/level');
  // disabling an upgrade removes it from the buyable set (but keeps it listed for the dashboard)
  await I.setUpgrade(gg,'jets',{enabled:false});
  s2=await freshCfg();
  assert.ok(!s2.upgradeById.jets,'disabled upgrade is not buyable');
  assert.equal(s2.allUpgrades.find((u)=>u.id==='jets').enabled,false,'still listed, marked disabled');
  assert.match((await I.buyUpgrade('g','ann','jets',s2)).error,/No such upgrade/);
  // bulk save, then reset
  await I.saveUpgrades(gg,[{id:'scrubber',baseCost:200,effect:40,max:5,enabled:true}]);
  s2=await freshCfg();
  assert.equal(I.upgradeCost('scrubber',0,s2.upgradeById),200); assert.equal(s2.upgradeById.scrubber.max,5);
  assert.ok(s2.upgradeById.jets,'bulk save (without jets) clears the old jets override → buyable again');
  await I.resetUpgrades(gg);
  s2=await freshCfg();
  assert.equal(I.upgradeCost('scrubber',0,s2.upgradeById),100,'back to the default cost after reset');
  console.log('✓ configurable upgrades: cost/effect/max/enabled, disable, bulk save and reset');

  // ---- Rebirth (prestige): reset bank+upgrades for permanent power + ⭐ stars
  const rs=I.idleSettings({idleGame:{enabled:true,rebirthBaseCost:1000,rebirthGrowth:2,rebirthBonusPct:20,starDivisor:100}});
  assert.deepEqual([rs.rebirthEnabled,rs.rebirthBaseCost,rs.rebirthGrowth,rs.rebirthBonusPct,rs.starDivisor],[true,1000,2,20,100]);
  assert.deepEqual([0,1,2].map((n)=>I.rebirthCost(n,rs)),[1000,2000,4000],'requirement doubles each rebirth');
  assert.equal(I.totalStarsFor(5000,rs),7,'floor(sqrt(5000/100))');
  assert.equal(I.prestigeMult({rebirths:2},rs).toFixed(2),'1.40','+20% per rebirth');
  let rx=await I.getFactory('g','rex'); rx.active=true; rx.lifetime=5000; rx.bank=777; rx.upgrades={scrubber:4}; rx.markModified('upgrades'); rx.lastTick=now; await rx.save();
  assert.equal(I.canRebirth(rx,rs),true,'5000 lifetime ≥ 1000 needed');
  let rb=await I.rebirth('g','rex',rs,now);
  assert.equal(rb.rebirths,1); assert.equal(rb.gained,7,'awarded √(5000/100) stars');
  assert.equal(rb.state.bank,0,'bank reset (no Nest Egg yet)'); assert.equal(rb.state.lifetime,5000,'lifetime kept');
  assert.deepEqual(rb.state.upgrades,{},'upgrades wiped'); assert.equal(I.ratePerHour(rb.state,rs),72,'60 × 1.2 prestige');
  // A second rebirth with no new lifetime awards no new stars (no double-paying).
  let rb2=await I.rebirth('g','rex',rs,now); assert.equal(rb2.rebirths,2); assert.equal(rb2.gained,0,'no new lifetime → no new stars');
  // Not enough lifetime → blocked.
  let rx2=await I.getFactory('g','ned'); rx2.active=true; rx2.lifetime=500; await rx2.save();
  assert.match((await I.rebirth('g','ned',rs,now)).error,/need \*\*1,000\*\* lifetime/);
  // Rebirth can be turned off.
  assert.match((await I.rebirth('g','rex',{...rs,rebirthEnabled:false},now)).error,/turned off/);
  console.log('✓ rebirth: resets run, keeps lifetime, awards √-scaled stars once, blocks under the requirement');

  // ---- Prestige perks (permanent, bought with ⭐) — on a fresh prestige-1 factory (no upgrades)
  await I.adminSetRebirth('g','rio',1); await I.adminGrantStars('g','rio',100);
  let bp=await I.buyPerk('g','rio','golden'); assert.equal(bp.newLevel,1); assert.equal(bp.cost,5);
  assert.equal(I.ratePerHour(bp.state,rs),Math.round(60*1.2*1.08),'Golden Touch adds +8% on top of prestige');
  bp=await I.buyPerk('g','rio','overflow'); assert.equal(I.dailyXpCapFor(bp.state,rs),rs.dailyXpCap+50,'Overflow lifts the daily XP cap');
  bp=await I.buyPerk('g','rio','reserves'); assert.equal(I.offlineCapHours(bp.state,rs),rs.offlineHours+2,'Deep Reserves extends offline storage');
  // Nest Egg gives starting bubbles on rebirth (rex: lifetime 5000, rebirths 2, needs 4000).
  await I.adminGrantStars('g','rex',100); await I.buyPerk('g','rex','nest');
  let rbn=await I.rebirth('g','rex',rs,now); assert.equal(rbn.state.bank,250,'Nest Egg gives starting bubbles on rebirth');
  // Can't afford → unchanged.
  let poor=await I.getFactory('g','pat'); poor.stars=0; await poor.save();
  assert.match((await I.buyPerk('g','pat','golden')).error,/costs/);
  console.log('✓ prestige perks: Golden Touch / Overflow / Deep Reserves / Nest Egg, star costs enforced');

  // ---- admin: stars + set rebirth
  let gs=await I.adminGrantStars('g','ann',25); assert.equal(gs.state.stars,25);
  gs=await I.adminGrantStars('g','ann',-10); assert.equal(gs.state.stars,15); assert.equal(gs.applied,-10);
  gs=await I.adminGrantStars('g','ann',-999); assert.equal(gs.state.stars,0,'stars never below 0');
  let sr=await I.adminSetRebirth('g','ann',7); assert.equal(sr.state.rebirths,7);
  // rebirth config validation
  assert.match(I.cleanSettings({rebirthBaseCost:100}).error,/Rebirth base cost/);
  assert.match(I.cleanSettings({rebirthGrowth:1.05}).error,/Rebirth growth/);
  console.log('✓ admin: grant/remove stars (clamped), set rebirth level, config validation');

  process.exit(0);
})().catch((e)=>{console.error(e);process.exit(1);});
