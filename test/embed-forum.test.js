// Embed builder → forum channels: sending creates a new forum post (title + tags), with the same
// permission checks as a text channel, and the post can be edited afterwards like any bot message.
process.env.TOKEN='x';process.env.CLIENT_ID='123';process.env.MONGODB_URI='mongodb://x';
const root=require('path').join(__dirname,'..')+'/'; const assert=require('assert');
const { PermissionsBitField, Collection, ChannelType } = require(root+'node_modules/discord.js');

const me={id:'bot'}; let perms=PermissionsBitField.All;
const created=[]; const threads=new Collection();
const message=(id,channelId,payload)=>({id,channelId,author:{id:'bot'},content:payload.content,embeds:payload.embeds||[],edits:[],edit:async function(p){this.edits.push(p);return this;},url:`https://discord.com/channels/g/${channelId}/${id}`});
const forum={id:'f1',name:'announcements',type:ChannelType.GuildForum,isTextBased:()=>false,isThread:()=>false,
  flags:{has:(f)=>f==='RequireTag'&&forum.requireTag},requireTag:false,
  availableTags:[{id:'t1',name:'News',emoji:{name:'📰'}},{id:'t2',name:'Events',emoji:null}],
  permissionsFor:()=>new PermissionsBitField(perms),
  threads:{create:async(opts)=>{ const id=String(9000+created.length); created.push(opts);
    const starter=message(id,id,opts.message);
    const thread={id,type:ChannelType.PublicThread,isTextBased:()=>true,isThread:()=>true,messages:{fetch:async(mid)=>{ if(mid!==id) throw new Error('Unknown'); return starter; }}};
    threads.set(id,thread); return thread; }}};
const text={id:'c1',name:'general',type:ChannelType.GuildText,isTextBased:()=>true,isThread:()=>false,permissionsFor:()=>new PermissionsBitField(perms),send:async(p)=>message('m1','c1',p)};
const guild={id:'111',channels:{cache:new Collection([['f1',forum],['c1',text]]),fetch:async(id)=>threads.get(id)||null},members:{me}};

(async()=>{
  const auth=require(root+'src/web/utils/authMiddleware');
  auth.requireAuth=(q,s,n)=>n(); auth.requireGuildAccess=(q,s,n)=>{q.guild=guild;n();}; auth.requirePage=()=>(q,s,n)=>n();
  const audit=require(root+'src/web/utils/audit'); audit.auditTrail=(q,s,n)=>n();
  const express=require(root+'node_modules/express'); const app=express(); app.use(express.json());
  app.use('/dashboard',require(root+'src/web/routes/embedBuilder'));
  const srv=app.listen(0); const base=`http://127.0.0.1:${srv.address().port}/dashboard/111/embed/send`;
  const send=async(body)=>{ const r=await fetch(base,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}); return {status:r.status,...await r.json()}; };
  const msg={content:'Hello',embeds:[{title:'Patch notes',description:'Lots of fixes'}]};

  let r=await send({message:msg,channelId:'f1'}); assert.equal(r.status,400); assert.match(r.error,/title/);
  r=await send({message:msg,channelId:'f1',postTitle:'x'.repeat(101)}); assert.match(r.error,/100 characters/);
  forum.requireTag=true; r=await send({message:msg,channelId:'f1',postTitle:'Patch 1.2'}); assert.match(r.error,/requires a tag/); forum.requireTag=false;
  r=await send({message:msg,channelId:'f1',postTitle:'Patch 1.2',tagIds:['t1','nope','t1']});
  assert.equal(r.ok,true); assert.equal(r.forum,true); assert.equal(r.url,'https://discord.com/channels/111/9000/9000');
  assert.equal(created[0].name,'Patch 1.2'); assert.deepEqual(created[0].appliedTags,['t1'],'unknown and repeated tags are dropped');
  assert.equal(created[0].message.content,'Hello'); assert.equal(created[0].message.embeds[0].title,'Patch notes');
  console.log('✓ a forum channel creates a new post with the title, tags and the embed as its first message');

  // The returned link works with "Edit a bot message".
  r=await send({message:{content:'Hello again',embeds:msg.embeds},editUrl:r.url}); assert.equal(r.edited,true,JSON.stringify(r));
  console.log('✓ the forum post can be edited afterwards from its link');

  perms=PermissionsBitField.Flags.ViewChannel; r=await send({message:msg,channelId:'f1',postTitle:'Nope'}); assert.equal(r.status,403); assert.match(r.error,/Create Posts/);
  perms=PermissionsBitField.All; r=await send({message:msg,channelId:'c1'}); assert.equal(r.ok,true); assert.equal(r.forum,undefined);
  console.log('✓ needs Create Posts + Embed Links in the forum; text channels work as before');
  srv.close(); process.exit(0);
})().catch(e=>{console.error(e);process.exit(1);});
