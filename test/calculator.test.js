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
console.log('✓ result embed');

// ---- command: form (pre-filled), quick options, DM copy
const user=(dmOk=true)=>({id:'u1',dms:[],send:async function(p){ if(!dmOk) throw new Error('closed'); this.dms.push(p); }});
const ix=(sub,opts={},u=user())=>{ const r={user:u,customId:`calcm:${sub}`,out:null,modal:null,
  options:{getSubcommand:()=>sub,getString:(k)=>opts[k]??null},
  fields:{getTextInputValue:(k)=>opts[k]??''},reply:async(o)=>{r.out=o;},showModal:async(m)=>{r.modal=m;}}; return r; };
(async()=>{
  let i=ix('pets'); await cmd.execute(i);
  assert.ok(i.modal,'no options → the form'); const mj=JSON.stringify(i.modal.toJSON()); assert.match(mj,/calcm:pets/);
  i=ix('pets',{have:'b 2, sss 2',want:'3x zzz'}); await i.user; await cmd.handleCalcModal(i);
  assert.equal(i.out.ephemeral,true); assert.match(i.out.content,/sent this to your DMs/); assert.equal(i.user.dms.length,1,'DM copy');
  assert.match(JSON.stringify(i.out.embeds[0].toJSON()),/12,152/);
  await new Promise((r)=>setTimeout(r,20));
  i=ix('pets'); await cmd.execute(i);
  assert.match(JSON.stringify(i.modal.toJSON()),/"value":"b 2, sss 2"/,'form pre-filled with last answers');
  i=ix('guns',{want:'1x zzz'},user(false)); await cmd.execute(i);
  assert.match(i.out.content,/Couldn't DM you/,'still replies when DMs are closed'); assert.match(JSON.stringify(i.out.embeds[0].toJSON()),/409,600/);
  i=ix('pets',{have:'b 2',want:'q'}); await cmd.handleCalcModal(i);
  assert.match(i.out.content,/Tell me what you want/,'nothing readable wanted → help');
  console.log('✓ /calculate: form, pre-fill, quick options, DM');
  process.exit(0);
})().catch((e)=>{console.error(e);process.exit(1);});
