// /idle — the Bubble Factory idle game (no gambling). Make bubbles over time, buy upgrades, cash out
// to XP. The main view uses buttons (see idleGame.handleIdleInteraction).
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const idle = require('../cogs/modules/idleGame');
const { getOrCreateConfig } = require('../cogs/modules/leveling');

const data = new SlashCommandBuilder()
  .setName('idle')
  .setDescription('The Bubble Factory — a chill idle game: make bubbles, upgrade, cash out to XP')
  .setDMPermission(false)
  .addSubcommand((s) => s.setName('play').setDescription('Open your Bubble Factory'))
  .addSubcommand((s) => s.setName('top').setDescription('The biggest factories in the server'))
  .addSubcommand((s) => s.setName('help').setDescription('How the Bubble Factory works'));

const fmt = (n) => Number(n).toLocaleString('en-US');

async function execute(interaction) {
  const sub = interaction.options.getSubcommand();
  const guild = interaction.guild;
  const s = idle.idleSettings(await getOrCreateConfig(guild.id));
  const reply = (content) => interaction.reply({ content, ephemeral: true, allowedMentions: { parse: [] } });

  if (!s.enabled) return reply('🫧 The Bubble Factory is off in this server. An admin can turn it on with the dashboard or `/idle` settings.');

  if (sub === 'help') {
    const embed = new EmbedBuilder()
      .setColor('#4AB3F4')
      .setTitle('🫧 How the Bubble Factory works')
      .setDescription(
        'A relaxing idle game — no gambling, no risk.\n\n' +
          '• Your factory makes **🫧 Bubbles** over time, even while you’re away ' +
          `(up to **${s.offlineHours}h** of storage, more with the 🛁 Bigger Tub upgrade).\n` +
          '• **Collect** your bubbles, then spend them on **upgrades** that make even more.\n' +
          `• **Cash out** bubbles into real **XP** at **${fmt(s.bubblesPerXp)} 🫧 = 1 XP**` +
          (s.dailyXpCap > 0 ? `, up to **${fmt(s.dailyXpCap)} XP a day** (resets at midnight UTC).` : '.') +
          '\n\nOpen it with `/idle play`.'
      );
    return interaction.reply({ embeds: [embed], ephemeral: true });
  }

  if (sub === 'top') {
    const rows = await idle.leaderboard(guild, { limit: 10 });
    const medal = (i) => ['🥇', '🥈', '🥉'][i] || `**${i + 1}.**`;
    const embed = new EmbedBuilder()
      .setColor('#4AB3F4')
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
