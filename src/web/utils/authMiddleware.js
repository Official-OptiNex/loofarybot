const { PermissionFlagsBits } = require('discord.js');
const GuildConfig = require('../../database/models/GuildConfig');

const MANAGE_GUILD = 0x20;
const ADMINISTRATOR = 0x8;

// Dashboard pages a moderator can be given (Overview is always visible; Server Settings never).
const MOD_PAGES = {
  leaderboard: 'Leaderboard',
  commands: 'Commands',
  logviewer: 'Log viewer (read-only)',
  welcome: 'Welcome',
  honeypot: 'Honeypot',
  leveling: 'Leveling',
  autorole: 'Auto-Role',
  gambling: 'Gambling',
  logs: 'Logs settings',
  alerts: 'Alerts',
  giveaways: 'Giveaways',
  reactionroles: 'Reaction Roles',
  community: 'Polls & Reminders',
  moderation: 'Moderation (lockdown, purge)',
  tickets: 'Tickets',
  engagement: 'Birthdays, Counting & Starboard',
  embed: 'Embed Builder'
};
const DEFAULT_MOD_PAGES = ['leaderboard', 'commands', 'logviewer'];

const wantsJson = (req) => req.originalUrl.startsWith('/api/');

function deny(req, res, status, message) {
  if (wantsJson(req)) return res.status(status).json({ ok: false, error: message });
  return res.status(status).render('error', { message });
}

function requireAuth(req, res, next) {
  if (!req.session.user) {
    if (wantsJson(req)) return res.status(401).json({ ok: false, error: 'Your login expired — refresh the page.' });
    return res.redirect('/auth/discord');
  }
  next();
}

function sessionHasManage(userGuild) {
  const perms = BigInt(userGuild?.permissions || '0');
  return (perms & BigInt(ADMINISTRATOR)) !== 0n || (perms & BigInt(MANAGE_GUILD)) !== 0n;
}

/**
 * Works out what the logged-in user can do in a guild:
 *   { level: 'admin', pages: null }        — Manage Server / Administrator (live permissions)
 *   { level: 'mod', pages: Set<string> }   — holds one of the configured moderator roles
 *   null                                    — no dashboard access
 */
async function resolveAccess(guild, userId, userGuild) {
  const member = await guild.members.fetch(userId).catch(() => null);
  if (member) {
    if (member.permissions.has(PermissionFlagsBits.ManageGuild) || member.permissions.has(PermissionFlagsBits.Administrator)) {
      return { level: 'admin', pages: null };
    }
  } else if (sessionHasManage(userGuild)) {
    return { level: 'admin', pages: null }; // member fetch failed; fall back to the login snapshot
  }

  if (!member) return null;
  const config = await GuildConfig.findOne({ guildId: guild.id }, { dashboardAccess: 1 }).lean();
  const access = config?.dashboardAccess || {};
  const modRoles = access.modRoleIds || [];
  if (!modRoles.some((id) => member.roles.cache.has(id))) return null;
  return { level: 'mod', pages: new Set(access.modPages || DEFAULT_MOD_PAGES) };
}

/**
 * Confirms the user can open :guildId's dashboard (admin or moderator) and that the bot is in it.
 * Attaches req.guild and req.access.
 */
async function requireGuildAccess(req, res, next) {
  const { guildId } = req.params;
  const userGuild = (req.session.guilds || []).find((g) => g.id === guildId);
  if (!userGuild) return deny(req, res, 403, "You don't have access to that server.");

  const client = req.app.locals.discordClient;
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return deny(req, res, 404, 'LoofaryBot is not in that server.');

  const access = await resolveAccess(guild, req.session.user.id, userGuild);
  if (!access) return deny(req, res, 403, "You need Manage Server permission (or a dashboard moderator role) on that server.");

  req.guild = guild;
  req.access = access;
  next();
}

const canUse = (access, page) => !!access && (access.level === 'admin' || (page !== 'settings' && access.pages?.has(page)));

// Route guard: requirePage('leveling') etc. 'settings' is admin-only.
function requirePage(page) {
  return (req, res, next) => (canUse(req.access, page) ? next() : deny(req, res, 403, "Your dashboard role doesn't include that page."));
}

module.exports = {
  requireAuth,
  requireGuildAccess,
  requirePage,
  resolveAccess,
  canUse,
  sessionHasManage,
  MOD_PAGES,
  DEFAULT_MOD_PAGES,
  MANAGE_GUILD,
  ADMINISTRATOR
};
