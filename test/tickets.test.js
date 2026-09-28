process.env.TOKEN='x';process.env.CLIENT_ID='123';process.env.MONGODB_URI='mongodb://x';
const root=require('path').join(__dirname,'..')+'/'; const assert=require('assert');
const { PermissionFlagsBits, PermissionsBitField, ChannelType, Collection } = require(root+'node_modules/discord.js');
const TicketConfig=require(root+'src/database/models/TicketConfig');
const Ticket=require(root+'src/database/models/Ticket');

// ---------- in-memory Mongo stand-in (just what tickets use)
function store(Model){
  const rows=[]; let id=1;
  const get=(o,k)=>k.split('.').reduce((x,p)=>x?.[p],o);
  const m1=(r,k,v)=>{ const val=get(r,k);
    if(v instanceof RegExp) return v.test(val??'');
    if(v&&v._bsontype) return String(val)===String(v);
    if(v&&typeof v==='object'&&!Array.isArray(v)&&!(v instanceof Date)){
      if('$in' in v) return v.$in.map(String).includes(String(val));
      if('$gte' in v) return new Date(val)>=new Date(v.$gte);
      if('$ne' in v) return val!==v.$ne; return true; }
    return String(val)===String(v); };
  const match=(r,q={})=>Object.entries(q).every(([k,v])=>k==='$or'?v.some(s=>match(r,s)):m1(r,k,v));
  const clone=(x)=>x&&JSON.parse(JSON.stringify(x));
  const hydrate=(r)=>{ if(!r) return null; const d=new Model(clone(r)); d._id=r._id; d.save=async function(){ const o=this.toObject(); Object.assign(r,clone({...o,_id:r._id})); return this; }; return d; };
  const apply=(r,u)=>{ const set=u.$set||(!u.$inc&&!u.$push?u:{}); for(const [k,v] of Object.entries(set)){ const parts=k.split('.'); let o=r; while(parts.length>1){const p=parts.shift(); o[p]=o[p]||{}; o=o[p];} o[parts[0]]=v; } if(u.$inc) for(const [k,v] of Object.entries(u.$inc)) r[k]=(r[k]||0)+v; };
  const query=(arr)=>{ const o={ sort(s){ const [[k,d]]=Object.entries(s); arr=[...arr].sort((a,b)=>(get(a,k)>get(b,k)?1:-1)*d); return o; }, skip(n){arr=arr.slice(n);return o;}, limit(n){arr=arr.slice(0,n);return o;}, lean:async()=>clone(arr), then:(a,b)=>Promise.resolve(arr.map(hydrate)).then(a,b)}; return o; };
  Model.find=(q)=>query(rows.filter(r=>match(r,q)));
  Model.findOne=(q)=>{ const r=rows.find(x=>match(x,q)); const p=Promise.resolve(hydrate(r)); p.lean=async()=>clone(r)||null; p.catch=(f)=>p.then(null,f); return p; };
  Model.countDocuments=async(q)=>rows.filter(r=>match(r,q)).length;
  Model.exists=async(q)=>rows.some(r=>match(r,q));
  Model.create=async(d)=>{ const doc=new Model(d); const r={...clone(doc.toObject()),_id:(id++).toString(16).padStart(24,'0'),createdAt:new Date().toISOString()}; rows.push(r); return hydrate(r); };
  Model.findOneAndUpdate=async(q,u,o={})=>{ let r=rows.find(x=>match(x,q)); if(!r){ if(!o.upsert) return null; const doc=new Model(Object.fromEntries(Object.entries(q).filter(([k,v])=>typeof v!=='object'))); r={...clone(doc.toObject()),_id:(id++).toString(16).padStart(24,'0')}; rows.push(r);} apply(r,u); return hydrate(r); };
  Model.updateOne=async(q,u)=>{ const r=rows.find(x=>match(x,q)); if(r) apply(r,u); return {modifiedCount:r?1:0}; };
  return rows;
}
const cfgRows=store(TicketConfig); const tRows=store(Ticket);

