// Dashboard integration of the newer features: sidebar/Overview on-off switches go through each
// feature's own rules (a channel is needed first), moderators only get switches for their pages,
// and the leaderboard shows XP shop badges.
process.env.TOKEN='x';process.env.CLIENT_ID='123';process.env.MONGODB_URI='mongodb://x';
const root=require('path').join(__dirname,'..')+'/'; const assert=require('assert');
const { PermissionsBitField, Collection } = require(root+'node_modules/discord.js');
const { store } = require('./helpers/memstore');
const M=(n)=>require(root+'src/database/models/'+n);
const rows={}; for (const n of ['GuildConfig','UserLevel','ShopItem','ShopOwnership','AuditEntry']) rows[n]=store(M(n));

const channel=(id)=>({id,name:id,isTextBased:()=>true,isThread:()=>false,permissionsFor:()=>new PermissionsBitField(PermissionsBitField.All)});
const members=new Collection([['ann',{id:'ann',displayName:'Ann',user:{bot:false},displayAvatarURL:()=>'a.png'}]]);
const guild={id:'g',name:'Lounge',channels:{cache:new Collection([['gen',channel('gen')]])},roles:{cache:new Collection()},emojis:{cache:new Collection()},
  members:{me:{id:'me',permissions:new PermissionsBitField(PermissionsBitField.All),roles:{highest:{position:9}}},cache:members,fetch:async()=>members,search:async()=>members}};

(async()=>{
  await M('GuildConfig').create({guildId:'g'});
  const express=require(root+'node_modules/express'); const auth=require(root+'src/web/utils/authMiddleware');
  let access={level:'admin',pages:null};
  auth.requireAuth=(q,s,n)=>n(); auth.requireGuildAccess=(q,s,n)=>{q.guild=guild;q.access=access;n();};
  const audit=require(root+'src/web/utils/audit'); audit.auditTrail=(q,s,n)=>n();
  const app=express(); app.use(express.json()); app.use((q,s,n)=>{q.session={user:{id:'admin',username:'ada'}};n();}); app.use('/api',require(root+'src/web/routes/api'));
  const srv=app.listen(0); const base=`http://127.0.0.1:${srv.address().port}/api/guilds/g`;
  const j=async(path,body)=>{ const res=await fetch(base+path,{method:body?'POST':'GET',headers:{'content-type':'application/json'},body:body?JSON.stringify(body):undefined}); return {status:res.status,...await res.json()}; };
  const cfg=()=>rows.GuildConfig.find(r=>r.guildId==='g');

  // Turning on a feature that needs a channel, before it has one → a clear error.
  for (const m of ['xpPot','birthdays','counting','starboard']) {
    const r=await j(`/modules/${m}`,{enabled:true}); assert.equal(r.status,400,m); assert.match(r.error,/channel/i);
  }
  let r=await j('/modules/chatdrops',{enabled:true}); assert.equal(r.status,400); assert.match(r.error,/channel/);
  // Auto-mod needs no channel.
  r=await j('/modules/automod',{enabled:true}); assert.equal(r.ok,true); assert.equal(cfg().automod.enabled,true);
  r=await j('/modules/automod',{enabled:false}); assert.equal(cfg().automod.enabled,false);
  // Once set up, the switches work both ways.
  cfg().xpPot={...(cfg().xpPot||{}),channelId:'gen'}; cfg().counting={...(cfg().counting||{}),channelId:'gen'};
  r=await j('/modules/xpPot',{enabled:true}); assert.equal(r.enabled,true); assert.equal(cfg().xpPot.enabled,true);
  r=await j('/modules/counting',{enabled:true}); assert.equal(cfg().counting.enabled,true);
  r=await j('/modules/xpPot',{enabled:false}); assert.equal(cfg().xpPot.enabled,false);
  r=await j('/modules/shop',{enabled:false}); assert.equal(cfg().shopEnabled,false);
  console.log('✓ sidebar/Overview switches: auto-mod, XP pot, birthdays, counting, starboard, chat drops, shop — and a channel is required first where one is needed');

  // A moderator with only the Engagement page can flip engagement switches, not auto-mod or the pot.
  access={level:'mod',pages:new Set(['engagement'])};
  r=await j('/modules/counting',{enabled:false}); assert.equal(r.ok,true);
  r=await j('/modules/automod',{enabled:true}); assert.equal(r.status,403);
  r=await j('/modules/xpPot',{enabled:true}); assert.equal(r.status,403);
  access={level:'admin',pages:null};
  console.log('✓ moderators only get the switches for pages they can edit');

  // Leaderboard shows shop badges and collectibles.
  await M('UserLevel').create({guildId:'g',userId:'ann',xp:5000,level:7});
  const badge=await M('ShopItem').create({guildId:'g',type:'badge',name:'Custom badge',emoji:'🎖️',price:1});
  const loofa=await M('ShopItem').create({guildId:'g',type:'collectible',name:'Golden Loofa',emoji:'🏆',price:1});
  await M('ShopOwnership').create({guildId:'g',userId:'ann',itemId:String(badge._id),type:'badge',active:true,custom:{emoji:'🦉',text:'Night Owl',color:'#FF00AA'}});
  await M('ShopOwnership').create({guildId:'g',userId:'ann',itemId:String(loofa._id),type:'collectible'});
  r=await j('/leaderboard');
  assert.equal(r.entries[0].name,'Ann'); assert.deepEqual(r.entries[0].badge,{emoji:'🦉',text:'Night Owl',color:'#FF00AA'}); assert.deepEqual(r.entries[0].collectibles,['🏆']);
  console.log('✓ the dashboard leaderboard shows XP shop badges and collectibles');
  srv.close();
  process.exit(0);
})().catch(e=>{console.error(e);process.exit(1);});
