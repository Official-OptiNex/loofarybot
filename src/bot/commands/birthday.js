// /birthday — members save their birthday; staff pick where (and how) birthdays are celebrated.
const { SlashCommandBuilder, PermissionFlagsBits, ChannelType, EmbedBuilder } = require('discord.js');
const birthdays = require('../cogs/modules/birthdays');
const { getOrCreateConfig } = require('../cogs/modules/leveling');
const { dashboardUrl } = require('../cogs/modules/help');

const data = new SlashCommandBuilder()
  .setName('birthday')
  .setDescription('Save your birthday and get celebrated on the day 🎂')
  .setDMPermission(false)
  .addSubcommand((s) =>
    s
      .setName('set')
      .setDescription('Save your birthday (month and day — no year needed)')
      .addIntegerOption((o) =>
        o
          .setName('month')
          .setDescription('Month')
          .setRequired(true)
          .addChoices(...birthdays.MONTHS.map((name, i) => ({ name, value: i + 1 })))
      )
      .addIntegerOption((o) => o.setName('day').setDescription('Day of the month').setRequired(true).setMinValue(1).setMaxValue(31))
  )
  .addSubcommand((s) => s.setName('remove').setDescription('Forget your birthday'))
  .addSubcommand((s) =>
    s.setName('view').setDescription("See someone's birthday").addUserOption((o) => o.setName('user').setDescription('Defaults to you'))
  )
  .addSubcommand((s) => s.setName('upcoming').setDescription('Birthdays coming up next'))
  .addSubcommand((s) =>
    s
      .setName('setup')
      .setDescription('(Staff) Where and how birthdays are celebrated — turns them on')
      .addChannelOption((o) =>
        o.setName('channel').setDescription('Where birthday wishes are posted').setRequired(true).addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
      )
      .addRoleOption((o) => o.setName('role').setDescription('A role members get for their birthday (removed the next day)'))
      .addIntegerOption((o) => o.setName('xp_gift').setDescription('XP gift on their birthday (0 = none)').setMinValue(0).setMaxValue(100000))
      .addIntegerOption((o) => o.setName('hour').setDescription('Hour to post, in UTC (0–23, default 14)').setMinValue(0).setMaxValue(23))
      .addStringOption((o) => o.setName('message').setDescription('Use {users} for the birthday people, {server} for the server').setMaxLength(1500))
  )
  .addSubcommand((s) =>
    s
      .setName('toggle')
      .setDescription('(Staff) Turn birthday posts on or off')
      .addBooleanOption((o) => o.setName('enabled').setDescription('On or off').setRequired(true))
  );

const isStaff = (interaction) => interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
const when = (days) => (days === 0 ? '**today!** 🎉' : days === 1 ? 'tomorrow' : `in ${days} days`);

async function execute(interaction) {
  const sub = interaction.options.getSubcommand();
  const guild = interaction.guild;
  const o = interaction.options;

  if (sub === 'set') {
    const res = await birthdays.setBirthday(guild.id, interaction.user.id, o.getInteger('month'), o.getInteger('day'));
    if (res.error) return interaction.reply({ content: `❌ ${res.error}`, ephemeral: true });
    const s = birthdays.birthdaySettings(await getOrCreateConfig(guild.id));
    const note = s.enabled ? '' : '\n-# Birthday posts are turned off in this server right now, but your date is saved.';
    return interaction.reply({ content: `🎂 Saved: **${birthdays.formatDate(res.month, res.day)}** — ${when(res.daysUntil)}.${note}`, ephemeral: true });
  }

  if (sub === 'remove') {
    const removed = await birthdays.removeBirthday(guild.id, interaction.user.id);
    return interaction.reply({ content: removed ? '🗑️ Your birthday was removed.' : "You hadn't saved a birthday here.", ephemeral: true });
  }

  if (sub === 'view') {
    const user = o.getUser('user') || interaction.user;
    const list = await birthdays.upcoming(guild.id, { limit: 1000 });
    const b = list.find((x) => x.userId === user.id);
    if (!b) return interaction.reply({ content: user.id === interaction.user.id ? 'You haven\'t saved a birthday yet — use `/birthday set`.' : `${user} hasn't saved a birthday.`, ephemeral: true, allowedMentions: { parse: [] } });
    return interaction.reply({ content: `🎂 ${user}'s birthday is **${birthdays.formatDate(b.month, b.day)}** — ${when(b.daysUntil)}.`, ephemeral: true, allowedMentions: { parse: [] } });
  }

  if (sub === 'upcoming') {
    const list = await birthdays.upcoming(guild.id, { limit: 10, guild });
    const embed = new EmbedBuilder()
      .setColor('#FF73FA')
      .setTitle('🎂 Upcoming birthdays')
      .setDescription(list.length ? list.map((b) => `**${birthdays.formatDate(b.month, b.day)}** · <@${b.userId}> — ${when(b.daysUntil)}`).join('\n') : 'Nobody has saved a birthday yet. Add yours with `/birthday set`!');
    return interaction.reply({ embeds: [embed], allowedMentions: { parse: [] } });
  }

  if (!isStaff(interaction)) return interaction.reply({ content: '❌ You need **Manage Server** for that.', ephemeral: true });

  if (sub === 'setup') {
    const input = { enabled: true, channelId: o.getChannel('channel').id };
    if (o.getRole('role')) input.roleId = o.getRole('role').id;
    if (o.getInteger('xp_gift') !== null) input.xpGift = o.getInteger('xp_gift');
    if (o.getInteger('hour') !== null) input.announceHour = o.getInteger('hour');
    if (o.getString('message') !== null) input.message = o.getString('message');
    const saved = await birthdays.saveSettings(guild, input);
    if (saved.error) return interaction.reply({ content: `❌ ${saved.error}`, ephemeral: true });
    const s = saved.settings;
    const missing = birthdays.missingPermissions(guild, s);
    return interaction.reply({
      content:
        `✅ **Birthdays are on** — wishes go to <#${s.channelId}> every day at **${String(s.announceHour).padStart(2, '0')}:00 UTC**.` +
        (s.roleId ? `\n🎈 Birthday role: <@&${s.roleId}> (for 24 hours)` : '') +
        (s.xpGift ? `\n🎁 XP gift: **${s.xpGift.toLocaleString('en-US')} XP**` : '') +
        (missing.length ? `\n⚠️ LoofaryBot needs: ${missing.join(', ')}` : '') +
        `\n-# Members add theirs with \`/birthday set\`. Dashboard: ${dashboardUrl(guild.id)}`,
      ephemeral: true,
      allowedMentions: { parse: [] }
    });
  }

  if (sub === 'toggle') {
    const saved = await birthdays.saveSettings(guild, { enabled: o.getBoolean('enabled') });
    if (saved.error) return interaction.reply({ content: `❌ ${saved.error} Use \`/birthday setup\`.`, ephemeral: true });
    return interaction.reply({ content: saved.settings.enabled ? '✅ Birthday posts are **on**.' : '⏸️ Birthday posts are **off**.', ephemeral: true });
  }
}

module.exports = { data, execute };
