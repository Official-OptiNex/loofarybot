// Link safety: decides whether a link in a message is fine, unsafe, or unknown — offline, with no
// API keys or paid services. It catches the usual Discord scams: sites pretending to be Discord /
// Steam / Roblox ("free Nitro"), link shorteners that hide where they go, raw IP addresses,
// lookalike letters (punycode), direct downloads of programs, and masked links whose text shows a
// different site than where they really go — and adult / NSFW sites (a big built-in list, the
// adult-only TLDs, and obvious words in the address). Well-known sites are allowed; each server can
// add its own allow and block lists, or only allow approved sites.
const { NSFW_DOMAINS } = require('./data/nsfwDomains');

// Well-known sites that are fine to post (a subdomain counts too: clips.twitch.tv, en.wikipedia.org).
const SAFE_DOMAINS = [
  'discord.com', 'discord.gg', 'discordapp.com', 'discordapp.net', 'discord.media', 'discord.new', 'discordstatus.com', 'dis.gd',
  'youtube.com', 'youtu.be', 'twitch.tv', 'kick.com', 'x.com', 'twitter.com', 'fxtwitter.com', 'vxtwitter.com', 'fixupx.com',
  'bsky.app', 'reddit.com', 'redd.it', 'instagram.com', 'tiktok.com', 'facebook.com', 'threads.net', 'linkedin.com', 'pinterest.com',
  'tenor.com', 'giphy.com', 'imgur.com', 'gyazo.com', 'streamable.com', 'medal.tv', 'spotify.com', 'soundcloud.com', 'music.apple.com',
  'github.com', 'gitlab.com', 'githubusercontent.com', 'stackoverflow.com', 'npmjs.com', 'wikipedia.org', 'wikimedia.org', 'fandom.com',
  'google.com', 'googleusercontent.com', 'gstatic.com', 'microsoft.com', 'apple.com', 'amazon.com', 'netflix.com',
  'steampowered.com', 'steamcommunity.com', 'roblox.com', 'epicgames.com', 'minecraft.net', 'xbox.com', 'playstation.com',
  'nintendo.com', 'ea.com', 'riotgames.com', 'leagueoflegends.com', 'valorant.com', 'blizzard.com', 'battle.net', 'itch.io',
  'top.gg', 'disboard.org', 'discords.com', 'discord.js.org', 'discordjs.guide', 'steamdb.info', 'medium.com', 'imdb.com', 'bbc.co.uk', 'bbc.com', 'nytimes.com', 'theguardian.com'
];

// The real domains of the brands scammers copy most. A link that mentions one of these brands but
// isn't on its real domain is treated as a scam.
const BRANDS = {
  discord: ['discord.com', 'discord.gg', 'discordapp.com', 'discordapp.net', 'discord.media', 'discord.new', 'discordstatus.com', 'dis.gd', 'discord.co'],
  nitro: ['discord.com', 'discord.gg', 'discordapp.com'],
  steam: ['steampowered.com', 'steamcommunity.com', 'steamstatic.com', 'steamgames.com', 's.team', 'steam.tv', 'steamdeck.com'],
  roblox: ['roblox.com', 'rbxcdn.com', 'rbx.com'],
  paypal: ['paypal.com', 'paypal.me'],
  epicgames: ['epicgames.com', 'unrealengine.com'],
  steamcommunity: ['steamcommunity.com'],
  steampowered: ['steampowered.com']
};
// Words scam sites put next to a brand name ("discord-nitro-gift", "steam-free-drop").
const SCAM_WORDS = ['gift', 'nitro', 'free', 'airdrop', 'promo', 'claim', 'drop', 'reward', 'verify', 'login', 'auth', 'bonus', 'giveaway', 'event', 'trade', 'skins', 'robux'];
// Brand names close-misspellings are checked against ("dlscord", "steamcommunlty", "rob1ox").
const TYPO_TARGETS = ['discord', 'discordapp', 'steamcommunity', 'steampowered', 'roblox', 'paypal', 'epicgames'];

const SHORTENERS = [
  'bit.ly', 'tinyurl.com', 'goo.gl', 't.co', 'ow.ly', 'is.gd', 'buff.ly', 'cutt.ly', 'shorturl.at', 'rb.gy', 'tiny.cc', 'bl.ink',
  'rebrand.ly', 'shorte.st', 'adf.ly', 'v.gd', 'qr.ae', 's.id', 't.ly', 'urlz.fr', 'clck.ru', 'u.to', 'lnkd.in', 'surl.li', 'tiny.one', 'grabify.link', 'iplogger.org', 'iplogger.com', '2no.co', 'yip.su'
];
// Programs and scripts: a link straight to one of these is almost never something to click in chat.
const RISKY_FILES = /\.(exe|scr|bat|cmd|msi|msix|apk|jar|vbs|vbe|jse|wsf|ps1|lnk|hta|pif|cpl|reg|dmg|pkg|iso)$/i;
// TLDs that look like file names ("photo.zip", "invoice.mov").
const FILE_LIKE_TLDS = ['zip', 'mov'];
// Text that comes with "free Nitro" scams.
const SCAM_TEXT = /\b(free\s*(discord\s*)?nitro|nitro\s*(for\s*)?free|steam\s*gift|free\s*(steam|robux|skins?)|(gift|nitro)\b.{0,40}\b(claim|first\s*\d+))\b/i;

