// Music / radio voice player. Plays Lofi / chill internet-radio streams in a voice channel — light
// and ToS-safe (public radio streams, not YouTube), so it fits the free tier. The @discordjs/voice
// stack is loaded lazily and guarded, so if the host has no ffmpeg / voice libs the bot still runs
// and /music just reports that playback isn't available instead of crashing.
const { PermissionFlagsBits } = require('discord.js');
const GuildConfig = require('../../../database/models/GuildConfig');

// Curated stations — stable public internet radio (SomaFM & friends), bot-friendly, no API keys.
const STATIONS = [
  { key: 'lofi', name: '🎧 Lofi Beats', genre: 'lofi hip-hop', url: 'https://ice1.somafm.com/fluid-128-mp3' },
  { key: 'chill', name: '🌙 Groove Salad', genre: 'chill / downtempo', url: 'https://ice1.somafm.com/groovesalad-128-mp3' },
  { key: 'ambient', name: '🌌 Drone Zone', genre: 'ambient', url: 'https://ice1.somafm.com/dronezone-128-mp3' },
  { key: 'vocal', name: '💜 Lush', genre: 'vocal chill', url: 'https://ice1.somafm.com/lush-128-mp3' },
  { key: 'synth', name: '🌆 Synthwave', genre: 'synthwave / retro', url: 'https://ice1.somafm.com/spacestation-128-mp3' },
  { key: 'jazz', name: '🎷 Sonic Universe', genre: 'nu-jazz', url: 'https://ice1.somafm.com/sonicuniverse-128-mp3' }
];

const clampVol = (v, d = 50) => (Number.isFinite(Number(v)) ? Math.min(100, Math.max(0, Math.round(Number(v)))) : d);

function musicSettings(config) {
  const g = (config && config.music) || {};
  const list = Array.isArray(g.stations) ? g.stations : [];
  return {
    enabled: !!g.enabled,
    commandChannelIds: Array.isArray(g.commandChannelIds) ? g.commandChannelIds : [],
    voiceChannelIds: Array.isArray(g.voiceChannelIds) ? g.voiceChannelIds : [],
    djRoleId: g.djRoleId || null,
    defaultVolume: clampVol(g.defaultVolume, 50),
    stations: list.filter((s) => s && s.name && s.url).map((s) => ({ name: String(s.name).slice(0, 60), url: String(s.url) }))
  };
}

/** Built-in stations plus any custom ones an admin added (custom get a key c0, c1, …). */
function allStations(settings) {
  const custom = (settings.stations || []).map((s, i) => ({ key: `c${i}`, name: s.name, genre: 'custom', url: s.url }));
  return [...STATIONS, ...custom];
}

/** Find a station by key, exact name, or a loose substring of the name/genre. */
function findStation(settings, query) {
  const list = allStations(settings);
  const q = String(query || '').trim().toLowerCase();
  if (!q) return null;
  return (
    list.find((s) => s.key === q) ||
    list.find((s) => s.name.toLowerCase() === q) ||
    list.find((s) => s.name.toLowerCase().includes(q) || s.genre.toLowerCase().includes(q)) ||
    null
  );
}

/** Can this member control playback? Anyone, unless a DJ role is set (admins always can). */
function canControl(member, settings) {
  if (!settings.djRoleId) return true;
  if (member?.permissions?.has(PermissionFlagsBits.ManageGuild)) return true;
  return !!member?.roles?.cache?.has(settings.djRoleId);
}

/**
 * Checks the command channel and the member's voice channel against the settings.
 * Returns { error } or { voiceChannel }.
 */
