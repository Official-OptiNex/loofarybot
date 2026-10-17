// /calculate pets · guns: parsing what people type, the merge maths (2 of a rarity = 1 of the next,
// owned pets count), the result embed, the form (pre-filled from last time) and the DM copy.
process.env.TOKEN='x';process.env.CLIENT_ID='123';process.env.MONGODB_URI='mongodb://x';
const root=require('path').join(__dirname,'..')+'/'; const assert=require('assert');
const { store } = require('./helpers/memstore');
const CalcProfile=require(root+'src/database/models/CalcProfile'); store(CalcProfile);
const C=require(root+'src/bot/cogs/modules/calculator');
const cmd=require(root+'src/bot/commands/calculate');

const at=(obj)=>{ const c=new Array(13).fill(0); for(const [t,n] of Object.entries(obj)) c[C.TIERS.indexOf(t)]=n; return c; };

// ---- parsing: every way people write it
for (const text of ['b 2, sss 2','2x b, 2x sss','B=2 SSS=2','b: 2\nsss: 2','b 2 sss 2','2 b 2 sss','2 x b, sss x2','b x2 and sss 2']) {
  const p=C.parseCounts(text);
  assert.deepEqual(p.counts,at({b:2,sss:2}),text); assert.deepEqual(p.unknown,[],text);
}
assert.deepEqual(C.parseCounts('3x zzz, 2x xxx').counts,at({zzz:3,xxx:2}));
assert.deepEqual(C.parseCounts('xx, zzz').counts,at({xx:1,zzz:1}),'a rarity alone = 1');
assert.deepEqual(C.parseCounts('2x x').counts,at({x:2}),'"2x x" = two X');
assert.deepEqual(C.parseCounts('').counts,at({})); assert.deepEqual(C.parseCounts('none').counts,at({}));
assert.deepEqual(C.parseCounts('b 2, q 5').unknown,['q','5'],'unreadable bits reported');
assert.equal(C.parseCounts('d 99999').counts[0],1000,'capped');
console.log('✓ parsing');

// ---- maths
let r=C.plan(at({}),at({zzz:1}));
assert.equal(r.buyD,4096,'ZZZ = 2^12 D'); assert.equal(r.buyD*100,409600,'matches the Diamond Spending Guide (ZZZ = 409,600)');
r=C.plan(at({b:2,sss:2}),at({zzz:3}));
assert.equal(r.buyD,3*4096-(2*4+2*64),'owned pets are merged in'); assert.deepEqual(r.leftover,at({}));
r=C.plan(at({zzz:1}),at({zzz:3})); assert.equal(r.buyD,8192,'owned ZZZ counts'); assert.equal(r.goals[0].owned,1);
r=C.plan(at({z:1}),at({xxx:2})); assert.equal(r.buyD,512,'a spare higher pet covers a lower goal'); assert.deepEqual(r.goals[0].upgraded,[10]);
r=C.plan(at({d:1}),at({c:1})); assert.equal(r.buyD,1);
r=C.plan(at({a:3}),at({a:2})); assert.equal(r.buyD,0); assert.deepEqual(r.leftover,at({a:1}),'spares listed');
// several goals share the owned pets (highest goal first): 3x ZZZ + 2x XXX from 1 XXX + 3 SS
r=C.plan(at({xxx:1,ss:3}),at({zzz:3,xxx:2}));
assert.equal(r.buyD,3*4096+2*512-512-3*32,'everything owned is used once');
assert.equal(r.goals.find((g)=>g.tier===9).owned,1,'the owned XXX counts toward the XXX goal');
// a pet is never split: an S covers one C goal (it's better), the other C is built
r=C.plan(at({s:1}),at({c:2})); assert.equal(r.buyD,2); assert.deepEqual(r.goals[0].upgraded,[4]);
// a higher pet under a bigger goal is merged into it rather than wasted on a small one
r=C.plan(at({z:1}),at({zzz:1,c:1})); assert.equal(r.buyD,4096-1024+2,'the Z goes into the ZZZ');
console.log('✓ maths');

