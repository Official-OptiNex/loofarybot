const express = require('express');
const { PermissionFlagsBits } = require('discord.js');
const { requireAuth, requireGuildAccess } = require('../utils/authMiddleware');
const { setupHoneypotChannel } = require('../../bot/cogs/modules/honeypot');
const { getOrCreateConfig, getLeaderboard } = require('../../bot/cogs/modules/leveling');
const EmbedTemplate = require('../../database/models/EmbedTemplate');

const router = express.Router();

// GET channels the bot can actually send messages in — used by the embed builder dropdown.
router.get('/guilds/:guildId/channels', requireAuth, requireGuildAccess, (req, res) => {
  const me = req.guild.members.me;
  const channels = req.guild.channels.cache
    .filter((c) => c.isTextBased() && !c.isThread() && me && c.permissionsFor(me)?.has(PermissionFlagsBits.SendMessages))
    .map((c) => ({ id: c.id, name: c.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
  res.json({ channels });
});

// GET everything the embed builder's live @/#/: autocomplete needs: members, channels, roles, emojis.
router.get('/guilds/:guildId/mentionable', requireAuth, requireGuildAccess, async (req, res) => {
  try {
    // Members aren't always fully cached — fetch (bounded) so autocomplete has real data
    // to search even in servers the bot just joined or hasn't seen much traffic in.
    await req.guild.members.fetch({ limit: 1000 }).catch(() => null);

    const users = req.guild.members.cache
      .filter((m) => !m.user.bot)
      .map((m) => ({ id: m.id, name: m.displayName, username: m.user.username }))
      .slice(0, 1000);

    const channels = req.guild.channels.cache
      .filter((c) => c.isTextBased() && !c.isThread())
      .map((c) => ({ id: c.id, name: c.name }));

    const roles = req.guild.roles.cache
      .filter((r) => r.name !== '@everyone' && !r.managed)
      .map((r) => ({ id: r.id, name: r.name }));

    const emojis = req.guild.emojis.cache.map((e) => ({
      id: e.id,
      name: e.name,
      animated: e.animated,
      url: e.imageURL({ size: 32 })
    }));

    res.json({ users, channels, roles, emojis });
  } catch (err) {
    console.error('Failed to load mentionable data:', err);
    res.status(500).json({ error: 'Failed to load server data.' });
  }
});

// GET a paginated, member-info-enriched XP leaderboard — powers the dashboard's Leaderboard tab.
router.get('/guilds/:guildId/leaderboard', requireAuth, requireGuildAccess, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const { entries, total, totalPages } = await getLeaderboard(req.guild.id, page, 10);

    // Members may not all be cached — fetch (bounded) so names/avatars resolve even for
    // users who haven't been active recently.
    await req.guild.members.fetch({ limit: 1000 }).catch(() => null);

    const startRank = (page - 1) * 10;
    const enriched = entries.map((r, i) => {
      const member = req.guild.members.cache.get(r.userId);
      return {
        rank: startRank + i + 1,
        userId: r.userId,
        name: member ? member.displayName : `Unknown User (${r.userId})`,
        avatarUrl: member ? member.displayAvatarURL({ size: 64 }) : null,
        level: r.level,
        xp: r.xp
      };
    });

    res.json({ entries: enriched, page, totalPages, total });
  } catch (err) {
    console.error('Failed to load leaderboard:', err);
    res.status(500).json({ error: 'Failed to load leaderboard.' });
  }
});

router.post('/guilds/:guildId/honeypot', requireAuth, requireGuildAccess, async (req, res) => {
  try {
    const { channelId, action } = req.body;
    const client = req.app.locals.client;

    const config = await getOrCreateConfig(req.guild.id);
    if (action && ['kick', 'softban', 'ban'].includes(action)) {
      config.honeypotAction = action;
      await config.save();
    }
    if (channelId && channelId !== config.honeypotChannelId) {
      await setupHoneypotChannel(client, req.guild.id, channelId);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/guilds/:guildId/levels', requireAuth, requireGuildAccess, async (req, res) => {
  try {
    const { enabled, levelRoles, xpMin, xpMax, xpCooldownSeconds, levelXpBase } = req.body;
    const config = await getOrCreateConfig(req.guild.id);

    if (typeof enabled === 'boolean') config.levelingEnabled = enabled;
    if (Array.isArray(levelRoles)) {
      config.levelRoles = levelRoles
        .filter((lr) => lr.level && lr.roleId)
        .map((lr) => ({ level: Number(lr.level), roleId: String(lr.roleId) }));
    }
    // Empty string / undefined from the form clears the override back to the global default.
    config.xpMin = xpMin === '' || xpMin == null ? null : Number(xpMin);
    config.xpMax = xpMax === '' || xpMax == null ? null : Number(xpMax);
    config.xpCooldownSeconds = xpCooldownSeconds === '' || xpCooldownSeconds == null ? null : Number(xpCooldownSeconds);
    config.levelXpBase = levelXpBase === '' || levelXpBase == null ? null : Number(levelXpBase);

    await config.save();
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- Embed Templates: save/load/delete named embed drafts per guild ---

router.get('/guilds/:guildId/embed-templates', requireAuth, requireGuildAccess, async (req, res) => {
  try {
    const templates = await EmbedTemplate.find({ guildId: req.guild.id }).sort({ name: 1 });
    res.json({ templates });
  } catch (err) {
    console.error('Failed to load embed templates:', err);
    res.status(500).json({ error: 'Failed to load templates.' });
  }
});

router.post('/guilds/:guildId/embed-templates', requireAuth, requireGuildAccess, async (req, res) => {
  try {
    const { name, title, description, color, footer, imageUrl, thumbnailUrl, fields, content } = req.body;
    const cleanName = String(name || '').trim().slice(0, 100);
    if (!cleanName) {
      return res.status(400).json({ ok: false, error: 'A template name is required.' });
    }

    const cleanFields = Array.isArray(fields)
      ? fields
          .filter((f) => f && f.name && f.value)
          .slice(0, 25)
          .map((f) => ({ name: String(f.name).slice(0, 256), value: String(f.value).slice(0, 1024), inline: !!f.inline }))
      : [];

    const data = {
      guildId: req.guild.id,
      name: cleanName,
      createdBy: req.session.user.id,
      title: title || '',
      description: description || '',
      content: content || '',
      color: color || '#5865f2',
      footer: footer || '',
      imageUrl: imageUrl || '',
      thumbnailUrl: thumbnailUrl || '',
      fields: cleanFields
    };

    // Upsert: saving under an existing name in this guild overwrites it rather than erroring,
    // so "Save" behaves the way people expect for an already-loaded template.
    const template = await EmbedTemplate.findOneAndUpdate({ guildId: req.guild.id, name: cleanName }, data, {
      upsert: true,
      new: true,
      setDefaultsOnInsert: true
    });

    res.json({ ok: true, template });
  } catch (err) {
    console.error('Failed to save embed template:', err);
    res.status(500).json({ ok: false, error: 'Failed to save template.' });
  }
});

router.delete('/guilds/:guildId/embed-templates/:name', requireAuth, requireGuildAccess, async (req, res) => {
  try {
    const result = await EmbedTemplate.deleteOne({ guildId: req.guild.id, name: req.params.name });
    if (result.deletedCount === 0) {
      return res.status(404).json({ ok: false, error: 'Template not found.' });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('Failed to delete embed template:', err);
    res.status(500).json({ ok: false, error: 'Failed to delete template.' });
  }
});

// --- Auto-Role ---

router.post('/guilds/:guildId/autorole', requireAuth, requireGuildAccess, async (req, res) => {
  try {
    const { roleId, enabled } = req.body;
    const config = await getOrCreateConfig(req.guild.id);
    if (roleId !== undefined) config.autoRoleId = roleId || null;
    if (typeof enabled === 'boolean') config.autoRoleEnabled = enabled;
    await config.save();
    res.json({ ok: true });
  } catch (err) {
    console.error('Failed to save auto-role config:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/guilds/:guildId/autorole/sync', requireAuth, requireGuildAccess, async (req, res) => {
  try {
    const config = await getOrCreateConfig(req.guild.id);
    if (!config.autoRoleId) {
      return res.status(400).json({ ok: false, error: 'No auto-role is configured yet.' });
    }
    const role = req.guild.roles.cache.get(config.autoRoleId);
    if (!role) {
      return res.status(404).json({ ok: false, error: 'The configured role no longer exists.' });
    }
    const botMember = req.guild.members.me;
    if (!botMember || botMember.roles.highest.position <= role.position) {
      return res.status(400).json({
        ok: false,
        error: `LoofaryBot's role is below ${role.name} in the hierarchy — move it above before syncing.`
      });
    }

    const members = await req.guild.members.fetch();
    const needsRole = members.filter((m) => !m.user.bot && !m.roles.cache.has(role.id));

    let granted = 0;
    let failed = 0;
    for (const member of needsRole.values()) {
      try {
        await member.roles.add(role, 'Auto-role sync (dashboard)');
        granted++;
      } catch {
        failed++;
      }
    }

    res.json({ ok: true, granted, failed });
  } catch (err) {
    console.error('Auto-role sync failed:', err);
    res.status(500).json({ ok: false, error: 'Sync failed. Check the server logs.' });
  }
});

module.exports = router;
