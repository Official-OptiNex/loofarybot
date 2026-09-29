// /shop — spend XP on fun extras, switch them on and off, and make them yours.
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const shop = require('../cogs/modules/shop');

const itemOption = (desc) => (o) => o.setName('item').setDescription(desc).setRequired(true).setAutocomplete(true);

const data = new SlashCommandBuilder()
  .setName('shop')
  .setDescription('Spend XP on fun extras 🛍️')
  .setDMPermission(false)
  .addSubcommand((s) => s.setName('view').setDescription('Browse the shop and buy something'))
  .addSubcommand((s) => s.setName('buy').setDescription('Buy an item').addStringOption(itemOption('What to buy')))
  .addSubcommand((s) => s.setName('inventory').setDescription('What you own').addUserOption((o) => o.setName('user').setDescription("Someone else's (defaults to you)")))
  .addSubcommand((s) =>
    s
      .setName('toggle')
      .setDescription('Switch an item you own on or off')
      .addStringOption(itemOption('Which item'))
      .addBooleanOption((o) => o.setName('on').setDescription('On or off (leave empty to flip it)'))
  )
  .addSubcommand((s) =>
    s
      .setName('customize')
      .setDescription('Make an item yours — emoji, badge title, color')
      .addStringOption(itemOption('Which item'))
      .addStringOption((o) => o.setName('emoji').setDescription('An emoji (normal, or one of this server’s)').setMaxLength(64))
      .addStringOption((o) => o.setName('title').setDescription('Badge title (up to 24 characters)').setMaxLength(24))
      .addStringOption((o) => o.setName('color').setDescription('Badge color, like #FF73FA').setMaxLength(7))
  );

const fmt = (n) => Number(n).toLocaleString('en-US');

async function autocomplete(interaction) {
  const sub = interaction.options.getSubcommand();
  const q = String(interaction.options.getFocused() || '').toLowerCase();
  let choices;
  if (sub === 'buy') {
    const items = await shop.listItems(interaction.guildId).catch(() => []);
    choices = items.filter((i) => !shop.soldOut(i)).map((i) => ({ name: `${i.name} — ${fmt(i.price)} XP`, value: String(i._id) }));
  } else {
    const owned = await shop.inventory(interaction.guildId, interaction.user.id).catch(() => []);
    choices = owned
      .filter((o) => (sub === 'toggle' ? shop.TYPES[o.item.type]?.toggle : shop.TYPES[o.item.type]?.custom.length))
      .map((o) => ({ name: `${o.item.name}${shop.TYPES[o.item.type]?.toggle ? (o.active ? ' (on)' : ' (off)') : ''}`, value: String(o.item._id) }));
  }
  return interaction.respond(choices.filter((c) => c.name.toLowerCase().includes(q)).slice(0, 25).map((c) => ({ name: c.name.slice(0, 100), value: c.value })));
}

async function execute(interaction) {
  const sub = interaction.options.getSubcommand();
  const guild = interaction.guild;
  const o = interaction.options;
  const reply = (content) => interaction.reply({ content, ephemeral: true, allowedMentions: { parse: [] } });
  const config = await require('../cogs/modules/leveling').getOrCreateConfig(guild.id);
  if (config.shopEnabled === false) return reply('🛍️ The shop is closed right now.');

  if (sub === 'view') {
    const { embed, items } = await shop.shopEmbed(guild, interaction.user.id);
    return interaction.reply({ embeds: [embed], components: shop.shopMenu(items, interaction.user.id), ephemeral: true });
  }

  if (sub === 'buy') {
    const res = await shop.buy(guild, interaction.member, o.getString('item'));
    return reply(res.error ? `❌ ${res.error}` : res.message);
  }

  if (sub === 'inventory') {
    const user = o.getUser('user') || interaction.user;
    const owned = await shop.inventory(guild.id, user.id);
    const now = Date.now();
    const lines = owned.map((x) => {
      const t = shop.TYPES[x.item.type];
      const state = t?.toggle ? (x.active ? '🟢 on' : '⚪ off') : x.expiresAt ? (new Date(x.expiresAt).getTime() > now ? `⏳ until <t:${Math.floor(new Date(x.expiresAt).getTime() / 1000)}:R>` : 'expired') : x.quantity > 1 ? `×${x.quantity}` : '';
      const mine = [x.custom?.emoji && t?.custom.includes('emoji') ? x.custom.emoji : null, x.custom?.text ? `“${x.custom.text}”` : null, x.custom?.color || null].filter(Boolean).join(' ');
      return `${x.item.emoji} **${x.item.name}** ${state}${mine ? ` · ${mine}` : ''}`;
    });
    const embed = new EmbedBuilder()
      .setColor('#EB459E')
      .setTitle(`🎒 ${user.id === interaction.user.id ? 'Your' : `${user.username}'s`} items`)
      .setDescription(lines.join('\n') || (user.id === interaction.user.id ? 'Nothing yet — have a look with `/shop view`!' : 'Nothing yet.'));
    return interaction.reply({ embeds: [embed], ephemeral: true, allowedMentions: { parse: [] } });
  }

  if (sub === 'toggle') {
    const on = o.getBoolean('on');
    const res = await shop.toggle(guild, interaction.member, o.getString('item'), on === null ? undefined : on);
    return reply(res.error ? `❌ ${res.error}` : `${res.item.emoji} **${res.item.name}** is now **${res.active ? 'on' : 'off'}**.`);
  }

  if (sub === 'customize') {
    const res = await shop.customize(guild, interaction.member, o.getString('item'), { emoji: o.getString('emoji'), text: o.getString('title'), color: o.getString('color') });
    if (res.error) return reply(`❌ ${res.error}`);
    const c = res.custom || {};
    const preview = res.item.type === 'badge' ? `${c.emoji} **${c.text}**${c.color ? ` (${c.color})` : ''}` : c.emoji;
    return reply(`✅ **${res.item.name}** updated: ${preview}`);
  }
}

module.exports = { data, execute, autocomplete };
