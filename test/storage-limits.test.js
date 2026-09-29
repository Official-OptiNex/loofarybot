// Free-tier guardrails: the per-server log cap, the database watchdog (low-space mode), the
// settings cache and its invalidation, and "known member" tracking for chat XP.
process.env.TOKEN='x';process.env.CLIENT_ID='123';process.env.MONGODB_URI='mongodb://x';
process.env.CONFIG_CACHE_MS='30000'; // this test checks the real cache (other tests turn it off)
const root=require('path').join(__dirname,'..')+'/'; const assert=require('assert');
const { store } = require('./helpers/memstore');
const M=(n)=>require(root+'src/database/models/'+n);

(async()=>{
  // ================================================================ Settings cache
  const GuildConfig=M('GuildConfig');
  const cache=require(root+'src/database/configCache');
  let reads=0; const realFindOne=GuildConfig.findOne;
  GuildConfig.findOne=async(q)=>{ reads++; return new GuildConfig({guildId:q.guildId}); };
  const a=await cache.getCachedConfig('g1'); await cache.getCachedConfig('g1'); await cache.getCachedConfig('g1');
  assert.equal(reads,1,'three reads within the TTL → one database read');
  assert.equal(a.levelingEnabled,true,'schema defaults are filled in (lean reads would miss them)');
  assert.equal(a.logRetentionDays,30);
  // A write through the model clears the cache (the real Mongoose hook runs before the query fails
  // — there's no database here).
  await GuildConfig.updateOne({guildId:'g1'},{$set:{levelingEnabled:false}}).catch(()=>null);
  await cache.getCachedConfig('g1'); assert.equal(reads,2,'updateOne cleared it');
  await GuildConfig.findOneAndUpdate({guildId:'g1'},{$inc:{caseCounter:1}}).catch(()=>null);
  await cache.getCachedConfig('g1'); assert.equal(reads,3,'findOneAndUpdate cleared it');
  await cache.getCachedConfig('g2'); await GuildConfig.updateMany({},{$set:{x:1}}).catch(()=>null);
  await cache.getCachedConfig('g2'); assert.equal(reads,5,'a write without a guildId clears everything');
  const doc=new GuildConfig({guildId:'g1'}); await doc.save().catch(()=>null); await cache.getCachedConfig('g1'); assert.ok(reads>=5);
  GuildConfig.findOne=realFindOne;
  console.log('✓ settings cache: 1 read per 30s per server instead of 2–3 per chat message; any write clears it at once');

  // ================================================================ Known members (chat XP)
  const known=require(root+'src/database/knownMembers'); const UserLevel=M('UserLevel');
  known.remember('g','u1'); known.remember('g','u2'); assert.ok(known.has('g','u1'));
  await UserLevel.deleteOne({guildId:'g',userId:'u1'}).catch(()=>null);
  assert.ok(!known.has('g','u1'),'deleting a record forgets that member'); assert.ok(known.has('g','u2'));
  await UserLevel.deleteMany({guildId:'g'}).catch(()=>null); assert.ok(!known.has('g','u2'),'bulk deletes forget everyone');
  console.log('✓ chat XP skips the "has a record?" query for members it has seen, and forgets them when records are deleted');

  // ================================================================ Log cap + watchdog
  const rows={}; for (const n of ['LogEntry','ChatDrop','Poll','Giveaway','Ticket','XpPot']) rows[n]=store(M(n));
  rows.GuildConfig=store(GuildConfig);
  const St=require(root+'src/bot/cogs/modules/storage');
  const now=Date.now();
  for (let i=0;i<30;i++) rows.LogEntry.push({_id:'a'+i,guildId:'big',type:i%2?'voice':'automod',createdAt:new Date(now-i*60000).toISOString()});
  for (let i=0;i<5;i++) rows.LogEntry.push({_id:'b'+i,guildId:'small',type:'voice',createdAt:new Date(now-i*60000).toISOString()});
  const removed=await St.pruneByCount(20);
  assert.equal(removed,10); assert.equal(rows.LogEntry.filter(l=>l.guildId==='big').length,20); assert.equal(rows.LogEntry.filter(l=>l.guildId==='small').length,5);
  assert.ok(rows.LogEntry.filter(l=>l.guildId==='big').every(l=>Number(l._id.slice(1))<20),'the newest ones are kept');
  console.log(`✓ log cap: at most ${St.MAX_LOGS_PER_GUILD.toLocaleString()} entries per server (tested with 20) — the newest are kept`);

  assert.equal(St.shouldStoreLog('voice'),true);
  let w=await St.watchdog(null,now,async()=>({usedMb:200,limitMb:512,share:200/512}));
  assert.equal(w.lowSpace,false); assert.equal(St.shouldStoreLog('commands'),true);
  for (let i=0;i<5;i++) rows.LogEntry.push({_id:'old'+i,guildId:'big',type:'voice',createdAt:new Date(now-10*864e5).toISOString()});
  const alerts=[]; const reporter=require(root+'src/bot/utils/errorReporter'); reporter.reportIssue=async(g,t,d)=>alerts.push([g,t,d]);
  const client={guilds:{cache:new Map([['big',{id:'big'}]])}};
  w=await St.watchdog(client,now,async()=>({usedMb:400,limitMb:512,share:400/512}));
  assert.equal(w.lowSpace,true); assert.ok(w.removed.logs>=5,'emergency: logs older than 7 days removed');
  assert.equal(St.shouldStoreLog('voice'),false,'low space: noisy logs are no longer stored'); assert.equal(St.shouldStoreLog('modActions'),true); assert.equal(St.shouldStoreLog('automod'),true);
  assert.equal(alerts.length,1); assert.match(alerts[0][2],/400 MB of 512 MB/);
  await St.watchdog(client,now,async()=>({usedMb:410,limitMb:512,share:410/512})); assert.equal(alerts.length,1,'alerted at most once a day');
  w=await St.watchdog(client,now,async()=>({usedMb:150,limitMb:512,share:150/512})); assert.equal(w.lowSpace,false); assert.equal(St.shouldStoreLog('voice'),true,'back to normal');
  console.log('✓ watchdog: past 75% of the 512 MB database it trims harder, keeps only moderation logs and alerts once a day; normal again when space frees up');

  const mem=St.memoryUsage(); assert.ok(mem.rssMb>0 && mem.limitMb===512);
  process.exit(0);
})().catch(e=>{console.error(e);process.exit(1);});