function checkUsable(interaction, settings) {
  if (!settings.enabled) return { error: '🎵 Music is turned off in this server.' };
  if (settings.commandChannelIds.length && !settings.commandChannelIds.includes(interaction.channelId)) {
    return { error: `🎵 Use music commands in ${settings.commandChannelIds.map((id) => `<#${id}>`).join(' or ')}.` };
  }
  const voiceChannel = interaction.member?.voice?.channel;
  if (!voiceChannel) return { error: '🔇 Join a voice channel first.' };
  if (settings.voiceChannelIds.length && !settings.voiceChannelIds.includes(voiceChannel.id)) {
    return { error: `🔇 Music can only play in ${settings.voiceChannelIds.map((id) => `<#${id}>`).join(' or ')}.` };
  }
  if (!canControl(interaction.member, settings)) return { error: `🎧 Only <@&${settings.djRoleId}> can control the music.` };
  return { voiceChannel };
}

// ---------------------------------------------------------------- Voice (lazy, guarded)

let voiceLib = undefined; // undefined = not tried, null = unavailable
function getVoice() {
  if (voiceLib !== undefined) return voiceLib;
  try {
    voiceLib = require('@discordjs/voice');
  } catch {
    voiceLib = null;
  }
  return voiceLib;
}
function playbackAvailable() {
  const V = getVoice();
  if (!V) return false;
  try {
    // An ffmpeg binary (ffmpeg-static or system) is needed to transcode the MP3 stream to Opus.
    require('ffmpeg-static');
    return true;
  } catch {
    // prism-media may still find a system ffmpeg on PATH; let the actual play attempt decide.
    return true;
  }
}

// guildId -> { connection, player, station, volume, textChannelId }
const sessions = new Map();
const getSession = (guildId) => sessions.get(guildId) || null;

/** Joins the member's voice channel and starts the station. Returns { station } or { error }. */
async function play(guild, voiceChannel, textChannelId, station, volume) {
  const V = getVoice();
  if (!V) return { error: "🎛️ Voice playback isn't available on this host (missing voice libraries or ffmpeg)." };
  try {
    const connection = V.joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: true
    });
    let s = sessions.get(guild.id);
    if (!s) {
      const player = V.createAudioPlayer({ behaviors: { noSubscriber: V.NoSubscriberBehavior.Play } });
      s = { connection, player, station: null, volume: clampVol(volume), textChannelId };
      connection.subscribe(player);
      player.on('error', (err) => console.error('[music] player error:', err.message));
      sessions.set(guild.id, s);
    } else {
      s.connection = connection;
      connection.subscribe(s.player);
    }
    s.textChannelId = textChannelId;
    const resource = V.createAudioResource(station.url, { inlineVolume: true });
    resource.volume?.setVolume((volume ?? s.volume) / 100);
    s.volume = clampVol(volume ?? s.volume);
    s.station = station;
    s.player.play(resource);
    return { station };
  } catch (err) {
    console.error('[music] play failed:', err.message);
    return { error: `🎛️ Couldn't start playback: ${err.message}` };
  }
}

function setVolume(guildId, volume) {
  const s = sessions.get(guildId);
  if (!s) return { error: 'Nothing is playing.' };
  s.volume = clampVol(volume);
  s.player?.state?.resource?.volume?.setVolume(s.volume / 100);
  return { volume: s.volume };
}

function stop(guildId) {
  const s = sessions.get(guildId);
  if (!s) return false;
  try {
    s.player?.stop();
    s.connection?.destroy();
  } catch {
    /* already gone */
  }
  sessions.delete(guildId);
  return true;
}

function nowPlaying(guildId) {
  const s = sessions.get(guildId);
  return s ? { station: s.station, volume: s.volume } : null;
}

/** Leaves voice channels the bot is alone in (saves resources on the free tier). */
function handleVoiceStateUpdate(oldState) {
  const guildId = oldState.guild?.id;
  const s = guildId && sessions.get(guildId);
  if (!s) return;
  const me = oldState.guild.members.me;
  const myChannel = me?.voice?.channel;
  if (!myChannel) return stop(guildId); // we were disconnected
  const humans = myChannel.members.filter((m) => !m.user.bot).size;
  if (humans === 0) stop(guildId);
}

// ---------------------------------------------------------------- Settings (dashboard / admin)

function cleanSettings(guild, input) {
  const patch = {};
  const chanOk = (id) => { const c = guild.channels.cache.get(id); return c && c.isTextBased?.() && !c.isThread?.(); };
  const voiceOk = (id) => { const c = guild.channels.cache.get(id); return c && (c.type === 2 || c.type === 13); }; // voice / stage
  if (input.enabled !== undefined) patch['music.enabled'] = !!input.enabled;
  if (input.commandChannelIds !== undefined) patch['music.commandChannelIds'] = (input.commandChannelIds || []).filter(chanOk).slice(0, 25);
  if (input.voiceChannelIds !== undefined) patch['music.voiceChannelIds'] = (input.voiceChannelIds || []).filter(voiceOk).slice(0, 25);
  if (input.djRoleId !== undefined) patch['music.djRoleId'] = input.djRoleId ? String(input.djRoleId) : null;
  if (input.defaultVolume !== undefined) patch['music.defaultVolume'] = clampVol(input.defaultVolume, 50);
  if (input.stations !== undefined) {
    const list = (Array.isArray(input.stations) ? input.stations : [])
      .map((s) => ({ name: String(s.name || '').trim().slice(0, 60), url: String(s.url || '').trim() }))
      .filter((s) => s.name && /^https?:\/\//i.test(s.url))
      .slice(0, 15);
    patch['music.stations'] = list;
  }
  return { patch };
}

async function saveSettings(guild, input) {
  const { patch } = cleanSettings(guild, input);
  await GuildConfig.updateOne({ guildId: guild.id }, { $set: patch }, { upsert: true });
  const fresh = await GuildConfig.findOne({ guildId: guild.id }, { music: 1 }).lean();
  return { settings: musicSettings(fresh) };
}

module.exports = {
  STATIONS,
  musicSettings,
  allStations,
  findStation,
  canControl,
  checkUsable,
  playbackAvailable,
  getSession,
  play,
  setVolume,
  stop,
  nowPlaying,
  handleVoiceStateUpdate,
  cleanSettings,
  saveSettings
};
