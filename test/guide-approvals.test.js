// Guide change approvals: guide editors' adds / deletes (and edits, when switched on) wait for an admin.
// Covers settings defaults, requests (posted with Approve / Reject buttons), approve applies the change as
// the editor, reject keeps things as they were, duplicates, cancelling, and the Discord buttons.
process.env.TOKEN='x';process.env.CLIENT_ID='123';process.env.MONGODB_URI='mongodb://x';process.env.REDIRECT_URI='https://x.onrender.com/auth/discord/callback';
const root=require('path').join(__dirname,'..')+'/'; const assert=require('assert');
const { Collection, ChannelType, PermissionFlagsBits } = require(root+'node_modules/discord.js');
const { store } = require('./helpers/memstore');
const GuildConfig=require(root+'src/database/models/GuildConfig'); const Guide=require(root+'src/database/models/Guide'); const GuideChange=require(root+'src/database/models/GuideChange');
store(GuildConfig); store(Guide); store(GuideChange);
const G=require(root+'src/bot/cogs/modules/guides');
const AP=require(root+'src/bot/cogs/modules/guideApprovals');

// ---- fakes: a forum (posts with editable starters) + a text channel for approval requests
let tid=1; const cache=new Collection();
function thread(id,name,payload){ const t={id,name,deleted:false,starter:{payload,edit:async(p)=>{t.starter.payload=p;}},fetchStarterMessage:async()=>t.starter,setName:async(n)=>{t.name=n;},setAppliedTags:async()=>{},pin:async()=>{},delete:async()=>{t.deleted=true;cache.delete(id);},messages:{fetch:async()=>Promise.reject(new Error('x'))},send:async()=>null}; return t; }
const forum={id:'forum',type:ChannelType.GuildForum,name:'guides',availableTags:[],threads:{create:async({name,message})=>{const t=thread('t'+(tid++),name,message);cache.set(t.id,t);return t;},fetch:async(id)=>cache.get(id)||Promise.reject(new Error('x'))}};
const edMsgs=new Map();
const editorCh={id:'edch',name:'guide-editors',type:ChannelType.GuildText,isTextBased:()=>true,sent:[],
  send:async(p)=>{const m={id:'m'+(tid++),payload:p,edit:async(np)=>{m.payload=np;}}; edMsgs.set(m.id,m); editorCh.sent.push(m); return m;},
  messages:{fetch:async(id)=>edMsgs.get(id)||Promise.reject(new Error('x'))}};
const dms=[];
const users={ed1:{id:'ed1',tag:'editor#1',send:async(p)=>dms.push({to:'ed1',...p})}};
const guild={id:'g',name:'Loofary',channels:{cache},members:{me:{id:'bot'}},client:{users:{fetch:async(id)=>users[id]||null}}};
forum.guild=guild; cache.set('forum',forum); cache.set('edch',editorCh);
const ed={id:'ed1',tag:'editor#1'}, admin={id:'ad1',tag:'admin#1'};
const ix=(isAdmin,customId,note='')=>{const r={customId,guild,member:{permissions:{has:(p)=>isAdmin&&(p===PermissionFlagsBits.ManageGuild)}},user:{id:isAdmin?'ad1':'ed1',tag:isAdmin?'admin#1':'editor#1'},out:[],modal:null,
  reply:async(o)=>r.out.push(o.content),deferReply:async()=>{},editReply:async(o)=>r.out.push(o.content),showModal:async(m)=>{r.modal=m;},fields:{getTextInputValue:()=>note}}; return r;};

