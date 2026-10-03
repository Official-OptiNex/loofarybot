const express = require('express');
const { PermissionFlagsBits, ChannelType } = require('discord.js');
const EmbedJson = require('../static/js/embed-json');
const { requireAuth, requireGuildAccess, requirePage } = require('../utils/authMiddleware');
const { auditTrail } = require('../utils/audit');

const router = express.Router();

const isForum = (c) => c?.type === ChannelType.GuildForum;

router.get('/:guildId/embed', requireAuth, requireGuildAccess, requirePage('embed'), (req, res) => {
  const me = req.guild.members.me;
  const canSend = (c) => me && c.permissionsFor(me)?.has(PermissionFlagsBits.SendMessages);
  const channels = req.guild.channels.cache
    .filter((c) => c.isTextBased() && !c.isThread() && canSend(c))
    .map((c) => ({ id: c.id, name: c.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
  // Forum channels: sending creates a new post (Send Messages = "Create Posts" there).
  const forums = req.guild.channels.cache
    .filter((c) => isForum(c) && canSend(c))
    .map((c) => ({
      id: c.id,
      name: c.name,
      requireTag: c.flags?.has?.('RequireTag') || false,
      tags: (c.availableTags || []).map((t) => ({ id: t.id, name: t.name, emoji: t.emoji?.name || '' }))
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const client = req.app.locals.discordClient;
  const bot = {
    name: me?.displayName || client.user.username,
    avatarUrl: me?.displayAvatarURL({ size: 64 }) || client.user.displayAvatarURL({ size: 64 })
  };

  res.render('embedBuilder', { guild: req.guild, channels, forums, bot });
});

// Parses a Discord message link and returns the message if it's in this server and readable.
async function fetchLinkedMessage(guild, link) {
  const m = String(link || '').trim().match(/discord(?:app)?\.com\/channels\/(\d+)\/(\d+)\/(\d+)/);
  if (!m) return { error: 'Paste a message link (right-click the message → Copy Message Link).' };
  if (m[1] !== guild.id) return { error: 'That message is in a different server.' };
  const channel = guild.channels.cache.get(m[2]) || (await guild.channels.fetch(m[2]).catch(() => null));
  if (!channel || !channel.isTextBased()) return { error: "LoofaryBot can't see that channel." };
  const message = await channel.messages.fetch(m[3]).catch(() => null);
  if (!message) return { error: "Couldn't load that message — it may be deleted or in a channel LoofaryBot can't read." };
  return { channel, message };
}

// Load an existing message (any author) into the builder.
router.get('/:guildId/embed/message', requireAuth, requireGuildAccess, requirePage('embed'), async (req, res) => {
  const { message, error } = await fetchLinkedMessage(req.guild, req.query.url);
  if (error) return res.status(400).json({ ok: false, error });
  const data = EmbedJson.normalizeMessage({ content: message.content, embeds: message.embeds.map((e) => e.toJSON()) });
  res.json({ ok: true, message: data, channelId: message.channelId, editable: message.author.id === req.guild.members.me?.id });
});

// Send a new message, or edit one LoofaryBot sent earlier when `editUrl` is given.
router.post('/:guildId/embed/send', requireAuth, requireGuildAccess, requirePage('embed'), auditTrail, async (req, res) => {
  try {
    const message = EmbedJson.normalizeMessage(req.body.message);
    const errors = EmbedJson.validateMessage(message);
    if (errors.length) return res.status(400).json({ ok: false, error: errors[0] });
    // The message content is what actually pings @users/@roles typed as real mentions (Discord never
    // notifies from text inside an embed), so allowedMentions keeps its default of parsing everything.
    const payload = { content: message.content || null, embeds: message.embeds };

    if (req.body.editUrl) {
      const { message: target, error } = await fetchLinkedMessage(req.guild, req.body.editUrl);
      if (error) return res.status(400).json({ ok: false, error });
      if (target.author.id !== req.guild.members.me?.id) {
        return res.status(400).json({ ok: false, error: 'Only messages sent by LoofaryBot can be edited — send it as a new message instead.' });
      }
      await target.edit(payload);
      res.locals.audit = { section: 'Embed Builder', action: 'Edited a message', detail: `Channel: <#${target.channelId}>` };
      return res.json({ ok: true, url: target.url, edited: true });
    }

    const me = req.guild.members.me;
    const channel = req.guild.channels.cache.get(String(req.body.channelId || ''));
    if (isForum(channel)) return res.json(await postToForum(req, res, channel, payload));
    if (!channel || !channel.isTextBased()) return res.status(400).json({ ok: false, error: 'Pick a channel to send to.' });
    if (!me || !channel.permissionsFor(me)?.has([PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
      return res.status(403).json({ ok: false, error: "LoofaryBot needs Send Messages and Embed Links in that channel." });
    }
    const sent = await channel.send(payload);
    res.json({ ok: true, url: sent.url });
  } catch (err) {
    console.error('Failed to send embed:', err);
    res.status(400).json({ ok: false, error: `Discord rejected the message — check the image/link URLs. (${err.message})` });
  }
});

/** Creates a new forum post with the message as its first post. Returns the JSON reply. */
async function postToForum(req, res, forum, payload) {
  const me = req.guild.members.me;
  if (!me || !forum.permissionsFor(me)?.has([PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
    res.status(403);
    return { ok: false, error: 'LoofaryBot needs Create Posts (Send Messages) and Embed Links in that forum.' };
  }
  const title = String(req.body.postTitle || '').trim();
  if (!title) {
    res.status(400);
    return { ok: false, error: 'Give the forum post a title.' };
  }
  if (title.length > 100) {
    res.status(400);
    return { ok: false, error: 'Forum post titles can be at most 100 characters.' };
  }
  const available = new Set((forum.availableTags || []).map((t) => t.id));
  const tags = [...new Set((Array.isArray(req.body.tagIds) ? req.body.tagIds : []).map(String))].filter((id) => available.has(id));
  if (tags.length > 5) {
    res.status(400);
    return { ok: false, error: 'Pick at most 5 tags.' };
  }
  if (!tags.length && forum.flags?.has?.('RequireTag')) {
    res.status(400);
    return { ok: false, error: 'This forum requires a tag — pick at least one.' };
  }
  const thread = await forum.threads.create({ name: title, message: payload, appliedTags: tags });
  res.locals.audit = { section: 'Embed Builder', action: 'Created a forum post', detail: `${title} in <#${forum.id}>` };
  // A forum post's first message has the same ID as the post, so this link works with "Edit a bot message".
  return { ok: true, url: `https://discord.com/channels/${req.guild.id}/${thread.id}/${thread.id}`, forum: true };
}

module.exports = router;
