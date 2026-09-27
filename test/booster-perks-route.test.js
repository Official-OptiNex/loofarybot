process.env.TOKEN='x';process.env.CLIENT_ID='123';process.env.MONGODB_URI='mongodb://x';
const root=require('path').join(__dirname,'..')+'/'; const assert=require('assert');
const L=require(root+'src/bot/cogs/modules/leveling'); const cfg={save:async()=>{}}; L.getOrCreateConfig=async()=>cfg;
const router=require(root+'src/web/routes/api');
const layer=router.stack.find(l=>l.route&&l.route.path==='/guilds/:guildId/levels/boosterperks');
const h=layer.route.stack.at(-1).handle;
const guild={id:'g',premiumSubscriptionCount:4,channels:{cache:new Map([['c1',{}]])}};
const call=(body)=>new Promise((res)=>{const r={code:200,status(c){r.code=c;return r;},json(d){res({code:r.code,...d});}};h({guild,body},r);});
(async()=>{
  let r=await call({enabled:true,extraGambles:'3',giveawayEntries:'2',dailyXp:'150',boostXp:'',channelId:'c1'});
  assert.equal(r.code,200); assert.deepEqual(cfg.boosterPerks,{enabled:true,extraGambles:3,giveawayEntries:2,dailyXp:150,boostXp:0,channelId:'c1'});
  r=await call({giveawayEntries:'50'}); assert.equal(r.code,400); assert.match(r.error,/Extra giveaway entries/);
  r=await call({channelId:'nope'}); assert.equal(r.code,400);
  console.log('✓ booster perks API saves and validates');
})().catch(e=>{console.error(e);process.exit(1);});
