process.env.TOKEN='x';process.env.CLIENT_ID='123';process.env.MONGODB_URI='mongodb://x';
const root=require('path').join(__dirname,'..','..')+'/';
// ---- tiny in-memory model stand-in
let idc=1;
function memModel(Model){
  const rows=[];
  const match=(r,q)=>Object.entries(q||{}).every(([k,v])=>{ if(k==='$expr')return true; const val=k.split('.').reduce((o,p)=>o?.[p],r); if(v&&typeof v==='object'&&!Array.isArray(v)){ if('$ne' in v) return Array.isArray(val)?!val.includes(v.$ne):val!==v.$ne; if('$lte' in v) return val<=v.$lte; return true;} return String(val)===String(v); });
  const wrap=(r)=>{ if(!r) return null; const d=Object.assign(Object.create({save:async function(){Object.assign(r,JSON.parse(JSON.stringify(plain(this))));return this;},toObject:function(){return JSON.parse(JSON.stringify(plain(this)));},deleteOne:async function(){rows.splice(rows.indexOf(r),1);}}),JSON.parse(JSON.stringify(r))); return d; };
  const plain=(d)=>Object.fromEntries(Object.keys(d).map(k=>[k,d[k]]));
  const q=(arr)=>{const p=Promise.resolve(arr); const o={sort:()=>o,limit:(n)=>{arr=arr.slice(0,n);return o;},lean:async()=>JSON.parse(JSON.stringify(arr)),then:(a,b)=>Promise.resolve(arr.map(wrap)).then(a,b)}; return o;};
  const apply=(r,u)=>{ if(u.$set) Object.assign(r,u.$set); if(u.$push) for(const k in u.$push) r[k].push(u.$push[k]); };
  Model.find=(qq)=>q(rows.filter(r=>match(r,qq)));
  Model.findOne=(qq)=>{const r=rows.find(r=>match(r,qq)); const p=Promise.resolve(wrap(r)); p.lean=async()=>r?JSON.parse(JSON.stringify(r)):null; return p;};
  Model.findById=(id)=>Model.findOne({_id:id});
  Model.create=async(d)=>{ const doc=new Model(d); const r={...doc.toObject(),_id:String(idc++)}; rows.push(r); return wrap(r); };
  Model.updateOne=async(qq,u)=>{const r=rows.find(r=>match(r,qq)); if(r) apply(r,u); return {modifiedCount:r?1:0};};
  Model.deleteOne=async(qq)=>{const i=rows.findIndex(r=>match(r,qq)); if(i>=0) rows.splice(i,1);};
  Model.findOneAndUpdate=async(qq,u)=>{const r=rows.find(r=>match(r,qq)); if(!r) return null; apply(r,u); return wrap(r);};
  Model.findOneAndDelete=async(qq)=>{const i=rows.findIndex(r=>match(r,qq)); if(i<0) return null; return rows.splice(i,1)[0];};
  Model.prototype.save=async function(){ const o=this.toObject(); o._id=String(o._id); const i=rows.findIndex(r=>r._id===o._id); if(i>=0) rows[i]=o; else rows.push(o); return this; };
  return rows;
}

module.exports={memModel};
