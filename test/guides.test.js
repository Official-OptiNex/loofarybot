// Guides: forum-published articles the bot owns. Covers settings validation, create/edit/delete
// (forum post create + in-place edit), the auto-updating legend, bulk import, the private editor
// channel, editor permission checks, and lookup/search.
process.env.TOKEN='x';process.env.CLIENT_ID='123';process.env.MONGODB_URI='mongodb://x';process.env.REDIRECT_URI='https://x.onrender.com/auth/discord/callback';
const root=require('path').join(__dirname,'..')+'/'; const assert=require('assert');
const { Collection, ChannelType, PermissionFlagsBits } = require(root+'node_modules/discord.js');
const { store } = require('./helpers/memstore');
const GuildConfig=require(root+'src/database/models/GuildConfig');
const Guide=require(root+'src/database/models/Guide');
store(GuildConfig); store(Guide);
const G=require(root+'src/bot/cogs/modules/guides');

// ---- fakes: a forum channel whose threads keep an editable starter message
const threads=[]; let tid=100;
function makeThread(id,name,payload,tags){ const t={id,name,appliedTags:tags||[],pinned:false,deleted:false,
  starter:{id,payload,edit:async(p)=>{t.starter.payload=p;return t.starter;}},
  fetchStarterMessage:async()=>t.starter, setName:async(n)=>{t.name=n;}, setAppliedTags:async(a)=>{t.appliedTags=a;},
  pin:async()=>{t.pinned=true;}, delete:async()=>{t.deleted=true; cache.delete(id);}}; return t; }
const cache=new Collection();
const forum={id:'forum',type:ChannelType.GuildForum,name:'guides',availableTags:[{id:'tg1',name:'Guides'},{id:'tg2',name:'FAQ'}],
  threads:{ create:async({name,message,appliedTags})=>{ const t=makeThread('t'+(tid++),name,message,appliedTags); threads.push(t); cache.set(t.id,t); return t; },
            fetch:async(id)=>{ const t=cache.get(id); return (t&&!t.deleted)?t:Promise.reject(new Error('unknown')); } }};
const createdChannels=[];
const guild={id:'g',name:'Server',channels:{cache,create:async({name,type,permissionOverwrites})=>{ const c={id:'ch'+(tid++),name,type,_ov:permissionOverwrites,permissionOverwrites:{set:async(ov)=>{c._ov=ov;}}}; cache.set(c.id,c); createdChannels.push(c); return c; }},
  roles:{everyone:{id:'g'},cache:new Collection([['ed',{id:'ed',name:'Editors',managed:false}],['vip',{id:'vip',name:'VIP',managed:false}]])},
  members:{me:{id:'bot',permissions:{has:()=>true},roles:{highest:{position:10}}}}};
forum.guild=guild; cache.set('forum',forum);
const member=(roleIds=[],admin=false)=>({id:'u1',permissions:{has:(p)=>admin},roles:{cache:{has:(r)=>roleIds.includes(r)}}});