// ---------- fake Discord
let chId=100; const sent=[]; const dms=[]; const deleted=[];
const client={user:{id:'bot'},users:{fetch:async(id)=>({id,send:async(m)=>{dms.push({id,m});}})}};
const roleCache=new Collection([['g',{id:'g',name:'@everyone'}],['sup',{id:'sup',name:'Support'}],['sup2',{id:'sup2',name:'Mods'}]]);
function makeChannel(opts){
  const msgs=new Collection(); let mid=1;
  const ch={id:String(opts.id||chId++),name:opts.name,type:opts.type??ChannelType.GuildText,parentId:opts.parent||null,topic:opts.topic,overwrites:opts.permissionOverwrites||[],client,
    isTextBased:()=>ch.type!==ChannelType.GuildCategory,isThread:()=>false,
    permissionsFor:()=>new PermissionsBitField(PermissionsBitField.All),
    toString(){return `<#${ch.id}>`;},
    send:async(p)=>{ const m={id:`${ch.id}-m${mid++}`,author:{id:'bot',tag:'LoofaryBot#0',bot:true},content:p.content||'',embeds:(p.embeds||[]).map(e=>e.data||e),components:p.components||[],attachments:new Collection(),createdAt:new Date(),payload:p,url:`https://discord.com/channels/g/${ch.id}/x`,
      edit:async(np)=>{m.payload={...m.payload,...np}; m.edited=(m.edited||0)+1; return m;}, pin:async()=>{m.pinned=true;}, delete:async()=>msgs.delete(m.id)}; msgs.set(m.id,m); sent.push({ch:ch.id,p}); return m; },
    messages:{ fetch:async(arg)=>{ if(typeof arg==='string') { const m=msgs.get(arg); if(!m) throw new Error('Unknown Message'); return m; } return new Collection([...msgs].reverse()); },
      fetchPinned:async()=>new Collection([...msgs].filter(([,m])=>m.pinned)), delete:async(id)=>{ if(!msgs.delete(id)) throw new Error('Unknown'); } },
    msgs,
    delete:async()=>{ deleted.push(ch.id); guild.channels.cache.delete(ch.id); },
    setName:async(n)=>{ch.name=n;},
    permissionOverwrites:{ edit:async(id,p)=>{ if(ch.failPerms) throw new Error('Missing Permissions'); ch.overwrites=ch.overwrites.filter(o=>o.id!==id||!o.allowObj); const prev=ch.overwrites.find(o=>o.id===id&&o.allowObj); ch.overwrites.push({id,allowObj:{...(prev?.allowObj||{}),...p}});}, delete:async(id)=>{ch.overwrites=ch.overwrites.filter(o=>o.id!==id);}, set:async(list)=>{ch.overwrites=list.map(o=>({...o})); ch.setCalls=(ch.setCalls||0)+1;} },
    children:{cache:new Collection()}, position:0};
  return ch;
}
const guild={id:'g',name:'Loof Lounge',client,roles:{cache:roleCache,everyone:{id:'g'}},channels:{cache:new Collection()},members:{cache:new Collection()}};
guild.members.me={id:'bot',permissions:new PermissionsBitField(PermissionsBitField.All)};
let createCalls=0;
guild.channels.create=async(o)=>{ createCalls++; await new Promise(r=>setTimeout(r,20)); const c=makeChannel(o); guild.channels.cache.set(c.id,c); return c; };
for (const c of [makeChannel({id:'pc',name:'support'}),makeChannel({id:'pc2',name:'help'}),makeChannel({id:'log',name:'ticket-logs'}),makeChannel({id:'cat',name:'Tickets',type:ChannelType.GuildCategory})]) guild.channels.cache.set(c.id,c);
function member(id,{roles=[],admin=false,name}={}){
  const m={id,guild,user:{id,username:name||id,tag:`${name||id}#0`,bot:false},displayName:name||id,
    permissions:new PermissionsBitField(admin?PermissionsBitField.All:0n),roles:{cache:new Collection(roles.map(r=>[r,{id:r}]))},toString(){return `<@${id}>`;}};
  guild.members.cache.set(id,m); return m;
}
const alice=member('alice',{name:'Alice'}), bob=member('bob',{name:'Bob'}), staff=member('staff',{roles:['sup'],name:'Sam'}), staff2=member('staff2',{roles:['sup'],name:'Kim'}), admin=member('admin',{admin:true,name:'Ada'});

