// /warn /timeout /untimeout /kick /ban /unban /slowmode — thin wrappers over modCases.performAction.
const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const { performAction, TYPES } = require('../cogs/modules/modCases');
const { parseDuration, formatDuration } = require('../utils/duration');
const { durationChoices } = require('../utils/autocomplete');

const reasonOption = (opt, required = false) => opt.setName('reason').setDescription('Why (shown to the member and in the case log)').setMaxLength(500).setRequired(required);

async function run(interaction, type, extra = {}) {
  await interaction.deferReply({ ephemeral: true });
  const user = interaction.options.getUser('user');
  const result = await performAction(interaction.guild, {
    type,
    userId: user.id,
    moderator: interaction.user,
    moderatorMember: interaction.member,
    reason: interaction.options.getString('reason') || '',
    ...extra
  });
  if (result.error) return interaction.editReply(`❌ ${result.error}`);
  const c = result.case;
  const t = TYPES[type];
  let text = `${t.emoji} **${c.userTag}** was ${t.past}${c.durationMs ? ` for **${formatDuration(c.durationMs)}**` : ''} · case **#${c.caseId}**`;
  if (c.reason) text += `\n**Reason:** ${c.reason}`;
  if (['warn', 'timeout', 'kick', 'ban'].includes(type)) text += result.dmSent ? '\n-# 📬 They were sent a DM.' : '\n-# 📭 Couldn\'t DM them (DMs closed or turned off).';
  if (result.escalated) {
    const e = result.escalated;
    text += e.error
      ? `\n⚠️ Escalation (${e.rule.count} warnings → ${e.rule.action}) failed: ${e.error}`
      : `\n🔺 That's warning **${e.rule.count}** — they were automatically ${TYPES[e.rule.action].past}${e.case.durationMs ? ` for ${formatDuration(e.case.durationMs)}` : ''} (case #${e.case.caseId}).`;
  }
  return interaction.editReply({ content: text, allowedMentions: { parse: [] } });
}

const commands = [
  {
    data: new SlashCommandBuilder()
      .setName('warn')
      .setDescription('Warn a member (recorded as a case; can trigger automatic escalation)')
      .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
      .addUserOption((o) => o.setName('user').setDescription('Member to warn').setRequired(true))
      .addStringOption((o) => reasonOption(o, true)),
    execute: (i) => run(i, 'warn')
  },
  {
    data: new SlashCommandBuilder()
      .setName('timeout')
      .setDescription('Time a member out (they can’t talk or react) for up to 28 days')
      .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
      .addUserOption((o) => o.setName('user').setDescription('Member to time out').setRequired(true))
      .addStringOption((o) => o.setName('duration').setDescription('How long, e.g. 10m, 2h, 1d (max 28d)').setRequired(true).setAutocomplete(true))
      .addStringOption((o) => reasonOption(o)),
    execute: (i) => {
      const ms = parseDuration(i.options.getString('duration'));
      if (!ms) return i.reply({ content: '❌ Invalid duration — use e.g. `10m`, `2h`, `1d`.', ephemeral: true });
      return run(i, 'timeout', { durationMs: ms });
    },
    autocomplete: (i) => i.respond(durationChoices(i.options.getFocused()))
  },
  {
    data: new SlashCommandBuilder()
      .setName('untimeout')
      .setDescription("Remove a member's timeout")
      .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
      .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true))
      .addStringOption((o) => reasonOption(o)),
    execute: (i) => run(i, 'untimeout')
  },
  {
    data: new SlashCommandBuilder()
      .setName('kick')
      .setDescription('Kick a member from the server')
      .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers)
      .addUserOption((o) => o.setName('user').setDescription('Member to kick').setRequired(true))
      .addStringOption((o) => reasonOption(o)),
    execute: (i) => run(i, 'kick')
  },
  {
    data: new SlashCommandBuilder()
      .setName('ban')
      .setDescription('Ban a member (or anyone, by user ID) — optionally only for a while')
      .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
      .addUserOption((o) => o.setName('user').setDescription('Member or user ID to ban').setRequired(true))
      .addStringOption((o) => reasonOption(o))
      .addStringOption((o) => o.setName('duration').setDescription('Temporary ban, e.g. 1d, 7d (leave empty for permanent)').setAutocomplete(true))
      .addStringOption((o) =>
        o
          .setName('delete_messages')
          .setDescription('Also delete their recent messages')
          .addChoices(
            { name: "Don't delete any", value: '0' },
            { name: 'Last hour', value: '3600' },
            { name: 'Last 24 hours', value: '86400' },
            { name: 'Last 7 days', value: '604800' }
          )
      ),
    execute: (i) => {
      const raw = i.options.getString('duration');
      const ms = raw ? parseDuration(raw) : null;
      if (raw && !ms) return i.reply({ content: '❌ Invalid duration — use e.g. `1d`, `7d`, or leave it empty for a permanent ban.', ephemeral: true });
      return run(i, 'ban', { durationMs: ms, deleteMessageSeconds: Number(i.options.getString('delete_messages') || 0) });
    },
    autocomplete: (i) => i.respond(durationChoices(i.options.getFocused()))
  },
  {
    data: new SlashCommandBuilder()
      .setName('unban')
      .setDescription('Unban a user (paste their user ID)')
      .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
      .addUserOption((o) => o.setName('user').setDescription('User or user ID').setRequired(true))
      .addStringOption((o) => reasonOption(o)),
    execute: (i) => run(i, 'unban')
  },
  {
    data: new SlashCommandBuilder()
      .setName('slowmode')
      .setDescription('Set how often members can send messages in a channel')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
      .addStringOption((o) =>
        o.setName('interval').setDescription('e.g. 5s, 30s, 1m, 2h — or "off"').setRequired(true).setAutocomplete(true)
      )
      .addChannelOption((o) =>
        o.setName('channel').setDescription('Channel (defaults to this one)').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum)
      ),
    execute: async (i) => {
      const raw = i.options.getString('interval').trim().toLowerCase();
      const channel = i.options.getChannel('channel') || i.channel;
      const seconds = ['off', '0', 'none'].includes(raw) ? 0 : Math.round((parseDuration(raw) || -1000) / 1000);
      if (seconds < 0 || seconds > 21600) return i.reply({ content: '❌ Use something like `5s`, `1m`, `2h` (max 6h), or `off`.', ephemeral: true });
      try {
        await channel.setRateLimitPerUser(seconds, `Slowmode set by ${i.user.tag}`);
      } catch (err) {
        return i.reply({ content: `❌ Couldn't change slowmode in ${channel} — LoofaryBot needs Manage Channels there. (${err.message})`, ephemeral: true });
      }
      return i.reply({ content: seconds ? `🐢 Slowmode in ${channel}: one message every **${formatDuration(seconds * 1000)}**.` : `⚡ Slowmode is off in ${channel}.`, ephemeral: true });
    },
    autocomplete: (i) => {
      const typed = i.options.getFocused();
      const picks = ['off', '5s', '10s', '30s', '1m', '5m', '15m', '1h'];
      return i.respond((typed ? [typed, ...picks.filter((p) => p !== typed)] : picks).slice(0, 25).map((p) => ({ name: p, value: p })));
    }
  }
];

module.exports = { commands };
