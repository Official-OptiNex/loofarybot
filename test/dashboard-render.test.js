process.env.TOKEN='x';process.env.CLIENT_ID='x';process.env.MONGODB_URI='mongodb://x';
const ejs=require('ejs'), fs=require('fs');
const root=require('path').join(__dirname,'..')+'/';
const { getGamblingSettings } = require(root+'src/bot/cogs/modules/gambling');
const { LOG_EVENTS } = require(root+'src/bot/cogs/modules/logging');
const { DEFAULT_TRAP_EMBED } = require(root+'src/bot/cogs/modules/honeypot');
const GuildConfig = require(root+'src/database/models/GuildConfig');
const WelcomeConfig = require(root+'src/database/models/WelcomeConfig');
const tpl=fs.readFileSync(root+'src/web/views/guild.ejs','utf8');
const guild={id:'1',name:'Loofary Lounge',iconURL:()=>null};
const base={guild,channels:[{id:'c1',name:'general'},{id:'c2',name:'welcome'}],roles:[{id:'r1',name:'Booster',assignable:true},{id:'r2',name:'Server Booster',assignable:false,managed:true,booster:true}],effectiveXp:{xpMin:1,xpMax:2,cooldownMs:1000,levelXpBase:100},logEvents:LOG_EVENTS,defaultTrapEmbed:DEFAULT_TRAP_EMBED,commandReference:require(root+'src/bot/commandReference'),stats:{memberCount:1234,boostTier:2,boostCount:9,channelCount:5,roleCount:7,emojiCount:3,createdTimestamp:Date.now()-400*864e5,ownerTag:'owner'},viewer:{id:'u',username:'nick</b>',avatarUrl:'https://cdn.discordapp.com/embed/avatars/0.png'},bot:{name:'LoofaryBot',avatarUrl:'x'},access:{level:'admin',pages:null},can:()=>true,modPageOptions:require(root+'src/web/utils/authMiddleware').MOD_PAGES,levelColorSettings:{enabled:true,interval:5,maxLevel:50,placement:'above',anchorRoleId:'r1',tiers:[]},levelColorTiers:[{level:5,custom:false,roleId:'x',color:'#5B8CFF'},{level:10,custom:true,roleId:'r1',color:'#ff00aa'}],levelColorPalette:require(root+'src/bot/cogs/modules/levelColors').PALETTE,recentMembers:[1,2,3,4].map(i=>({name:'m'+i,avatarUrl:'https://cdn.discordapp.com/embed/avatars/'+i+'.png'})),levelStats:{ranked:312,topLevel:42,totalXp:1843200},goals:{members:{current:1234,target:2500},ranked:{current:312,target:1234},boosts:{current:9,target:14,maxed:false}}};
const scripts=[];
for (const [config, welcome] of [[{}, new WelcomeConfig({guildId:'1'}).toObject()], [new GuildConfig({guildId:'1'}), {...new WelcomeConfig({guildId:'1',enabled:true,channelId:'c2',embedEnabled:true,embedConfig:{title:'Hi {username}',description:'</textarea><script>',thumbnailUrl:'{avatar}'}}).toObject()}]]) {
  const html=ejs.render(tpl,{...base,config,welcome,gambling:getGamblingSettings(config)},{filename:root+'src/web/views/guild.ejs'});
  const script=html.slice(html.lastIndexOf('<script>')+8, html.lastIndexOf('</script>'));
  new Function(script);
  console.log('guild ok', html.includes('</textarea><script>') ? 'UNESCAPED' : 'escaped', /id="tab-welcome"/.test(html), /chart\.umd/.test(html));
  const opts=(id)=>{ const m=html.match(new RegExp('id="'+id+'"[\\s\\S]*?</select>')); return m?m[0]:''; };
  if (!/id="tab-engagement"/.test(html) || !/data-sub="en-starboard"/.test(html)) throw new Error('engagement tab missing');
  if (!/Server Booster/.test(opts('gwReqRole'))) throw new Error('booster role missing from giveaway requirement picker');
  for (const id of ['arRole','bdRole']) if (/Server Booster/.test(opts(id))) throw new Error('managed role offered in '+id);
  console.log('engagement tab rendered; booster role pickable for requirements but not for roles the bot hands out');
  fs.writeFileSync(require('os').tmpdir()+'/loofary-render-guild'+scripts.push(1)+'.html', html);
}
// Every feature switched on and set up (Overview cards only fill in their details when a feature is
// on, so a mistake there only breaks servers that use it).
{
  const on=new GuildConfig({guildId:'1',logChannelId:'c1',shopEnabled:true,
    automod:{enabled:true},xpPot:{enabled:true,channelId:'c1'},birthdays:{enabled:true,channelId:'c1'},
    counting:{enabled:true,channelId:'c1'},starboard:{enabled:true,channelId:'c1'},chatDrops:{enabled:true,channelIds:['c1','gone']}});
  const html=ejs.render(tpl,{...base,config:on,welcome:new WelcomeConfig({guildId:'1'}).toObject(),gambling:getGamblingSettings(on)},{filename:root+'src/web/views/guild.ejs'});
  new Function(html.slice(html.lastIndexOf('<script>')+8, html.lastIndexOf('</script>')));
  if (!/XP every 30–90 min in #general</.test(html)) throw new Error('chat drops overview card missing its channel');
  console.log('guild ok with every feature on');
}
{
  const modPages=new Set(['leaderboard','commands','logviewer','welcome']);
  const html=ejs.render(tpl,{...base,config:{},welcome:new WelcomeConfig({guildId:'1'}).toObject(),gambling:getGamblingSettings({}),access:{level:'mod',pages:[...modPages]},can:(p)=>p!=='settings'&&modPages.has(p)},{filename:root+'src/web/views/guild.ejs'});
  new Function(html.slice(html.lastIndexOf('<script>')+8, html.lastIndexOf('</script>')));
  fs.writeFileSync(require('os').tmpdir()+'/loofary-render-guild-mod.html', html);
  console.log('mod view ok', /id="tab-settings"/.test(html)?'SETTINGS LEAKED':'no settings panel', (html.match(/class="nav-item/g)||[]).length+' nav items');
}
const eb=ejs.render(fs.readFileSync(root+'src/web/views/embedBuilder.ejs','utf8'),{guild,channels:base.channels,bot:base.bot,...{botName:'LoofaryBot',botAvatar:'',inviteUrl:'x',user:null}},{filename:root+'src/web/views/embedBuilder.ejs'});
for (const m of eb.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Function(m[1]); console.log('embed builder ok');
const S=require('os').tmpdir()+'/loofary-render-';
const site={botName:'LoofaryBot',botAvatar:'https://cdn.discordapp.com/embed/avatars/0.png',inviteUrl:'https://discord.com/oauth2/authorize?x=1'};
const { publicCommands } = require(root+'src/web/utils/site');
for (const user of [null,{id:'1',name:'Nick',avatarUrl:'https://cdn.discordapp.com/embed/avatars/1.png'}]) {
  const h=ejs.render(fs.readFileSync(root+'src/web/views/home.ejs','utf8'),{...site,user,stats:{servers:12,members:48213,commands:80,modules:9},publicCommands:publicCommands()},{filename:root+'src/web/views/home.ejs'});
  fs.writeFileSync(S+(user?'home-in.html':'home-out.html'),h); console.log('home ok', user?'in':'out', (h.match(/class="cmd-item"/g)||[]).length+' public cmds');
}
const d=ejs.render(fs.readFileSync(root+'src/web/views/dashboard.ejs','utf8'),{...site,user:{id:'1',name:'Nick',avatarUrl:'https://cdn.discordapp.com/embed/avatars/1.png'},totalGuilds:12,
 guilds:[{id:'1',name:'Loofary Lounge',iconUrl:null,memberCount:1234,channelCount:40,accessLevel:'admin'},{id:'2',name:'Speedrun <Hub>',iconUrl:'https://cdn.discordapp.com/embed/avatars/2.png',memberCount:89,channelCount:12,accessLevel:'mod'},{id:'3',name:'Art Club',iconUrl:null,memberCount:15020,channelCount:61,accessLevel:'admin'}],
 addable:[{id:'9',name:'My Test Server',iconUrl:null,inviteUrl:'https://x'}]},{filename:root+'src/web/views/dashboard.ejs'});
fs.writeFileSync(S+'picker.html',d); console.log('picker ok', d.includes('Speedrun &lt;Hub&gt;'));
const d0=ejs.render(fs.readFileSync(root+'src/web/views/dashboard.ejs','utf8'),{...site,user:{id:'1',name:'Nick',avatarUrl:'x'},totalGuilds:12,guilds:[],addable:[]},{filename:root+'src/web/views/dashboard.ejs'});
fs.writeFileSync(S+'picker-empty.html',d0); console.log('picker empty ok');
const e=ejs.render(fs.readFileSync(root+'src/web/views/error.ejs','utf8'),{...site,user:null,message:'Nope'},{filename:root+'src/web/views/error.ejs'}); console.log('error ok');
const e2=ejs.render(fs.readFileSync(root+'src/web/views/error.ejs','utf8'),{message:'Nope'},{filename:root+'src/web/views/error.ejs'}); console.log('error bare ok');