// Adult / NSFW: TLDs that exist only for adult sites, and words that give a site away. "sex" and
// "nude" only count at the start of a word in the address, so essex.ac.uk, unisex-shop.com or
// denuded-trees.org are fine.
const NSFW_TLDS = ['xxx', 'porn', 'sex', 'adult'];
const NSFW_WORDS = /porn|xxx|hentai|nsfw|xvideo|xnxx|xhamster|onlyfans|camgirl|camsex|sexcam|livesex|freesex|milf|rule34|gonewild|erotic|fetish|bdsm|gangbang|blowjob|cumshot|shemale|escorts?|fuckbook|jerkoff/;
const NSFW_LABEL = /^sex|sexy|^nudes?(?!t)/;

/** Is this an adult site? Also checks the subreddit of a reddit link (reddit.com/r/gonewild). */
function isNsfw(host, parsed) {
  if (onAny(host, NSFW_DOMAINS)) return true;
  const labels = host.split('.');
  if (NSFW_TLDS.includes(labels.at(-1))) return true;
  const name = labels.slice(0, -1);
  if (name.some((l) => NSFW_WORDS.test(deLeet(l)) || l.split('-').some((w) => NSFW_LABEL.test(deLeet(w))))) return true;
  if (onDomain(host, 'reddit.com') || host === 'redd.it') {
    const sub = (parsed.pathname.match(/^\/(?:r|u|user)\/([^/]+)/i) || [])[1];
    if (sub && (NSFW_WORDS.test(sub.toLowerCase()) || sub.toLowerCase().split(/[-_]/).some((w) => NSFW_LABEL.test(w)))) return true;
  }
  return false;
}

// Discord only makes http(s) links clickable. <…> just stops the preview, so it's handled the same.
const URL_RE = /https?:\/\/[^\s<>()"'`]+(?:\([^\s)]*\)[^\s<>()"'`]*)*/gi;
const MASKED_RE = /\[([^\]\n]{1,200})\]\(\s*<?(https?:\/\/[^\s)>]+)>?\s*\)/gi;

const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b', '@': 'a', $: 's' };
const deLeet = (s) => s.toLowerCase().replace(/[0134578@$]/g, (c) => LEET[c] || c);

/** Lowercase host without a trailing dot or "www.", or null when the URL can't be read. */
function hostOf(url) {
  try {
    const u = new URL(url);
    return u.hostname.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
  } catch {
    return null;
  }
}

/** Is `host` this domain or one of its subdomains? */
const onDomain = (host, domain) => host === domain || host.endsWith(`.${domain}`);
const onAny = (host, list) => list.some((d) => onDomain(host, d));

function editDistance(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
}

/** Cleans a list of domains typed by staff ("https://www.Example.com/x" → "example.com"). */
function cleanDomains(list) {
  const out = [];
  for (const raw of Array.isArray(list) ? list : String(list || '').split(/[\s,]+/)) {
    let d = String(raw || '').trim().toLowerCase();
    if (!d) continue;
    d = d.replace(/^[a-z]+:\/\//, '').replace(/^www\./, '').split(/[/?#:]/)[0].replace(/\.$/, '');
    if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d) && d.length <= 253 && !out.includes(d)) out.push(d);
  }
  return out.slice(0, 200);
}

/** Every link in a message: { url, host, text } (text = the visible text of a masked link). */
function extractLinks(content) {
  const text = String(content || '');
  const links = [];
  const seen = new Set();
  for (const m of text.matchAll(MASKED_RE)) {
    const url = m[2].replace(/[.,!?;:]+$/, '');
    links.push({ url, host: hostOf(url), text: m[1] });
    seen.add(url);
  }
  for (const m of text.matchAll(URL_RE)) {
    const url = m[0].replace(/[.,!?;:>]+$/, '');
    if (seen.has(url)) continue;
    seen.add(url);
    links.push({ url, host: hostOf(url), text: null });
  }
  return links;
}

/**
 * Judges one link. Returns { verdict: 'safe' | 'unsafe' | 'unknown', reason, scam }.
 * `scam` marks the clear-cut scam cases (fake brands, disguised links) — those can skip the warnings.
 */
