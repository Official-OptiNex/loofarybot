const { EmbedBuilder, PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const AlertSubscription = require('../../../database/models/AlertSubscription');
const GuildConfig = require('../../../database/models/GuildConfig');
const { reportIssue, reportError } = require('../../utils/errorReporter');

const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID || null;
const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET || null;
const TWITCH_POLL_MS = 2 * 60 * 1000;
const YOUTUBE_POLL_MS = 5 * 60 * 1000;
// Twitch sometimes reports a stream offline for a minute; the same stream coming back within this
// window is treated as one stream (no second announcement).
const STREAM_RESUME_MS = 15 * 60 * 1000;

const DEFAULTS = {
  twitch: {
    message: '🔴 **{name}** is live on Twitch!',
    title: '{title}',
    description: 'Playing **{game}**\n{url}',
    color: '#9146FF'
  },
  youtube: {
    message: '📺 **{name}** just posted a new video!',
    title: '{title}',
    description: '{url}',
    color: '#FF0000'
  }
};

// With TWITCH_CLIENT_ID/SECRET set the bot uses Twitch's official API. Without them it falls back to
// the public endpoint twitch.tv's own website uses (no account needed) — unofficial, so Twitch could
// change it, but it means any streamer can be followed with zero setup.
const twitchUsesOfficialApi = () => !!(TWITCH_CLIENT_ID && TWITCH_CLIENT_SECRET);
const PUBLIC_GQL_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko'; // twitch.tv's public web client

// ------------------------------------------------------------------ Twitch

let twitchToken = null; // { value, expiresAt }

async function twitchFetch(path) {
  if (!twitchToken || Date.now() > twitchToken.expiresAt - 60_000) {
    const res = await fetch(
      `https://id.twitch.tv/oauth2/token?client_id=${TWITCH_CLIENT_ID}&client_secret=${TWITCH_CLIENT_SECRET}&grant_type=client_credentials`,
      { method: 'POST' }
    );
    if (!res.ok) throw new Error(`Twitch login failed (${res.status}) — check the client ID/secret.`);
    const data = await res.json();
    twitchToken = { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  }
  const res = await fetch(`https://api.twitch.tv/helix/${path}`, {
    headers: { 'Client-Id': TWITCH_CLIENT_ID, Authorization: `Bearer ${twitchToken.value}` }
  });
  if (res.status === 401) twitchToken = null;
  if (!res.ok) throw new Error(`Twitch API error ${res.status}`);
  return res.json();
}

// Official API: users (+ live streams) for up to 100 logins per call.
async function lookupViaHelix(logins) {
  const out = new Map();
  for (let i = 0; i < logins.length; i += 100) {
    const batch = logins.slice(i, i + 100);
    const q = batch.map((l) => `login=${encodeURIComponent(l)}`).join('&');
    const sq = batch.map((l) => `user_login=${encodeURIComponent(l)}`).join('&');
    const [users, streams] = await Promise.all([twitchFetch(`users?${q}`), twitchFetch(`streams?${sq}&first=100`)]);
    const live = new Map((streams.data || []).map((st) => [st.user_login.toLowerCase(), st]));
    for (const u of users.data || []) {
      const st = live.get(u.login.toLowerCase());
      out.set(u.login.toLowerCase(), {
        login: u.login.toLowerCase(),
        displayName: u.display_name,
        avatarUrl: u.profile_image_url,
        stream: st
          ? {
              id: st.id,
              title: st.title,
              game: st.game_name,
              startedAt: st.started_at,
              thumbnail: st.thumbnail_url.replace('{width}', '1280').replace('{height}', '720')
            }
          : null
      });
    }
  }
  return out;
}

// Public endpoint (no keys): one aliased query per 30 logins.
async function lookupViaPublicGql(logins) {
  const out = new Map();
  for (let i = 0; i < logins.length; i += 30) {
    const batch = logins.slice(i, i + 30);
    const fields =
      'login displayName profileImageURL(width: 300) broadcastSettings { title game { displayName } } ' +
      'stream { id createdAt previewImageURL(width: 1280, height: 720) game { displayName } }';
    const query = `query { ${batch.map((l, n) => `u${n}: user(login: ${JSON.stringify(l)}) { ${fields} }`).join(' ')} }`;
    const res = await fetch('https://gql.twitch.tv/gql', {
      method: 'POST',
      headers: { 'Client-Id': PUBLIC_GQL_CLIENT_ID, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query })
    });
    if (!res.ok) throw new Error(`Twitch public API error ${res.status}`);
    const body = await res.json();
    if (!body.data) throw new Error(`Twitch public API: ${body.errors?.[0]?.message || 'unexpected response'}`);
    batch.forEach((_, n) => {
      const u = body.data[`u${n}`];
      if (!u) return;
      const st = u.stream;
      out.set(u.login.toLowerCase(), {
        login: u.login.toLowerCase(),
        displayName: u.displayName,
        avatarUrl: u.profileImageURL,
        stream: st
          ? {
              id: st.id,
              title: u.broadcastSettings?.title || '',
              game: st.game?.displayName || u.broadcastSettings?.game?.displayName || '',
              startedAt: st.createdAt,
              thumbnail: st.previewImageURL || ''
            }
          : null
      });
    });
  }
  return out;
}

/** login → { login, displayName, avatarUrl, stream: {id,title,game,startedAt,thumbnail} | null } */
function twitchLookup(logins) {
  return twitchUsesOfficialApi() ? lookupViaHelix(logins) : lookupViaPublicGql(logins);
}

// Accepts a twitch.tv link (any form), @name, or a plain username.
function parseTwitchLogin(input) {
  return String(input)
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/^(www\.|m\.)?twitch\.tv\//i, '')
    .replace(/[/?#].*$/, '')
    .replace(/^@/, '')
    .toLowerCase();
}

async function resolveTwitch(input) {
  const login = parseTwitchLogin(input);
  if (!/^[a-z0-9_]{3,25}$/.test(login)) throw new Error("That doesn't look like a Twitch channel — paste a twitch.tv link or a username.");
  const user = (await twitchLookup([login])).get(login);
  if (!user) throw new Error(`No Twitch channel called "${login}".`);
  return { account: user.login, displayName: user.displayName, avatarUrl: user.avatarUrl };
}

// ------------------------------------------------------------------ YouTube

const decodeXml = (s) =>
  String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&');

function parseYouTubeFeed(xml) {
  const tag = (block, name) => {
    const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
    return m ? decodeXml(m[1].trim()) : '';
  };
  const channelName = tag(xml.split('<entry>')[0], 'title');
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(([, e]) => ({
    videoId: tag(e, 'yt:videoId'),
    title: tag(e, 'title'),
    published: new Date(tag(e, 'published')),
    url: (e.match(/<link rel="alternate" href="([^"]+)"/) || [])[1] || ''
  }));
  return { channelName, entries: entries.filter((v) => v.videoId) };
}

async function fetchYouTubeFeed(channelId) {
  const res = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`);
  if (!res.ok) throw new Error(`YouTube feed error ${res.status}`);
  return parseYouTubeFeed(await res.text());
}

// Accepts a channel ID (UC…), a channel URL, or a handle (@name / youtube.com/@name).
async function resolveYouTube(input) {
  const raw = String(input).trim();
  let channelId = (raw.match(/(UC[\w-]{22})/) || [])[1] || null;
  if (!channelId) {
    const handle = (raw.match(/@([\w.-]+)/) || [])[1] || raw.replace(/^https?:\/\/(www\.)?youtube\.com\//i, '').replace(/[/?#].*$/, '');
    if (!handle) throw new Error("That doesn't look like a YouTube channel.");
    const res = await fetch(`https://www.youtube.com/@${encodeURIComponent(handle)}`, { headers: { 'Accept-Language': 'en' } });
    if (!res.ok) throw new Error(`Couldn't find the YouTube channel @${handle}.`);
    const html = await res.text();
    channelId = (html.match(/"externalId":"(UC[\w-]{22})"/) || html.match(/channel\/(UC[\w-]{22})/) || [])[1] || null;
    if (!channelId) throw new Error(`Couldn't find the YouTube channel @${handle}.`);
  }
  const feed = await fetchYouTubeFeed(channelId);
  return { account: channelId, displayName: feed.channelName || channelId, avatarUrl: '', feed };
}

// ------------------------------------------------------------------ Rendering

function fill(template, vars) {
  return String(template || '').replace(/\{(name|title|url|game)\}/gi, (t) => vars[t.slice(1, -1).toLowerCase()] ?? '');
}

/**
 * Builds the alert message. vars: { name, title, url, game, image, avatar }. `ended` turns a
 * live alert into its "stream ended" form.
 */
function buildAlertMessage(sub, guild, vars, { ended = null } = {}) {
  const defaults = DEFAULTS[sub.platform];
  const pingId = sub.pingRoleId;
  const ping = pingId ? (pingId === guild.id ? '@everyone' : `<@&${pingId}>`) : '';
  const text = fill(sub.message || defaults.message, vars);
  const payload = {
    content: [ping, text].filter(Boolean).join(' ').slice(0, 2000) || undefined,
    allowedMentions: pingId ? (pingId === guild.id ? { parse: ['everyone'] } : { roles: [pingId] }) : { parse: [] },
    embeds: [],
    components: vars.url
      ? [new ActionRowBuilder().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(vars.url).setLabel(sub.platform === 'twitch' ? 'Watch stream' : 'Watch video'))]
      : []
  };
  if (sub.embed?.enabled !== false) {
    const e = sub.embed || {};
    const embed = new EmbedBuilder()
      .setColor(/^#[0-9a-f]{6}$/i.test(e.color || '') ? e.color : defaults.color)
      .setAuthor({ name: vars.name || sub.displayName || sub.account, iconURL: vars.avatar || sub.avatarUrl || undefined, url: vars.url || undefined });
    const title = fill(e.title || defaults.title, vars).slice(0, 256);
    const description = fill(e.description || defaults.description, vars).slice(0, 4096);
    if (title) embed.setTitle(title);
    if (vars.url) embed.setURL(vars.url);
    if (description) embed.setDescription(description);
    if (e.showImage !== false && vars.image) embed.setImage(vars.image);
    if (ended) {
      embed.setColor('#4E5058').setFooter({ text: `⚫ Stream ended · streamed for ${ended}` });
    } else {
      embed.setTimestamp();
    }
    payload.embeds = [embed];
  }
  if (ended) payload.content = undefined; // don't re-ping on edit
  return payload;
}

// ------------------------------------------------------------------ Posting

async function moduleEnabled(guildId) {
  const config = await GuildConfig.findOne({ guildId }, { socialAlertsEnabled: 1 }).lean();
  return config?.socialAlertsEnabled !== false;
}

function resolvePostChannel(client, sub) {
  const guild = client.guilds.cache.get(sub.guildId);
  const channel = guild?.channels.cache.get(sub.channelId);
  const me = guild?.members.me;
  if (!guild || !channel || !channel.isTextBased()) return { guild, error: 'The alert channel no longer exists.' };
  if (!me || !channel.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
    return { guild, error: `LoofaryBot needs View Channel, Send Messages and Embed Links in #${channel.name}.` };
  }
  return { guild, channel };
}

async function post(client, sub, vars) {
  const { guild, channel, error } = resolvePostChannel(client, sub);
  if (error) {
    if (guild) reportIssue(guild.id, `${sub.platform === 'twitch' ? 'Twitch' : 'YouTube'} alert not posted`, `Alert for **${sub.displayName}**: ${error}`);
    return null;
  }
  const msg = await channel.send(buildAlertMessage(sub, guild, vars));
  // Announcement channels: publish so followers in other servers get it too.
  if (channel.type === 5 && msg.crosspostable) msg.crosspost().catch(() => null);
  return msg;
}

function formatDuration(ms) {
  const mins = Math.max(1, Math.round(ms / 60000));
  const h = Math.floor(mins / 60);
  return h ? `${h}h ${mins % 60}m` : `${mins}m`;
}

// ------------------------------------------------------------------ Polling

let twitchRunning = false;
async function pollTwitch(client) {
  if (twitchRunning) return;
  twitchRunning = true;
  try {
    const subs = await AlertSubscription.find({ platform: 'twitch', enabled: true });
    if (!subs.length) return;
    const logins = [...new Set(subs.map((s) => s.account))];
    const info = await twitchLookup(logins);
    const live = new Map([...info].filter(([, u]) => u.stream).map(([login, u]) => [login, u]));

    for (const sub of subs) {
      if (!(await moduleEnabled(sub.guildId))) continue;
      const channel = live.get(sub.account);
      const stream = channel?.stream;
      if (channel?.avatarUrl && channel.avatarUrl !== sub.avatarUrl) sub.avatarUrl = channel.avatarUrl;
      try {
        if (stream && !sub.state.live) {
          const resumed = sub.state.streamId === stream.id && sub.state.liveStartedAt && Date.now() - sub.updatedAt < STREAM_RESUME_MS;
          sub.state.live = true;
          if (!resumed) {
            const vars = {
              name: channel.displayName,
              title: stream.title || `${channel.displayName} is live`,
              game: stream.game || 'something',
              url: `https://twitch.tv/${channel.login}`,
              // Cache-buster so Discord shows the current frame, not a stale thumbnail.
              image: stream.thumbnail ? `${stream.thumbnail}${stream.thumbnail.includes('?') ? '&' : '?'}t=${Date.now()}` : '',
              avatar: channel.avatarUrl || sub.avatarUrl
            };
            const msg = await post(client, sub, vars);
            sub.state.streamId = stream.id;
            sub.state.liveMessageId = msg?.id || null;
            sub.state.liveStartedAt = stream.startedAt ? new Date(stream.startedAt) : new Date();
          }
          await sub.save();
        } else if (!stream && sub.state.live) {
          sub.state.live = false;
          await sub.save();
          await markStreamEnded(client, sub).catch(() => null);
        }
      } catch (err) {
        reportError(err, { guildId: sub.guildId, context: `Twitch alert for ${sub.displayName} failed` });
      }
    }
  } catch (err) {
    reportError(err, { context: 'Twitch polling failed' });
  } finally {
    twitchRunning = false;
  }
}

// Edits the go-live alert into a "stream ended" card (no second ping).
async function markStreamEnded(client, sub) {
  if (!sub.state.liveMessageId) return;
  const { guild, channel } = resolvePostChannel(client, sub);
  if (!channel) return;
  const msg = await channel.messages.fetch(sub.state.liveMessageId).catch(() => null);
  if (!msg || !msg.embeds[0]) return;
  const started = sub.state.liveStartedAt ? new Date(sub.state.liveStartedAt).getTime() : Date.now();
  const vars = {
    name: msg.embeds[0].author?.name || sub.displayName,
    title: msg.embeds[0].title || '',
    url: `https://twitch.tv/${sub.account}`,
    game: '',
    image: msg.embeds[0].image?.url || '',
    avatar: sub.avatarUrl
  };
  const payload = buildAlertMessage(sub, guild, vars, { ended: formatDuration(Date.now() - started) });
  payload.embeds[0]?.setTitle(msg.embeds[0].title || null).setDescription(msg.embeds[0].description || null);
  await msg.edit({ embeds: payload.embeds, components: payload.components }).catch(() => null);
}

let youtubeRunning = false;
async function pollYouTube(client) {
  if (youtubeRunning) return;
  youtubeRunning = true;
  try {
    const subs = await AlertSubscription.find({ platform: 'youtube', enabled: true });
    const feeds = new Map();
    for (const sub of subs) {
      if (!(await moduleEnabled(sub.guildId))) continue;
      try {
        if (!feeds.has(sub.account)) feeds.set(sub.account, await fetchYouTubeFeed(sub.account));
        const feed = feeds.get(sub.account);
        const seen = new Set(sub.state.seenVideoIds || []);
        const since = sub.state.lastVideoPublished ? new Date(sub.state.lastVideoPublished).getTime() : Date.now();
        const fresh = feed.entries
          .filter((v) => !seen.has(v.videoId) && v.published.getTime() > since)
          .sort((a, b) => a.published - b.published)
          .slice(-3); // never flood a channel after a long outage

        for (const video of fresh) {
          await post(client, sub, {
            name: feed.channelName || sub.displayName,
            title: video.title,
            url: video.url || `https://www.youtube.com/watch?v=${video.videoId}`,
            game: '',
            image: `https://i.ytimg.com/vi/${video.videoId}/hqdefault.jpg`,
            avatar: sub.avatarUrl
          });
        }
        const newest = feed.entries.reduce((max, v) => (v.published > max ? v.published : max), new Date(since));
        sub.state.lastVideoPublished = newest;
        sub.state.seenVideoIds = [...new Set([...feed.entries.map((v) => v.videoId), ...(sub.state.seenVideoIds || [])])].slice(0, 30);
        if (feed.channelName && feed.channelName !== sub.displayName) sub.displayName = feed.channelName;
        await sub.save();
      } catch (err) {
        reportError(err, { guildId: sub.guildId, context: `YouTube alert for ${sub.displayName} failed` });
      }
    }
  } catch (err) {
    reportError(err, { context: 'YouTube polling failed' });
  } finally {
    youtubeRunning = false;
  }
}

function startPolling(client) {
  setTimeout(() => pollTwitch(client), 15_000);
  setTimeout(() => pollYouTube(client), 30_000);
  setInterval(() => pollTwitch(client), TWITCH_POLL_MS);
  setInterval(() => pollYouTube(client), YOUTUBE_POLL_MS);
}

// ------------------------------------------------------------------ Management

/**
 * Creates or updates a subscription after validating the account. New YouTube subscriptions start
 * from the channel's current latest video so the back catalog isn't announced.
 */
async function upsertSubscription(guild, data, existingId = null) {
  const platform = data.platform;
  if (!['twitch', 'youtube'].includes(platform)) throw new Error('Pick Twitch or YouTube.');
  const existing = existingId ? await AlertSubscription.findOne({ _id: existingId, guildId: guild.id }) : null;
  if (existingId && !existing) throw new Error('That alert no longer exists.');

  let identity = null;
  const accountChanged = !existing || existing.platform !== platform || (data.account && data.account !== existing.account && data.account !== existing.displayName);
  if (accountChanged) {
    identity = platform === 'twitch' ? await resolveTwitch(data.account) : await resolveYouTube(data.account);
  }

  const channel = guild.channels.cache.get(String(data.channelId || ''));
  if (!channel || !channel.isTextBased()) throw new Error('Pick a text channel to post alerts in.');
  if (data.pingRoleId && !guild.roles.cache.has(String(data.pingRoleId))) throw new Error('That ping role no longer exists.');

  const sub = existing || new AlertSubscription({ guildId: guild.id, platform });
  sub.platform = platform;
  if (identity) {
    sub.account = identity.account;
    sub.displayName = identity.displayName;
    sub.avatarUrl = identity.avatarUrl || sub.avatarUrl;
    sub.state = { live: false, streamId: null, liveMessageId: null, liveStartedAt: null, lastVideoPublished: new Date(), seenVideoIds: [] };
    if (identity.feed) {
      sub.state.seenVideoIds = identity.feed.entries.map((v) => v.videoId).slice(0, 30);
      const newest = identity.feed.entries.reduce((max, v) => (v.published > max ? v.published : max), new Date(0));
      sub.state.lastVideoPublished = newest.getTime() > 0 ? newest : new Date();
    }
  }
  sub.channelId = channel.id;
  sub.pingRoleId = data.pingRoleId || null;
  if (typeof data.enabled === 'boolean') sub.enabled = data.enabled;
  sub.message = String(data.message ?? sub.message ?? '').slice(0, 1500);
  const e = data.embed || {};
  sub.embed = {
    enabled: e.enabled !== false,
    title: String(e.title ?? '').slice(0, 256),
    description: String(e.description ?? '').slice(0, 2000),
    color: /^#[0-9a-f]{6}$/i.test(e.color || '') ? e.color : '',
    showImage: e.showImage !== false
  };
  await sub.save();
  return sub;
}

// Posts a sample alert with placeholder data so admins can check the look and the ping.
async function sendTest(client, sub) {
  const sample = sub.platform === 'twitch'
    ? { name: sub.displayName, title: 'Test stream title', game: 'Just Chatting', url: `https://twitch.tv/${sub.account}`, image: '', avatar: sub.avatarUrl }
    : { name: sub.displayName, title: 'Test video title', game: '', url: `https://www.youtube.com/channel/${sub.account}`, image: '', avatar: sub.avatarUrl };
  const { guild, channel, error } = resolvePostChannel(client, sub);
  if (error) throw new Error(error);
  const payload = buildAlertMessage(sub, guild, sample);
  payload.content = `🧪 **Test alert** (no one was pinged)\n${(payload.content || '').replace(/<@&\d+>|@everyone/g, '').trim()}`;
  payload.allowedMentions = { parse: [] };
  await channel.send(payload);
}

module.exports = {
  DEFAULTS,
  twitchUsesOfficialApi,
  parseTwitchLogin,
  parseYouTubeFeed,
  buildAlertMessage,
  upsertSubscription,
  sendTest,
  startPolling,
  pollTwitch,
  pollYouTube
};