(async()=>{
  await GuildConfig.create({guildId:'g',guides:{enabled:true,forumChannelId:'forum',editorChannelId:'edch'}});
  let s=G.guidesSettings(await GuildConfig.findOne({guildId:'g'}).lean());
  assert.deepEqual(s.approval,{create:true,edit:false,delete:true},'adds + deletes need approval by default');
  assert.equal(AP.needsApproval(s,'create',false),true); assert.equal(AP.needsApproval(s,'create',true),false,'admins never wait');
  assert.equal(AP.needsApproval(s,'edit',false),false);
  console.log('✓ defaults: adds and deletes wait for an admin, edits don\'t');

  // ---- add: request → nothing posted in the forum until approved
  const posts=cache.size;
  let r=await AP.requestChange(guild,{type:'create',payload:{title:'Pet Tips',tags:['Guides'],body:{embeds:[{title:'Pets',description:'Level pets evenly'}]}}},ed,s);
  assert.ok(!r.error,r.error); assert.equal(r.change.status,'PENDING');
  assert.equal(cache.size,posts,'no forum post yet'); assert.equal(await G.getGuide('g','pet tips'),null);
  const msg=editorCh.sent[0]; const btns=msg.payload.components[0].toJSON().components;
  assert.deepEqual(btns.slice(0,2).map((b)=>b.custom_id),[`gch:ok:${r.change._id}`,`gch:no:${r.change._id}`]);
  assert.match(btns[2].url,/\/dashboard\/g\/guides\?change=/,'link to preview it on the dashboard');
  assert.match(JSON.stringify(msg.payload.embeds[0].toJSON()),/Add guide: Pet Tips/);
  // only admins can press the buttons
  let i=ix(false,`gch:ok:${r.change._id}`); await AP.handleChangeButton(i); assert.match(i.out[0],/Only admins/);
  i=ix(true,`gch:ok:${r.change._id}`); await AP.handleChangeButton(i); assert.match(i.out[0],/Approved/);
  const g=await G.getGuide('g','pet tips'); assert.ok(g,'created on approval'); assert.equal(g.createdBy,'ed1','credited to the editor');
  assert.ok(cache.get(g.threadId),'forum post made'); assert.match(JSON.stringify(cache.get(g.threadId).starter.payload),/Level pets evenly/);
  assert.equal(msg.payload.components[0].toJSON().components[0].disabled,true,'buttons disabled after a decision');
  assert.match(dms[0].content,/approved your request to create the guide \*\*Pet Tips\*\*/);
  console.log('✓ add: waits, then approve → guide posted, editor credited + DM\'d');

  // ---- delete: request, no duplicates, reject keeps it
  r=await AP.requestChange(guild,{type:'delete',slug:'pet-tips'},ed,s);
  assert.ok(!r.error,r.error);
  const dup=await AP.requestChange(guild,{type:'delete',slug:'pet-tips'},ed,s); assert.match(dup.error,/already a request/);
  i=ix(true,`gch:no:${r.change._id}`); await AP.handleChangeButton(i); assert.ok(i.modal,'reject asks for a note');
  i=ix(true,`gchm:no:${r.change._id}`,'Still useful'); await AP.handleChangeModal(i); assert.match(i.out[0],/Rejected/);
  assert.ok(await G.getGuide('g','pet tips'),'rejected delete keeps the guide');
  assert.match(dms.at(-1).content,/rejected your request to delete/); assert.match(dms.at(-1).content,/Still useful/);
  r=await AP.requestChange(guild,{type:'delete',slug:'pet-tips'},ed,s);
  const d=await AP.decideChange(guild,r.change._id,{approve:true,by:admin},s);
  assert.equal(d.change.status,'APPROVED'); assert.equal(await G.getGuide('g','pet tips'),null,'approved delete removes it'); assert.equal(cache.get(g.threadId),undefined);
  const again=await AP.decideChange(guild,r.change._id,{approve:false,by:admin},s); assert.match(again.error,/already approved/);
  console.log('✓ delete: no duplicates, reject keeps it, approve deletes it');

  // ---- cancel + edit approvals
  r=await AP.requestChange(guild,{type:'create',payload:{title:'Mine Tips',body:{embeds:[{description:'x'}]}}},ed,s);
  assert.match((await AP.cancelChange(guild,r.change._id,'someone-else',false)).error,/Only the person/);
  assert.equal((await AP.cancelChange(guild,r.change._id,'ed1',false)).change.status,'CANCELLED');
  assert.match((await AP.decideChange(guild,r.change._id,{approve:true,by:admin},s)).error,/already cancelled/);
  await G.saveSettings({...guild,roles:{cache:new Collection()}},{approval:{create:true,edit:true,delete:true}});
  s=G.guidesSettings(await GuildConfig.findOne({guildId:'g'}).lean()); assert.equal(s.approval.edit,true);
  const live=await G.createGuide(guild,{title:'Raid',body:'old text'},s);
  r=await AP.requestChange(guild,{type:'edit',slug:live.guide.slug,payload:{title:'Raid',tags:[],body:'new text'}},ed,s);
  assert.match(JSON.stringify(cache.get(live.guide.threadId).starter.payload),/old text/,'edit waits');
  await AP.decideChange(guild,r.change._id,{approve:true,by:admin},s);
  assert.match(JSON.stringify(cache.get(live.guide.threadId).starter.payload),/new text/,'approved edit goes live');
  assert.equal((await AP.listChanges('g',{status:'PENDING'})).length,0);
  console.log('✓ cancel, and edit approvals when switched on');
  process.exit(0);
})().catch((e)=>{console.error(e);process.exit(1);});
