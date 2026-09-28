process.env.TOKEN='x';process.env.CLIENT_ID='1';process.env.MONGODB_URI='m';
const root=require('path').join(__dirname,'..')+'/'; const assert=require('assert');
const { Collection } = require(root+'node_modules/discord.js');
const G=require(root+'src/bot/cogs/modules/giveaways');
// 1) weighted pick is fair and weighted
const ids=['a','b','c','d']; const w=new Map([['a',3],['b',1],['c',1],['d',1]]); const hits={a:0,b:0,c:0,d:0};
for (let i=0;i<60000;i++) hits[G.weightedPick(ids,w,1)[0]]++;
const share=hits.a/60000; assert.ok(Math.abs(share-0.5)<0.02, 'a has 3 of 6 tickets ≈ 50%: '+share);
assert.ok(Math.abs(hits.b/60000-1/6)<0.02);
const many=G.weightedPick(ids,w,4); assert.equal(new Set(many).size,4,'no duplicates');
console.log('✓ weighted draw: 3 tickets ≈ 50% (got '+(share*100).toFixed(1)+'%), 1 ticket ≈ 16.7%, never picks the same person twice');
// 2) uniform when no bonus: roughly even
const even={a:0,b:0,c:0,d:0}; const one=new Map(); for(let i=0;i<40000;i++) even[G.weightedPick(ids,one,1)[0]]++;
Object.values(even).forEach(v=>assert.ok(Math.abs(v/40000-0.25)<0.02)); console.log('✓ without bonuses every entrant has an equal chance');
// 3) entryWeights uses best role bonus
const mem=(id,roles)=>({id,roles:{cache:new Map(roles.map(r=>[r,true]))}});
const guild={members:{fetch:async({user})=>new Collection(user.map(id=>[id,{ 'x':mem('x',['boost','vip']), 'y':mem('y',['vip']), 'z':mem('z',[]) }[id]]))}};
(async()=>{
  const g={bonusEntries:[{roleId:'boost',extra:2},{roleId:'vip',extra:1}]};
  const ws=await G.entryWeights(guild,g,['x','y','z']); assert.deepEqual([...ws.values()],[3,2,1]);
  console.log('✓ tickets: best bonus role counts (Booster+2 & VIP+1 → 3; VIP → 2; none → 1)');
  assert.deepEqual(G.cleanBonus([{roleId:'r',extra:50},{roleId:'r',extra:2},{roleId:'',extra:1},{roleId:'q',extra:0}]),[{roleId:'r',extra:10}]);
  assert.match(G.describeBonus(g),/<@&boost> \+2 · <@&vip> \+1/);
  const emb=G.buildGiveawayEmbed({...g,type:'timed',prize:'P',customDesc:'d',winnerCount:1,endTimestamp:Date.now()+1e6,hostId:'h',entries:[],colorHex:'#5865F2'}).toJSON();
  assert.match(emb.description,/Bonus entries/);
  console.log('✓ bonus shown on the giveaway embed; invalid bonus values cleaned');
  process.exit(0);
})().catch(e=>{console.error(e);process.exit(1);});
