const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder
} = require('discord.js');
const GuildConfig = require('../../database/models/GuildConfig');
const { setupHoneypotChannel, refreshCounterEmbed, buildCounterEmbed, isHttpUrl } = require('../cogs/modules/honeypot');
const { resolveColor } = require('../cogs/modules/giveaways');
const { getOrCreateConfig } = require('../cogs/modules/leveling');

const data = new SlashCommandBuilder()
  .setName('honeypot')
  .setDescription('Configure the honeypot anti-raid trap')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand((sub) =>
    sub
      .setName('setup')
      .setDescription('Designate a channel as the honeypot trap and post the live counter')
      .addChannelOption((opt) => opt.setName('channel').setDescription('Trap channel').setRequired(true))
  )
  .addSubcommand((sub) =>
    sub
      .setName('action')
      .setDescription('Set the enforcement action for anyone who posts in the trap')
      .addStringOption((opt) =>
        opt
          .setName('type')
          .setDescription('Action to take')
          .setRequired(true)
          .addChoices(
            { name: 'Kick', value: 'kick' },
            { name: 'Soft Ban (ban + unban, purges messages)', value: 'softban' },
            { name: 'Permanent Ban', value: 'ban' }
          )
      )
  )
  .addSubcommand((sub) => sub.setName('status').setDescription('Show current honeypot configuration and counts'))
  .addSubcommand((sub) =>
    sub
      .setName('embed')
      .setDescription('Customize (disguise) the trap message — opens an editor')
      .addBooleanOption((opt) => opt.setName('show_counts').setDescription('Show the kick/ban counters (turn off to disguise it better)'))
  )
  .addSubcommand((sub) =>
    sub
      .setName('dm')
      .setDescription('DM caught members an explanation (compromised account, punishment, how to secure it)')
      .addBooleanOption((opt) => opt.setName('enabled').setDescription('Send the DM?').setRequired(true))
  )
  .addSubcommand((sub) =>
    sub
      .setName('toggle')
      .setDescription('Turn the honeypot trap on or off without removing its setup')
      .addBooleanOption((opt) => opt.setName('enabled').setDescription('Trap active?').setRequired(true))
  )
  .addSubcommand((sub) => sub.setName('embed_reset').setDescription('Reset the trap message to the default look'));

