process.env.TOKEN='x';process.env.CLIENT_ID='123';process.env.MONGODB_URI='mongodb://x';
const root=require('path').join(__dirname,'..')+'/'; const assert=require('assert');
const { store } = require('./helpers/memstore');
const M=(n)=>require(root+'src/database/models/'+n);
const rows={}; for (const n of ['GuildConfig','WelcomeConfig','AlertSubscription','EmbedTemplate','UserLevel','ConfigBackup','TicketConfig','ShopItem']) rows[n]=store(M(n));
const B=require(root+'src/bot/cogs/modules/backups');
const guild={id:'g',name:'Loof'};
(async()=>{
  await M('GuildConfig').create({guildId:'g',caseCounter:5,boosterDropDay:'2026-01-01',chatDrops:{enabled:true,channelIds:['c'],minXp:10,maxXp:20},counting:{enabled:true,channelId:'cnt',current:10,record:10},birthdays:{enabled:true,channelId:'bd',lastRunDay:'2026-01-01'},gamblingDailyWinCap:777});
  await M('TicketConfig').create({guildId:'g',supportRoleIds:['sup'],panel:{title:'Old title'},counter:3});
  const shopItem=await M('ShopItem').create({guildId:'g',type:'collectible',name:'Duck',emoji:'🦆',price:100,sold:7});
  const backup=await B.exportGuild(guild);
  assert.equal(backup.data.tickets.panel.title,'Old title'); assert.ok(!('counter' in backup.data.tickets));
  assert.equal(B.summarize(backup).hasTickets,true);
  // life goes on: more cases, tickets, drops
  rows.GuildConfig[0].caseCounter=42; rows.GuildConfig[0].boosterDropDay='2026-09-27'; rows.GuildConfig[0].chatDrops.nextDropAt='2026-09-27T10:00:00.000Z';
  rows.GuildConfig[0].counting.current=250; rows.GuildConfig[0].counting.record=300; rows.GuildConfig[0].counting.channelId='moved'; rows.GuildConfig[0].birthdays.lastRunDay='2026-09-27';
  rows.ShopItem[0].price=999; rows.ShopItem[0].sold=7;
  rows.TicketConfig[0].counter=19; rows.TicketConfig[0].panel.title='New title'; rows.GuildConfig[0].gamblingDailyWinCap=5;
  await B.importGuild(guild,backup);
  const cfg=rows.GuildConfig.find(r=>r.guildId==='g'); const tk=rows.TicketConfig.find(r=>r.guildId==='g');
  assert.equal(cfg.gamblingDailyWinCap,777,'settings restored'); assert.equal(tk.panel.title,'Old title','ticket settings restored');
  assert.equal(cfg.caseCounter,42,'case counter never goes backwards'); assert.equal(cfg.boosterDropDay,'2026-09-27'); assert.equal(cfg.chatDrops.nextDropAt,'2026-09-27T10:00:00.000Z'); assert.equal(cfg.chatDrops.minXp,10);
  assert.equal(tk.counter,19,'ticket numbers keep counting');
  const duck=rows.ShopItem.find(i=>String(i._id)===String(shopItem._id)); assert.equal(duck.price,100,'shop item restored in place'); assert.equal(duck.sold,7,'sales count kept'); assert.equal(rows.ShopItem.filter(i=>i.guildId==='g').length,1,'no duplicate');
  assert.equal(cfg.counting.current,250,'the count carries on'); assert.equal(cfg.counting.record,300); assert.equal(cfg.counting.channelId,'cnt','counting settings restored');
  assert.equal(cfg.birthdays.lastRunDay,'2026-09-27',"today's birthdays aren't posted again");
  assert.equal(rows.ConfigBackup.length,1,'safety backup taken first');
  console.log('✓ backups include ticket settings; restoring keeps case/ticket counters and today’s drop schedule');
  // cross-server import into a fresh server
  const g2={id:'g2',name:'Other'}; await B.importGuild(g2,backup);
  assert.equal(rows.TicketConfig.find(r=>r.guildId==='g2').counter,0); assert.equal(rows.GuildConfig.find(r=>r.guildId==='g2').caseCounter,5);
  console.log('✓ importing into another server starts its counters fresh');
  process.exit(0);
})().catch(e=>{console.error(e);process.exit(1);});