function classifyLink(link, opts = {}) {
  const o = { allow: [], block: [], shorteners: true, ipLinks: true, files: true, nsfw: true, ...opts };
  const { url, host, text } = link;
  if (!host) return { verdict: 'unsafe', reason: "a broken link that can't be checked", scam: false };
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { verdict: 'unsafe', reason: "a broken link that can't be checked", scam: false };
  }

  if (onAny(host, o.block)) return { verdict: 'unsafe', reason: "on this server's block list", scam: false };
  // "https://discord.com@evil.site/" really goes to evil.site.
  if (parsed.username || parsed.password) return { verdict: 'unsafe', reason: 'hides its real address behind a fake one', scam: true };
  // A masked link whose text is itself an address, but a different one than where it really goes
  // ("[discord.com/gift](https://scam.site)"). Two well-known sites (youtube.com → youtu.be) are fine.
  if (text) {
    const shown = String(text).trim().match(/^(?:https?:\/\/)?(?:www\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,})(?:[/?#]\S*)?$/i);
    const shownHost = shown && shown[1].toLowerCase();
    const known = (h) => onAny(h, o.allow) || onAny(h, SAFE_DOMAINS);
    if (shownHost && !onDomain(host, shownHost) && !onDomain(shownHost, host) && !(known(host) && known(shownHost))) {
      return { verdict: 'unsafe', reason: `shows ${shownHost} but really goes to ${host}`, scam: true };
    }
  }
  if (o.files && RISKY_FILES.test(decodeURIComponent(parsed.pathname).replace(/\/+$/, ''))) return { verdict: 'unsafe', reason: 'a direct download of a program or script', scam: false };

  // Adult sites (before the well-known list, so a NSFW subreddit is caught too). The server's
  // approved list wins, and NSFW channels pass nsfw: false.
  if (o.nsfw && !onAny(host, o.allow) && isNsfw(host, parsed)) return { verdict: 'unsafe', reason: 'an adult (NSFW) site', scam: false, nsfw: true };

  if (onAny(host, o.allow) || onAny(host, SAFE_DOMAINS)) return { verdict: 'safe', reason: 'a well-known site', scam: false };

  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[')) {
    return o.ipLinks ? { verdict: 'unsafe', reason: 'a raw IP address instead of a website', scam: false } : { verdict: 'unknown', reason: '', scam: false };
  }
  if (host.split('.').some((l) => l.startsWith('xn--'))) return { verdict: 'unsafe', reason: 'uses lookalike letters in the address', scam: true };
  if (onAny(host, SHORTENERS)) {
    return o.shorteners ? { verdict: 'unsafe', reason: 'a link shortener that hides where it goes', scam: false } : { verdict: 'unknown', reason: '', scam: false };
  }

  // Pretending to be a brand: "discord-nitro.gift", "steamcommunlty.com", "dlscord.app".
  const labels = host.split('.');
  const tld = labels.at(-1);
  const name = deLeet(labels.slice(0, -1).join('.'));
  const flat = name.replace(/[.-]/g, '');
  for (const [brand, real] of Object.entries(BRANDS)) {
    if (onAny(host, real)) continue;
    if (flat.includes(brand) && (SCAM_WORDS.some((w) => w !== brand && flat.includes(w)) || /^(gift|nitro|app|link|click|shop|xyz|ru|tk|ml|ga|cf|gq|top|live|site|online)$/.test(tld))) {
      return { verdict: 'unsafe', reason: `pretends to be ${brand === 'nitro' ? 'Discord Nitro' : brand[0].toUpperCase() + brand.slice(1)}`, scam: true };
    }
  }
  for (const label of name.split(/[.-]/)) {
    if (label.length < 5) continue;
    for (const target of TYPO_TARGETS) {
      if (label === target) continue;
      const d = editDistance(label, target);
      if (d > 0 && d <= (target.length >= 9 ? 2 : 1)) return { verdict: 'unsafe', reason: `a misspelled copy of ${target}`, scam: true };
    }
  }
  if (FILE_LIKE_TLDS.includes(tld)) return { verdict: 'unsafe', reason: `a .${tld} address that looks like a file name`, scam: false };
  return { verdict: 'unknown', reason: '', scam: false };
}

/**
 * Checks every link in a message. Returns the first problem as { link, host, reason, scam, unapproved }
 * or null. In 'allowlist' mode, links to sites that aren't approved count too (unapproved: true).
 */
function checkContent(content, opts = {}) {
  const links = extractLinks(content);
  if (!links.length) return null;
  const scamText = SCAM_TEXT.test(String(content || ''));
  for (const link of links) {
    const r = classifyLink(link, opts);
    if (r.verdict === 'unsafe') return { link: link.url, host: link.host, reason: r.reason, scam: r.scam, unapproved: false, nsfw: !!r.nsfw };
    if (r.verdict === 'unknown' && scamText) return { link: link.url, host: link.host, reason: 'posted with a “free Nitro / gift” scam message', scam: true, unapproved: false };
    if (r.verdict === 'unknown' && opts.mode === 'allowlist') return { link: link.url, host: link.host, reason: "not on this server's approved sites", scam: false, unapproved: true };
  }
  return null;
}

module.exports = { SAFE_DOMAINS, SHORTENERS, NSFW_DOMAINS, isNsfw, hostOf, cleanDomains, extractLinks, classifyLink, checkContent, editDistance };
