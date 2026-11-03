// FAQ dashboard page: build the server's FAQ message (text + up to 10 embeds) in the same visual /
// markdown / JSON editor as the Embed Builder, then save it (so `/faq show` posts it) or post it to a
// channel right away. Open to guide editors (via requirePage('faq')). See cogs/modules/faq.js.
const express = require('express');
const { PermissionFlagsBits, ChannelType } = require('discord.js');
const faq = require('../../bot/cogs/modules/faq');
const { requireAuth, requireGuildAccess, requirePage, guidesOnly } = require('../utils/authMiddleware');
const { auditTrail } = require('../utils/audit');

const router = express.Router();

const SENDABLE = [ChannelType.GuildText, ChannelType.GuildAnnouncement];

function sendableChannels(guild) {
  const me = guild.members.me;
  return guild.channels.cache
    .filter((c) => SENDABLE.includes(c.type) && (!me || c.permissionsFor(me)?.has(PermissionFlagsBits.SendMessages)))
    .map((c) => ({ id: c.id, name: c.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

router.get('/:guildId/faq', requireAuth, requireGuildAccess, requirePage('faq'), async (req, res) => {
  try {
    const guild = req.guild;
    const client = req.app.locals.discordClient;
    const me = guild.members.me;
    const bot = {
      name: me?.displayName || client.user.username,
      avatarUrl: me?.displayAvatarURL({ size: 64 }) || client.user.displayAvatarURL({ size: 64 })
    };
    const { message, channelId } = await faq.getFaq(guild.id);
    res.render('faq', {
      guild,
      bot,
      channels: sendableChannels(guild),
      message,
      channelId,
      isAdmin: req.access?.level === 'admin',
      guidesOnly: guidesOnly(req.access)
    });
  } catch (err) {
    console.error('FAQ page failed:', err);
    res.status(500).send('The FAQ page failed to load — please try again. (The error is in the bot logs.)');
  }
});

// Fresh saved FAQ (JSON) for refreshes.
router.get('/:guildId/faq/data', requireAuth, requireGuildAccess, requirePage('faq'), async (req, res) => {
  const data = await faq.getFaq(req.guild.id).catch(() => null);
  if (!data) return res.status(500).json({ ok: false, error: 'Failed to load the FAQ.' });
  res.json({ ok: true, message: data.message, channelId: data.channelId });
});

// Save the FAQ message (editors).
router.post('/:guildId/faq/save', requireAuth, requireGuildAccess, requirePage('faq'), auditTrail, async (req, res) => {
  const result = await faq.saveFaq(req.guild, { message: req.body.message }, req.session.user.id);
  if (result.error) return res.status(400).json({ ok: false, error: result.error });
  res.locals.audit = { section: 'FAQ', action: 'Saved the FAQ', detail: '' };
  res.json({ ok: true, message: result.message });
});

// Post the FAQ to a channel now (editors). Saves it first so the saved copy matches what was posted.
router.post('/:guildId/faq/post', requireAuth, requireGuildAccess, requirePage('faq'), auditTrail, async (req, res) => {
  try {
    const saved = await faq.saveFaq(req.guild, { message: req.body.message }, req.session.user.id);
    if (saved.error) return res.status(400).json({ ok: false, error: saved.error });

    const me = req.guild.members.me;
    const channel = req.guild.channels.cache.get(String(req.body.channelId || ''));
    if (!channel || !SENDABLE.includes(channel.type)) return res.status(400).json({ ok: false, error: 'Pick a channel to post the FAQ in.' });
    if (!me || !channel.permissionsFor(me)?.has([PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
      return res.status(403).json({ ok: false, error: 'LoofaryBot needs Send Messages and Embed Links in that channel.' });
    }
    const sent = await channel.send(faq.toPayload(saved.message));
    await faq.rememberChannel(req.guild.id, channel.id);
    res.locals.audit = { section: 'FAQ', action: 'Posted the FAQ', detail: `Channel: <#${channel.id}>` };
    res.json({ ok: true, url: sent.url });
  } catch (err) {
    console.error('FAQ post failed:', err);
    res.status(400).json({ ok: false, error: `Discord rejected the message — check the image/link URLs. (${err.message})` });
  }
});

module.exports = router;
