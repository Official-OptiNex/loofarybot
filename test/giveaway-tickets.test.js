// The exact setup from a real giveaway: OG role +1, server booster perk +2 — checked with real
// discord.js member objects (not hand-made fakes).
process.env.TOKEN='x';process.env.CLIENT_ID='123';process.env.MONGODB_URI='mongodb://x';
const root=require('path').join(__dirname,'..')+'/'; const assert=require('assert');
const { Client, GatewayIntentBits } = require(root+'node_modules/discord.js');
const G=require(root+'src/bot/cogs/modules/giveaways');

const client=new Client({intents:[GatewayIntentBits.Guilds]});
const guild=client.guilds._add({id:'100000000000000001',name:'Lounge',owner_id:'1',channels:[],members:[],roles:[
  {id:'100000000000000001',name:'@everyone',permissions:'0',position:0},
  {id:'200000000000000002',name:'OG',permissions:'0',position:3},
  {id:'300000000000000003',name:'Server Booster',permissions:'0',position:2,tags:{premium_subscriber:null}},
  {id:'400000000000000004',name:'Member',permissions:'0',position:1}]});
const OG='200000000000000002', BOOST='300000000000000003', MEMBER='400000000000000004';
const now=new Date().toISOString();
const mk=(id,roles,premium=null)=>guild.members._add({user:{id,username:'u'+id},roles,premium_since:premium,joined_at:now});
const plain=mk('11',[MEMBER]), og=mk('12',[MEMBER,OG]), booster=mk('13',[MEMBER,BOOST],now), both=mk('14',[OG,BOOST],now);
const stale=mk('15',[MEMBER],now); // Discord says "boosting" but the booster role is gone (boost just ended)

const g={type:'timed',bonusEntries:[{roleId:OG,extra:1}],boosterEntries:2};
const t=(m)=>G.ticketBreakdown(m,g,2);
assert.equal(t(plain).tickets,1,'no OG, not boosting → 1 ticket');
assert.equal(t(og).tickets,2,'OG → 1 + 1');
assert.equal(t(booster).tickets,3,'booster → 1 + 2');
assert.equal(t(both).tickets,3,'OG + booster → best bonus only (1 + 2), not 1 + 1 + 2');
assert.equal(t(stale).tickets,1,'boost date without the booster role → no bonus');
assert.equal(G.describeTickets(t(booster)),'3 entries (1 + 2 from 💎 boosting)');
assert.equal(G.describeTickets(t(og)),`2 entries (1 + 1 from <@&${OG}>)`);
assert.equal(G.describeTickets(t(plain)),'1 entry');
console.log('✓ OG +1 / booster +2: plain 1 · OG 2 · booster 3 · OG+booster 3 (best bonus counts, no stacking)');

// If the booster role is ALSO added as a bonus role, boosters still get their best bonus once.
const g2={...g,bonusEntries:[{roleId:OG,extra:1},{roleId:BOOST,extra:2}]};
assert.equal(G.ticketBreakdown(booster,g2,2).tickets,3); assert.equal(G.ticketBreakdown(plain,g2,2).tickets,1);
// A role everyone has as a bonus gives everyone that bonus — which is what the breakdown makes visible.
const g3={...g,bonusEntries:[{roleId:MEMBER,extra:2}]};
assert.equal(G.ticketBreakdown(plain,g3,2).tickets,3); assert.equal(G.describeTickets(G.ticketBreakdown(plain,g3,2)),`3 entries (1 + 2 from <@&${MEMBER}>)`);
console.log('✓ booster role as a bonus role doesn’t double up; a bonus on a role everyone has shows up clearly in the breakdown');

// The draw uses the same numbers.
(async()=>{
  guild.members.fetch=async({user})=>new Map(user.map((id)=>[id,guild.members.cache.get(id)]));
  const w=await G.entryWeights(guild,g,['11','12','13','14']);
  assert.deepEqual([...w.values()],[1,2,3,3]);
  console.log('✓ the draw’s weights match what members are told');
  process.exit(0);
})().catch(e=>{console.error(e);process.exit(1);});