(async()=>{
  await GuildConfig.create({guildId:'g'});

  // ---- settings: must be a forum; editor roles filtered to real roles
  let bad=await G.saveSettings(guild,{enabled:true,forumChannelId:'nope'});
  assert.match(bad.error,/forum/i,'a non-forum channel is rejected');
  let sv=await G.saveSettings(guild,{enabled:true,forumChannelId:'forum',editorRoleIds:['ed','ghost']});
  assert.deepEqual(sv.settings.editorRoleIds,['ed'],'unknown roles are dropped');
  const freshSettings=async()=>G.guidesSettings(await GuildConfig.findOne({guildId:'g'}).lean());
  let s=await freshSettings();

  // ---- editor permission check
  assert.equal(G.isEditor(member(['ed']),s),true,'editor role → can edit');
  assert.equal(G.isEditor(member(['vip']),s),false,'random role → cannot edit');
  assert.equal(G.isEditor(member([],true),s),true,'admin → can edit');
  console.log('✓ settings validated (forum required, roles filtered) + isEditor');

  // ---- create a guide → forum thread + stored ids + legend appears
  let r=await G.createGuide(guild,{title:'Data Collection',tags:['Guides'],body:'**How** to collect data',authorId:'u1',createdBy:'u1'},s);
  assert.ok(!r.error,r.error); assert.equal(r.guide.title,'Data Collection'); assert.equal(r.guide.slug,'data-collection');
  const thread=cache.get(r.guide.threadId);
  assert.ok(thread,'a forum thread was created'); assert.deepEqual(thread.appliedTags,['tg1'],'tag name mapped to forum tag id');
  assert.match(JSON.stringify(thread.starter.payload),/How/,'the body is in the post');
  s=await freshSettings();
  assert.ok(s.legendThreadId,'a legend thread was created and stored');
  const legend=cache.get(s.legendThreadId);
  assert.match(JSON.stringify(legend.starter.payload),/Guides Index/,'legend titled');
  assert.match(JSON.stringify(legend.starter.payload),/Data Collection/,'legend lists the guide');
  console.log('✓ create: forum post with mapped tags + body, legend created and lists it');

  // ---- duplicate title gets a unique slug
  r=await G.createGuide(guild,{title:'Data Collection',tags:[],body:'second',authorId:'u1'},s);
  assert.equal(r.guide.slug,'data-collection-2','duplicate title → -2 slug');

  // ---- edit updates the SAME thread in place (no new thread)
  const before=threads.length;
  let e=await G.editGuide(guild,'data-collection',{title:'Data Collection (v2)',body:'updated body'},'u2',s);
  assert.ok(!e.error,e.error); assert.equal(threads.length,before,'editing reuses the thread, no new post');
  assert.equal(thread.name,'Data Collection (v2)','thread renamed');
  assert.match(JSON.stringify(thread.starter.payload),/updated body/,'starter message edited in place');
  console.log('✓ edit: same post renamed + body edited in place');

  // ---- lookup + search
  assert.equal((await G.getGuide('g','data-collection')).slug,'data-collection','lookup by slug');
  assert.equal((await G.getGuide('g','DATA collection (v2)'))?.slug,'data-collection','lookup by title (case-insensitive)');
  assert.equal((await G.searchGuides('g','updated')).length>=1,true,'search matches body text');
  console.log('✓ lookup by slug/title + search');

  // ---- import: bulk create, skip entries with no title
  const imp=await G.importGuides(guild,[
    {title:'FAQ',tags:['FAQ'],body:{embeds:[{description:'answers'}]},images:['https://e.com/a.png']},
    {title:'',body:'no title'},
    {title:'Targets',body:'hit your targets'}
  ],'u1',s);
  assert.deepEqual(imp.imported.sort(),['FAQ','Targets'],'two imported');
  assert.equal(imp.skipped.length,1,'the titleless one is skipped');
  const faq=await G.getGuide('g','faq');
  assert.match(JSON.stringify(faq.body),/a\.png/,'image URL merged into the FAQ body');
  console.log('✓ import: bulk create, images merged, bad rows skipped');

  // ---- import: :Name: shortcodes become the server's custom emojis (exact case wins, unknown left alone)
  guild.emojis={cache:new Collection([['e1',{id:'e1',name:'RaidGem',animated:false}],['e2',{id:'e2',name:'raidgem',animated:false}],['e3',{id:'e3',name:'Diamond',animated:false}]])};
  const em=G.resolveEmojis(guild,{embeds:[{description:':raidgem: :RaidGem: :diamond: :nope: <:Diamond:e3> 6:21:30',thumbnail:{url:'https://e.com/:Diamond:.png'}}]});
  assert.equal(em.embeds[0].description,'<:raidgem:e2> <:RaidGem:e1> <:Diamond:e3> :nope: <:Diamond:e3> 6:21:30','shortcodes resolved, existing emoji tags untouched');
  assert.equal(em.embeds[0].thumbnail.url,'https://e.com/:Diamond:.png','URLs are never rewritten');
  delete guild.emojis;
  console.log('✓ import: emoji shortcodes resolved');

  // ---- reorder: manual order drives listGuides + the legend
  const slugsBefore=(await G.listGuides('g')).map((x)=>x.slug);
  const reversed=[...slugsBefore].reverse();
  await G.reorderGuides(guild,reversed,s);
  assert.deepEqual((await G.listGuides('g')).map((x)=>x.slug),reversed,'listGuides follows the saved order');
  const legend2=cache.get((await freshSettings()).legendThreadId);
  assert.match(JSON.stringify(legend2.starter.payload),/Guides Index/,'legend still rebuilt after reorder');
  console.log('✓ reorder: order persists and drives the list + legend');

  // ---- delete removes the post + record + updates legend
  const faqThreadObj=cache.get(faq.threadId);
  let d=await G.deleteGuide(guild,'faq',s);
  assert.ok(d.ok); assert.equal(faqThreadObj.deleted,true,'forum post deleted');
  assert.equal(await G.getGuide('g','faq'),null,'record removed');
  console.log('✓ delete: post + record removed, legend refreshed');

  // ---- Start Here: shown at the top of the pinned index post, never posted on its own
  const idx=cache.get((await freshSettings()).legendThreadId);
  const nThreads=threads.length;
  let sh=await G.createGuide(guild,{title:'Welcome',tags:['Start Here'],body:'read me first'},s);
  assert.ok(!sh.error,sh.error); assert.equal(threads.length,nThreads,'no separate post for the Start Here guide');
  assert.equal(sh.guide.threadId,idx.id,'Start Here links to the index post');
  const ip=JSON.stringify(idx.starter.payload);
  assert.ok(ip.indexOf('read me first')>=0 && ip.indexOf('read me first')<ip.indexOf('Guides Index'),'intro sits above the index');
  assert.ok(!/Welcome\]\(/.test(ip),'Start Here is not listed as a guide in the index');
  assert.match(idx.name,/Start Here/,'index post renamed to Start Here');
  await G.deleteGuide(guild,'welcome',s);
  assert.equal(idx.deleted,false,'deleting Start Here keeps the index post');
  assert.doesNotMatch(JSON.stringify(idx.starter.payload),/read me first/,'intro removed from the index');
  assert.equal(idx.name,'📖 Guides Index','index name restored');
  // an existing guide re-tagged as Start Here gives up its own post
  const tg=await G.getGuide('g','targets'); const tgThread=cache.get(tg.threadId);
  await G.editGuide(guild,'targets',{tags:['Start Here']},'u1',s);
  assert.equal(tgThread.deleted,true,'its own post is removed'); assert.equal((await G.getGuide('g','targets')).threadId,idx.id,'now points at the index');
  await G.editGuide(guild,'targets',{tags:['Guides']},'u1',s);
  const back=await G.getGuide('g','targets'); assert.notEqual(back.threadId,idx.id,'untagged → gets its own post again'); assert.ok(cache.get(back.threadId),'new post exists');
  console.log('✓ start here: merged into the pinned index post');

  // ---- "include in index" option: same as Start Here, works on import, several guides stack in order
  const nT=threads.length;
  const imp2=await G.importGuides(guild,[{title:'Mega Guide',inIndex:true,body:'mega intro'},{title:'Legend Box',tags:['Guides'],body:'legend text'}],'u1',s);
  assert.equal(imp2.imported.length,2);
  assert.equal(threads.length,nT+1,'only the normal guide got its own post');
  const mg=await G.getGuide('g','mega guide'); assert.equal(mg.inIndex,true); assert.equal(mg.threadId,idx.id,'in-index guide links to the index post');
  await G.editGuide(guild,'legend-box',{inIndex:true},'u1',s);
  const p2=JSON.stringify(idx.starter.payload);
  assert.ok(p2.indexOf('mega intro')>=0 && p2.indexOf('legend text')>=0 && p2.indexOf('legend text')<p2.indexOf('Guides Index'),'both included guides sit above the list');
  assert.match(idx.name,/Start Here/);
  await G.editGuide(guild,'mega-guide',{inIndex:false},'u1',s);
  const mg2=await G.getGuide('g','mega guide'); assert.notEqual(mg2.threadId,idx.id,'unticked → own post again');
  assert.doesNotMatch(JSON.stringify(idx.starter.payload),/mega intro/,'removed from the index');
  await G.deleteGuide(guild,'mega-guide',s); await G.deleteGuide(guild,'legend-box',s);
  assert.equal(idx.deleted,false,'index post survives'); assert.equal(idx.name,'📖 Guides Index');
  console.log('✓ include in index: flag, import, multiple, untick');

  // ---- index post look: name, title, colour, intro above the list, footer with {count}
  assert.deepEqual(G.cleanIndex({color:'#ff0000',name:'x'.repeat(150),intro:'  hi  '}),{name:'x'.repeat(100),title:'',color:0xff0000,intro:'hi',footer:''},'cleaned + capped');
  await G.saveIndex(guild,{name:'📖 Start Here',title:'Welcome!',color:'#00ff00',intro:'New? read this',footer:'{count} total'},await freshSettings());
  const look=JSON.stringify(idx.starter.payload);
  assert.equal(idx.name,'📖 Start Here','custom post name');
  assert.match(look,/Welcome!/); assert.match(look,/"color":65280/);
  assert.ok(look.indexOf('New? read this')<look.indexOf('Targets'),'intro sits above the guide list');
  assert.match(look,/\d+ guides? total/,'footer {count} filled in');
  assert.equal((await freshSettings()).index.title,'Welcome!','stored');
  await G.saveIndex(guild,{},await freshSettings());
  assert.equal(idx.name,'📖 Guides Index','cleared → defaults again');
  console.log('✓ index post: name, title, colour, intro, footer');

  // ---- private editor channel: created, @everyone denied view, editor role allowed
  const ec=await G.ensureEditorChannel(guild,s,{});
  assert.ok(!ec.error,ec.error); assert.equal(ec.channel.name,'guide-editors');
  const ov=ec.channel._ov;
  const everyone=ov.find((o)=>o.id==='g'); assert.ok(everyone.deny.includes(PermissionFlagsBits.ViewChannel),'@everyone denied view');
  const edOv=ov.find((o)=>o.id==='ed'); assert.ok(edOv.allow.includes(PermissionFlagsBits.ViewChannel),'editor role allowed view');
  s=await freshSettings(); assert.equal(s.editorChannelId,ec.channel.id,'editor channel stored');
  console.log('✓ editor channel: created, locked to editors, stored');

  process.exit(0);
})().catch((e)=>{console.error(e);process.exit(1);});