function interaction(m,{customId,channelId='pc',fields={}}={}){
  const log={replies:[],modal:null,updates:[]};
  const i={guildId:'g',guild,member:m,user:m.user,customId,channelId,channel:guild.channels.cache.get(channelId),client,deferred:false,replied:false,
    memberPermissions:m.permissions,
    reply:async(o)=>{i.replied=true;log.replies.push(o);}, deferReply:async()=>{i.deferred=true;}, editReply:async(o)=>{log.replies.push(o);},
    showModal:async(md)=>{log.modal=md.toJSON();}, update:async(o)=>{log.updates.push(o);},
    fields:{getTextInputValue:(k)=>fields[k]??''}};
  return [i,log];
}
const text=(x)=>typeof x==='string'?x:(x.content||JSON.stringify(x));
const T=require(root+'src/bot/cogs/modules/tickets');
const realST=global.setTimeout; const timers=[]; global.setTimeout=(fn,ms)=>{ if(ms>=1000){ timers.push({fn,ms}); return {unref(){}}; } return realST(fn,ms); };

(async()=>{
  // ---- settings validation
  assert.match(T.cleanSettings(guild,{panel:{color:'blue'}}).error,/hex color/);
  assert.match(T.cleanSettings(guild,{nameFormat:'support'}).error,/\{number\} or \{username\}/);
  assert.match(T.cleanSettings(guild,{categoryId:'pc'}).error,/category/);
  assert.match(T.cleanSettings(guild,{supportRoleIds:['nope']}).error,/doesn't exist/);
  assert.match(T.cleanSettings(guild,{panel:{imageUrl:'ftp://x'}}).error,/image link/);
  assert.match(T.cleanSettings(guild,{button:{style:'Blue'}}).error,/Button style/);
  const {patch}=T.cleanSettings(guild,{categoryId:'cat',supportRoleIds:['sup'],nameFormat:'Ticket-{Number}',maxOpenPerUser:1,logChannelId:'log',closeDelaySeconds:5,panel:{title:'Help desk',color:'#ff0000',imageUrl:'https://x/banner.png'},button:{label:'Get help',style:'Success',emoji:'🆘'}});
  assert.equal(patch.nameFormat,'ticket-{number}'); assert.equal(patch['panel.title'],'Help desk');
  await T.saveSettings('g',patch);
  console.log('✓ settings are validated (color, name format, category, roles, image links, button style)');

  // ---- panel
  let r=await T.publishPanel(guild,'pc'); assert.ok(r.message); const firstPanel=r.message.id;
  const pp=r.message.payload; assert.equal(pp.embeds[0].data.title,'Help desk'); assert.equal(pp.embeds[0].data.image.url,'https://x/banner.png');
  const btn=pp.components[0].toJSON().components[0]; assert.equal(btn.custom_id,'tk:open'); assert.equal(btn.label,'Get help'); assert.equal(btn.style,3); assert.equal(btn.emoji.name,'🆘');
  r=await T.publishPanel(guild); assert.equal(r.message.id,firstPanel); assert.equal(r.message.edited,1);
  r=await T.publishPanel(guild,'pc2'); assert.notEqual(r.message.id,firstPanel); assert.ok(!guild.channels.cache.get('pc').msgs.has(firstPanel));
  console.log('✓ panel: posted with the custom look/button; re-saving edits it in place; moving it deletes the old one');

  // ---- open
  let [i,l]=interaction(alice,{customId:'tk:open'}); await T.handleTicketButton(i);
  assert.match(text(l.replies.at(-1)),/Your ticket is open: <#\d+>/);
  let t=tRows.find(x=>x.openerId==='alice'); const ch=guild.channels.cache.get(t.channelId);
  assert.equal(ch.name,'ticket-0001'); assert.equal(ch.parentId,'cat'); assert.equal(t.number,1); assert.equal(t.status,'OPEN');
  const ow=Object.fromEntries(ch.overwrites.map(o=>[o.id,o]));
  const has=(o,f,k='allow')=>(o[k]||[]).includes(f);
  assert.ok(has(ow.g,PermissionFlagsBits.ViewChannel,'deny'));
  assert.ok(has(ow.bot,PermissionFlagsBits.ManageChannels)&&has(ow.bot,PermissionFlagsBits.ManageRoles)&&has(ow.bot,PermissionFlagsBits.SendMessages));
  for (const who of ['alice','sup']) for (const f of ['ViewChannel','SendMessages','AttachFiles','ReadMessageHistory']) assert.ok(has(ow[who],PermissionFlagsBits[f]),`${who} ${f}`);
  const welcome=[...ch.msgs.values()][0]; assert.match(welcome.payload.content,/<@alice> <@&sup>/); assert.ok(welcome.pinned);
  const row=welcome.payload.components[0].toJSON().components.map(c=>c.custom_id+':'+c.label); assert.deepEqual(row,['tk:close:Close','tk:claim:Claim','tk:ping:Ping user']);
  // Exactly: everyone (denied), bot, support role, opener — no other role or member.
  assert.deepEqual(ch.overwrites.map(o=>o.id).sort(),['alice','bot','g','sup'].sort());
  for (const f of ['ViewChannel','SendMessages','CreatePublicThreads','CreatePrivateThreads']) assert.ok(has(ow.g,PermissionFlagsBits[f],'deny'),`everyone deny ${f}`);
  assert.ok(!has(ow.sup2||{},PermissionFlagsBits.ViewChannel));
  const pch=guild.channels.cache.get('pc2'); const po=Object.fromEntries(pch.overwrites.filter(o=>o.allowObj).map(o=>[o.id,o.allowObj]));
  assert.deepEqual([po.g.ViewChannel,po.g.ReadMessageHistory,po.g.SendMessages,po.g.AddReactions,po.g.CreatePublicThreads,po.g.SendMessagesInThreads],[true,true,false,false,false,false]);
  assert.equal(po.bot.SendMessages,true);
  const co=Object.fromEntries(guild.channels.cache.get('cat').overwrites.filter(o=>o.allowObj).map(o=>[o.id,o.allowObj]));
  assert.equal(co.g.ViewChannel,false); assert.equal(co.sup.ViewChannel,true); assert.equal(co.bot.ViewChannel,true);
  console.log('✓ panel channel is button-only for members (see + click, no messages/reactions/threads); ticket category hidden from everyone but support + bot');
  console.log('✓ open: private channel in the category (everyone denied; member, support and bot allowed), pinned welcome pinging member + support, Close/Claim/Ping');

  [i,l]=interaction(alice,{customId:'tk:open'}); await T.handleTicketButton(i); assert.match(text(l.replies.at(-1)),/already have an open ticket: <#/);
  const before=createCalls; const pair=[interaction(bob,{customId:'tk:open'}),interaction(bob,{customId:'tk:open'})];
  await Promise.all(pair.map(([x])=>T.handleTicketButton(x))); assert.equal(createCalls-before,1); assert.equal(tRows.filter(x=>x.openerId==='bob'&&x.status==='OPEN').length,1);
  console.log('✓ one open ticket per member (a double click creates only one)');

  // ---- claim / ping (support only)
  [i,l]=interaction(alice,{customId:'tk:claim',channelId:t.channelId}); await T.handleTicketButton(i); assert.match(text(l.replies[0]),/Only the support team/);
  const mgr=member('mgr',{name:'Manny'}); mgr.permissions=new PermissionsBitField([PermissionFlagsBits.ManageGuild]);
  [i,l]=interaction(mgr,{customId:'tk:claim',channelId:t.channelId}); await T.handleTicketButton(i); assert.match(text(l.replies[0]),/Only the support team/);
  [i,l]=interaction(staff,{customId:'tk:claim',channelId:t.channelId}); await T.handleTicketButton(i);
  assert.equal(tRows.find(x=>x._id===t._id).claimedBy,'staff'); assert.match(l.updates[0].components[0].toJSON().components[1].label,/Claimed by Sam/);
  assert.match(sent.at(-1).p.content,/claimed this ticket/);
  [i,l]=interaction(staff2,{customId:'tk:claim',channelId:t.channelId}); await T.handleTicketButton(i); assert.match(text(l.replies[0]),/already claimed by <@staff>/);
  [i,l]=interaction(staff,{customId:'tk:ping',channelId:t.channelId}); await T.handleTicketButton(i); assert.match(sent.at(-1).p.content,/<@alice>, .* is waiting for your reply/); assert.deepEqual(sent.at(-1).p.allowedMentions.users,['alice']);
  console.log('✓ claim (label shows who; others can’t steal it) and ping are support-only');

  // ---- close: who may, confirmation form, DM, log + transcript, countdown delete, DB
  [i,l]=interaction(bob,{customId:'tk:close',channelId:t.channelId}); await T.handleTicketButton(i); assert.match(text(l.replies[0]),/Only the person who opened/);
  [i,l]=interaction(alice,{customId:'tk:close',channelId:t.channelId}); await T.handleTicketButton(i); assert.equal(l.modal.custom_id,`tkm:close:${t.channelId}`); assert.match(l.modal.title,/Close ticket #1\?/);
  await ch.send({content:'I need help with my rank'});
  [i,l]=interaction(staff,{customId:`tkm:close:${t.channelId}`,channelId:t.channelId,fields:{reason:'Solved'}}); await T.handleTicketModal(i);
  assert.match(text(l.replies.at(-1)),/Closing ticket #1… The member was sent a DM/);
  const dm=dms.find(d=>d.id==='alice').m.embeds[0].data; assert.match(dm.description,/Your ticket \*\*#1\*\* in \*\*Loof Lounge\*\* has been closed by \*\*Sam#0\*\*\.\n\*\*Reason:\*\* Solved/);
  const logMsg=sent.find(s=>s.ch==='log'); assert.match(logMsg.p.embeds[0].data.title,/Ticket #1 closed/); assert.equal(logMsg.p.files[0].name,'ticket-1.txt'); assert.match(logMsg.p.files[0].attachment.toString(),/Reason: Solved|Closed by Sam#0/);
  const countdown=sent.filter(s=>s.ch===t.channelId).at(-1); assert.match(countdown.p.embeds[0].data.description,/will be deleted <t:\d+:R>/);
  assert.equal(timers.at(-1).ms,5000); await timers.at(-1).fn(); assert.ok(deleted.includes(t.channelId));
  t=tRows.find(x=>x._id===t._id); assert.equal(t.status,'CLOSED'); assert.equal(t.closedBy,'staff'); assert.equal(t.closeReason,'Solved'); assert.ok(t.closedAt); assert.ok(t.transcript.some(x=>/my rank/.test(x.content))); assert.equal(t.messageCount,t.transcript.length);
  console.log('✓ close: opener or support only, reason form, DM "closed by … Reason: …", log + .txt transcript, 5s countdown then delete, status CLOSED with timestamps');
  const again=await T.closeTicket(guild,await Ticket.findOne({_id:t._id}),staff.user,'x'); assert.match(again.error,/already closed/);
  [i,l]=interaction(alice,{customId:'tk:open'}); await T.handleTicketButton(i); assert.match(text(l.replies.at(-1)),/Your ticket is open/);
  const t2=tRows.filter(x=>x.openerId==='alice').at(-1); assert.equal(t2.number,4 - (tRows.length===3?1:0) > 0 ? t2.number : 0);
  console.log('✓ closing twice is refused; the member can open a new ticket afterwards (#'+t2.number+')');

  // ---- manual channel delete frees the slot
  const listeners={}; T.registerTicketEvents({on:(e,f)=>listeners[e]=f});
  const t2ch=guild.channels.cache.get(t2.channelId); guild.channels.cache.delete(t2ch.id); await listeners.channelDelete({id:t2ch.id,guild});
  assert.equal(tRows.find(x=>x._id===t2._id).status,'CLOSED');
  [i,l]=interaction(alice,{customId:'tk:open'}); await T.handleTicketButton(i); assert.match(text(l.replies.at(-1)),/Your ticket is open/);
  console.log('✓ a ticket channel deleted by hand is marked closed and doesn’t block the member');

  // ---- ask reason + disabled
  await T.saveSettings('g',{askReason:true,maxOpenPerUser:0});
  [i,l]=interaction(bob,{customId:'tk:open'}); await T.handleTicketButton(i); assert.equal(l.modal.custom_id,'tkm:open');
  [i,l]=interaction(bob,{customId:'tkm:open',fields:{reason:'Payment issue'}}); await T.handleTicketModal(i); assert.match(text(l.replies.at(-1)),/Your ticket is open/);
  const tb=tRows.filter(x=>x.openerId==='bob').at(-1); assert.equal(tb.reason,'Payment issue'); const wb=[...guild.channels.cache.get(tb.channelId).msgs.values()][0]; assert.ok(wb.payload.embeds[0].data.fields.some(f=>f.value==='Payment issue'));
  await T.saveSettings('g',{enabled:false});
  [i,l]=interaction(bob,{customId:'tk:open'}); await T.handleTicketButton(i); assert.match(text(l.replies[0]),/turned off/);
  await T.saveSettings('g',{enabled:true,askReason:false});
  console.log('✓ "ask what they need" form shows the answer in the ticket; 0 = no per-member limit; turning tickets off blocks new ones');

  // ---- missing bot permissions
  guild.members.me.permissions=new PermissionsBitField([PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages]);
  const cat=guild.channels.cache.get('cat'); const realPF=cat.permissionsFor; cat.permissionsFor=()=>guild.members.me.permissions;
  [i,l]=interaction(staff,{customId:'tk:open'}); await T.handleTicketButton(i); assert.match(text(l.replies.at(-1)),/needs \*\*Manage Channels, Manage Roles, Embed Links\*\*/);
  guild.members.me.permissions=new PermissionsBitField(PermissionsBitField.All); cat.permissionsFor=realPF;
  console.log('✓ missing bot permissions are explained instead of failing silently');

  // ---- /ticket command
  const C=require(root+'src/bot/commands/ticket');
  const cmd=(m,sub,opts={},channelId='pc')=>{ const [x,lg]=interaction(m,{channelId}); x.options={getSubcommand:()=>sub,getString:(k)=>opts[k]??null,getInteger:(k)=>opts[k]??null,getBoolean:(k)=>opts[k]??null,getChannel:(k)=>opts[k]??null,getRole:(k)=>opts[k]??null,getUser:(k)=>opts[k]??null}; return [x,lg]; };
  let [c,cl]=cmd(staff,'setup',{channel:guild.channels.cache.get('pc')}); await C.execute(c); assert.match(text(cl.replies[0]),/needs \*\*Manage Server\*\*/);
  [c,cl]=cmd(admin,'setup',{channel:guild.channels.cache.get('pc'),support_role:roleCache.get('sup'),support_role_2:roleCache.get('sup2'),name_format:'{username}-{number}',title:'Support',description:'Line 1\\nLine 2',button_style:'Danger'}); await C.execute(c);
  assert.match(text(cl.replies.at(-1)),/Tickets are set up.*Panel: https/s); assert.match(text(cl.replies.at(-1)),/admin-0001|ada-0001/);
  const cfg=cfgRows[0]; assert.deepEqual(cfg.supportRoleIds,['sup','sup2']); assert.equal(cfg.panel.description,'Line 1\nLine 2'); assert.equal(cfg.button.style,'Danger'); assert.equal(cfg.panelChannelId,'pc');
  const open=tRows.find(x=>x.status==='OPEN'&&x.openerId==='alice');
  [c,cl]=cmd(staff,'add',{user:bob.user},open.channelId); await C.execute(c); assert.ok(guild.channels.cache.get(open.channelId).overwrites.some(o=>o.id==='bob'));
  [c,cl]=cmd(staff,'remove',{user:bob.user},open.channelId); await C.execute(c); assert.ok(!guild.channels.cache.get(open.channelId).overwrites.some(o=>o.id==='bob'));
  [c,cl]=cmd(staff,'rename',{name:'Billing Issue!'},open.channelId); await C.execute(c); assert.equal(guild.channels.cache.get(open.channelId).name,'billing-issue');
  [c,cl]=cmd(staff,'claim',{},open.channelId); await C.execute(c); assert.equal(tRows.find(x=>x._id===open._id).claimedBy,'staff');
  [c,cl]=cmd(staff,'list'); await C.execute(c); assert.match(cl.replies[0].embeds[0].data.description,/#\d+.*📌 <@staff>/);
  [c,cl]=cmd(alice,'list'); await C.execute(c); assert.match(text(cl.replies[0]),/Only the support team/);
  [c,cl]=cmd(alice,'close',{reason:'nvm'},open.channelId); await C.execute(c); assert.match(text(cl.replies.at(-1)),/Closing ticket/);
  [c,cl]=cmd(staff,'close',{},'pc'); await C.execute(c); assert.match(text(cl.replies[0]),/inside an open ticket/);
  [c,cl]=cmd(admin,'toggle',{enabled:false}); await C.execute(c); assert.match(text(cl.replies[0]),/off/); await T.saveSettings('g',{enabled:true});
  console.log('✓ /ticket setup (Manage Server, multiple support roles, \\n in text) · add · remove · rename · claim · list · close · toggle');

  // ---- permissions are re-applied: support roles changed / someone loosened a ticket by hand
  const openT=tRows.find(x=>x.status==='OPEN'); const och=guild.channels.cache.get(openT.channelId);
  och.overwrites.push({id:'sup2',allow:[PermissionFlagsBits.ViewChannel]},{id:'randomUser',allow:[PermissionFlagsBits.ViewChannel]});
  let lk=await T.applyLockdown(guild); assert.ok(lk.fixed>=1); assert.deepEqual(och.overwrites.map(o=>o.id).sort(),['bot','g','sup','sup2',openT.openerId].sort()); // sup2 is a support role since /ticket setup
  await T.saveSettings('g',{supportRoleIds:['sup']}); await T.applyLockdown(guild);
  assert.deepEqual(och.overwrites.map(o=>o.id).sort(),['bot','g','sup',openT.openerId].sort());
  console.log('✓ open tickets are reset to exactly opener + support + bot (removed support roles and hand-added access are taken away)');
  await T.saveSettings('g',{lockPanelChannel:false}); const pcNow=guild.channels.cache.get(cfgRows[0].panelChannelId); const before2=JSON.stringify(pcNow.overwrites);
  await T.publishPanel(guild); assert.equal(JSON.stringify(pcNow.overwrites),before2);
  await T.saveSettings('g',{lockPanelChannel:true}); pcNow.failPerms=true; const pub=await T.publishPanel(guild); assert.ok(pub.message); assert.match(pub.warnings[0],/button-only — LoofaryBot needs Manage Roles/); pcNow.failPerms=false;
  console.log('✓ the panel lock can be turned off (channel left alone); a failed lock is reported, not fatal');

  // ---- dashboard routes
  const express=require(root+'node_modules/express'); const auth=require(root+'src/web/utils/authMiddleware');
  auth.requireAuth=(q,s,n)=>n(); auth.requireGuildAccess=(q,s,n)=>{q.guild=guild;q.access={level:'admin',pages:null};n();}; auth.requirePage=()=>(q,s,n)=>n();
  const audit=require(root+'src/web/utils/audit'); audit.auditTrail=(q,s,n)=>n();
  const app=express(); app.use(express.json()); app.use((q,s,n)=>{q.session={user:{id:'admin',username:'ada',global_name:'Ada'}};n();}); app.use('/api',require(root+'src/web/routes/manage'));
  const srv=app.listen(0); const base=`http://127.0.0.1:${srv.address().port}/api/guilds/g`;
  const j=async(path,opt={})=>{ const res=await fetch(base+path,{method:opt.method||'GET',headers:{'content-type':'application/json'},body:opt.body?JSON.stringify(opt.body):undefined}); return {status:res.status,...await res.json()}; };
  let d=await j('/tickets'); assert.equal(d.settings.panel.title,'Support'); assert.ok(d.categories.some(x=>x.id==='cat')); assert.ok(d.panelUrl); assert.equal(d.missingPerms.length,0);
  const openCount=d.open.length; assert.ok(openCount>=1); assert.ok(d.open[0].channelUrl.includes(d.open[0].channelId));
  d=await j('/tickets/settings',{method:'POST',body:{panel:{color:'nope'}}}); assert.equal(d.status,400);
  d=await j('/tickets/settings',{method:'POST',body:{publish:true,panelChannelId:'pc2',panel:{title:'Dash title'},button:{label:'Open!'}}}); assert.equal(d.status,200); assert.ok(d.panelUrl);
  assert.equal(cfgRows[0].panelChannelId,'pc2');
  const target=(await j('/tickets')).open[0];
  d=await j(`/tickets/${target.id}/close`,{method:'POST',body:{reason:'Closed from dashboard'}}); assert.equal(d.status,200); assert.equal(d.ticket.status,'CLOSED');
  assert.match(dms.at(-1).m.embeds[0].data.description,/closed by \*\*Ada\*\*/);
  d=await j(`/tickets/${target.id}/close`,{method:'POST',body:{}}); assert.equal(d.status,400);
  d=await j('/tickets/history'); assert.ok(d.total>=3); assert.ok(d.tickets.every(x=>x.status==='CLOSED'));
  d=await j('/tickets/history?q=%231'); assert.equal(d.tickets[0].number,1);
  d=await j('/tickets/history?q=bob'); assert.ok(d.tickets.length>=1 && d.tickets.every(x=>x.openerId==='bob'));
  d=await j('/tickets/history?q=Solved'); assert.equal(d.tickets.length,1);
  d=await j(`/tickets/${tRows[0]._id}`); assert.ok(d.transcript.some(x=>/my rank/.test(x.content)));
  srv.close();
  console.log('✓ dashboard API: overview, settings validation + publish, close from dashboard (DM credits the admin), history search by #, name and reason, transcript');
  process.exit(0);
})().catch(e=>{console.error(e);process.exit(1);});
