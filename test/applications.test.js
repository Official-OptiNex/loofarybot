// Applications: forms with an Apply panel in any channel, requirement checks (level, account age, time
// in the server, role), one pending application, re-apply cooldown, review channel posting with pings,
// approve/deny (role + DM + review message update), and panel post/move/update/delete.
process.env.TOKEN='x';process.env.CLIENT_ID='123';process.env.MONGODB_URI='mongodb://x';process.env.REDIRECT_URI='https://x.onrender.com/auth/discord/callback';
const root=require('path').join(__dirname,'..')+'/'; const assert=require('assert');
const { Collection, ChannelType, PermissionFlagsBits } = require(root+'node_modules/discord.js');
const { store } = require('./helpers/memstore');
const ApplicationForm=require(root+'src/database/models/ApplicationForm');
const Application=require(root+'src/database/models/Application');
const UserLevel=require(root+'src/database/models/UserLevel');
store(ApplicationForm); store(Application); store(UserLevel);
const A=require(root+'src/bot/cogs/modules/applications');

// ---- fakes
let mid=1;
function textChannel(id,name){
  const msgs=new Map();
  const c={id,name,type:ChannelType.GuildText,isTextBased:()=>true,isThread:()=>false,permissionsFor:()=>({has:()=>true}),sent:[],
    send:async(p)=>{ const m={id:'m'+(mid++),payload:p,channel:c,deleted:false,url:`https://discord.com/channels/g/${id}/x`,edit:async(np)=>{m.payload=np;m.edits=(m.edits||0)+1;return m;}}; msgs.set(m.id,m); c.sent.push(m); return m; },
    messages:{fetch:async(i)=>msgs.get(i)||Promise.reject(new Error('gone')),delete:async(i)=>{const m=msgs.get(i); if(m){m.deleted=true; msgs.delete(i);}}}};
  return c;
}
const panelCh=textChannel('pc','apply-here'), panelCh2=textChannel('pc2','general'), reviewCh=textChannel('rc','staff-review');
const roles=new Collection([['ed',{id:'ed',name:'Guide Editor'}],['mods',{id:'mods',name:'Mods'}],['vip',{id:'vip',name:'VIP'}]]);
const DAY=86400000;
const dms=[];
function mkMember(id,{accountDays=100,joinedDays=50,roleIds=[],admin=false}={}){
  const set=new Set(roleIds);
  return {id,guild:null,joinedTimestamp:Date.now()-joinedDays*DAY,
    user:{id,tag:id+'#0',username:id,createdTimestamp:Date.now()-accountDays*DAY,displayAvatarURL:()=>'https://x/a.png',send:async(p)=>{dms.push({to:id,content:p.content});}},
    permissions:{has:(p)=>admin&&(p===PermissionFlagsBits.ManageGuild||p===PermissionFlagsBits.Administrator)},
    roles:{cache:{has:(r)=>set.has(r)},add:async(r)=>{set.add(r);}}};
}
const members={};
const guild={id:'g',name:'Loofary',channels:{cache:new Collection([['pc',panelCh],['pc2',panelCh2],['rc',reviewCh]])},roles:{cache:roles},
  members:{me:{id:'bot'},fetch:async(id)=>members[id]||Promise.reject(new Error('left'))},client:{users:{fetch:async(id)=>members[id]?.user||null}}};
const add=(m)=>{m.guild=guild; members[m.id]=m; return m;};
const newbie=add(mkMember('newbie',{accountDays:3,joinedDays:1}));
const vet=add(mkMember('vet'));
const vet2=add(mkMember('vet2'));
const mod=add(mkMember('mod',{roleIds:['mods']}));
const rando=add(mkMember('rando'));

// interaction stand-in that records what the bot answered
function ix(member,customId,fields={}){
  const r={customId,guildId:'g',guild,member,user:member.user,deferred:false,replied:false,out:[],modal:null,
    reply:async(o)=>{r.replied=true;r.out.push(typeof o==='string'?o:o.content);},deferReply:async()=>{r.deferred=true;},
    editReply:async(o)=>{r.out.push(typeof o==='string'?o:o.content);},showModal:async(m)=>{r.modal=m;},
    fields:{getTextInputValue:(k)=>fields[k]??''}};
  return r;
}

