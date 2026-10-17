// "New here?" button: a button on the welcome message (and an optional panel) that shows the pressing
// member a private multi-embed message. Covers defaults, input cleaning, placeholders, the welcome
// button, the private reply, the panel (posted, then edited in place) and /welcome newmember.
process.env.TOKEN='x';process.env.CLIENT_ID='1';process.env.MONGODB_URI='m';
const root=require('path').join(__dirname,'..')+'/'; const assert=require('assert');
const { PermissionsBitField, Collection } = require(root+'node_modules/discord.js');
const { store } = require('./helpers/memstore');
const WelcomeConfig=require(root+'src/database/models/WelcomeConfig'); store(WelcomeConfig);
const NM=require(root+'src/bot/cogs/modules/newMember');
const W=require(root+'src/bot/cogs/modules/welcome');

const msgs=new Map(); let mid=1;
const ch={id:'c1',name:'welcome',isTextBased:()=>true,isThread:()=>false,permissionsFor:()=>new PermissionsBitField(PermissionsBitField.All),sent:[],
  send:async(p)=>{const m={id:'m'+(mid++),payload:p,edit:async(np)=>{m.payload=np;}}; msgs.set(m.id,m); ch.sent.push(m); return m;},
  messages:{fetch:async(id)=>msgs.get(id)||Promise.reject(new Error('x'))}};
const guild={id:'g',name:'Loof',memberCount:41,channels:{cache:new Collection([['c1',ch]])},members:{me:{}},iconURL:()=>null};
const member={id:'u',guild,user:{username:'nova',displayAvatarURL:()=>'https://cdn/nova.png'}};

