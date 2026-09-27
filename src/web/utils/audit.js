const AuditEntry = require('../../database/models/AuditEntry');

const MODULE_NAMES = {
  welcome: 'Welcome',
  honeypot: 'Honeypot',
  leveling: 'Leveling',
  autorole: 'Auto-Role',
  gambling: 'Gambling',
  logs: 'Logs',
  alerts: 'Alerts'
};

// Field names that are noise in the "changed" summary.
const IGNORED_FIELDS = new Set(['id', 'guildId', 'payload']);

function fieldSummary(body) {
  if (!body || typeof body !== 'object') return '';
  const keys = Object.keys(body).filter((k) => !IGNORED_FIELDS.has(k));
  return keys.length ? `Fields: ${keys.join(', ')}` : '';
}

/**
 * Turns a successful dashboard request into a human-readable change-history line.
 * Returns null for requests that aren't worth recording.
 */
function describe(req) {
  const route = req.route?.path || '';
  const b = req.body || {};
  const tail = route.replace(/^\/(guilds\/)?:guildId/, '').replace(/^\//, ''); // API routes and /dashboard/:guildId/… pages
  const map = {
    honeypot: ['Honeypot', 'Updated honeypot settings', fieldSummary(b)],
    levels: ['Leveling', 'Updated leveling settings', fieldSummary(b)],
    levelcolors: ['Leveling', 'Updated level colors', `Every ${b.interval} levels up to ${b.maxLevel} · ${b.enabled ? 'on' : 'off'}`],
    'levelcolors/sync': ['Leveling', 'Synced level colors to all members', ''],
    'levelcolors/remove-auto': ['Leveling', 'Deleted auto level color roles', ''],
    gambling: ['Gambling', 'Updated gambling settings', `Edge ${b.houseEdge}% · bets ${b.minBet}–${b.maxBet || '∞'}`],
    logs: ['Logs', 'Updated log settings', fieldSummary(b)],
    'modules/:module': ['Modules', `${b.enabled ? 'Enabled' : 'Disabled'} ${MODULE_NAMES[req.params.module] || req.params.module}`, ''],
    'joins/sync': ['Overview', 'Synced join data', ''],
    welcome: ['Welcome', 'Updated welcome message', `${b.enabled ? 'On' : 'Off'} · ${b.embedEnabled ? 'with embed' : 'text only'}`],
    'welcome/from-embed': ['Welcome', 'Set welcome message from the Embed Builder', ''],
    'welcome/test': ['Welcome', 'Sent a test welcome message', ''],
    'welcome/goodbye': ['Welcome', 'Updated goodbye message', `${b.enabled ? 'On' : 'Off'}`],
    'welcome/goodbye/test': ['Welcome', 'Sent a test goodbye message', ''],
    'embed-templates': ['Embed Builder', `Saved embed template “${String(b.name || '').slice(0, 60)}”`, ''],
    'embed-templates/:name': ['Embed Builder', `Deleted embed template “${String(req.params.name || '').slice(0, 60)}”`, ''],
    autorole: ['Auto-Role', 'Updated auto-role', ''],
    'autorole/sync': ['Auto-Role', 'Synced auto-role to existing members', ''],
    alerts: ['Alerts', `${b.id ? 'Updated' : 'Added'} ${b.platform === 'twitch' ? 'Twitch' : 'YouTube'} alert for ${String(b.account || '').slice(0, 60)}`, ''],
    'alerts/:id': ['Alerts', 'Removed an alert', ''],
    'alerts/:id/test': ['Alerts', 'Sent a test alert', ''],
    'settings/access': ['Settings', 'Updated dashboard moderator access', ''],
    'settings/alerts-channel': ['Settings', b.channelId ? 'Set the bot alerts channel' : 'Turned off bot alerts', ''],
    backups: ['Backups', 'Created a manual backup', ''],
    'backups/:id/restore': ['Backups', `Restored a backup${b.includeXp ? ' (including XP)' : ''}`, ''],
    'import/preview': null,
    import: ['Backups', `Imported settings from a file${b.includeXp ? ' (including XP)' : ''}`, ''],
    'embed/send': ['Embed Builder', 'Sent an embed', b.channelId ? `Channel: <#${b.channelId}>` : '']
  };
  if (tail in map && map[tail] === null) return null;
  const hit = map[tail];
  if (!hit) return { section: 'Dashboard', action: `${req.method} ${tail}`, detail: '' };
  return { section: hit[0], action: hit[1], detail: hit[2] || '' };
}

/** Express middleware: records successful non-GET dashboard requests once the response is sent. */
function auditTrail(req, res, next) {
  if (req.method === 'GET') return next();
  res.on('finish', () => {
    if (res.statusCode >= 400 || !req.guild || !req.session?.user) return;
    // Routes can describe themselves (res.locals.audit) when the URL alone isn't enough.
    const entry = res.locals.audit || describe(req);
    if (!entry) return;
    const u = req.session.user;
    AuditEntry.create({
      guildId: req.guild.id,
      userId: u.id,
      username: u.global_name || u.username || '',
      avatarUrl: u.avatar ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=64` : '',
      role: req.access?.level || 'admin',
      ...entry
    }).catch((err) => console.error('Failed to write change history:', err.message));
  });
  next();
}

module.exports = { auditTrail, describe };
