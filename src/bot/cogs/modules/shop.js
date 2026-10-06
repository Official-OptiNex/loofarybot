// XP shop: members spend XP on fun extras. Starter items are added the first time a server opens the
// shop; staff can edit, hide or delete them and add their own (roles, collectibles, any type) on the
// dashboard. Owned items that can be toggled (auto-react, nickname tag, badge, roles) are switched on
// and off by the member, and the emoji / badge text is theirs to customise.
const { EmbedBuilder, PermissionFlagsBits, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const GuildConfig = require('../../../database/models/GuildConfig');
const ShopItem = require('../../../database/models/ShopItem');
const ShopOwnership = require('../../../database/models/ShopOwnership');
const UserLevel = require('../../../database/models/UserLevel');
const leveling = require('./leveling');
const { sendLog } = require('./logging');

const COLOR = '#EB459E';
const fmt = (n) => Number(n).toLocaleString('en-US');

// What each kind of item does. toggle = the member can switch it on/off; custom = what they can change.
const TYPES = {
  autoReact: { label: 'Auto-react', toggle: true, custom: ['emoji'], help: 'LoofaryBot reacts to your messages with your emoji.' },
  xpBoost: { label: 'XP boost', toggle: false, custom: [], help: 'More XP from chatting for a while. Buying again adds more time.' },
  extraGambles: { label: 'Extra gambles', toggle: false, custom: [], help: 'More /gamble plays today.' },
  nickTag: { label: 'Nickname tag', toggle: true, custom: ['emoji'], help: 'An emoji in front of your name.' },
  nickname: { label: 'Nickname', toggle: false, custom: [], help: 'Set your own server nickname (for members who can’t change it themselves).' },
  badge: { label: 'Custom badge', toggle: true, custom: ['emoji', 'text', 'color'], help: 'Your own title, emoji and color on /levels rank and the leaderboard.' },
  role: { label: 'Role', toggle: true, custom: [], help: 'A role — wear it or hide it any time.' },
  collectible: { label: 'Collectible', toggle: false, custom: [], help: 'A trophy for your /levels rank card.' }
};

// Starter items (a normal chatter earns roughly 1,000 XP in a few hours of chatting).
const DEFAULT_ITEMS = [
  { key: 'autoreact', type: 'autoReact', emoji: '✨', name: 'Auto-react', price: 2500, description: 'LoofaryBot reacts to your messages with an emoji you pick. Toggle it any time.', config: { reactEmoji: '🔥', cooldownSeconds: 45 } },
  { key: 'xpboost', type: 'xpBoost', emoji: '⚡', name: 'XP Boost (24h)', price: 1500, maxPerUser: 0, description: '+50% XP from chatting for 24 hours. Buying again adds another 24 hours.', config: { multiplier: 1.5, durationHours: 24 } },
  { key: 'gambles', type: 'extraGambles', emoji: '🎲', name: '+3 Gambles', price: 800, maxPerUser: 0, description: 'Three extra /gamble plays today (resets at midnight UTC).', config: { plays: 3 } },
  { key: 'nicktag', type: 'nickTag', emoji: '🏷️', name: 'Nickname tag', price: 1200, description: 'Put an emoji of your choice in front of your name. Toggle it any time.', config: { reactEmoji: '⭐' } },
  { key: 'nickname', type: 'nickname', emoji: '📝', name: 'Nickname change', price: 1000, maxPerUser: 0, description: 'Set your own server nickname. Run `/shop buy` and type your new name (or pick it here and a box pops up).', config: {} },
  { key: 'badge', type: 'badge', emoji: '🎖️', name: 'Custom badge', price: 3000, description: 'Your own title, emoji and color on your rank card and the leaderboard.', config: {} },
  { key: 'loofa', type: 'collectible', emoji: '🏆', name: 'Golden Loofa', price: 10000, stock: 10, description: 'Ultra rare trophy — only 10 exist. Shows on your rank card forever.', config: {} }
];

const CUSTOM_EMOJI_RE = /^<a?:\w{2,32}:(\d{17,20})>$/;

// Starter items that existed before we tracked which ones a server had been offered. Used once, to
// seed the tracking set for servers that were seeded back then, so only genuinely new starter items
// (e.g. the Nickname change) get topped up — staff-deleted ones never come back on their own.
const LEGACY_SEEDED_KEYS = ['autoreact', 'xpboost', 'gambles', 'nicktag', 'badge', 'loofa'];

// ---------------------------------------------------------------- Catalog

async function ensureDefaults(guildId) {
  // First time this server opens the shop: seed the whole starter catalog (once).
  const claimed = await GuildConfig.updateOne(
    { guildId, shopSeeded: { $ne: true } },
    { $set: { shopSeeded: true, shopSeededKeys: DEFAULT_ITEMS.map((d) => d.key) } }
  );
  if (claimed.modifiedCount === 1) {
    if (await ShopItem.exists({ guildId })) return false;
    await ShopItem.insertMany(DEFAULT_ITEMS.map((d, i) => ({ ...d, guildId, order: i, maxPerUser: d.maxPerUser ?? 1, stock: d.stock ?? null })));
    return true;
  }
  // Already seeded before some starter items existed: add the new ones this server has never been
  // offered (so they appear without the staff having to add them), but never re-add ones staff
  // deleted on purpose, and never duplicate an item that's already there.
  const cfg = await GuildConfig.findOne({ guildId }, { shopSeededKeys: 1 }).lean();
  const have = new Set((await ShopItem.find({ guildId, key: { $ne: null } }, { key: 1 }).lean()).map((i) => i.key));
  const offered = new Set(cfg?.shopSeededKeys || LEGACY_SEEDED_KEYS);
  const fresh = DEFAULT_ITEMS.filter((d) => !offered.has(d.key) && !have.has(d.key));
  if (!fresh.length) {
    if (!cfg?.shopSeededKeys) await GuildConfig.updateOne({ guildId }, { $set: { shopSeededKeys: [...new Set([...offered, ...have])] } });
    return false;
  }
  const count = await ShopItem.countDocuments({ guildId });
  await ShopItem.insertMany(fresh.map((d, i) => ({ ...d, guildId, order: count + i, maxPerUser: d.maxPerUser ?? 1, stock: d.stock ?? null })));
  await GuildConfig.updateOne({ guildId }, { $set: { shopSeededKeys: [...new Set([...offered, ...have, ...fresh.map((d) => d.key)])] } });
  return true;
}

/** Puts back any starter items that were deleted (edited ones are left as they are). */
async function restoreDefaults(guildId) {
  const existing = await ShopItem.find({ guildId, key: { $ne: null } }, { key: 1 }).lean();
  const have = new Set(existing.map((e) => e.key));
  const missing = DEFAULT_ITEMS.filter((d) => !have.has(d.key));
  const count = await ShopItem.countDocuments({ guildId });
  if (missing.length) await ShopItem.insertMany(missing.map((d, i) => ({ ...d, guildId, order: count + i, maxPerUser: d.maxPerUser ?? 1, stock: d.stock ?? null })));
  return missing.length;
}

async function listItems(guildId, { all = false } = {}) {
  await ensureDefaults(guildId);
  const items = await ShopItem.find(all ? { guildId } : { guildId, enabled: true }).sort({ order: 1, price: 1 }).lean();
  return items.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.price - b.price);
}

