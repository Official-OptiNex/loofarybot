const {memModel}=require('./helpers/memmodel');
const root=require('path').join(__dirname,'..')+'/'; const assert=require('assert');
const { Collection, PermissionsBitField, ChannelType } = require(root+'node_modules/discord.js');
const Giveaway=require(root+'src/database/models/Giveaway'); const rows=memModel(Giveaway);
const form=require(root+'src/bot/cogs/modules/giveawayForm');
const loof=require(root+'src/bot/commands/loof');
const sent=[];
const ch={id:'c1',name:'general',type:ChannelType.GuildText,isTextBased:()=>true,toString:()=>'<#c1>',permissionsFor:()=>new PermissionsBitField(PermissionsBitField.All),
  send:async(o)=>{sent.push(o);return{id:'m'+sent.length,url:'https://discord/x/'+sent.length,edit:async()=>{}};},messages:{fetch:async()=>null}};
const guild={id:'g1',channels:{cache:new Collection([['c1',ch]])},members:{me:{}},roles:{cache:new Collection()}};
ch.guild=guild;
const client={channels:{fetch:async()=>ch}};
const user={id:'u1'};
let modal=null, reply=null, updates=[];
const baseI={guildId:'g1',guild,user,channelId:'c1',memberPermissions:new PermissionsBitField(PermissionsBitField.All),client};
function fields(map){return{getTextInputValue:(id)=>{if(!(id in map))throw new Error('no');return map[id];},getStringSelectValues:(id)=>map[id]||[],getSelectedChannels:(id)=>map[id]?new Collection([[map[id],{id:map[id]}]]):null,getSelectedRoles:(id)=>map[id]?new Collection([[map[id],{id:map[id]}]]):null};}
(async()=>{
  // /loof create → modal
  await loof.execute({...baseI,options:{getSubcommand:()=>'create',getChannel:()=>null,getRole:()=>null,getString:(n)=>n==='type'?'drop':null},showModal:async(m)=>{modal=m.toJSON();}},client);
  assert.equal(modal.title,'Create a giveaway'); assert.equal(modal.components.length,5);
  const draftId=modal.custom_id.split(':')[1];
  assert.ok(modal.components[0].component.options.find(o=>o.value==='drop').default,'type preselected');
  console.log('✓ /loof create opens form:', modal.components.map(c=>c.label).join(' | '));
  // submit basics (first time → reply)
  await form.handleDraftModal({...baseI,customId:`gwd:${draftId}:basics`,fields:fields({type:['timed'],channel:'c1',prize:'Nitro',duration:'2h',winners:'3'}),isFromMessage:()=>false,reply:async(o)=>{reply=o;}});
  assert.ok(reply.ephemeral); assert.equal(reply.embeds[1].data.title,'🎁 Giveaway: Nitro'); assert.equal(reply.components[1].components[0].data.disabled,false);
  console.log('✓ panel:', reply.embeds[0].data.description.split('\n').slice(0,4).join(' / '));
  const upd=(o)=>{updates.push(o);};
  // look, requirements, ping
  await form.handleDraftModal({...baseI,customId:`gwd:${draftId}:look`,fields:fields({description:'Win big',color:'red',emoji:'🎁'}),isFromMessage:()=>true,update:upd});
  await form.handleDraftModal({...baseI,customId:`gwd:${draftId}:req`,fields:fields({role:'r9',days:'7',level:''}),isFromMessage:()=>true,update:upd});
  await form.handleDraftModal({...baseI,customId:`gwd:${draftId}:ping`,fields:fields({ping:['here'],role:'r5'}),isFromMessage:()=>true,update:upd});
  const last=updates.at(-1); assert.match(last.embeds[1].data.description,/Win big[\s\S]*<@&r9>[\s\S]*7\+ day/); assert.match(last.embeds[0].data.description,/@here <@&r5>/);
  console.log('✓ look / requirements / ping update the preview');
  // bad duration disables start
  await form.handleDraftModal({...baseI,customId:`gwd:${draftId}:basics`,fields:fields({type:['timed'],channel:'c1',prize:'Nitro',duration:'soon',winners:'3'}),isFromMessage:()=>true,update:upd});
  assert.equal(updates.at(-1).components[1].components[0].data.disabled,true); assert.match(updates.at(-1).embeds[0].data.description,/Duration must look like/);
  await form.handleDraftModal({...baseI,customId:`gwd:${draftId}:basics`,fields:fields({type:['timed'],channel:'c1',prize:'Nitro',duration:'2h',winners:'3'}),isFromMessage:()=>true,update:upd});
  console.log('✓ invalid duration blocks Start with a clear message');
  // reopen modals prefilled
  let reopened=null; await form.handleDraftButton({...baseI,customId:`gwd:${draftId}:req`,showModal:async(m)=>{reopened=m.toJSON();}},client);
  assert.deepEqual(reopened.components[0].component.default_values,[{id:'r9',type:'role'}]); assert.equal(reopened.components[1].component.value,'7');
  console.log('✓ buttons reopen forms with saved values');
  // start
  let edited=null; await form.handleDraftButton({...baseI,customId:`gwd:${draftId}:start`,deferUpdate:async()=>{},editReply:async(o)=>{edited=o;}},client);
  assert.match(edited.content,/Giveaway started/); const g=rows[0];
  assert.equal(g.prize,'Nitro'); assert.equal(g.winnerCount,3); assert.equal(g.colorHex,'#ED4245'); assert.equal(g.emoji,'🎁'); assert.equal(g.requirements.roleId,'r9'); assert.equal(g.requirements.minDaysInServer,7); assert.equal(g.requirements.minLevel,null);
  assert.equal(sent.at(-1).content,'@here <@&r5>'); assert.ok(Math.abs(g.endTimestamp-(Date.now()+7200e3))<5000);
  console.log('✓ Start posts it with every option');
  // expired draft
  let exp=null; await form.handleDraftButton({...baseI,customId:`gwd:${draftId}:start`,reply:async(o)=>{exp=o;}},client); assert.match(exp.content,/expired/);
  // another user's draft
  await loof.execute({...baseI,options:{getSubcommand:()=>'create',getChannel:()=>null,getRole:()=>null,getString:()=>null},showModal:async(m)=>{modal=m.toJSON();}},client);
  const id2=modal.custom_id.split(':')[1]; exp=null;
  await form.handleDraftButton({...baseI,user:{id:'intruder'},customId:`gwd:${id2}:start`,reply:async(o)=>{exp=o;}},client); assert.match(exp.content,/expired/);
  console.log('✓ expired / other people\'s setups are refused');
  // /loof start with type drop + ping
  let r=null; const opts={getSubcommand:()=>'start',getString:(n)=>({duration:'1h',prize:'Key',type:'drop',ping:'everyone'})[n]??null,getInteger:(n)=>n==='winners'?2:null,getRole:()=>null,getChannel:()=>ch,getBoolean:()=>null};
  await loof.execute({...baseI,options:opts,deferReply:async function(){this.deferred=true;},deferred:true,editReply:async(o)=>{r=o;}},client);
  const drop=rows.at(-1); assert.equal(drop.type,'drop'); assert.equal(drop.emoji,'⚡'); assert.equal(sent.at(-1).content,'@everyone'); assert.equal(drop.colorHex,'#F1C40F');
  console.log('✓ /loof start type:drop ping:@everyone');
  // /loof edit
  const eo=(vals)=>({getSubcommand:()=>'edit',getString:(n)=>vals[n]??null,getInteger:(n)=>vals[n]??null,getRole:()=>null,getBoolean:()=>null});
  await loof.execute({...baseI,options:eo({message_id:g.messageId,ends_in:'3d',new_description:'New desc',new_color:'green',new_winners:5}),deferReply:async()=>{},deferred:true,editReply:async(o)=>{r=o;}},client);
  assert.match(r.content,/Updated/); assert.equal(rows[0].customDesc,'New desc'); assert.equal(rows[0].winnerCount,5); assert.equal(rows[0].colorHex,'#57F287');
  await loof.execute({...baseI,options:eo({message_id:g.messageId}),deferReply:async()=>{},deferred:true,editReply:async(o)=>{r=o;}},client); assert.match(r.content,/Nothing to change/);
  console.log('✓ /loof edit (ends_in, description, color, winners)');
  // autocomplete
  let ac=null; const acI=(sub,name,value)=>({...baseI,options:{getFocused:()=>({name,value}),getSubcommand:()=>sub},respond:async(c)=>{ac=c;}});
  await loof.autocomplete(acI('end','message_id','nit')); assert.equal(ac.length,1); assert.match(ac[0].name,/Nitro — #general · 0 entries · ends in/);
  await loof.autocomplete(acI('reroll','message_id','')); assert.equal(ac.length,0,'nothing ended yet');
  await loof.autocomplete(acI('start','duration','')); assert.equal(ac[0].value,'10m');
  await loof.autocomplete(acI('start','duration','90m')); assert.equal(ac[0].name,'90m (1h 30m)');
  await loof.autocomplete({...acI('end','message_id',''),memberPermissions:new PermissionsBitField(0n),user:{id:'nobody'}}); assert.equal(ac.length,0,'non-admins see nothing');
  console.log('✓ autocomplete: giveaways by prize, durations, hidden from non-admins');
  process.exit(0);
})().catch(e=>{console.error(e);process.exit(1);});
