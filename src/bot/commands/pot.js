// /pot — the Daily XP Pot: see today's pot, and (staff) set it up, style it, or start the draw now.
const { SlashCommandBuilder, PermissionFlagsBits, ChannelType, EmbedBuilder } = require('discord.js');
const pot = require('../cogs/modules/xpPot');
const { dashboardUrl } = require('../cogs/modules/help');

const data = new SlashCommandBuilder()
  .setName('pot')
  .setDescription('The Daily XP Pot — gambling losses, shared out to people who chatted in the last hour')
  .setDMPermission(false)
  .addSubcommand((s) => s.setName('view').setDescription("Today's pot, the top contributors and when it's drawn"))
  .addSubcommand((s) => s.setName('history').setDescription('Recent winners'))
  .addSubcommand((s) =>
    s
      .setName('setup')
      .setDescription('(Staff) Where and when the pot is drawn — turns it on')
      .addChannelOption((o) => o.setName('channel').setDescription('Where the pot is posted').setRequired(true).addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
      .addIntegerOption((o) => o.setName('draw_hour').setDescription('Hour of the draw in UTC (0 = midnight, the end of the day)').setMinValue(0).setMaxValue(23))
      .addIntegerOption((o) => o.setName('countdown').setDescription('Minutes of live countdown before the draw (default 10)').setMinValue(1).setMaxValue(60))
      .addIntegerOption((o) => o.setName('messages').setDescription('Messages in the last hour to be entered (default 3)').setMinValue(1).setMaxValue(50))
      .addIntegerOption((o) => o.setName('min_pot').setDescription('Smaller pots roll over to tomorrow (default 100)').setMinValue(0).setMaxValue(1000000))
      .addIntegerOption((o) => o.setName('top_prize').setDescription('Most XP 1st place can win (default 3,000); the rest goes to 2nd, 3rd…').setMinValue(10).setMaxValue(1000000))
      .addIntegerOption((o) => o.setName('winners').setDescription('Most winners per draw (default 10); anything left rolls over').setMinValue(1).setMaxValue(25))
      .addIntegerOption((o) => o.setName('pot_cap').setDescription('Most XP the pot holds (default 10,000); when full, it is drawn right away').setMinValue(100).setMaxValue(1000000))
      .addIntegerOption((o) => o.setName('share').setDescription('% of each gambling loss that goes into the pot (default 100)').setMinValue(1).setMaxValue(100))
      .addRoleOption((o) => o.setName('ping').setDescription('Role to ping when the countdown starts'))
  )
  .addSubcommand((s) =>
    s
      .setName('look')
      .setDescription('(Staff) Change how the pot embed looks')
      .addStringOption((o) => o.setName('title').setDescription('Embed title').setMaxLength(256))
      .addStringOption((o) => o.setName('description').setDescription('Text — {pot} {draw} {min} {window} work; "default" restores the built-in text').setMaxLength(3000))
      .addStringOption((o) => o.setName('color').setDescription('Hex color, like #F1C40F').setMaxLength(7))
      .addStringOption((o) => o.setName('image').setDescription('Banner image link (or "none")').setMaxLength(500))
      .addStringOption((o) => o.setName('thumbnail').setDescription('Small image link (or "none")').setMaxLength(500))
      .addStringOption((o) => o.setName('footer').setDescription('Footer text').setMaxLength(200))
      .addStringOption((o) => o.setName('win_message').setDescription('Winner message — {winners} {winner} {count} {pot} {prize} {rollover} {entrants}; "default" resets').setMaxLength(1500))
  )
  .addSubcommand((s) =>
    s.setName('toggle').setDescription('(Staff) Turn the Daily XP Pot on or off').addBooleanOption((o) => o.setName('enabled').setDescription('On or off').setRequired(true))
  )
  .addSubcommand((s) => s.setName('draw').setDescription("(Staff) Post today's pot now and draw it after the countdown (e.g. to test it)"))
  .addSubcommand((s) => s.setName('preview').setDescription('(Staff) See how the pot embed looks, just for you'));

const fmt = (n) => Number(n).toLocaleString('en-US');
const MEDALS = ['🥇', '🥈', '🥉'];
// "🥇 <@a> 3,000 · 🥈 <@b> 2,100 · +2 more (7,000 XP, 12 entered)" — older pots only have one winner.
function winnersLine(p) {
  const winners = p.winners?.length ? p.winners : [{ userId: p.winnerId, amount: p.won }];
  const shown = winners.slice(0, 3).map((w, i) => `${MEDALS[i]} <@${w.userId}> ${fmt(w.amount)}`).join(' · ');
  const more = winners.length > 3 ? ` · +${winners.length - 3} more` : '';
  return `${shown}${more} (**${fmt(p.won)} XP**, ${fmt(p.entrants)} entered)`;
}
const isStaff = (i) => i.memberPermissions?.has(PermissionFlagsBits.ManageGuild);

async function execute(interaction) {
  const sub = interaction.options.getSubcommand();
  const guild = interaction.guild;
  const o = interaction.options;
  const reply = (content) => interaction.reply({ content, ephemeral: true, allowedMentions: { parse: [] } });

  if (sub === 'view') {
    const cur = await pot.currentPot(guild);
    if (!cur.settings.enabled) return reply('💰 The Daily XP Pot is off in this server.');
    const embed = pot.buildEmbed(cur.pot, cur.settings, { entrants: cur.entrants, drawAt: cur.drawAt });
    return interaction.reply({ embeds: [embed], ephemeral: true, allowedMentions: { parse: [] } });
  }

  if (sub === 'history') {
    const past = await pot.recentPots(guild.id, 7);
    const embed = new EmbedBuilder()
      .setColor('#F1C40F')
      .setTitle('💰 Recent Daily XP Pots')
      .setDescription(
        past.length
          ? past.map((p) => `**${p.day}** · ${p.status === 'done' ? winnersLine(p) : `🔁 ${fmt(p.amount)} XP rolled over`}`).join('\n')
          : 'No pots have been drawn yet.'
      );
    return interaction.reply({ embeds: [embed], ephemeral: true, allowedMentions: { parse: [] } });
  }

  if (!isStaff(interaction)) return reply('❌ You need **Manage Server** for that.');

  if (sub === 'setup') {
    const input = { enabled: true, channelId: o.getChannel('channel').id };
    for (const [opt, key] of [['draw_hour', 'drawHour'], ['countdown', 'countdownMinutes'], ['messages', 'minMessages'], ['min_pot', 'minPot'], ['share', 'sharePercent'], ['top_prize', 'maxPrize'], ['winners', 'maxWinners'], ['pot_cap', 'maxPot']]) {
      if (o.getInteger(opt) !== null) input[key] = o.getInteger(opt);
    }
    if (o.getRole('ping')) input.pingRoleId = o.getRole('ping').id;
    const saved = await pot.saveSettings(guild, input);
    if (saved.error) return reply(`❌ ${saved.error}`);
    const s = saved.settings;
    const next = pot.nextDrawAt(Date.now(), s.drawHour);
    return reply(
      `✅ **Daily XP Pot is on** in <#${s.channelId}>.\n` +
        `🎲 ${s.sharePercent}% of every gambling loss goes in · 📣 posted ${s.countdownMinutes} min before the draw · 🏆 drawn at **${String(s.drawHour).padStart(2, '0')}:00 UTC** (next: <t:${Math.floor(next.getTime() / 1000)}:R>)\n` +
        `💬 Entered: ${s.minMessages}+ messages in the last ${s.windowMinutes} min · pots under ${fmt(s.minPot)} XP roll over.\n` +
        `🏆 Up to ${s.maxWinners} winner(s): 1st gets up to **${fmt(s.maxPrize)} XP**, each place after gets less (e.g. ${pot.describeLadder(s.maxPrize * 3, s.maxWinners, s).prizes.slice(0, 4).map(fmt).join(' → ')}…). The rest rolls over.\n` +
        `🔥 The pot holds at most **${fmt(s.maxPot)} XP**; when it's full, it's drawn right away (${s.countdownMinutes} min countdown), whatever the time.\n` +
        `-# Style it with \`/pot look\` or on the dashboard: ${dashboardUrl(guild.id)}`
    );
  }

  if (sub === 'look') {
    const e = {};
    const clear = (v) => (v && v.toLowerCase() === 'none' ? '' : v);
    if (o.getString('title') !== null) e.title = o.getString('title');
    if (o.getString('description') !== null) e.description = o.getString('description').toLowerCase() === 'default' ? '' : o.getString('description').replace(/\\n/g, '\n');
    if (o.getString('color') !== null) e.color = o.getString('color').startsWith('#') ? o.getString('color') : `#${o.getString('color')}`;
    if (o.getString('image') !== null) e.imageUrl = clear(o.getString('image'));
    if (o.getString('thumbnail') !== null) e.thumbnailUrl = clear(o.getString('thumbnail'));
    if (o.getString('footer') !== null) e.footer = o.getString('footer');
    const input = { embed: e };
    if (o.getString('win_message') !== null) input.winMessage = o.getString('win_message').toLowerCase() === 'default' ? '' : o.getString('win_message').replace(/\\n/g, '\n');
    const saved = await pot.saveSettings(guild, input);
    if (saved.error) return reply(`❌ ${saved.error}`);
    const cur = await pot.currentPot(guild);
    return interaction.reply({ content: '✅ Saved — here’s how it looks:', embeds: [pot.buildEmbed(cur.pot, saved.settings, { entrants: cur.entrants, drawAt: cur.drawAt })], ephemeral: true, allowedMentions: { parse: [] } });
  }

  if (sub === 'toggle') {
    const saved = await pot.saveSettings(guild, { enabled: o.getBoolean('enabled') });
    if (saved.error) return reply(`❌ ${saved.error} Use \`/pot setup\`.`);
    return reply(saved.settings.enabled ? '✅ The Daily XP Pot is **on**.' : '⏸️ The Daily XP Pot is **off** (the XP collected so far stays in the pot).');
  }

  if (sub === 'draw') {
    const res = await pot.startNow(guild);
    if (res.error) return reply(`❌ ${res.error}`);
    return reply(`💰 Posted! It will be drawn <t:${Math.floor(res.drawAt.getTime() / 1000)}:R> — gambling losses keep adding to it until then.`);
  }

  if (sub === 'preview') {
    const cur = await pot.currentPot(guild);
    return interaction.reply({ embeds: [pot.buildEmbed(cur.pot, cur.settings, { entrants: cur.entrants, drawAt: cur.drawAt })], ephemeral: true, allowedMentions: { parse: [] } });
  }
}

module.exports = { data, execute };
