// In-memory stand-in for the Mongoose calls the bot uses (enough for tests).
function store(Model){
  const rows=[]; let id=1;
  const get=(o,k)=>k.split('.').reduce((x,p)=>x?.[p],o);
  const eq=(a,b)=>{ if(a instanceof Date||b instanceof Date||(typeof a==='string'&&/^\d{4}-\d\d-\d\dT/.test(a))) return a!=null&&b!=null&&new Date(a).getTime()===new Date(b).getTime(); if(b===null) return a===null||a===undefined; return String(a)===String(b); };
  const m1=(r,k,v)=>{ const val=get(r,k);
    if(v instanceof RegExp) return v.test(val??'');
    if(v&&v._bsontype) return String(val)===String(v);
    if(v&&typeof v==='object'&&!Array.isArray(v)&&!(v instanceof Date)){
      if('$in' in v) return v.$in.map(String).includes(String(val));
      if('$nin' in v) return !v.$nin.map(String).includes(String(val));
      if('$exists' in v) return v.$exists ? val!==undefined : val===undefined;
      if('$lt' in v) return val!=null && (typeof v.$lt==='number'?Number(val)<v.$lt:new Date(val)<new Date(v.$lt));
      if('$gte' in v) return new Date(val)>=new Date(v.$gte);
      if('$gt' in v) return val!=null && (typeof v.$gt==='number'?Number(val)>v.$gt:new Date(val)>new Date(v.$gt));
      if('$lte' in v) return new Date(val)<=new Date(v.$lte);
      if('$ne' in v) return Array.isArray(val)?!val.map(String).includes(String(v.$ne)):!eq(val,v.$ne);
      return true; }
    if(Array.isArray(val)) return val.map(String).includes(String(v));
    return eq(val,v); };
  const expr=(r,e)=>{ if(e.$lt){ const [a,b]=e.$lt.map(x=>x&&x.$size?(get(r,x.$size.slice(1))||[]).length:typeof x==='string'&&x.startsWith('$')?get(r,x.slice(1)):x); return a<b; } return true; };
  const match=(r,q={})=>Object.entries(q).every(([k,v])=>k==='$or'?v.some(s=>match(r,s)):k==='$expr'?expr(r,v):m1(r,k,v));
  const clone=(x)=>x&&JSON.parse(JSON.stringify(x));
  const hydrate=(r)=>{ if(!r) return null; const d=new Model(clone(r)); d._id=r._id; d.save=async function(){ const o=this.toObject(); Object.assign(r,clone({...o,_id:r._id})); return this; }; return d; };
  const setPath=(r,k,v)=>{ const parts=k.split('.'); let o=r; while(parts.length>1){const p=parts.shift(); o[p]=o[p]||{}; o=o[p];} o[parts[0]]=v instanceof Date?v.toISOString():v; };
  const apply=(r,u,inserted=false)=>{ if(Array.isArray(u)){ require('mingo/init/system'); const { Aggregator }=require('mingo'); const out=new Aggregator(u).run([clone(r)])[0]; for(const k of Object.keys(r)) delete r[k]; Object.assign(r,clone(out)); return; } const ops=['$set','$inc','$push','$max','$setOnInsert']; const set=u.$set||(!ops.some(o=>u[o])?u:{}); for(const [k,v] of Object.entries(set)) setPath(r,k,v);
    if(u.$inc) for(const [k,v] of Object.entries(u.$inc)) setPath(r,k,(get(r,k)||0)+v);
    if(u.$max) for(const [k,v] of Object.entries(u.$max)) if(!(get(r,k)>=v)) setPath(r,k,v);
    if(inserted&&u.$setOnInsert) for(const [k,v] of Object.entries(u.$setOnInsert)) setPath(r,k,v);
    if(u.$push) for(const [k,v] of Object.entries(u.$push)) (r[k]=r[k]||[]).push(v); };
  const query=(arr)=>{ const o={ sort(s){ const [[k,d]]=Object.entries(s); arr=[...arr].sort((a,b)=>(get(a,k)>get(b,k)?1:-1)*d); return o; }, skip(n){arr=arr.slice(n);return o;}, limit(n){arr=arr.slice(0,n);return o;}, lean:async()=>clone(arr), catch(){return o;}, then:(a,b)=>Promise.resolve(arr.map(hydrate)).then(a,b)}; return o; };
  const newId=()=> (id++).toString(16).padStart(24,'0');
  Model.find=(q)=>query(rows.filter(r=>match(r,q)));
  Model.findOne=(q)=>{ let hits=rows.filter(x=>match(x,q)); let lean=false; const p=Promise.resolve().then(()=>{ const r=hits[0]; return lean?(clone(r)||null):hydrate(r); }); p.lean=()=>{ lean=true; return p; }; p.sort=(sp)=>{ const [[k,d]]=Object.entries(sp); hits=[...hits].sort((a,b)=>(get(a,k)>get(b,k)?1:-1)*d); return p; }; p.catch=p.catch.bind(p); return p; };
  Model.findById=(id2)=>Model.findOne({_id:String(id2)});
  Model.countDocuments=async(q)=>rows.filter(r=>match(r,q)).length;
  Model.exists=async(q)=>rows.some(r=>match(r,q));
  Model.create=async(d)=>{ const doc=new Model(d); const r={...clone(doc.toObject()),_id:newId(),createdAt:new Date().toISOString()}; rows.push(r); return hydrate(r); };
  const withLean=(fn)=>{ let lean=false; const run=Promise.resolve().then(()=>fn()); const p=run.then((r)=>lean?clone(r):hydrate(r)); p.lean=()=>{ lean=true; return p; }; return p; };
  Model.findOneAndUpdate=(q,u,o={})=>withLean(()=>{ let r=rows.find(x=>match(x,q)); let inserted=false; if(!r){ if(!o.upsert) return null; const doc=new Model(Object.fromEntries(Object.entries(q).filter(([k,v])=>typeof v!=='object'))); r={...clone(doc.toObject()),_id:newId()}; rows.push(r); inserted=true; } const before=clone(r); apply(r,u,inserted); if(o.new===false) return inserted?null:before; return r; });
  Model.findOneAndDelete=(q)=>withLean(()=>{ const i=rows.findIndex(x=>match(x,q)); return i<0?null:rows.splice(i,1)[0]; });
  Model.updateOne=async(q,u,o={})=>{ let r=rows.find(x=>match(x,q)); let ins=false; if(!r&&o.upsert){ r={...Object.fromEntries(Object.entries(q).filter(([k,v])=>typeof v!=='object')),_id:newId()}; rows.push(r); ins=true;} if(r) apply(r,u,ins); return {modifiedCount:r?1:0}; };
  Model.updateMany=async(q,u)=>{ let n=0; for(const r of rows) if(match(r,q)){ apply(r,u); n++; } return {modifiedCount:n}; };
  Model.aggregate=(pipeline)=>{ require('mingo/init/system'); const { Aggregator }=require('mingo'); const p=Promise.resolve().then(()=>new Aggregator(pipeline).run(clone(rows))); return p; };
  Model.deleteOne=async(q)=>{ const i=rows.findIndex(x=>match(x,q)); if(i>=0) rows.splice(i,1); return {deletedCount:i>=0?1:0}; };
  Model.replaceOne=async(q,doc,o={})=>{ const i=rows.findIndex(x=>match(x,q)); const r={...clone(doc),_id:i>=0?rows[i]._id:newId()}; if(i>=0) rows[i]=r; else if(o.upsert) rows.push(r); return {modifiedCount:1}; };
  Model.deleteMany=async(q)=>{ let n=0; for(let i=rows.length-1;i>=0;i--) if(match(rows[i],q)){rows.splice(i,1);n++;} return {deletedCount:n}; };
  Model.insertMany=async(list)=>{ for(const d of list) rows.push({...clone(new Model(d).toObject()),_id:newId(),createdAt:new Date().toISOString()}); return list; };
  Model.bulkWrite=async(ops)=>{ for(const op of ops){ if(op.replaceOne) await Model.replaceOne(op.replaceOne.filter,op.replaceOne.replacement,{upsert:op.replaceOne.upsert}); } return {}; };
  return rows;
}
module.exports={store};
