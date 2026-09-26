const UNIT_MS = { s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 };

// Parses durations like "10m", "2d", or compound forms like "1h30m" / "1d 12h".
// Returns milliseconds, or null if the string isn't a valid positive duration.
function parseDuration(str) {
  if (!str) return null;
  const cleaned = String(str).trim().toLowerCase().replace(/\s+/g, '');
  if (!/^(\d+[smhdw])+$/.test(cleaned)) return null;
  let total = 0;
  for (const [, num, unit] of cleaned.matchAll(/(\d+)([smhdw])/g)) {
    total += parseInt(num, 10) * UNIT_MS[unit];
  }
  return total > 0 ? total : null;
}

function formatDuration(ms) {
  const parts = [];
  let remaining = Math.max(0, Math.round(ms / 1000));
  for (const [label, secs] of [['d', 86400], ['h', 3600], ['m', 60], ['s', 1]]) {
    const n = Math.floor(remaining / secs);
    if (n > 0) parts.push(`${n}${label}`);
    remaining -= n * secs;
  }
  return parts.join(' ') || '0s';
}

module.exports = { parseDuration, formatDuration };
