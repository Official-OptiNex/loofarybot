const express = require('express');
const { PermissionFlagsBits, ChannelType } = require('discord.js');
const guides = require('../../bot/cogs/modules/guides');
const GuideModel = require('../../database/models/Guide');
const GuildConfig = require('../../database/models/GuildConfig');
const { requireAuth, requireGuildAccess, requirePage } = require('../utils/authMiddleware');
const { auditTrail } = require('../utils/audit');

const router = express.Router();

const isAdmin = (req) => req.access?.level === 'admin';
const adminOnly = (req, res, next) => (isAdmin(req) ? next() : res.status(403).json({ ok: false, error: 'Only admins can change guide settings or import.' }));

async function settingsOf(guild) {
  return guides.guidesSettings(await GuildConfig.findOne({ guildId: guild.id }, { guides: 1 }).lean());
}

// The Guides dashboard page (admins + guide-editor roles; editors see only this page).
router.get('/:guildId/guides', requireAuth, requireGuildAccess, requirePage('guides'), async (req, res) => {
  try {
    const guild = req.guild;
    const s = await settingsOf(guild);
    const forum = s.forumChannelId && guild.channels.cache.get(s.forumChannelId);
    const forums = guild.channels.cache
      .filter((c) => c.type === ChannelType.GuildForum)
      .map((c) => ({ id: c.id, name: c.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const textChannels = guild.channels.cache
      .filter((c) => c.type === ChannelType.GuildText)
      .map((c) => ({ id: c.id, name: c.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const roles = guild.roles.cache
      .filter((r) => r.id !== guild.id && !r.managed)
      .map((r) => ({ id: r.id, name: r.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const forumTags = forum ? (forum.availableTags || []).map((t) => t.name) : [];
    // For the visual editor: server emojis as images, channel/role names for mention pills.
    const editorData = {
      emojis: guild.emojis.cache.map((e) => ({ id: e.id, name: e.name, animated: !!e.animated, url: `https://cdn.discordapp.com/emojis/${e.id}.${e.animated ? 'gif' : 'png'}?size=48` })),
      channels: guild.channels.cache.filter((c) => c.name && c.type !== ChannelType.GuildCategory && !c.isThread?.()).map((c) => ({ id: c.id, name: c.name })),
      roles
    };
    const list = await guides.listGuides(guild.id);

    res.render('guides', {
      guild,
      isAdmin: isAdmin(req),
      settings: s,
      forums,
      textChannels,
      roles,
      forumTags,
      editorData,
      guides: list.map((g) => ({ slug: g.slug, title: g.title, tags: g.tags || [], inIndex: !!g.inIndex, threadId: g.threadId, body: g.body || { content: '', embeds: [] }, messages: (g.messages || []).map((m) => ({ key: m.key, messageId: m.messageId || null, body: m.body || { embeds: [] } })) }))
    });
  } catch (err) {
    // Without this an error here leaves the browser loading forever.
    console.error('Guides page failed:', err);
    res.status(500).send('The Guides page failed to load — please try again. (The error is in the bot logs.)');
  }
});

// Fresh guide list (JSON) for refreshes after a save/delete/import.
router.get('/:guildId/guides/data', requireAuth, requireGuildAccess, requirePage('guides'), async (req, res) => {
  const list = await guides.listGuides(req.guild.id).catch((err) => (console.error('Guide list failed:', err), null));
  if (!list) return res.status(500).json({ ok: false, error: 'Failed to load guides.' });
  res.json({ ok: true, guides: list.map((g) => ({ slug: g.slug, title: g.title, tags: g.tags || [], inIndex: !!g.inIndex, threadId: g.threadId, body: g.body || { content: '', embeds: [] }, messages: (g.messages || []).map((m) => ({ key: m.key, messageId: m.messageId || null, body: m.body || { embeds: [] } })) })) });
});

// Create or edit a guide (editors).
router.post('/:guildId/guides/save', requireAuth, requireGuildAccess, requirePage('guides'), auditTrail, async (req, res) => {
  try {
    const s = await settingsOf(req.guild);
    if (!s.forumChannelId) return res.status(400).json({ ok: false, error: 'An admin needs to pick a forum channel first (Settings below).' });
    const title = String(req.body.title || '').trim();
    if (!title) return res.status(400).json({ ok: false, error: 'A title is required.' });
    const tags = Array.isArray(req.body.tags) ? req.body.tags.map(String).filter(Boolean).slice(0, 5) : [];
    const inIndex = !!req.body.inIndex;
    const body = req.body.body ?? { content: '', embeds: [] };
    const messages = Array.isArray(req.body.messages) ? req.body.messages : undefined;
    const userId = req.session.user.id;

    const existing = req.body.slug ? await GuideModel.exists({ guildId: req.guild.id, slug: String(req.body.slug) }) : null;
    const result = existing
      ? await guides.editGuide(req.guild, String(req.body.slug), { title, tags, body, messages, inIndex }, userId, s)
      : await guides.createGuide(req.guild, { title, tags, body, messages: messages || [], inIndex, authorId: userId, createdBy: userId }, s);
    if (result.error) return res.status(400).json({ ok: false, error: result.error });
    res.locals.audit = { section: 'Guides', action: existing ? 'Edited a guide' : 'Created a guide', detail: title };
    res.json({ ok: true, guide: { slug: result.guide.slug, title: result.guide.title, tags: result.guide.tags || [], inIndex: !!result.guide.inIndex, threadId: result.guide.threadId } });
  } catch (err) {
    console.error('Guide save failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to save the guide.' });
  }
});

// Delete a guide (editors).
router.post('/:guildId/guides/delete', requireAuth, requireGuildAccess, requirePage('guides'), auditTrail, async (req, res) => {
  const s = await settingsOf(req.guild);
  const result = await guides.deleteGuide(req.guild, String(req.body.slug || ''), s);
  if (result.error) return res.status(400).json({ ok: false, error: result.error });
  res.locals.audit = { section: 'Guides', action: 'Deleted a guide', detail: result.title };
  res.json({ ok: true });
});

// Reorder guides (editors). Body: { slugs: [...] } in the desired order.
router.post('/:guildId/guides/reorder', requireAuth, requireGuildAccess, requirePage('guides'), async (req, res) => {
  const s = await settingsOf(req.guild);
  const slugs = Array.isArray(req.body.slugs) ? req.body.slugs.map(String) : [];
  await guides.reorderGuides(req.guild, slugs, s);
  res.json({ ok: true });
});

// Bulk import (admins). Accepts an array of { title, tags, body, images }.
router.post('/:guildId/guides/import', requireAuth, requireGuildAccess, requirePage('guides'), adminOnly, auditTrail, async (req, res) => {
  try {
    const s = await settingsOf(req.guild);
    if (!s.forumChannelId) return res.status(400).json({ ok: false, error: 'Pick a forum channel first.' });
    let items = req.body.guides ?? req.body.items ?? req.body;
    if (typeof items === 'string') {
      try {
        items = JSON.parse(items);
      } catch {
        return res.status(400).json({ ok: false, error: "That isn't valid JSON." });
      }
    }
    if (!Array.isArray(items)) return res.status(400).json({ ok: false, error: 'Import expects a JSON array of guides.' });
    const { imported, updated, skipped } = await guides.importGuides(req.guild, items, req.session.user.id, s);
    res.locals.audit = { section: 'Guides', action: `Imported ${imported.length} guide(s), updated ${updated.length}`, detail: [...imported, ...updated].slice(0, 5).join(', ') };
    res.json({ ok: true, imported, updated, skipped });
  } catch (err) {
    console.error('Guide import failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to import guides.' });
  }
});

// The pinned index post's look (editors): post name, title, colour, intro text, footer.
router.post('/:guildId/guides/index', requireAuth, requireGuildAccess, requirePage('guides'), auditTrail, async (req, res) => {
  try {
    const s = await settingsOf(req.guild);
    if (!s.forumChannelId) return res.status(400).json({ ok: false, error: 'An admin needs to pick a forum channel first (Settings below).' });
    const { index } = await guides.saveIndex(req.guild, req.body || {}, s);
    res.locals.audit = { section: 'Guides', action: 'Edited the index post', detail: index.name || index.title || '' };
    res.json({ ok: true, index });
  } catch (err) {
    console.error('Guide index save failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to save the index post.' });
  }
});

// Repost the pinned index post (editors): a fresh post without old 'changed the post title' lines.
router.post('/:guildId/guides/index/repost', requireAuth, requireGuildAccess, requirePage('guides'), auditTrail, async (req, res) => {
  try {
    const result = await guides.repostIndex(req.guild, await settingsOf(req.guild));
    if (result.error) return res.status(400).json({ ok: false, error: result.error });
    res.locals.audit = { section: 'Guides', action: 'Reposted the index post', detail: '' };
    res.json({ ok: true, threadId: result.threadId });
  } catch (err) {
    console.error('Guide index repost failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to repost the index post.' });
  }
});

// Settings (admins): forum channel, editor roles, editor channel.
router.post('/:guildId/guides/settings', requireAuth, requireGuildAccess, requirePage('guides'), adminOnly, auditTrail, async (req, res) => {
  try {
    const input = {
      enabled: true,
      forumChannelId: req.body.forumChannelId || null,
      editorRoleIds: Array.isArray(req.body.editorRoleIds) ? req.body.editorRoleIds : []
    };
    const saved = await guides.saveSettings(req.guild, input);
    if (saved.error) return res.status(400).json({ ok: false, error: saved.error });

    // Editor channel: create a new one, use an existing one, or leave as-is.
    if (req.body.createEditorChannel) {
      const ec = await guides.ensureEditorChannel(req.guild, saved.settings, {});
      if (ec.error) return res.json({ ok: true, settings: saved.settings, warning: ec.error });
    } else if (req.body.editorChannelId) {
      await guides.ensureEditorChannel(req.guild, saved.settings, { existingId: String(req.body.editorChannelId) });
    }
    await guides.rebuildLegend(req.guild, saved.settings);
    res.locals.audit = { section: 'Guides', action: 'Updated guide settings', detail: '' };
    const fresh = await settingsOf(req.guild);
    res.json({ ok: true, settings: fresh });
  } catch (err) {
    console.error('Guide settings failed:', err);
    res.status(500).json({ ok: false, error: 'Failed to save settings.' });
  }
});

module.exports = router;
