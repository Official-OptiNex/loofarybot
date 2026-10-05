// /serverstats — view-only "stats channels" at the top of the server (Members, Online, Boosts, …).
const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const stats = require('../cogs/modules/serverStats');

const statChoices = stats.STAT_DEFS.map((d) => ({ name: `${d.emoji} ${d.label}`, value: d.key }));

const data = new SlashCommandBuilder()
  .setName('serverstats')
  .setDescription('Live server-stat channels at the top of the server (members, online, boosts, top XP…)')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setDMPermission(false)
  .addSubcommand((s) => s.setName('setup').setDescription('Turn it on and create the stat channels'))
  .addSubcommand((s) => s.setName('refresh').setDescription('Update the stat channels right now'))
  .addSubcommand((s) => s.setName('remove').setDescription('Delete the stat channels and turn it off'))
  .addSubcommand((s) =>
    s
      .setName('stat')
      .setDescription('Show or hide one stat channel')
      .addStringOption((o) => o.setName('name').setDescription('Which stat').setRequired(true).addChoices(...statChoices))
      .addBooleanOption((o) => o.setName('show').setDescription('Show it (on) or hide it (off)').setRequired(true))
  )
  .addSubcommand((s) => s.setName('status').setDescription('Which stats are shown'));

async function execute(interaction) {
  const sub = interaction.options.getSubcommand();
  const guild = interaction.guild;
  const reply = (content) => interaction.editReply({ content });

  if (sub === 'status') {
    const s = stats.serverStatsSettings(await require('../cogs/modules/leveling').getOrCreateConfig(guild.id));
    const list = stats.STAT_DEFS.map((d) => `${s.enabledStats.includes(d.key) ? '✅' : '▫️'} ${d.emoji} ${d.label}`).join('\n');
    const embed = new EmbedBuilder()
      .setColor(s.enabled ? 0x57f287 : 0x4e5058)
      .setTitle(`📊 Server Stats — ${s.enabled ? 'on' : 'off'}`)
      .setDescription(list)
      .setFooter({ text: s.enabled ? 'Channels refresh every ~30 minutes.' : 'Turn it on with /serverstats setup.' });
    return interaction.reply({ embeds: [embed], ephemeral: true });
  }

  await interaction.deferReply({ ephemeral: true });

  if (sub === 'setup') {
    await stats.saveSettings(guild, { enabled: true });
    const res = await stats.syncChannels(interaction.client, guild);
    if (res.error) return reply(`❌ ${res.error}`);
    return reply(`✅ Server Stats is on — created **${res.created}** channel(s) at the top of the server. They refresh every ~30 minutes. Use \`/serverstats stat\` to pick which ones show.`);
  }

  if (sub === 'refresh') {
    const res = await stats.syncChannels(interaction.client, guild);
    if (res.error) return reply(`❌ ${res.error} Run \`/serverstats setup\` first.`);
    return reply(`🔄 Updated the stat channels (${res.renamed} refreshed, ${res.created} created, ${res.removed} removed).`);
  }

  if (sub === 'remove') {
    await stats.removeAll(guild);
    await stats.saveSettings(guild, { enabled: false });
    return reply('🧹 Removed the stat channels and turned Server Stats off.');
  }

  // stat — toggle one on/off
  const key = interaction.options.getString('name');
  const show = interaction.options.getBoolean('show');
  const current = stats.serverStatsSettings(await require('../cogs/modules/leveling').getOrCreateConfig(guild.id));
  const set = new Set(current.enabledStats);
  if (show) set.add(key);
  else set.delete(key);
  const saved = await stats.saveSettings(guild, { enabledStats: [...set] });
  if (saved.settings.enabled) await stats.syncChannels(interaction.client, guild).catch(() => null);
  const def = stats.STAT_DEFS.find((d) => d.key === key);
  return reply(`${show ? '✅ Showing' : '▫️ Hid'} **${def.emoji} ${def.label}**.${saved.settings.enabled ? '' : ' (Turn Server Stats on with `/serverstats setup`.)'}`);
}

module.exports = { data, execute };
