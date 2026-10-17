const express = require('express');
const { ChannelType } = require('discord.js');
const apps = require('../../bot/cogs/modules/applications');
const { requireAuth, requireGuildAccess, requirePage } = require('../utils/authMiddleware');
const { auditTrail } = require('../utils/audit');

const router = express.Router();
const guard = [requireAuth, requireGuildAccess, requirePage('applications')];

// Wraps a handler so an error answers the request instead of leaving it hanging.
const safe = (what, fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    console.error(`Applications: ${what} failed:`, err);
    if (!res.headersSent) res.status(500).json({ ok: false, error: `Failed to ${what}.` });
  }
};

const appView = (a) => ({
  id: String(a._id), formId: a.formId, formName: a.formName, userId: a.userId, userTag: a.userTag, answers: a.answers || [],
  status: a.status, decidedByTag: a.decidedByTag, decidedAt: a.decidedAt, reason: a.reason, createdAt: a.createdAt,
  reviewUrl: a.reviewMessageId ? `https://discord.com/channels/${a.guildId}/${a.reviewChannelId}/${a.reviewMessageId}` : null
});

// The Applications dashboard page.
router.get('/:guildId/applications', ...guard, async (req, res) => {
  try {
    const guild = req.guild;
    const channels = guild.channels.cache
      .filter((c) => (c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement))
      .map((c) => ({ id: c.id, name: c.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const roles = guild.roles.cache
      .filter((r) => r.id !== guild.id && !r.managed)
      .sort((a, b) => b.position - a.position)
      .map((r) => ({ id: r.id, name: r.name, color: r.hexColor }));
    const [forms, list] = await Promise.all([apps.listForms(guild.id), apps.listApplications(guild.id)]);
    const editorData = {
      emojis: guild.emojis.cache.map((e) => ({ id: e.id, name: e.name, animated: !!e.animated, url: `https://cdn.discordapp.com/emojis/${e.id}.${e.animated ? 'gif' : 'png'}?size=48` })),
      channels,
      roles: roles.map((r) => ({ id: r.id, name: r.name }))
    };
    res.render('applications', { guild, channels, roles, forms, applications: list.map(appView), maxQuestions: apps.MAX_QUESTIONS, editorData });
  } catch (err) {
    console.error('Applications page failed:', err);
    res.status(500).send('The Applications page failed to load — please try again. (The error is in the bot logs.)');
  }
});

router.get('/:guildId/applications/data', ...guard, safe('load applications', async (req, res) => {
  const [forms, list] = await Promise.all([apps.listForms(req.guild.id), apps.listApplications(req.guild.id)]);
  res.json({ ok: true, forms, applications: list.map(appView) });
}));

router.post('/:guildId/applications/forms', ...guard, auditTrail, safe('create the form', async (req, res) => {
  const result = await apps.createForm(req.guild, req.body || {});
  if (result.error) return res.status(400).json({ ok: false, error: result.error });
  res.locals.audit = { section: 'Applications', action: 'Created an application form', detail: result.form.name };
  res.json({ ok: true, form: result.form });
}));

router.post('/:guildId/applications/forms/:formId', ...guard, auditTrail, safe('save the form', async (req, res) => {
  const result = await apps.saveForm(req.guild, req.params.formId, req.body || {});
  if (result.error) return res.status(400).json({ ok: false, error: result.error });
  res.locals.audit = { section: 'Applications', action: 'Edited an application form', detail: result.form.name };
  res.json({ ok: true, form: result.form });
}));

router.post('/:guildId/applications/forms/:formId/delete', ...guard, auditTrail, safe('delete the form', async (req, res) => {
  const result = await apps.deleteForm(req.guild, req.params.formId);
  if (result.error) return res.status(400).json({ ok: false, error: result.error });
  res.locals.audit = { section: 'Applications', action: 'Deleted an application form', detail: result.name };
  res.json({ ok: true });
}));

router.post('/:guildId/applications/forms/:formId/publish', ...guard, auditTrail, safe('post the panel', async (req, res) => {
  const result = await apps.publishPanel(req.guild, req.params.formId, req.body?.channelId);
  if (result.error) return res.status(400).json({ ok: false, error: result.error });
  res.locals.audit = { section: 'Applications', action: 'Posted an application panel', detail: `#${result.message.channel?.name || ''}` };
  res.json({ ok: true, url: result.message.url || null, form: await apps.getForm(req.guild.id, req.params.formId) });
}));

// Approve / deny from the dashboard (same as the buttons in the review channel).
router.post('/:guildId/applications/:appId/decide', ...guard, auditTrail, safe('save the decision', async (req, res) => {
  const user = req.session.user;
  const result = await apps.decide(req.guild, req.params.appId, { approve: !!req.body?.approve, by: { id: user.id, tag: user.global_name || user.username || user.name || 'staff' }, reason: req.body?.reason || null });
  if (result.error) return res.status(400).json({ ok: false, error: result.error });
  res.locals.audit = { section: 'Applications', action: `${result.app.status === 'APPROVED' ? 'Approved' : 'Denied'} an application`, detail: `${result.app.userTag || result.app.userId} · ${result.app.formName}` };
  res.json({ ok: true, application: appView(result.app), warnings: result.warnings || [] });
}));

module.exports = router;
