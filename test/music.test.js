// Music / radio player: settings, station lookup, DJ/channel/voice gating, and settings validation.
// (The actual voice streaming isn't exercised here — only the pure logic that guards it.)
process.env.TOKEN='x';process.env.CLIENT_ID='1';process.env.MONGODB_URI='mongodb://x';
const root=require('path').join(__dirname,'..')+'/'; const assert=require('assert');
const { Collection, PermissionsBitField, PermissionFlagsBits } = require(root+'node_modules/discord.js');
const { store } = require('./helpers/memstore');
const GuildConfig=require(root+'src/database/models/GuildConfig'); store(GuildConfig);
const M=require(root+'src/bot/cogs/modules/music');

// fake guild with a text channel, a voice channel and roles
const chans=new Collection();
chans.set('text', { id:'text', type:0, isTextBased:()=>true, isThread:()=>false });
chans.set('vc', { id:'vc', name:'Chill', type:2 });
chans.set('vc2', { id:'vc2', name:'Other', type:2 });
const guild={ id:'g', channels:{ cache:chans } };
const member=(o={})=>({ permissions:new PermissionsBitField(o.admin?PermissionsBitField.All:0n), roles:{ cache:{ has:(r)=>(o.roles||[]).includes(r) } }, voice:{ channel:('vc' in o)?o.vc:chans.get('vc') } });
const interaction=(over={})=>({ channelId:over.channelId||'text', member:over.member||member(), guild });

(async()=>{
  await GuildConfig.create({guildId:'g'});

  // ---- settings + stations
  let s=M.musicSettings({});
  assert.equal(s.enabled,false); assert.equal(s.defaultVolume,50); assert.deepEqual(s.commandChannelIds,[]);
  assert.equal(M.STATIONS.length>=5,true,'a handful of built-in stations');
  const withCustom=M.musicSettings({music:{stations:[{name:'My Lofi',url:'https://ex.com/s'}]}});
  const all=M.allStations(withCustom);
  assert.equal(all.length,M.STATIONS.length+1,'custom station added');
  assert.equal(M.findStation(withCustom,'lofi').key,'lofi','match by name substring');
  assert.equal(M.findStation(withCustom,'chill').genre,'chill / downtempo','by name');
  assert.equal(M.findStation(withCustom,'My Lofi').key,'c0','custom by name');
  assert.equal(M.findStation(withCustom,'nope'),null);
  console.log('✓ settings, built-in + custom stations, station lookup');

  // ---- canControl (DJ role)
  assert.equal(M.canControl(member(),{djRoleId:null}),true,'no DJ role → anyone');
  assert.equal(M.canControl(member({roles:[]}),{djRoleId:'dj'}),false,'DJ role set, member lacks it');
  assert.equal(M.canControl(member({roles:['dj']}),{djRoleId:'dj'}),true,'member has DJ role');
  assert.equal(M.canControl(member({admin:true}),{djRoleId:'dj'}),true,'admins always can');
  console.log('✓ DJ-role control gate');

  // ---- checkUsable gating
  let base=M.musicSettings({music:{enabled:true}});
  assert.match(M.checkUsable(interaction(),{...base,enabled:false}).error,/turned off/);
  assert.equal(M.checkUsable(interaction(),base).voiceChannel.id,'vc','enabled + in a voice channel → ok');
  // command-channel restriction
  let r1=M.checkUsable(interaction({channelId:'wrong'}),{...base,commandChannelIds:['text']});
  assert.match(r1.error,/Use music commands in/);
  // must be in a voice channel
  assert.match(M.checkUsable(interaction({member:member({vc:null})}),base).error,/Join a voice channel/);
  // voice-channel allow-list
  assert.match(M.checkUsable(interaction(),{...base,voiceChannelIds:['vc2']}).error,/can only play in/);
  assert.equal(M.checkUsable(interaction(),{...base,voiceChannelIds:['vc']}).voiceChannel.id,'vc');
  // DJ role enforced
  assert.match(M.checkUsable(interaction({member:member({roles:[]})}),{...base,djRoleId:'dj'}).error,/can control the music/);
  console.log('✓ checkUsable: off / command channel / in-voice / allowed voice / DJ role');

  // ---- settings validation + save
  let res=await M.saveSettings(guild,{enabled:true,defaultVolume:150,commandChannelIds:['text','vc','ghost'],voiceChannelIds:['vc','text'],stations:[{name:'Good',url:'https://a.b/s'},{name:'Bad',url:'notaurl'},{name:'',url:'https://x'}]});
  assert.equal(res.settings.enabled,true);
  assert.equal(res.settings.defaultVolume,100,'volume clamped to 100');
  assert.deepEqual(res.settings.commandChannelIds,['text'],'only real text channels kept');
  assert.deepEqual(res.settings.voiceChannelIds,['vc'],'only real voice channels kept');
  assert.deepEqual(res.settings.stations.map(x=>x.name),['Good'],'only valid-URL, named stations kept');
  console.log('✓ settings validated and saved (channels, volume clamp, station URLs)');

  // ---- stop / nowPlaying on empty state are safe
  assert.equal(M.stop('g'),false,'nothing to stop');
  assert.equal(M.nowPlaying('g'),null);
  console.log('✓ stop / nowPlaying are safe when idle');

  process.exit(0);
})().catch(e=>{console.error(e);process.exit(1);});