const soldOut = (item) => item.stock !== null && item.stock !== undefined && item.sold >= item.stock;

function itemLine(item, owned = null) {
  const bits = [`**${fmt(item.price)} XP**`];
  if (item.stock !== null && item.stock !== undefined) bits.push(soldOut(item) ? '**sold out**' : `${item.stock - item.sold} left`);
  if (item.minLevel) bits.push(`level ${item.minLevel}+`);
  if (owned) bits.push(TYPES[item.type]?.toggle ? (owned.active ? '✅ owned · on' : '✅ owned · off') : owned.expiresAt && new Date(owned.expiresAt) > new Date() ? `⏳ active until <t:${Math.floor(new Date(owned.expiresAt).getTime() / 1000)}:R>` : item.maxPerUser === 1 ? '✅ owned' : '');
  return `${item.emoji} **${item.name}** · ${bits.filter(Boolean).join(' · ')}\n${item.description}`;
}

// ---------------------------------------------------------------- Validation helpers

/** A single emoji: any standard emoji, or a custom one from this server. Returns the emoji or null. */
function cleanEmoji(guild, raw) {
  const e = String(raw || '').trim();
  if (!e) return null;
  const custom = e.match(CUSTOM_EMOJI_RE);
  if (custom) return guild.emojis?.cache?.has(custom[1]) ? e : null;
  if (e.length > 16 || /[\w\s<>:@#]/.test(e) || !/\p{Extended_Pictographic}|\p{Emoji_Presentation}|\p{Regional_Indicator}/u.test(e)) return null;
  return e;
}

function cleanText(raw, max = 24) {
  const t = String(raw || '').replace(/[\r\n]+/g, ' ').replace(/<[@#&!]*\d+>|@(everyone|here)|https?:\/\/\S+|discord\.gg\/\S+/gi, '').replace(/[*_`~|>]/g, '').trim();
  return t ? t.slice(0, max) : null;
}

const cleanColor = (raw) => (/^#?[0-9a-f]{6}$/i.test(String(raw || '').trim()) ? `#${String(raw).trim().replace('#', '').toUpperCase()}` : null);

/** A server nickname: 1–32 chars, no line breaks. Discord blocks a few words itself — we let it, and
 * surface its error if so. Returns the cleaned nickname or null when it's empty. */
function cleanNickname(raw) {
  const t = String(raw || '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, 32) : null;
}

function botCanGiveRole(guild, roleId) {
  const role = roleId ? guild.roles.cache.get(roleId) : null;
  const me = guild.members.me;
  return !!(role && !role.managed && me?.permissions.has(PermissionFlagsBits.ManageRoles) && me.roles.highest.position > role.position);
}

function canNick(member) {
  const me = member.guild.members.me;
  return !!(me?.permissions.has(PermissionFlagsBits.ManageNicknames) && member.id !== member.guild.ownerId && member.roles.highest.position < me.roles.highest.position);
}

// ---------------------------------------------------------------- Effects

const TAG_SEP = ' ';
function stripTag(name, emoji) {
  return emoji && name?.startsWith(emoji + TAG_SEP) ? name.slice(emoji.length + TAG_SEP.length) : name;
}

async function applyNickTag(member, owned, on) {
  if (!canNick(member)) return { error: "LoofaryBot can't change your nickname (it needs Manage Nicknames and a role above yours)." };
  const emoji = owned.custom?.emoji;
  const current = member.nickname; // null = no server nickname
  if (on) {
    const base = stripTag(current || member.user.globalName || member.user.username, emoji);
    // Remember the nickname they had before the tag, so switching it off puts it back.
    // '' = they had no server nickname.
    if (!current?.startsWith(emoji + TAG_SEP)) await ShopOwnership.updateOne({ _id: owned._id }, { $set: { 'custom.originalNick': current || '' } });
    await member.setNickname(`${emoji}${TAG_SEP}${base}`.slice(0, 32), 'XP shop: nickname tag');
  } else {
    const saved = owned.custom?.originalNick;
    const back = saved !== null && saved !== undefined ? saved : current ? stripTag(current, emoji) : null;
    await member.setNickname(back || null, 'XP shop: nickname tag off');
  }
  return { ok: true };
}

async function applyRole(member, item, on) {
  const roleId = item.config?.roleId;
  if (!botCanGiveRole(member.guild, roleId)) return { error: "LoofaryBot can't hand out that role right now — ask staff to check its position." };
  if (on) await member.roles.add(roleId, `XP shop: ${item.name}`);
  else await member.roles.remove(roleId, `XP shop: ${item.name} hidden`);
  return { ok: true };
}

// In-memory lookups so chat stays fast: auto-react owners and XP boosts.
const reactCache = new Map(); // guildId -> { at, users: Map(userId -> { emoji, cooldownMs }) }
const boostCache = new Map(); // `${guildId}:${userId}` -> { at, mult, until }
const lastReact = new Map(); // `${guildId}:${userId}` -> ts
const CACHE_MS = 60 * 1000;

function forget(guildId, userId = null) {
  reactCache.delete(guildId);
  if (userId) boostCache.delete(`${guildId}:${userId}`);
}

async function reactUsers(guildId) {
  const hit = reactCache.get(guildId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.users;
  const owned = await ShopOwnership.find({ guildId, type: 'autoReact', active: true }).lean();
  const items = new Map((await ShopItem.find({ guildId, type: 'autoReact' }).lean()).map((i) => [String(i._id), i]));
  const users = new Map();
  for (const o of owned) {
    const item = items.get(String(o.itemId));
    if (!item) continue;
    users.set(o.userId, { emoji: o.custom?.emoji || item.config?.reactEmoji || item.emoji, cooldownMs: Math.max(5, item.config?.cooldownSeconds ?? 45) * 1000 });
  }
  reactCache.set(guildId, { at: Date.now(), users });
  return users;
}

/** Chat hook: auto-react for members who own it (with a cooldown so it isn't on every message). */
async function handleShopMessage(message, config) {
  if (!message.guild || message.author.bot || config?.shopEnabled === false) return;
  const users = await reactUsers(message.guild.id);
  const r = users.get(message.author.id);
  if (!r) return;
  const key = `${message.guild.id}:${message.author.id}`;
  if (Date.now() - (lastReact.get(key) || 0) < r.cooldownMs) return;
  lastReact.set(key, Date.now());
  await message.react(r.emoji).catch(() => null);
}

/** XP multiplier from an active XP boost (1 when none). Used by chat XP. */
async function boostMultiplier(guildId, userId, now = Date.now()) {
  const key = `${guildId}:${userId}`;
  const hit = boostCache.get(key);
  if (hit && now - hit.at < CACHE_MS) return hit.until > now ? hit.mult : 1;
  const owned = await ShopOwnership.findOne({ guildId, userId, type: 'xpBoost', active: true, expiresAt: { $gt: new Date(now) } }).sort({ expiresAt: -1 }).lean();
  let mult = 1;
  let until = 0;
  if (owned) {
    const item = await ShopItem.findOne({ _id: owned.itemId }).lean().catch(() => null);
    mult = Math.min(Math.max(Number(item?.config?.multiplier) || 1.5, 1), 5);
    until = new Date(owned.expiresAt).getTime();
  }
  boostCache.set(key, { at: now, mult, until });
  return until > now ? mult : 1;
}

// ---------------------------------------------------------------- Buying

/**
 * Buys an item for a member. Checks stock, limits and level, takes the XP atomically (refunded if the
 * item can't be delivered), then applies it. Returns { ok, message } or { error }.
 */
async function buy(guild, member, itemId, { free = false, by = null, nickname = null } = {}) {
  const config = await leveling.getOrCreateConfig(guild.id);
  if (config.shopEnabled === false) return { error: 'The shop is closed right now.' };
  if (config.levelingEnabled === false && !free) return { error: 'Leveling is turned off, so XP can’t be spent right now.' };
  const item = await ShopItem.findOne({ _id: itemId, guildId: guild.id }).lean().catch(() => null);
  if (!item || (!item.enabled && !free)) return { error: 'That item isn’t in the shop.' }; // staff can still gift hidden items
  if (soldOut(item)) return { error: `**${item.name}** is sold out.` };
  const record = await UserLevel.findOne({ guildId: guild.id, userId: member.id }).lean();
  if (!free && (record?.level || 0) < (item.minLevel || 0)) return { error: `You need to be **Level ${item.minLevel}** to buy **${item.name}** (you're Level ${record?.level || 0}).` };
  if (!free && (record?.xp || 0) < item.price) return { error: `**${item.name}** costs **${fmt(item.price)} XP** — you have **${fmt(record?.xp || 0)}**.` };
  const owned = await ShopOwnership.findOne({ guildId: guild.id, userId: member.id, itemId: String(item._id) }).lean();
  if (owned && item.maxPerUser && owned.quantity >= item.maxPerUser) {
    return { error: TYPES[item.type]?.toggle ? `You already own **${item.name}** — switch it with \`/shop toggle\`.` : `You already own **${item.name}**.` };
  }

  // Type checks before any XP moves.
  if (item.type === 'role' && !botCanGiveRole(guild, item.config?.roleId)) return { error: "This role can't be handed out right now — ask staff to check the bot's role position." };
  if (item.type === 'nickTag' && !canNick(member)) return { error: "LoofaryBot can't change your nickname (it needs Manage Nicknames and a role above yours), so this item wouldn't work for you." };
  if (item.type === 'nickname') {
    if (!canNick(member)) return { error: "LoofaryBot can't change your nickname (it needs Manage Nicknames and a role above yours), so this item wouldn't work for you." };
    if (!cleanNickname(nickname)) return { error: 'Tell me the nickname you want — for example `/shop buy item:Nickname name:CoolName`.' };
  }
  if (item.type === 'extraGambles') {
    const { getGamblingSettings } = require('./gambling');
    const g = getGamblingSettings(config);
    if (!g.enabled) return { error: 'Gambling is turned off in this server.' };
    if (!g.dailyLimit) return { error: 'There’s no daily gamble limit here, so you don’t need extra plays!' };
  }

  // Reserve stock, then take the XP. Either failing undoes the other.
  if (item.stock !== null && item.stock !== undefined) {
    const reserved = await ShopItem.findOneAndUpdate({ _id: item._id, $expr: { $lt: ['$sold', '$stock'] } }, { $inc: { sold: 1 } });
    if (!reserved) return { error: `**${item.name}** just sold out.` };
  } else {
    await ShopItem.updateOne({ _id: item._id }, { $inc: { sold: 1 } });
  }
  const { levelXpBase } = leveling.getEffectiveXpSettings(config);
  const price = free ? 0 : item.price;
  const paid = free || (await leveling.debitXp(guild.id, member.id, item.price, levelXpBase));
  if (!paid) {
    await ShopItem.updateOne({ _id: item._id }, { $inc: { sold: -1 } });
    return { error: `You don't have **${fmt(item.price)} XP** any more.` };
  }
  const refund = async (why) => {
    if (price) await leveling.adjustXp(guild, member.id, price, config).catch(() => null);
    await ShopItem.updateOne({ _id: item._id }, { $inc: { sold: -1 } });
    return { error: price ? `${why} Your **${fmt(price)} XP** was refunded.` : why };
  };

  const now = Date.now();
  const itemKey = { guildId: guild.id, userId: member.id, itemId: String(item._id) };
  let message;
  try {
    if (item.type === 'xpBoost') {
      const hours = Math.max(1, item.config?.durationHours || 24);
      const from = owned?.expiresAt && new Date(owned.expiresAt).getTime() > now ? new Date(owned.expiresAt).getTime() : now;
      const until = new Date(from + hours * 3600000);
      await ShopOwnership.updateOne(itemKey, { $set: { type: item.type, active: true, expiresAt: until }, $inc: { quantity: 1, spent: price } }, { upsert: true });
      boostCache.delete(`${guild.id}:${member.id}`);
      message = `⚡ **${item.name}** active — **×${item.config?.multiplier || 1.5} chat XP** until <t:${Math.floor(until.getTime() / 1000)}:f>.`;
    } else if (item.type === 'extraGambles') {
      const plays = Math.max(1, item.config?.plays || 3);
      const day = new Date().toISOString().slice(0, 10);
      await UserLevel.updateOne({ guildId: guild.id, userId: member.id }, [
        { $set: { gamblesToday: { $subtract: [{ $cond: [{ $eq: ['$gambleDay', day] }, { $ifNull: ['$gamblesToday', 0] }, 0] }, plays] }, gambleDay: day } }
      ]);
      await ShopOwnership.updateOne(itemKey, { $set: { type: item.type, active: false }, $inc: { quantity: 1, spent: price } }, { upsert: true });
      message = `🎲 **+${plays} gambles** added for today — go get 'em!`;
    } else if (item.type === 'role') {
      const hours = item.config?.durationHours || 0;
      const expiresAt = hours ? new Date(now + hours * 3600000) : null;
      const applied = await applyRole(member, item, true).catch((err) => ({ error: err.message }));
      if (applied.error) return refund(applied.error);
      await ShopOwnership.updateOne(itemKey, { $set: { type: item.type, active: true, expiresAt }, $inc: { quantity: 1, spent: price } }, { upsert: true });
      message = `🎭 You got <@&${item.config.roleId}>${expiresAt ? ` until <t:${Math.floor(expiresAt.getTime() / 1000)}:f>` : ''}! Hide or show it with \`/shop toggle\`.`;
    } else if (item.type === 'nickname') {
      const nick = cleanNickname(nickname);
      try {
        await member.setNickname(nick, 'XP shop: nickname change');
      } catch (err) {
        return refund(`Discord wouldn't let me set that nickname (${err.message}).`);
      }
      await ShopOwnership.updateOne(itemKey, { $set: { type: item.type, active: false }, $inc: { quantity: 1, spent: price } }, { upsert: true });
      message = `📝 Your nickname is now **${nick.replace(/([*_`~|\\])/g, '\\$1')}**.`;
    } else {
      const defaults = {
        autoReact: { emoji: item.config?.reactEmoji || item.emoji },
        nickTag: { emoji: item.config?.reactEmoji || item.emoji },
        badge: { emoji: item.emoji, text: item.config?.defaultText || 'Supporter', color: '#EB459E' }
      }[item.type];
      const set = { type: item.type, active: true };
      if (defaults && !owned) for (const [k, v] of Object.entries(defaults)) set[`custom.${k}`] = v;
      await ShopOwnership.updateOne(itemKey, { $set: set, $inc: { quantity: 1, spent: price } }, { upsert: true });
      if (item.type === 'nickTag') {
        const fresh = await ShopOwnership.findOne(itemKey).lean();
        const done = await applyNickTag(member, fresh, true).catch((err) => ({ error: err.message }));
        if (done.error) {
          await ShopOwnership.deleteOne(itemKey);
          return refund(done.error);
        }
      }
      forget(guild.id, member.id);
      message = {
        autoReact: `✨ **Auto-react** is on — I'll react with ${defaults?.emoji} now and then. Change it with \`/shop customize\`.`,
        nickTag: `🏷️ Your nickname tag is on. Pick your emoji with \`/shop customize\`.`,
        badge: `🎖️ Badge unlocked! Make it yours with \`/shop customize\` — title, emoji and color.`,
        collectible: `${item.emoji} **${item.name}** is yours! It shows on your \`/levels rank\` card.`
      }[item.type];
    }
  } catch (err) {
    return refund(`Something went wrong (${err.message}).`);
  }

  sendLog(
    guild,
    'shop',
    new EmbedBuilder()
      .setColor(COLOR)
      .setAuthor({ name: `${member.user.tag ?? member.user.username} (${member.id})`, iconURL: member.user.displayAvatarURL?.({ size: 64 }) || undefined })
      .setDescription(free ? `🎁 Was given ${item.emoji} **${item.name}**${by ? ` by ${by}` : ''}` : `🛍️ Bought ${item.emoji} **${item.name}** for **${fmt(price)} XP**`),
    {
      entry: {
        userId: member.id,
        userTag: member.user.tag ?? member.user.username,
        userAvatar: member.user.displayAvatarURL?.({ size: 64 }) || '',
        summary: free ? `was given ${item.name}${by ? ` by ${by}` : ''}` : `bought ${item.name} for ${fmt(price)} XP`,
        details: { itemId: String(item._id), price, type: item.type, gift: free }
      }
    }
  ).catch(() => null);
  const left = await UserLevel.findOne({ guildId: guild.id, userId: member.id }, { xp: 1, level: 1 }).lean();
  return { ok: true, item, message: free ? message : `${message}\n-# Paid ${fmt(price)} XP · you have ${fmt(left?.xp || 0)} XP left (level ${left?.level ?? 0}).` };
}

// ---------------------------------------------------------------- Owned items

async function inventory(guildId, userId) {
  const owned = await ShopOwnership.find({ guildId, userId }).lean();
  const items = new Map((await ShopItem.find({ guildId }).lean()).map((i) => [String(i._id), i]));
  return owned.map((o) => ({ ...o, item: items.get(String(o.itemId)) || null })).filter((o) => o.item);
}

/** Switches an owned toggleable item on or off (flips it when `on` is undefined). */
async function toggle(guild, member, itemId, on) {
  const owned = await ShopOwnership.findOne({ guildId: guild.id, userId: member.id, itemId: String(itemId) }).lean();
  const item = owned && (await ShopItem.findOne({ _id: owned.itemId }).lean().catch(() => null));
  if (!owned || !item) return { error: "You don't own that." };
  if (!TYPES[item.type]?.toggle) return { error: `**${item.name}** can't be switched on or off.` };
  if (owned.expiresAt && new Date(owned.expiresAt) <= new Date()) return { error: `**${item.name}** has expired.` };
  const next = on === undefined ? !owned.active : !!on;
  try {
    if (item.type === 'nickTag') {
      const done = await applyNickTag(member, owned, next);
      if (done.error) return done;
    }
    if (item.type === 'role') {
      const done = await applyRole(member, item, next);
      if (done.error) return done;
    }
  } catch (err) {
    return { error: err.message };
  }
  await ShopOwnership.updateOne({ _id: owned._id }, { $set: { active: next } });
  forget(guild.id, member.id);
  return { ok: true, item, active: next };
}

/** Changes the member's own touches (emoji, badge text, color). */
async function customize(guild, member, itemId, { emoji, text, color } = {}) {
  const owned = await ShopOwnership.findOne({ guildId: guild.id, userId: member.id, itemId: String(itemId) }).lean();
  const item = owned && (await ShopItem.findOne({ _id: owned.itemId }).lean().catch(() => null));
  if (!owned || !item) return { error: "You don't own that." };
  const allowed = TYPES[item.type]?.custom || [];
  if (!allowed.length) return { error: `**${item.name}** has nothing to customise.` };
  const set = {};
  if (emoji !== undefined && emoji !== null) {
    if (!allowed.includes('emoji')) return { error: `**${item.name}** doesn't use an emoji.` };
    const e = cleanEmoji(guild, emoji);
    if (!e) return { error: 'Use one emoji — a normal one, or a custom emoji from this server.' };
    set['custom.emoji'] = e;
  }
  if (text !== undefined && text !== null) {
    if (!allowed.includes('text')) return { error: `**${item.name}** doesn't have a title.` };
    const t = cleanText(text, 24);
    if (!t) return { error: 'Pick a title (up to 24 characters, no links or mentions).' };
    set['custom.text'] = t;
  }
  if (color !== undefined && color !== null) {
    if (!allowed.includes('color')) return { error: `**${item.name}** doesn't have a color.` };
    const c = cleanColor(color);
    if (!c) return { error: 'Use a hex color like #FF73FA.' };
    set['custom.color'] = c;
  }
  if (!Object.keys(set).length) return { error: `Tell me what to change: ${allowed.join(', ')}.` };
  // Nickname tags: swap the old emoji for the new one right away.
  if (item.type === 'nickTag' && owned.active && set['custom.emoji'] && canNick(member)) {
    const base = stripTag(member.nickname || member.user.globalName || member.user.username, owned.custom?.emoji);
    await member.setNickname(`${set['custom.emoji']}${TAG_SEP}${base}`.slice(0, 32), 'XP shop: nickname tag').catch(() => null);
  }
  await ShopOwnership.updateOne({ _id: owned._id }, { $set: set });
  forget(guild.id, member.id);
  const fresh = await ShopOwnership.findOne({ _id: owned._id }).lean();
  return { ok: true, item, custom: fresh.custom };
}

/** Staff: takes an item away from a member (switching its effect off first). No refund. */
async function removeOwned(guild, ownershipId) {
  const owned = await ShopOwnership.findOne({ _id: ownershipId, guildId: guild.id }).lean().catch(() => null);
  if (!owned) return { error: 'Not found.' };
  const item = await ShopItem.findOne({ _id: owned.itemId }).lean().catch(() => null);
  const member = await guild.members.fetch(owned.userId).catch(() => null);
  if (member && item && owned.active) {
    if (item.type === 'nickTag') await applyNickTag(member, owned, false).catch(() => null);
    if (item.type === 'role') await applyRole(member, item, false).catch(() => null);
  }
  await ShopOwnership.deleteOne({ _id: owned._id });
  forget(guild.id, owned.userId);
  return { ok: true, item };
}

/** Badge + collectibles for /levels rank and the leaderboard. */
async function flair(guildId, userIds) {
  const ids = Array.isArray(userIds) ? userIds : [userIds];
  const owned = await ShopOwnership.find({ guildId, userId: { $in: ids }, $or: [{ type: 'badge', active: true }, { type: 'collectible' }] }).lean();
  const items = new Map((await ShopItem.find({ guildId, type: { $in: ['badge', 'collectible'] } }).lean()).map((i) => [String(i._id), i]));
  const out = new Map();
  for (const o of owned) {
    const item = items.get(String(o.itemId));
    if (!item) continue;
    const f = out.get(o.userId) || { badge: null, collectibles: [] };
    if (o.type === 'badge') f.badge = { emoji: o.custom?.emoji || item.emoji, text: o.custom?.text || 'Supporter', color: o.custom?.color || null };
    else f.collectibles.push({ emoji: item.emoji, name: item.name, quantity: o.quantity });
    out.set(o.userId, f);
  }
  return out;
}

// Ends expired XP boosts and takes back temporary roles.
async function sweepExpired(client, now = new Date()) {
  const due = await ShopOwnership.find({ active: true, expiresAt: { $ne: null, $lte: now } }).limit(100).lean();
  for (const o of due) {
    if (o.type === 'role') {
      const guild = client.guilds.cache.get(o.guildId);
      const item = await ShopItem.findOne({ _id: o.itemId }).lean().catch(() => null);
      const member = guild && (await guild.members.fetch(o.userId).catch(() => null));
      if (member && item?.config?.roleId && member.roles.cache.has(item.config.roleId)) await member.roles.remove(item.config.roleId, 'XP shop: role expired').catch(() => null);
      // A timed role is used up once it runs out, so it can be bought again.
      await ShopOwnership.deleteOne({ _id: o._id });
    } else {
      await ShopOwnership.updateOne({ _id: o._id }, { $set: { active: false } });
    }
    boostCache.delete(`${o.guildId}:${o.userId}`);
  }
  return due.length;
}

function startShop(client) {
  setInterval(() => sweepExpired(client).catch((err) => console.error('Shop sweep failed:', err.message)), 60 * 1000);
}

// ---------------------------------------------------------------- Staff (dashboard)

/** Validates an item from the dashboard editor. Returns { item } or { error }. */
function cleanItem(guild, b) {
  const type = String(b.type || '');
  if (!TYPES[type]) return { error: 'Pick what kind of item this is.' };
  const name = String(b.name || '').trim().slice(0, 60);
  if (!name) return { error: 'Give the item a name.' };
  const price = Number.parseInt(b.price, 10);
  if (!(price >= 0 && price <= 10_000_000)) return { error: 'Price must be 0–10,000,000 XP.' };
  const emoji = cleanEmoji(guild, b.emoji) || '🛍️';
  const int = (v, min, max, label, dflt = null) => {
    if (v === '' || v === null || v === undefined) return dflt;
    const n = Number.parseInt(v, 10);
    if (!(n >= min && n <= max)) throw new Error(`${label} must be ${min}–${max}.`);
    return n;
  };
  try {
    const item = {
      type,
      name,
      price,
      emoji,
      description: String(b.description || '').trim().slice(0, 300),
      enabled: b.enabled !== false,
      stock: int(b.stock, 0, 1_000_000, 'Stock'),
      maxPerUser: int(b.maxPerUser, 0, 1000, 'Limit per member', ['xpBoost', 'extraGambles', 'nickname'].includes(type) ? 0 : 1),
      minLevel: int(b.minLevel, 0, 1000, 'Minimum level', 0),
      config: {}
    };
    const c = b.config || {};
    if (type === 'role') {
      const roleId = String(c.roleId || '');
      const role = guild.roles.cache.get(roleId);
      if (!role) return { error: 'Pick the role this item gives.' };
      if (role.managed) return { error: 'That role is managed by Discord or an integration — pick a normal role.' };
      if (role.permissions.has(PermissionFlagsBits.Administrator) || role.permissions.has(PermissionFlagsBits.ManageGuild)) return { error: "For safety, roles with Administrator or Manage Server can't be sold." };
      item.config.roleId = roleId;
      item.config.durationHours = int(c.durationHours, 0, 8760, 'Duration (hours)', 0);
    }
    if (type === 'xpBoost') {
      const m = Number(c.multiplier);
      if (!(m >= 1.1 && m <= 5)) return { error: 'The XP multiplier must be between 1.1 and 5.' };
      item.config.multiplier = Math.round(m * 100) / 100;
      item.config.durationHours = int(c.durationHours, 1, 720, 'Duration (hours)', 24);
    }
    if (type === 'extraGambles') item.config.plays = int(c.plays, 1, 50, 'Plays', 3);
    if (type === 'autoReact') {
      item.config.reactEmoji = cleanEmoji(guild, c.reactEmoji) || '🔥';
      item.config.cooldownSeconds = int(c.cooldownSeconds, 5, 3600, 'Cooldown (seconds)', 45);
    }
    if (type === 'nickTag') item.config.reactEmoji = cleanEmoji(guild, c.reactEmoji) || '⭐';
    if (type === 'badge') item.config.defaultText = cleanText(c.defaultText, 24) || 'Supporter';
    return { item };
  } catch (err) {
    return { error: err.message };
  }
}

async function shopStats(guildId) {
  const [owners, spent] = await Promise.all([
    ShopOwnership.aggregate([{ $match: { guildId } }, { $group: { _id: '$itemId', owners: { $sum: 1 }, active: { $sum: { $cond: ['$active', 1, 0] } }, spent: { $sum: '$spent' } } }]).catch(() => []),
    ShopOwnership.aggregate([{ $match: { guildId } }, { $group: { _id: null, spent: { $sum: '$spent' }, buyers: { $addToSet: '$userId' } } }]).catch(() => [])
  ]);
  return {
    perItem: Object.fromEntries(owners.map((o) => [String(o._id), { owners: o.owners, active: o.active, spent: o.spent }])),
    totalSpent: spent[0]?.spent || 0,
    buyers: spent[0]?.buyers?.length || 0
  };
}

// ---------------------------------------------------------------- Discord UI (select menu + confirm)

function shopMenu(items, userId) {
  const buyable = items.filter((i) => !soldOut(i)).slice(0, 25);
  if (!buyable.length) return [];
  return [
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`shop:pick:${userId}`)
        .setPlaceholder('🛍️ Pick something to buy…')
        .addOptions(buyable.map((i) => ({ label: `${i.name} — ${fmt(i.price)} XP`.slice(0, 100), description: (i.description || TYPES[i.type].help).slice(0, 100), value: String(i._id), emoji: CUSTOM_EMOJI_RE.test(i.emoji) ? undefined : i.emoji })))
    )
  ];
}

