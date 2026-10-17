// Guide editors (a guide editor role, no moderator role) have only the Guides page, so the dashboard
// sends them straight there: the server picker, the guild overview and login all lead to Guides.
process.env.TOKEN='x';process.env.CLIENT_ID='123';process.env.MONGODB_URI='mongodb://x';process.env.REDIRECT_URI='https://x.onrender.com/auth/discord/callback';
const root=require('path').join(__dirname,'..')+'/'; const assert=require('assert');
const express=require(root+'node_modules/express');
const { Collection, ChannelType } = require(root+'node_modules/discord.js');
const { store } = require('./helpers/memstore');
const GuildConfig=require(root+'src/database/models/GuildConfig'); const Guide=require(root+'src/database/models/Guide');
store(GuildConfig); store(Guide);
const { guidesOnly, homeFor } = require(root+'src/web/utils/authMiddleware');

// ---- unit: who counts as guides-only
assert.equal(guidesOnly({level:'mod',pages:new Set(['guides'])}),true);
assert.equal(guidesOnly({level:'mod',pages:new Set(['guides','leaderboard'])}),false,'a moderator who also edits guides keeps the overview');
assert.equal(guidesOnly({level:'admin',pages:null}),false);
assert.equal(homeFor('7',{level:'mod',pages:new Set(['guides'])}),'/dashboard/7/guides');
assert.equal(homeFor('7',{level:'admin',pages:null}),'/dashboard/7');
console.log('✓ guidesOnly / homeFor');

// ---- fake bot client: two servers where the user holds only the guide editor role
const member=(roles)=>({id:'u1',permissions:{has:()=>false},roles:{cache:new Collection(roles.map((r)=>[r,{id:r}]))}});
const mkGuild=(id,name,roles)=>({id,name,memberCount:10,iconURL:()=>null,
  members:{fetch:async()=>member(roles),me:{id:'bot'}},
  channels:{cache:new Collection([['f'+id,{id:'f'+id,name:'guides',type:ChannelType.GuildForum,availableTags:[],isTextBased:()=>false,isThread:()=>false}]])},
  roles:{cache:new Collection([['ed',{id:'ed',name:'Guide Editor',managed:false}]])},
  emojis:{cache:new Collection()}});
const guilds=new Collection([['g1',mkGuild('g1','Loofary',['ed'])],['g2',mkGuild('g2','Second',['ed'])]]);
const client={guilds:{cache:guilds}};
let sessionGuilds=[{id:'g1',name:'Loofary',permissions:'0'}];

const app=express();
app.locals.discordClient=client;
app.set('view engine','ejs'); app.set('views',root+'src/web/views');
app.use((req,res,next)=>{ req.session={user:{id:'u1',name:'Nick',avatarUrl:''},guilds:sessionGuilds}; Object.assign(res.locals,{user:req.session.user,botName:'LoofaryBot',botAvatar:'',inviteUrl:'x'}); next(); });
app.use('/dashboard',require(root+'src/web/routes/guides'));
app.use('/dashboard',require(root+'src/web/routes/dashboard'));

(async()=>{
  for (const id of ['g1','g2']) await GuildConfig.create({guildId:id,guides:{enabled:true,forumChannelId:'f'+id,editorRoleIds:['ed']}});
  const srv=app.listen(0); const base=`http://localhost:${srv.address().port}`;
  const get=(p)=>fetch(base+p,{redirect:'manual'});

  // one server, guides only → the picker is skipped
  let r=await get('/dashboard');
  assert.equal(r.status,302); assert.equal(r.headers.get('location'),'/dashboard/g1/guides','straight to the Guides page');
  // the overview redirects too
  r=await get('/dashboard/g1');
  assert.equal(r.status,302); assert.equal(r.headers.get('location'),'/dashboard/g1/guides','overview → Guides');
  // the Guides page itself loads, with a way back to the server list (not the overview)
  r=await get('/dashboard/g1/guides');
  const html=await r.text();
  assert.equal(r.status,200,html.slice(0,300)); assert.match(html,/← Servers/); assert.doesNotMatch(html,/href="\/dashboard\/g1" /);
  console.log('✓ guide editor: login/picker and overview go straight to Guides');

  // two servers → the picker shows, each tile opening that server's Guides page
  sessionGuilds=[{id:'g1',name:'Loofary',permissions:'0'},{id:'g2',name:'Second',permissions:'0'}];
  r=await get('/dashboard');
  const pick=await r.text();
  assert.equal(r.status,200);
  assert.match(pick,/href="\/dashboard\/g1\/guides"/); assert.match(pick,/href="\/dashboard\/g2\/guides"/);
  assert.match(pick,/Guide editor/,'labelled as a guide editor');
  console.log('✓ guide editor in several servers: tiles open each Guides page');

  srv.close(); process.exit(0);
})().catch((e)=>{console.error(e);process.exit(1);});
