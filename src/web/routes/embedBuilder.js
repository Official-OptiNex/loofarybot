const express = require('express');
const { PermissionFlagsBits } = require('discord.js');
const EmbedJson = require('../static/js/embed-json');
const { requireAuth, requireGuildAccess, requirePage } = require('../utils/authMiddleware');
const { auditTrail } = require('../utils/audit');

const router = express.Router();

router.get('/:guildId/embed', requireAuth, requireGuildAccess, requirePage('embed'), (req, res) => {
  const me = req.guild.members.me;
  const channels = req.guild.channels.cache
    .filter((c) => c.isTextBased() && !c.isThread() && me && c.permissionsFor(me)?.has(PermissionFlagsBits.SendMessages))
    .map((c) => ({ id: c.id, name: c.name }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const client = req.app.locals.discordClient;
  const bot = {
    name: me?.displayName || client.user.username,
    avatarUrl: me?.displayAvatarURL({ size: 64 }) || client.user.displayAvatarURL({ size: 64 })
  };

  res.render('embedBuilder', { guild: req.guild, channels, bot });
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

module.exports = router;
