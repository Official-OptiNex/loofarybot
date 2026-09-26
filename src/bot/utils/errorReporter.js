const { EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const GuildConfig = require('../../database/models/GuildConfig');

// Optional bot-wide channel (any server the bot is in) that receives every error, including
// crashes that aren't tied to a server. Per-server alerts go to that server's alerts channel.
const GLOBAL_CHANNEL_ID = process.env.ERROR_ALERT_CHANNEL_ID || null;
const DEDUPE_MS = 10 * 60 * 1000;

let clientRef = null;
const recent = new Map(); // key -> { at, count }

function setClient(client) {
  clientRef = client;
}

async function sendTo(channelId, embed) {
  if (!clientRef || !channelId) return;
  const channel = clientRef.channels.cache.get(channelId) || (await clientRef.channels.fetch(channelId).catch(() => null));
  if (!channel || !channel.isTextBased()) return;
  const me = channel.guild?.members.me;
  if (me && !channel.permissionsFor(me)?.has([PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) return;
  await channel.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch(() => null);
}

// Same problem repeating within 10 minutes is sent once, with a repeat count on the next alert.
function shouldSend(key) {
  const now = Date.now();
  const prev = recent.get(key);
  if (prev && now - prev.at < DEDUPE_MS) {
    prev.count += 1;
    return null;
  }
  const repeats = prev ? prev.count : 0;
  recent.set(key, { at: now, count: 0 });
  if (recent.size > 500) recent.delete(recent.keys().next().value);
  return { repeats };
}

async function guildAlertChannel(guildId) {
  if (!guildId) return null;
  const config = await GuildConfig.findOne({ guildId }, { alertsChannelId: 1 }).lean().catch(() => null);
  return config?.alertsChannelId || null;
}

/**
 * Something broke (an exception). Logged, then sent to the server's alerts channel (short form)
 * and the global channel (with stack trace).
 */
async function reportError(err, { guildId = null, context = 'Unexpected error' } = {}) {
  const message = err?.message || String(err);
  console.error(`[${context}]${guildId ? ` guild=${guildId}` : ''}`, err);
  const gate = shouldSend(`err:${guildId}:${context}:${message}`);
  if (!gate) return;
  try {
    const guild = guildId ? clientRef?.guilds.cache.get(guildId) : null;
    const base = () =>
      new EmbedBuilder()
        .setColor('#ED4245')
        .setTitle(`⚠️ ${context}`.slice(0, 256))
        .setDescription(`\`\`\`${message.slice(0, 1500)}\`\`\``)
        .setTimestamp();
    const repeatNote = gate.repeats ? { text: `Repeated ${gate.repeats} more time(s) in the last 10 minutes` } : null;

    const guildChannel = await guildAlertChannel(guildId);
    if (guildChannel) {
      const embed = base();
      if (repeatNote) embed.setFooter(repeatNote);
      await sendTo(guildChannel, embed);
    }
    if (GLOBAL_CHANNEL_ID) {
      const embed = base();
      if (guild) embed.addFields({ name: 'Server', value: `${guild.name} (${guild.id})` });
      if (err?.stack) embed.addFields({ name: 'Stack', value: `\`\`\`${err.stack.split('\n').slice(1, 6).join('\n').slice(0, 1000)}\`\`\`` });
      if (repeatNote) embed.setFooter(repeatNote);
      await sendTo(GLOBAL_CHANNEL_ID, embed);
    }
  } catch (e) {
    console.error('Error reporter failed:', e.message);
  }
}

/**
 * A setup problem admins can fix (missing permission, role too high, deleted channel…).
 * Sent to the server's alerts channel only.
 */
async function reportIssue(guildId, title, description) {
  console.warn(`[issue] guild=${guildId} ${title}: ${description}`);
  const gate = shouldSend(`issue:${guildId}:${title}:${description}`);
  if (!gate) return;
  const channelId = await guildAlertChannel(guildId);
  if (!channelId) return;
  const embed = new EmbedBuilder()
    .setColor('#FEE75C')
    .setTitle(`🛠️ ${title}`.slice(0, 256))
    .setDescription(description.slice(0, 4000))
    .setTimestamp();
  if (gate.repeats) embed.setFooter({ text: `Repeated ${gate.repeats} more time(s) in the last 10 minutes` });
  await sendTo(channelId, embed);
}

function registerProcessHandlers(client) {
  setClient(client);
  process.on('unhandledRejection', (reason) => reportError(reason instanceof Error ? reason : new Error(String(reason)), { context: 'Unhandled promise rejection' }));
  process.on('uncaughtException', (err) => {
    reportError(err, { context: 'Crash (uncaught exception)' }).finally(() => setTimeout(() => process.exit(1), 2000));
  });
  client.on('error', (err) => reportError(err, { context: 'Discord client error' }));
}

module.exports = { setClient, reportError, reportIssue, registerProcessHandlers };