(async()=>{
  // ---- defaults + cleaning
  let s=NM.settings(null);
  assert.equal(s.enabled,false); assert.equal(s.onWelcome,true); assert.equal(s.buttonLabel,'New here? Click me');
  assert.ok(s.message.embeds.length>=2,'starter is a multi-embed message');
  assert.match(NM.cleanInput({buttonEmoji:'hi'}).errors[0],/single emoji/);
  assert.deepEqual(NM.cleanInput({buttonEmoji:'<:pet:123>'}).errors,[]);
  assert.match(NM.cleanInput({buttonLabel:'',buttonEmoji:''}).errors[0],/label or an emoji/);
  assert.match(NM.cleanInput({message:{content:'',embeds:[]}}).errors[0],/Add some message text/);
  const big={embeds:Array.from({length:12},(_,i)=>({title:'E'+i}))};
  assert.equal(NM.cleanInput({message:big}).data.message.embeds.length,10,'capped at 10 embeds');
  assert.equal(NM.cleanInput({message:{embeds:[{title:'x',thumbnail:{url:'{avatar}'}}]}}).data.message.embeds[0].thumbnail.url,'{avatar}','{avatar} survives cleaning');
  console.log('✓ defaults, emoji / empty / 10-embed checks, {avatar} kept');

  // ---- placeholders + the private reply
  const p=NM.privatePayload(NM.settings({newMember:{message:{content:'Hi {user}',embeds:[{title:'Welcome to {server}, {username}!',thumbnail:{url:'{avatar}'},fields:[{name:'#{membercount}',value:'v'}]},{description:'second'}]}}}),member);
  assert.equal(p.ephemeral,true,'only they can see it'); assert.equal(p.content,'Hi <@u>'); assert.deepEqual(p.allowedMentions,{parse:[]});
  assert.equal(p.embeds.length,2); assert.equal(p.embeds[0].title,'Welcome to Loof, nova!'); assert.equal(p.embeds[0].thumbnail.url,'https://cdn/nova.png'); assert.equal(p.embeds[0].fields[0].name,'#41');
  let out=null; const press={guildId:'g',member,reply:async(o)=>{out=o;}};
  await NM.handleNewMemberButton(press); assert.match(out.content,/isn’t set up/); assert.equal(out.ephemeral,true);
  let r=await NM.saveSettings('g',{enabled:true,buttonLabel:'Start here',buttonEmoji:'🧭',buttonStyle:'Success'}); assert.ok(!r.error,r.error);
  await NM.handleNewMemberButton(press); assert.equal(out.ephemeral,true); assert.equal(out.embeds.length,NM.DEFAULT_MESSAGE.embeds.length,'starter message when none is saved');
  assert.equal(out.embeds[0].title,'👋 Welcome to Loof, nova!');
  console.log('✓ pressing the button shows the filled-in message privately (ephemeral, no pings)');

  // ---- on the welcome message
  await WelcomeConfig.updateOne({guildId:'g'},{$set:{enabled:true,channelId:'c1',messageContent:'Welcome {user}!'}});
  assert.equal(await W.sendWelcome(member),null);
  let row=ch.sent.at(-1).payload.components[0].toJSON().components[0];
  assert.equal(row.custom_id,NM.BUTTON_ID); assert.equal(row.label,'Start here'); assert.equal(row.emoji.name,'🧭'); assert.equal(row.style,3);
  await NM.saveSettings('g',{onWelcome:false}); await W.sendWelcome(member);
  assert.equal(ch.sent.at(-1).payload.components,undefined,'switched off → no button on the welcome');
  await NM.saveSettings('g',{onWelcome:true,enabled:false}); await W.sendWelcome(member);
  assert.equal(ch.sent.at(-1).payload.components,undefined,'module off → no button');
  await NM.saveSettings('g',{enabled:true});
  console.log('✓ the button rides on the welcome message only when switched on');

  // ---- panel: posted once, then edited in place
  s=NM.settings(await WelcomeConfig.findOne({guildId:'g'}).lean());
  let pr=await NM.postPanel(guild,s,'c1'); assert.ok(pr.messageId); const n=ch.sent.length;
  assert.match(JSON.stringify(ch.sent.at(-1).payload.embeds),/New here\?/); assert.equal(ch.sent.at(-1).payload.components[0].toJSON().components[0].custom_id,NM.BUTTON_ID);
  await WelcomeConfig.updateOne({guildId:'g'},{$set:{'newMember.panelChannelId':'c1','newMember.panelMessageId':pr.messageId}});
  await NM.saveSettings('g',{panel:{content:'Tap below 👇',embeds:[]}});
  s=NM.settings(await WelcomeConfig.findOne({guildId:'g'}).lean());
  pr=await NM.postPanel(guild,s,'c1'); assert.equal(pr.edited,true); assert.equal(ch.sent.length,n,'no second panel');
  assert.equal(msgs.get(pr.messageId).payload.content,'Tap below 👇');
  assert.match((await NM.postPanel(guild,s,'nope')).error,/text channel/);
  console.log('✓ panel posts once and updates in place');

  // ---- /welcome newmember
  const cmd=require(root+'src/bot/commands/greetings').commands.find(c=>c.data.name==='welcome');
  const i=(sub,opts={})=>({guildId:'g',guild,member,options:{getSubcommand:()=>sub,getChannel:()=>ch,getString:(k)=>opts[k]??null,getBoolean:(k)=>opts[k]??null},reply:async(o)=>{out=o;},deferReply:async()=>{},editReply:async(o)=>{out=o;}});
  await cmd.execute(i('newmember',{button_label:'Hi there',button_color:'Danger'}));
  assert.match(out.content,/\*\*on\*\*/); assert.match(out.content,/Hi there \(Danger\)/);
  await cmd.execute(i('newmember',{button_emoji:'nope'})); assert.match(out.content,/single emoji/);
  await cmd.execute(i('newmember_preview')); assert.equal(out.ephemeral,true); assert.ok(out.embeds.length);
  await cmd.execute(i('newmember_panel')); assert.match(out,/Panel updated/);
  console.log('✓ /welcome newmember · newmember_preview · newmember_panel');
  process.exit(0);
})().catch(e=>{console.error(e);process.exit(1);});
