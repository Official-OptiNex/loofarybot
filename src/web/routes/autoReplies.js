const express = require('express');
const { ChannelType } = require('discord.js');
const autoReplies = require('../../bot/cogs/modules/autoReplies');
const GuildConfig = require('../../database/models/GuildConfig');
const { requireAuth, requireGuildAccess, requirePage } = require('../utils/authMiddleware');
const { auditTrail } = require('../utils/audit');

const router = express.Router();

const settingsOf = async (guild) => autoReplies.autoRepliesSettings(await GuildConfig.findOne({ guildId: guild.id }, { autoReplies: 1 }).lean());

router.get('/:guildId/autoreplies', requireAuth, requireGuildAccess, requirePage('autoreplies'), async (req, res) => {
  const guild = req.guild;
  const s = await settingsOf(guild);
  const channels = guild.channels.cache
    .filter((c) => c.isTextBased?.() && !c.isThread?.())
    .map((c) => ({ id: c.id, name: c.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const roles = guild.roles.cache
    .filter((r) => r.id !== guild.id && !r.managed)
    .map((r) => ({ id: r.id, name: r.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
  res.render('autoReplies', { guild, settings: s, channels, roles, matchModes: autoReplies.MATCH_MODES });
});

router.get('/:guildId/autoreplies/data', requireAuth, requireGuildAccess, requirePage('autoreplies'), async (req, res) => {
  res.json({ ok: true, settings: await settingsOf(req.guild) });
});

// Create or update a trigger.
router.post('/:guildId/autoreplies/save', requireAuth, requireGuildAccess, requirePage('autoreplies'), auditTrail, async (req, res) => {
  const t = req.body || {};
  const res2 = await autoReplies.addTrigger(req.guild, {
    id: t.id || undefined,
    name: t.name,
    keywords: Array.isArray(t.keywords) ? t.keywords : String(t.keywords || '').split(','),
    response: t.response,
    match: t.match,
    reply: t.reply !== false,
    caseSensitive: !!t.caseSensitive,
    deleteTrigger: !!t.deleteTrigger,
    ignoreChannelIds: Array.isArray(t.ignoreChannelIds) ? t.ignoreChannelIds : [],
    ignoreRoleIds: Array.isArray(t.ignoreRoleIds) ? t.ignoreRoleIds : [],
    enabled: t.enabled !== false
  });
  if (res2.error) return res.status(400).json({ ok: false, error: res2.error });
  res.locals.audit = { section: 'Auto-Replies', action: res2.editing ? 'Edited an auto-reply' : 'Added an auto-reply', detail: res2.trigger.name };
  res.json({ ok: true, settings: await settingsOf(req.guild) });
});

router.post('/:guildId/autoreplies/delete', requireAuth, requireGuildAccess, requirePage('autoreplies'), auditTrail, async (req, res) => {
  const r = await autoReplies.removeTrigger(req.guild, String(req.body.id || ''));
  if (r.error) return res.status(400).json({ ok: false, error: r.error });
  res.locals.audit = { section: 'Auto-Replies', action: 'Deleted an auto-reply', detail: r.trigger.name };
  res.json({ ok: true, settings: await settingsOf(req.guild) });
});

router.post('/:guildId/autoreplies/toggle', requireAuth, requireGuildAccess, requirePage('autoreplies'), async (req, res) => {
  const r = await autoReplies.toggleTrigger(req.guild, String(req.body.id || ''), req.body.on);
  if (r.error) return res.status(400).json({ ok: false, error: r.error });
  res.json({ ok: true, settings: await settingsOf(req.guild) });
});

router.post('/:guildId/autoreplies/settings', requireAuth, requireGuildAccess, requirePage('autoreplies'), auditTrail, async (req, res) => {
  const r = await autoReplies.saveSettings(req.guild, { enabled: req.body.enabled, cooldownSeconds: req.body.cooldownSeconds });
  if (r.error) return res.status(400).json({ ok: false, error: r.error });
  res.locals.audit = { section: 'Auto-Replies', action: 'Updated auto-reply settings', detail: '' };
  res.json({ ok: true, settings: r.settings });
});

module.exports = router;
