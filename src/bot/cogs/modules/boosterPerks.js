// Server booster perks: extra daily gambles, extra giveaway entries, an automatic daily XP drop and a
// one-time thank-you XP package when someone boosts. Everything is configurable per server
// (/perks config or the dashboard's Leveling → Booster perks tab).
const { EmbedBuilder } = require('discord.js');
const GuildConfig = require('../../../database/models/GuildConfig');
const UserLevel = require('../../../database/models/UserLevel');
const { getOrCreateConfig, adjustXp } = require('./leveling');
const { reportIssue } = require('../../utils/errorReporter');

const PACKAGE_COOLDOWN_MS = 30 * 24 * 3600 * 1000; // unboosting and reboosting can't farm the package
const utcDay = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
const fmtNum = (n) => Number(n).toLocaleString('en-US');

function boosterSettings(config) {
  const b = (config && config.boosterPerks) || {};
  return {
    enabled: b.enabled !== false,
    extraGambles: Math.max(0, b.extraGambles ?? 5),
    giveawayEntries: Math.max(0, b.giveawayEntries ?? 2),
    dailyXp: Math.max(0, b.dailyXp ?? 100),
    boostXp: Math.max(0, b.boostXp ?? 500),
    channelId: b.channelId ?? null
  };
}

const isBooster = (member) => !!member?.premiumSince;

// The perks a member gets right now (all zero for non-boosters or when perks are off).
function perksFor(config, member) {
  const s = boosterSettings(config);
  if (!s.enabled || !isBooster(member)) return { extraGambles: 0, giveawayEntries: 0 };
  return { extraGambles: s.extraGambles, giveawayEntries: s.giveawayEntries };
}

function describePerks(s) {
  if (!s.enabled) return 'Booster perks are **off**.';
  const lines = [
    s.extraGambles ? `🎲 **+${s.extraGambles}** gambles a day` : null,
    s.giveawayEntries ? `🎁 **+${s.giveawayEntries}** entries in every giveaway` : null,
    s.dailyXp ? `📦 **${fmtNum(s.dailyXp)} XP** automatically every day` : null,
    s.boostXp ? `💝 **${fmtNum(s.boostXp)} XP** thank-you package when you boost` : null
  ].filter(Boolean);
  return lines.length ? lines.join('\n') : 'Booster perks are on, but every perk is set to 0.';
}

async function announce(guild, s, embed) {
  if (!s.channelId) return;
  const channel = guild.channels.cache.get(s.channelId);
  if (!channel?.isTextBased()) return;
  await channel.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch((err) =>
    reportIssue(guild.id, 'Booster perks message failed', `Couldn't post in <#${s.channelId}>: ${err.message}. Give LoofaryBot Send Messages and Embed Links there.`)
  );
}

// ---------------------------------------------------------------- Daily XP drop

/**
 * Gives every booster the daily XP drop, once per UTC day per server. The day is claimed with an
 * atomic update first, so two copies of the bot (during a redeploy) can't both pay it out.
 */
async function runDailyDrop(guild, { force = false } = {}) {
  const config = await getOrCreateConfig(guild.id);
  const s = boosterSettings(config);
  if (!s.enabled || !s.dailyXp || config.levelingEnabled === false) return { skipped: true };
  const today = utcDay();
  if (!force) {
    const claimed = await GuildConfig.updateOne({ guildId: guild.id, boosterDropDay: { $ne: today } }, { $set: { boosterDropDay: today } });
    if (claimed.modifiedCount !== 1) return { skipped: true };
  }

  await guild.members.fetch().catch(() => null);
  const boosters = [...guild.members.cache.filter((m) => isBooster(m) && !m.user.bot).values()];
  const leveled = [];
  for (const member of boosters) {
    const result = await adjustXp(guild, member.id, s.dailyXp, config).catch(() => null);
    if (result && result.newLevel > result.oldLevel) leveled.push(`${member} → Level ${result.newLevel}`);
  }
  if (boosters.length) {
    const names = boosters.slice(0, 40).map((m) => `${m}`).join(' ');
    await announce(
      guild,
      s,
      new EmbedBuilder()
        .setColor('#F47FFF')
        .setTitle('📦 Daily booster drop')
        .setDescription(
          `**${boosters.length}** booster${boosters.length === 1 ? '' : 's'} got **${fmtNum(s.dailyXp)} XP** each — thank you for boosting! 💎\n${names}${boosters.length > 40 ? ` +${boosters.length - 40} more` : ''}` +
            (leveled.length ? `\n\n🎉 ${leveled.slice(0, 15).join(' · ')}` : '')
        )
    );
  }
  return { count: boosters.length, amount: s.dailyXp, leveled: leveled.length };
}

async function runAllDrops(client) {
  for (const guild of client.guilds.cache.values()) {
    await runDailyDrop(guild).catch((err) => console.error(`Booster drop failed in ${guild.id}:`, err.message));
  }
}

function startBoosterDrops(client) {
  // Checked every 15 minutes, so the drop lands shortly after midnight UTC (or right after a restart).
  setTimeout(() => runAllDrops(client), 20 * 1000);
  setInterval(() => runAllDrops(client), 15 * 60 * 1000);
}

// ---------------------------------------------------------------- Thank-you package

async function grantBoostPackage(member, config = null) {
  config = config || (await getOrCreateConfig(member.guild.id));
  const s = boosterSettings(config);
  if (!s.enabled || !s.boostXp || config.levelingEnabled === false) return null;
  const cutoff = new Date(Date.now() - PACKAGE_COOLDOWN_MS);
  await UserLevel.updateOne({ guildId: member.guild.id, userId: member.id }, { $setOnInsert: { xp: 0, level: 0 } }, { upsert: true }).catch(() => null);
  const claimed = await UserLevel.updateOne(
    { guildId: member.guild.id, userId: member.id, $or: [{ boostPackageAt: null }, { boostPackageAt: { $lte: cutoff } }] },
    { $set: { boostPackageAt: new Date() } }
  );
  if (claimed.modifiedCount !== 1) return null;
  const result = await adjustXp(member.guild, member.id, s.boostXp, config);
  const embed = new EmbedBuilder()
    .setColor('#F47FFF')
    .setTitle('💝 Thanks for boosting!')
    .setDescription(
      `${member} just boosted **${member.guild.name}** and got a **${fmtNum(s.boostXp)} XP** thank-you package!` +
        (result && result.newLevel > result.oldLevel ? `\n🎉 That's **Level ${result.newLevel}**!` : '') +
        `\n\n**Booster perks**\n${describePerks(s)}`
    );
  await announce(member.guild, s, embed);
  await member
    .send({ content: `💝 Thanks for boosting **${member.guild.name}**! You got **${fmtNum(s.boostXp)} XP**.\n\n**Your booster perks**\n${describePerks(s)}` })
    .catch(() => null);
  return { amount: s.boostXp, level: result?.newLevel };
}

function registerBoostListener(client) {
  client.on('guildMemberUpdate', async (oldMember, newMember) => {
    // A partial old member has no premiumSince, which would look like a fresh boost — skip those.
    if (oldMember.partial || oldMember.premiumSince || !newMember.premiumSince || newMember.user?.bot) return;
    await grantBoostPackage(newMember).catch((err) => console.error('Boost package failed:', err.message));
  });
}

module.exports = {
  boosterSettings,
  isBooster,
  perksFor,
  describePerks,
  runDailyDrop,
  runAllDrops,
  startBoosterDrops,
  grantBoostPackage,
  registerBoostListener,
  PACKAGE_COOLDOWN_MS
};
