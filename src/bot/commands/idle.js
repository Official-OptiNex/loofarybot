// /idle — the Bubble Factory idle game (no gambling). Make bubbles over time, buy upgrades, cash out
// to XP. The main view uses buttons (see idleGame.handleIdleInteraction). Staff get an `admin` group
// to toggle it and grant/remove bubbles.
const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const idle = require('../cogs/modules/idleGame');
const { getOrCreateConfig } = require('../cogs/modules/leveling');

const data = new SlashCommandBuilder()
  .setName('idle')
  .setDescription('The Bubble Factory — a chill idle game: make bubbles, upgrade, cash out to XP')
  .setDMPermission(false)
  .addSubcommand((s) => s.setName('play').setDescription('Open your Bubble Factory'))
  .addSubcommand((s) => s.setName('top').setDescription('The biggest factories in the server'))
  .addSubcommand((s) => s.setName('help').setDescription('How the Bubble Factory works'))
  .addSubcommandGroup((g) =>
    g
      .setName('admin')
      .setDescription('Staff: manage the Bubble Factory')
      .addSubcommand((s) =>
        s
          .setName('toggle')
          .setDescription('Turn the Bubble Factory on or off for this server')
          .addBooleanOption((o) => o.setName('enabled').setDescription('On or off').setRequired(true))
      )
      .addSubcommand((s) =>
        s
          .setName('give')
          .setDescription('Reward a member with bubbles (straight into their bank)')
          .addUserOption((o) => o.setName('user').setDescription('Who to reward').setRequired(true))
          .addIntegerOption((o) => o.setName('amount').setDescription('How many 🫧 to give').setRequired(true).setMinValue(1).setMaxValue(10000000))
      )
      .addSubcommand((s) =>
        s
          .setName('take')
          .setDescription("Remove bubbles from a member's bank")
          .addUserOption((o) => o.setName('user').setDescription('Who to take from').setRequired(true))
          .addIntegerOption((o) => o.setName('amount').setDescription('How many 🫧 to remove').setRequired(true).setMinValue(1).setMaxValue(10000000))
      )
      .addSubcommand((s) =>
        s
          .setName('reset')
          .setDescription("Wipe a member's factory back to a fresh start")
          .addUserOption((o) => o.setName('user').setDescription('Whose factory to reset').setRequired(true))
      )
  );

const fmt = (n) => Number(n).toLocaleString('en-US');

async function runAdmin(interaction, sub) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    return interaction.reply({ content: '❌ That needs the **Manage Server** permission.', ephemeral: true });
  }
  const guild = interaction.guild;

  if (sub === 'toggle') {
    const enabled = interaction.options.getBoolean('enabled');
    const res = await idle.saveSettings(guild, { enabled });
    if (res.error) return interaction.reply({ content: `❌ ${res.error}`, ephemeral: true });
    return interaction.reply({ content: `🫧 Bubble Factory is now **${enabled ? 'ON' : 'OFF'}** for this server.`, ephemeral: true });
  }

  const target = interaction.options.getUser('user');
  if (sub === 'reset') {
    await idle.resetFactory(guild.id, target.id);
    return interaction.reply({ content: `🧹 Reset **${target.username}**'s factory back to a fresh start.`, ephemeral: true, allowedMentions: { parse: [] } });
  }

  const amount = interaction.options.getInteger('amount');
  const delta = sub === 'take' ? -amount : amount;
  const { state, applied } = await idle.adminAdjustBubbles(guild.id, target.id, delta);
  if (sub === 'give') {
    return interaction.reply({
      content: `🎁 Gave **${fmt(applied)} 🫧** to **${target.username}** — their bank is now **${fmt(state.bank)} 🫧**.`,
      ephemeral: true,
      allowedMentions: { parse: [] }
    });
  }
  return interaction.reply({
    content: `➖ Removed **${fmt(-applied)} 🫧** from **${target.username}** — their bank is now **${fmt(state.bank)} 🫧**.`,
    ephemeral: true,
    allowedMentions: { parse: [] }
  });
}

async function execute(interaction) {
  const group = interaction.options.getSubcommandGroup(false);
  const sub = interaction.options.getSubcommand();
  const guild = interaction.guild;

  if (group === 'admin') return runAdmin(interaction, sub);

  const s = idle.idleSettings(await getOrCreateConfig(guild.id));
  const reply = (content) => interaction.reply({ content, ephemeral: true, allowedMentions: { parse: [] } });

  if (sub === 'help') {
    const tree = idle.UPGRADES.map((u) => `${u.emoji} **${u.name}** — ${u.blurb}${u.max ? ` _(max Lv ${u.max})_` : ''}`).join('\n');
    const embed = new EmbedBuilder()
      .setColor(0x4ab3f4)
      .setTitle('🫧 How the Bubble Factory works')
      .setDescription(
        'A relaxing idle game — **no gambling, no risk.** Your factory bubbles away on its own; you just pop in to collect and upgrade.'
      )
      .addFields(
        {
          name: '1️⃣ Make bubbles',
          value: `Your factory makes **🫧 Bubbles** over time, even while you're away — up to **${s.offlineHours}h** of storage (more with 🛁 Bigger Tub).`
        },
        { name: '2️⃣ Collect', value: 'Open `/idle play` and press **🫧 Collect** to bank the bubbles waiting for you. Nothing is spendable until you collect it.' },
        { name: '3️⃣ Upgrade', value: `Spend banked bubbles on upgrades that make even more:\n${tree}` },
        {
          name: '4️⃣ Cash out → XP',
          value:
            s.dailyXpCap > 0
              ? `Turn bubbles into real **XP** at **${fmt(s.bubblesPerXp)} 🫧 = 1 XP**, up to **${fmt(s.dailyXpCap)} XP a day** (resets at midnight UTC).`
              : 'Cash-out is currently **off** here — bubbles are just for show and upgrades.'
        }
      )
      .setFooter({ text: s.enabled ? 'Open it with /idle play' : 'An admin needs to turn it on with /idle admin toggle' });
    return interaction.reply({ embeds: [embed], ephemeral: true });
  }

  if (!s.enabled) return reply('🫧 The Bubble Factory is off in this server. An admin can turn it on with `/idle admin toggle` or the dashboard.');

  if (sub === 'top') {
    const rows = await idle.leaderboard(guild, { limit: 10 });
    const medal = (i) => ['🥇', '🥈', '🥉'][i] || `**${i + 1}.**`;
    const embed = new EmbedBuilder()
      .setColor(0x4ab3f4)
      .setTitle('🏭 Biggest Bubble Factories')
      .setDescription(
        rows.length
          ? rows.map((r, i) => `${medal(i)} ${r.name ? r.name : `<@${r.userId}>`} — **${fmt(r.lifetime)} 🫧** lifetime · ${fmt(r.rate)}/hr`).join('\n')
          : 'Nobody has started a factory yet. Be the first with `/idle play`!'
      );
    return interaction.reply({ embeds: [embed], ephemeral: true, allowedMentions: { parse: [] } });
  }

  // play — show the factory with its pending bubbles waiting; the Collect button banks them.
  const state = await idle.getFactory(guild.id, interaction.user.id);
  const name = interaction.member?.displayName || interaction.user.username;
  return interaction.reply({ embeds: [idle.factoryEmbed(state, s, { name })], components: [idle.rowFor(interaction.user.id, s)], ephemeral: true });
}

module.exports = { data, execute };
