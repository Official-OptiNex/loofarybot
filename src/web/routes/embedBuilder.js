const express = require('express');
const { PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const { requireAuth, requireGuildAccess } = require('../utils/authMiddleware');

const router = express.Router();

router.get('/:guildId/embed', requireAuth, requireGuildAccess, (req, res) => {
  const me = req.guild.members.me;
  const channels = req.guild.channels.cache
    .filter((c) => c.isTextBased() && !c.isThread() && me && c.permissionsFor(me)?.has(PermissionFlagsBits.SendMessages))
    .map((c) => ({ id: c.id, name: c.name }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const client = req.app.locals.client;
  const bot = {
    name: me?.displayName || client.user.username,
    avatarUrl: me?.displayAvatarURL({ size: 64 }) || client.user.displayAvatarURL({ size: 64 })
  };

  res.render('embedBuilder', { guild: req.guild, channels, bot });
});

router.post('/:guildId/embed/send', requireAuth, requireGuildAccess, async (req, res) => {
  try {
    const { channelId, content, title, description, color, fields, footer, imageUrl, thumbnailUrl } = req.body;

    const me = req.guild.members.me;
    const channel = req.guild.channels.cache.get(channelId);
    if (!channel || !channel.isTextBased()) {
      return res.status(400).json({ ok: false, error: 'Invalid channel.' });
    }
    if (!me || !channel.permissionsFor(me)?.has(PermissionFlagsBits.SendMessages)) {
      return res.status(403).json({ ok: false, error: "The bot doesn't have permission to send messages there." });
    }

    const hasEmbedContent = title || description || footer || imageUrl || thumbnailUrl || (Array.isArray(fields) && fields.length);
    if (!content && !hasEmbedContent) {
      return res.status(400).json({ ok: false, error: 'Add a message, an embed, or both before sending.' });
    }

    const embed = new EmbedBuilder();
    if (title) embed.setTitle(String(title).slice(0, 256));
    if (description) embed.setDescription(String(description).slice(0, 4096));
    if (color) embed.setColor(color);
    if (footer) embed.setFooter({ text: String(footer).slice(0, 2048) });
    if (imageUrl) embed.setImage(imageUrl);
    if (thumbnailUrl) embed.setThumbnail(thumbnailUrl);

    if (Array.isArray(fields)) {
      const cleanFields = fields
        .filter((f) => f && f.name && f.value)
        .slice(0, 25)
        .map((f) => ({ name: String(f.name).slice(0, 256), value: String(f.value).slice(0, 1024), inline: !!f.inline }));
      if (cleanFields.length) embed.addFields(cleanFields);
    }

    // The message content is what actually pings @users/@roles typed as real mentions
    // (Discord never notifies from text inside an embed) — allowedMentions defaults to
    // parsing everything, which is exactly the point of this field.
    const payload = { embeds: hasEmbedContent ? [embed] : [] };
    if (content) payload.content = String(content).slice(0, 2000);

    await channel.send(payload);
    res.json({ ok: true });
  } catch (err) {
    console.error('Failed to send embed:', err);
    res.status(500).json({ ok: false, error: 'Failed to send. Check that all URLs and the color are valid.' });
  }
});

module.exports = router;
