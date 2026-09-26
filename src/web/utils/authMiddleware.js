const MANAGE_GUILD = 0x20;
const ADMINISTRATOR = 0x8;

function requireAuth(req, res, next) {
  if (!req.session.user) {
    return res.redirect('/auth/discord');
  }
  next();
}

/**
 * Confirms the logged-in user has MANAGE_GUILD or ADMINISTRATOR on :guildId
 * (from their cached OAuth2 guild list) AND that the bot is actually a member
 * of that guild. Attaches req.guild (the Discord.js Guild object) on success.
 */
async function requireGuildAccess(req, res, next) {
  const { guildId } = req.params;
  const userGuild = (req.session.guilds || []).find((g) => g.id === guildId);

  if (!userGuild) {
    return res.status(403).render('error', { message: "You don't have access to that server." });
  }

  const perms = BigInt(userGuild.permissions || '0');
  const hasAccess = (perms & BigInt(ADMINISTRATOR)) !== 0n || (perms & BigInt(MANAGE_GUILD)) !== 0n;
  if (!hasAccess) {
    return res.status(403).render('error', { message: "You don't have Manage Server permission on that server." });
  }

  const client = req.app.locals.client;
  const guild = client.guilds.cache.get(guildId);
  if (!guild) {
    return res.status(404).render('error', { message: 'LoofaryBot is not in that server.' });
  }

  req.guild = guild;
  next();
}

module.exports = { requireAuth, requireGuildAccess, MANAGE_GUILD, ADMINISTRATOR };