(async()=>{
  await UserLevel.create({guildId:'g',userId:'vet',level:7,xp:0});
  await UserLevel.create({guildId:'g',userId:'vet2',level:9,xp:0});
  await UserLevel.create({guildId:'g',userId:'newbie',level:2,xp:0});

  // ---- create: validation, defaults
  let bad=await A.createForm(guild,{name:'Guide Editor',review:{}});
  assert.match(bad.error,/review channel/i,'a review channel is required');
  bad=await A.createForm(guild,{name:'x',review:{channelId:'rc'},questions:Array.from({length:6},(_,i)=>({label:'Q'+i}))});
  assert.match(bad.error,/at most 5/,'Discord allows 5 questions');
  const made=await A.createForm(guild,{name:'Guide Editor',
    panel:{content:'<@&ed> hiring!',title:'Become a guide editor',description:'Help write guides.'},button:{label:'Apply now',emoji:'📝',style:'Success'},
    questions:[{label:'Why do you want to help?',style:'paragraph',maxLength:5000},{label:'Timezone',style:'short'}],
    requirements:{minLevel:5,minAccountAgeDays:30,minDaysInServer:2,requiredRoleId:'ghost'},
    limits:{reapplyCooldownHours:24},
    review:{channelId:'rc',pingRoleIds:['mods','ghost'],approveRoleId:'ed'}});
  assert.ok(!made.error,made.error);
  const F=made.form;
  assert.equal(F.questions[0].maxLength,1000,'long answers capped to fit an embed field');
  assert.equal(F.requirements.requiredRoleId,null,'unknown roles dropped'); assert.deepEqual(F.review.pingRoleIds,['mods']);
  console.log('✓ forms: validated + cleaned');

  // ---- panel: post, move, update on save
  let pub=await A.publishPanel(guild,F.formId,'pc');
  assert.ok(!pub.error,pub.error);
  const panel=panelCh.sent[0];
  assert.equal(panel.payload.content,'<@&ed> hiring!'); assert.deepEqual(panel.payload.allowedMentions,{parse:['roles']},'role pings in the message text ping');
  const btn=panel.payload.components[0].toJSON().components[0];
  assert.equal(btn.custom_id,`ap:apply:${F.formId}`); assert.equal(btn.label,'Apply now');
  pub=await A.publishPanel(guild,F.formId,'pc2');
  assert.equal(panel.deleted,true,'moving the panel removes the old one'); const panel2=panelCh2.sent[0];
  await A.saveForm(guild,F.formId,{panel:{title:'Guide editors wanted'}});
  assert.equal(panel2.edits,1,'saving edits the posted panel'); assert.match(JSON.stringify(panel2.payload.embeds),/Guide editors wanted/);
  console.log('✓ panel: post, move, update in place');

  // ---- requirements
  let i=ix(newbie,`ap:apply:${F.formId}`); await A.handleApplicationButton(i);
  assert.equal(i.modal,null,'no form for someone who doesn\'t qualify');
  assert.match(i.out[0],/❌ Be \*\*Level 5\+\*\* \(you're Level 2\)/); assert.match(i.out[0],/❌ Have a Discord account at least \*\*30 days\*\* old/); assert.match(i.out[0],/❌ Be in the server for \*\*2 days\*\*/);
  i=ix(vet,`ap:apply:${F.formId}`); await A.handleApplicationButton(i);
  assert.ok(i.modal,'qualifying member gets the form'); const mj=i.modal.toJSON(); assert.equal(mj.components.length,2,'one input per question');
  console.log('✓ requirements: level, account age, days in server');

  // ---- submit → review channel
  i=ix(vet,`apm:submit:${F.formId}`,{q0:'I love writing',q1:'UTC+10'}); await A.handleApplicationModal(i);
  assert.match(i.out[0],/✅ Your \*\*Guide Editor\*\* application was sent/);
  const review=reviewCh.sent[0];
  assert.equal(review.payload.content,'<@&mods>'); assert.deepEqual(review.payload.allowedMentions,{roles:['mods']},'only the chosen roles are pinged');
  const emb=review.payload.embeds[0].toJSON();
  assert.deepEqual(emb.fields.map((f)=>[f.name,f.value]),[['Why do you want to help?','I love writing'],['Timezone','UTC+10']]);
  assert.match(emb.description,/<@vet>/); assert.match(emb.description,/Level:\*\* 7/);
  i=ix(vet,`ap:apply:${F.formId}`); await A.handleApplicationButton(i);
  assert.match(i.out[0],/already have a \*\*Guide Editor\*\* application waiting/,'one pending application at a time');
  console.log('✓ submit: posted for review with the answers + ping; one pending at a time');

  // ---- review: only reviewers; approve gives the role, DMs, updates the message
  const app=(await A.listApplications('g'))[0];
  i=ix(rando,`ap:ok:${app._id}`); await A.handleApplicationButton(i);
  assert.match(i.out[0],/Only reviewers/); assert.equal(i.modal,null);
  i=ix(mod,`ap:ok:${app._id}`); await A.handleApplicationButton(i);
  assert.ok(i.modal,'ping roles can review');
  i=ix(mod,`apm:ok:${app._id}`,{reason:'Welcome!'}); await A.handleApplicationModal(i);
  assert.match(i.out[0],/✅ Approved\. They were sent a DM/);
  assert.equal(vet.roles.cache.has('ed'),true,'approve role given');
  assert.match(dms.find((d)=>d.to==='vet').content,/approved/); assert.match(dms.find((d)=>d.to==='vet').content,/Welcome!/);
  const rv=review.payload.components[0].toJSON().components; assert.equal(rv.every((b)=>b.disabled),true,'buttons disabled after a decision');
  assert.match(review.payload.embeds[0].toJSON().footer.text,/Approved · by mod#0 — Welcome!/);
  i=ix(mod,`apm:no:${app._id}`); await A.handleApplicationModal(i);
  assert.match(i.out[0],/already approved/,'a decision is final');
  i=ix(vet,`ap:apply:${F.formId}`); await A.handleApplicationButton(i);
  assert.match(i.out[0],/already have the <@&ed> role/,'can\'t apply for a role you have');
  console.log('✓ review: reviewers only, approve → role + DM + message updated');

  // ---- deny → re-apply cooldown
  await A.handleApplicationModal(ix(vet2,`apm:submit:${F.formId}`,{q0:'pls',q1:'UTC'}));
  const app2=(await A.listApplications('g',{status:'PENDING'}))[0];
  const res=await A.decide(guild,app2._id,{approve:false,by:{id:'mod',tag:'mod#0'},reason:'Too soon'});
  assert.equal(res.app.status,'DENIED'); assert.equal(vet2.roles.cache.has('ed'),false);
  assert.match(dms.find((d)=>d.to==='vet2').content,/not accepted/);
  i=ix(vet2,`ap:apply:${F.formId}`); await A.handleApplicationButton(i);
  assert.match(i.out[0],/apply for \*\*Guide Editor\*\* again <t:\d+:R>/,'re-apply cooldown after a denial');
  console.log('✓ deny: DM + re-apply cooldown');

  // ---- closed form, delete
  await A.saveForm(guild,F.formId,{open:false});
  assert.equal(panel2.payload.components[0].toJSON().components[0].disabled,true,'closing disables the button');
  i=ix(rando,`ap:apply:${F.formId}`); await A.handleApplicationButton(i); assert.match(i.out[0],/closed/);
  await A.deleteForm(guild,F.formId);
  assert.equal(panel2.deleted,true,'deleting removes the panel'); assert.equal(await A.getForm('g',F.formId),null);
  assert.equal((await A.listApplications('g')).length,2,'past applications are kept');
  console.log('✓ closed + delete');
  process.exit(0);
})().catch((e)=>{console.error(e);process.exit(1);});