async function execute(interaction, client) {
  const sub = interaction.options.getSubcommand();

  if (sub === 'setup') {
    const channel = interaction.options.getChannel('channel');
    try {
      await setupHoneypotChannel(client, interaction.guildId, channel.id);
      return interaction.reply({ content: `✅ Honeypot trap set up in ${channel}.`, ephemeral: true });
    } catch (err) {
      console.error(err);
      return interaction.reply({ content: `❌ ${err.message}`, ephemeral: true });
    }
  }

  if (sub === 'action') {
    const type = interaction.options.getString('type');
    const config = await getOrCreateConfig(interaction.guildId);
    config.honeypotAction = type;
    await config.save();
    return interaction.reply({ content: `✅ Honeypot enforcement action set to **${type}**.`, ephemeral: true });
  }

  if (sub === 'embed') {
    const config = await getOrCreateConfig(interaction.guildId);
    const current = config.honeypotEmbed || {};
    const showCounts = interaction.options.getBoolean('show_counts') ?? current.showCounts !== false;

    const input = (id, label, style, value, max, required = false) => {
      const t = new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setRequired(required).setMaxLength(max);
      if (value) t.setValue(String(value).slice(0, max));
      return new ActionRowBuilder().addComponents(t);
    };

    const modal = new ModalBuilder()
      .setCustomId(`hpembed_modal:${showCounts ? 1 : 0}`)
      .setTitle('Customize Honeypot Message')
      .addComponents(
        input('hp_title', 'Title (blank = default)', TextInputStyle.Short, current.title, 256),
        input('hp_desc', 'Description (blank = default)', TextInputStyle.Paragraph, current.description, 4000),
        input('hp_color', 'Color (hex or name, blank = red)', TextInputStyle.Short, current.color, 20),
        input('hp_footer', 'Footer text (blank = default)', TextInputStyle.Short, current.footer, 2048),
        input('hp_image', 'Image URL (optional)', TextInputStyle.Short, current.imageUrl, 1000)
      );
    return interaction.showModal(modal);
  }

  if (sub === 'dm' || sub === 'toggle') {
    const enabled = interaction.options.getBoolean('enabled');
    const config = await getOrCreateConfig(interaction.guildId);
    if (sub === 'dm') config.honeypotDmEnabled = enabled;
    else config.honeypotEnabled = enabled;
    await config.save();
    return interaction.reply({
      content: sub === 'dm'
        ? `✅ Caught members will ${enabled ? 'now' : 'no longer'} get a DM explaining what happened.`
        : `✅ Honeypot trap **${enabled ? 'enabled' : 'disabled'}**.`,
      ephemeral: true
    });
  }

  if (sub === 'embed_reset') {
    const config = await getOrCreateConfig(interaction.guildId);
    config.honeypotEmbed = { title: '', description: '', color: '', footer: '', imageUrl: '', thumbnailUrl: '', showCounts: true };
    await config.save();
    await refreshCounterEmbed(client, config);
    return interaction.reply({ content: '✅ Honeypot message reset to the default look.', ephemeral: true });
  }

  if (sub === 'status') {
    const config = await GuildConfig.findOne({ guildId: interaction.guildId });
    if (!config || !config.honeypotChannelId) {
      return interaction.reply({ content: 'Honeypot has not been set up yet. Use `/honeypot setup`.', ephemeral: true });
    }
    const embed = new EmbedBuilder()
      .setTitle('Honeypot Status')
      .setColor('#ED4245')
      .addFields(
        { name: 'Channel', value: `<#${config.honeypotChannelId}>`, inline: true },
        { name: 'Action', value: config.honeypotAction, inline: true },
        { name: 'Status', value: config.honeypotEnabled === false ? 'Disabled' : 'Active', inline: true },
        { name: 'DM caught members', value: config.honeypotDmEnabled === false ? 'No' : 'Yes', inline: true },
        { name: 'Kicks', value: `${config.honeypotKicks}`, inline: true },
        { name: 'Soft Bans', value: `${config.honeypotSoftbans}`, inline: true },
        { name: 'Bans', value: `${config.honeypotBans}`, inline: true }
      );
    return interaction.reply({ embeds: [embed], ephemeral: true });
  }
}

async function handleModalSubmit(interaction, client) {
  const showCounts = interaction.customId.split(':')[1] === '1';
  const get = (id) => interaction.fields.getTextInputValue(id).trim();

  const imageUrl = get('hp_image');
  if (imageUrl && !isHttpUrl(imageUrl)) {
    return interaction.reply({ content: '❌ The image URL must start with `http://` or `https://`.', ephemeral: true });
  }
  const rawColor = get('hp_color');

  const config = await getOrCreateConfig(interaction.guildId);
  config.honeypotEmbed = {
    ...(config.honeypotEmbed?.toObject ? config.honeypotEmbed.toObject() : config.honeypotEmbed || {}),
    title: get('hp_title'),
    description: get('hp_desc'),
    color: rawColor ? resolveColor(rawColor) : '',
    footer: get('hp_footer'),
    imageUrl,
    showCounts
  };
  await config.save();
  await refreshCounterEmbed(client, config);

  return interaction.reply({
    content: config.honeypotChannelId
      ? '✅ Honeypot message updated. Preview:'
      : '✅ Saved. It will be used once you run `/honeypot setup`. Preview:',
    embeds: [buildCounterEmbed(config)],
    ephemeral: true
  });
}

module.exports = { data, execute, handleModalSubmit };
