const { parseDuration, formatDuration } = require('./duration');

const DURATION_SUGGESTIONS = ['10m', '30m', '1h', '2h', '6h', '12h', '1d', '2d', '3d', '7d', '14d', '30d'];

// Suggestions for any "duration" option: what you typed (if valid, with its meaning) plus common picks.
function durationChoices(typed) {
  const query = String(typed || '').toLowerCase().trim();
  const valid = parseDuration(query);
  const list = valid ? [query, ...DURATION_SUGGESTIONS.filter((d) => d !== query)] : DURATION_SUGGESTIONS.filter((d) => !query || d.startsWith(query));
  return list.slice(0, 25).map((d) => ({ name: `${d} (${formatDuration(parseDuration(d))})`, value: d }));
}

// Short "in 2h" / "3d ago" for choice labels.
function relative(ts) {
  const diff = ts - Date.now();
  const text = formatDuration(Math.abs(diff)).split(' ').slice(0, 2).join(' ');
  return diff >= 0 ? `in ${text}` : `${text} ago`;
}

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

module.exports = { durationChoices, relative, clip };
