// Bot Chat: lets an admin (or a moderator given the page) talk through the bot from the dashboard,
// with a short live feed of a channel's recent messages and a reply button. It never mass-pings:
// @everyone/@here and role pings are stripped (the Embed Builder is the place for announcements).
const express = require('express');
const { PermissionFlagsBits, ChannelType } = require('discord.js');
const { requireAuth, requireGuildAccess, requirePage } = require('../utils/authMiddleware');
const { auditTrail } = require('../utils/audit');

const router = express.Router();

const FEED_LIMIT = 25;
const MAX_LEN = 2000;
const SENDABLE = [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.PublicThread, ChannelType.PrivateThread, ChannelType.AnnouncementThread, ChannelType.GuildVoice];

// Channels the bot can both read and talk in, newest-activity first so the useful ones are on top.
function chatChannels(guild) {
  const me = guild.members.me;
  if (!me) return [];
  return guild.channels.cache
    .filter((c) => SENDABLE.includes(c.type) && c.viewable && c.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]))
    .map((c) => ({ id: c.id, name: c.name, type: c.isThread() ? 'thread' : 'text', parent: c.parent?.name || null }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

router.get('/:guildId/botchat', requireAuth, requireGuildAccess, requirePage('botchat'), (req, res) => {
  res.render('botChat', { guild: req.guild, channels: chatChannels(req.guild) });
});

// Returns the channel so routes can bail out with a consistent error when it can't be used.
function usableChannel(req) {
  const id = String(req.query.channelId || req.body.channelId || '');
  const channel = req.guild.channels.cache.get(id);
  const me = req.guild.members.me;
  if (!channel || !SENDABLE.includes(channel.type)) return { error: 'Pick a channel in this server.' };
  if (!me || !channel.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {
    return { error: "LoofaryBot can't talk in that channel (it needs View Channel and Send Messages)." };
  }
  return { channel };
}

const nameOf = (msg) => msg.member?.displayName || msg.author?.globalName || msg.author?.username || 'Unknown';
const snippet = (text, n = 80) => {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

function shape(msg, collection) {
  const extras = [];
  if (msg.attachments?.size) extras.push(`📎 ${msg.attachments.size} attachment${msg.attachments.size > 1 ? 's' : ''}`);
  if (msg.stickers?.size) extras.push('🏷️ sticker');
  if (!msg.content && msg.embeds?.length) extras.push('📊 embed');
  let replyTo = null;
  const refId = msg.reference?.messageId;
  if (refId) {
    const ref = collection?.get(refId);
    replyTo = { id: refId, name: ref ? nameOf(ref) : null, text: ref ? snippet(ref.content, 60) : null };
  }
  return {
    id: msg.id,
    authorId: msg.author?.id || null,
    name: nameOf(msg),
    avatar: msg.author?.displayAvatarURL?.({ size: 64 }) || '',
    bot: !!msg.author?.bot,
    self: msg.author?.id === msg.guild?.members.me?.id,
    content: msg.content || '',
    extras,
    at: msg.createdTimestamp,
    replyTo
  };
}

// The channel's recent messages (oldest → newest), polled by the page. Not stored anywhere.
router.get('/:guildId/botchat/feed', requireAuth, requireGuildAccess, requirePage('botchat'), async (req, res) => {
  const { channel, error } = usableChannel(req);
  if (error) return res.status(400).json({ ok: false, error });
  const me = req.guild.members.me;
  if (!channel.permissionsFor(me)?.has(PermissionFlagsBits.ReadMessageHistory)) {
    return res.status(403).json({ ok: false, error: "LoofaryBot can't read that channel's history (it needs Read Message History)." });
  }
  const fetched = await channel.messages.fetch({ limit: FEED_LIMIT }).catch(() => null);
  if (!fetched) return res.status(502).json({ ok: false, error: 'Discord would not return that channel right now — try again.' });
  const messages = [...fetched.values()].reverse().map((m) => shape(m, fetched));
  res.json({ ok: true, channelId: channel.id, messages });
});

// Send a message as the bot. Replies set the Discord reply reference. Mass pings are stripped.
router.post('/:guildId/botchat/send', requireAuth, requireGuildAccess, requirePage('botchat'), auditTrail, async (req, res) => {
  const { channel, error } = usableChannel(req);
  if (error) return res.status(400).json({ ok: false, error });
  const content = String(req.body.content || '').trim();
  if (!content) return res.status(400).json({ ok: false, error: 'Type a message first.' });
  if (content.length > MAX_LEN) return res.status(400).json({ ok: false, error: `Messages can be at most ${MAX_LEN} characters (that one was ${content.length}).` });

  // Only normal user mentions ping — never @everyone/@here or roles, so this can't be a mass-ping tool.
  const payload = { content, allowedMentions: { parse: ['users'] } };
  const replyTo = String(req.body.replyTo || '');
  if (replyTo) payload.reply = { messageReference: replyTo, failIfNotExists: false };

  try {
    const sent = await channel.send(payload);
    res.locals.audit = { section: 'Bot Chat', action: replyTo ? 'Replied through the bot' : 'Spoke through the bot', detail: `${snippet(content, 120)} — in <#${channel.id}>` };
    res.json({ ok: true, message: shape(sent, null) });
  } catch (err) {
    console.error('Bot chat send failed:', err.message);
    res.status(400).json({ ok: false, error: `Discord rejected the message (${err.message}).` });
  }
});

module.exports = router;