// ---- embed
const emb=C.resultEmbed('pets',at({b:2,sss:2}),at({zzz:3}),C.plan(at({b:2,sss:2}),at({zzz:3})),{id:'u1'}).toJSON();
const all=JSON.stringify(emb);
assert.match(all,/SSS\*\* ×2 · \*\*B\*\* ×2/,'inventory, highest first');
assert.match(all,/12,152\*\* D pets/); assert.match(all,/1,215,200\*\* Pet Gems/); assert.match(all,/1,215,200\*\* Diamonds/);
assert.match(all,/merges your \*\*SSS\*\* ×2 · \*\*B\*\* ×2/);
const gun=JSON.stringify(C.resultEmbed('guns',at({}),at({zzz:1}),C.plan(at({}),at({zzz:1}))).toJSON());
assert.match(gun,/409,600\*\* Diamonds/); assert.doesNotMatch(gun,/Pet Gems/,'guns cost diamonds only');
assert.match(JSON.stringify(C.resultEmbed('pets',at({zzz:1}),at({zzz:1}),C.plan(at({zzz:1}),at({zzz:1}))).toJSON()),/already have everything/);
// fish: random draws instead of D summons — averages from the draw odds
assert.equal(C.drawValue(C.KINDS.fish.draws.free.odds),1.6,'free draw: D60/C30/B10 → 1.6 D'); assert.equal(C.drawValue(C.KINDS.fish.draws.epic.odds),3.2,'epic draw: C60/B30/A10 → 3.2 D');
let dp=C.drawPlan(C.KINDS.fish,2); assert.equal(dp.perD*2,125,'a C fish ≈ 125 Diamonds (as the guide says)');
dp=C.drawPlan(C.KINDS.fish,4096); assert.equal(dp.diamonds,256000,'ZZZ fish ≈ 256,000 Diamonds (as the guide says)'); assert.equal(dp.freeDays,512,'or ~512 days of free draws (the guide: 500+ days)');
const fishE=JSON.stringify(C.resultEmbed('fish',at({ss:1}),at({zzz:1}),C.plan(at({ss:1}),at({zzz:1}))).toJSON());
assert.match(fishE,/4,064\*\* D-worth of fish/); assert.match(fishE,/1,270\*\* epic draws ≈ \*\*254,000\*\* Diamonds/); assert.match(fishE,/508\*\* days of free daily draws/);
assert.match(fishE,/saves ~500 Diamonds/); assert.doesNotMatch(fishE,/Pet Gems/);
console.log('✓ result embed (pets, guns, fish)');

