// FAQ dashboard page: a click-to-edit visual editor for the server's FAQ — a list of question → answer
// entries plus a title, intro and colour — with a live Discord-style preview, markdown + @/#/: autocomplete,
// and JSON import/export. Save it (so /faq posts it) or post it to a channel now. Open to guide editors
// (requirePage('faq')). See cogs/modules/faq.js.
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
    // For the visual editor: server emojis (picker) and channel/role names (mention pills + autocomplete).
    const editorData = {
      emojis: guild.emojis.cache.map((e) => ({ id: e.id, name: e.name, animated: !!e.animated, url: `https://cdn.discordapp.com/emojis/${e.id}.${e.animated ? 'gif' : 'png'}?size=48` })),
      channels: guild.channels.cache.filter((c) => c.name && c.type !== ChannelType.GuildCategory && !c.isThread?.()).map((c) => ({ id: c.id, name: c.name })),
      roles: guild.roles.cache.filter((r) => r.id !== guild.id && !r.managed).map((r) => ({ id: r.id, name: r.name })).sort((a, b) => a.name.localeCompare(b.name))
    };
    const faqState = await faq.getFaq(guild.id);
    res.render('faq', {
      guild,
      bot,
      channels: sendableChannels(guild),
      faq: faqState,
      defaultTitle: faq.DEFAULT_TITLE,
      editorData,
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
  res.json({ ok: true, faq: data });
});

// Save the FAQ (editors).
router.post('/:guildId/faq/save', requireAuth, requireGuildAccess, requirePage('faq'), auditTrail, async (req, res) => {
  const result = await faq.saveFaq(req.guild, req.body.faq || req.body, req.session.user.id);
  if (result.error) return res.status(400).json({ ok: false, error: result.error });
  res.locals.audit = { section: 'FAQ', action: 'Saved the FAQ', detail: `${result.faq.items.length} question(s)` };
  res.json({ ok: true, faq: result.faq });
});

// Post the FAQ to a channel now (editors). Saves it first so the saved copy matches what was posted.
router.post('/:guildId/faq/post', requireAuth, requireGuildAccess, requirePage('faq'), auditTrail, async (req, res) => {
  try {
    const saved = await faq.saveFaq(req.guild, req.body.faq || req.body, req.session.user.id);
    if (saved.error) return res.status(400).json({ ok: false, error: saved.error });

    const me = req.guild.members.me;
    const channel = req.guild.channels.cache.get(String(req.body.channelId || ''));
    if (!channel || !SENDABLE.includes(channel.type)) return res.status(400).json({ ok: false, error: 'Pick a channel to post the FAQ in.' });
    if (!me || !channel.permissionsFor(me)?.has([PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
      return res.status(403).json({ ok: false, error: 'LoofaryBot needs Send Messages and Embed Links in that channel.' });
    }
    const sent = await channel.send(faq.toPayload(saved.faq));
    await faq.rememberChannel(req.guild.id, channel.id);
    res.locals.audit = { section: 'FAQ', action: 'Posted the FAQ', detail: `Channel: <#${channel.id}>` };
    res.json({ ok: true, url: sent.url });
  } catch (err) {
    console.error('FAQ post failed:', err);
    res.status(400).json({ ok: false, error: `Discord rejected the message — check the length and any links. (${err.message})` });
  }
});

module.exports = router;