async function shopEmbed(guild, userId) {
  const items = await listItems(guild.id);
  const owned = new Map((await ShopOwnership.find({ guildId: guild.id, userId }).lean()).map((o) => [String(o.itemId), o]));
  const record = await UserLevel.findOne({ guildId: guild.id, userId }, { xp: 1, level: 1 }).lean();
  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle(`🛍️ ${guild.name} XP Shop`)
    .setDescription(items.length ? items.map((i) => itemLine(i, owned.get(String(i._id)))).join('\n\n').slice(0, 4000) : 'The shop is empty right now.')
    .setFooter({ text: `You have ${fmt(record?.xp || 0)} XP (level ${record?.level || 0}) · spending XP can lower your level, but earned role rewards are kept` });
  return { embed, items };
}

/** Handles the shop's select menu and buttons (customId shop:…). */
async function handleShopInteraction(interaction) {
  const [, action, a, b] = interaction.customId.split(':');
  if (action === 'pick') {
    if (a !== interaction.user.id) return interaction.reply({ content: 'Open your own shop with `/shop view`.', ephemeral: true });
    const item = await ShopItem.findOne({ _id: interaction.values[0], guildId: interaction.guildId }).lean().catch(() => null);
    if (!item) return interaction.reply({ content: '❌ That item is gone.', ephemeral: true });
    // Nickname needs a name, so pop a box to type it in rather than a plain confirm button.
    if (item.type === 'nickname') {
      return interaction.showModal(
        new ModalBuilder()
          .setCustomId(`shop:nickmodal:${item._id}:${interaction.user.id}`)
          .setTitle(`${item.name} — ${fmt(item.price)} XP`.slice(0, 45))
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId('name').setLabel('Your new nickname').setStyle(TextInputStyle.Short).setMinLength(1).setMaxLength(32).setRequired(true)
            )
          )
      );
    }
    return interaction.reply({
      content: `${item.emoji} **${item.name}** for **${fmt(item.price)} XP**?\n${item.description || TYPES[item.type].help}`,
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`shop:buy:${item._id}:${interaction.user.id}`).setLabel(`Buy for ${fmt(item.price)} XP`).setStyle(ButtonStyle.Success).setEmoji('🛒'),
          new ButtonBuilder().setCustomId(`shop:cancel:${interaction.user.id}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary)
        )
      ],
      ephemeral: true
    });
  }
  if (action === 'nickmodal') {
    if (b !== interaction.user.id) return interaction.reply({ content: "That's not your purchase.", ephemeral: true });
    const res = await buy(interaction.guild, interaction.member, a, { nickname: interaction.fields.getTextInputValue('name') });
    return interaction.reply({ content: res.error ? `❌ ${res.error}` : res.message, ephemeral: true });
  }
  if (action === 'cancel') return interaction.update({ content: 'No worries — nothing was bought.', components: [] });
  if (action === 'buy') {
    if (b !== interaction.user.id) return interaction.reply({ content: "That's not your purchase.", ephemeral: true });
    const res = await buy(interaction.guild, interaction.member, a);
    return interaction.update({ content: res.error ? `❌ ${res.error}` : res.message, components: [] });
  }
  return interaction.reply({ content: '❌ Unknown shop action.', ephemeral: true });
}

module.exports = {
  TYPES,
  DEFAULT_ITEMS,
  ensureDefaults,
  restoreDefaults,
  listItems,
  soldOut,
  itemLine,
  cleanEmoji,
  cleanText,
  cleanColor,
  buy,
  inventory,
  removeOwned,
  toggle,
  customize,
  flair,
  handleShopMessage,
  boostMultiplier,
  sweepExpired,
  startShop,
  cleanItem,
  shopStats,
  shopMenu,
  shopEmbed,
  handleShopInteraction,
  _caches: { reactCache, boostCache, lastReact }
};