// ---- /calculate panel: menu → pets/guns → 13 rarity buttons for inventory + goal → calculate (+ DM)
const mkUser=(dmOk=true)=>({id:'u1',dms:[],send:async function(p){ if(!dmOk) throw new Error('closed'); this.dms.push(p); }});
const btn=(customId,u)=>{ const r={customId,user:u,out:null,modal:null,reply:async(o)=>{r.out=o;},update:async(o)=>{r.out=o;},showModal:async(m)=>{r.modal=m;}}; return r; };
const sub=(customId,u,n)=>{ const r={customId,user:u,out:null,isFromMessage:()=>true,fields:{getTextInputValue:()=>n},update:async(o)=>{r.out=o;},reply:async(o)=>{r.out=o;}}; return r; };
const ids=(view)=>view.components.flatMap((row)=>row.toJSON().components.map((c)=>c.custom_id));
const labels=(view)=>view.components.flatMap((row)=>row.toJSON().components.map((c)=>c.label));
(async()=>{
  const u=mkUser();
  let r={user:u,reply:async(o)=>{r.out=o;}}; await cmd.execute(r);
  assert.equal(r.out.ephemeral,true); assert.deepEqual(ids(r.out),['calc:pets:have','calc:guns:have','calc:fish:have'],'step 1: pick pets or guns');
  // pets → inventory panel with a button per rarity
  let i=btn('calc:pets:have',u); await cmd.handleCalcButton(i);
  const tierIds=ids(i.out).filter((x)=>x.includes(':set:'));
  assert.equal(tierIds.length,13,'13 rarity buttons'); assert.equal(tierIds[0],'calc:pets:set:have:0'); assert.equal(tierIds[12],'calc:pets:set:have:12');
  assert.ok(labels(i.out).includes('ZZZ · 0'),'every rarity starts at 0');
  assert.ok(ids(i.out).includes('calc:pets:want') && ids(i.out).includes('calc:pets:calc'),'goal + calculate buttons');
  // set B = 2 and SSS = 2 through the number boxes
  i=btn('calc:pets:set:have:2',u); await cmd.handleCalcButton(i);
  assert.match(JSON.stringify(i.modal.toJSON()),/How many B pets do you own/);
  i=sub('calcm:pets:have:2',u,'2'); await cmd.handleCalcModal(i); assert.match(i.out.content,/B: \*\*2\*\*/); assert.ok(labels(i.out).includes('B · 2'),'the button shows the new count');
  await cmd.handleCalcModal(sub('calcm:pets:have:6',u,'2'));
  i=sub('calcm:pets:have:0',u,'abc'); await cmd.handleCalcModal(i); assert.match(i.out.content,/isn't a number/);
  i=btn('calc:pets:set:have:2',u); await cmd.handleCalcButton(i); assert.match(JSON.stringify(i.modal.toJSON()),/"value":"2"/,'box pre-filled with the saved number');
  // calculate with no goal → sent to the goal panel
  i=btn('calc:pets:calc',u); await cmd.handleCalcButton(i); assert.match(i.out.content,/Set your goal first/); assert.ok(ids(i.out).includes('calc:pets:set:want:12'));
  // goal: 3x ZZZ
  await cmd.handleCalcModal(sub('calcm:pets:want:12',u,'3'));
  i=btn('calc:pets:want',u); await cmd.handleCalcButton(i);
  assert.match(JSON.stringify(i.out.embeds[0].toJSON()),/SSS\*\* ×2 · \*\*B\*\* ×2/,'inventory shown'); assert.match(JSON.stringify(i.out.embeds[0].toJSON()),/ZZZ\*\* ×3/,'goal shown');
  i=btn('calc:pets:calc',u); await cmd.handleCalcButton(i);
  assert.match(JSON.stringify(i.out.embeds[0].toJSON()),/12,152\*\* D pets/); assert.match(i.out.content,/sent this to your DMs/); assert.equal(u.dms.length,1,'DM copy');
  // saved: reopening shows the same numbers; guns are separate
  i=btn('calc:pets:have',u); await cmd.handleCalcButton(i); assert.ok(labels(i.out).includes('SSS · 2'));
  i=btn('calc:guns:have',u); await cmd.handleCalcButton(i); assert.ok(labels(i.out).includes('SSS · 0'),'guns have their own numbers');
  // reset + closed DMs
  i=btn('calc:pets:reset:have',u); await cmd.handleCalcButton(i); assert.ok(!labels(i.out).some((l)=>/· [1-9]/.test(l)),'inventory cleared');
  const shy=mkUser(false); await cmd.handleCalcModal(sub('calcm:guns:want:12',shy,'1'));
  i=btn('calc:guns:calc',shy); await cmd.handleCalcButton(i); assert.match(i.out.content,/Couldn't DM you/); assert.match(JSON.stringify(i.out.embeds[0].toJSON()),/409,600\*\* Diamonds/);
  await cmd.handleCalcModal(sub('calcm:fish:want:12',u,'1'));
  i=btn('calc:fish:calc',u); await cmd.handleCalcButton(i); assert.match(JSON.stringify(i.out.embeds[0].toJSON()),/epic draws ≈ \*\*256,000\*\* Diamonds/,'fish calculator works through the panel');
  i=btn('calc:menu',u); await cmd.handleCalcButton(i); assert.deepEqual(ids(i.out),['calc:pets:have','calc:guns:have','calc:fish:have'],'back to the start');
  console.log('✓ /calculate panel: pick, 13 rarity buttons for inventory + goal, calculate + DM, saved');
  process.exit(0);
})().catch((e)=>{console.error(e);process.exit(1);});
