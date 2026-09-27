// /welcome and /goodbye — the dashboard's Welcome tab from Discord. The full embed designer stays on
// the dashboard; these cover the channel, the text, on/off, a test and a summary.
const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const WelcomeConfig = require('../../database/models/WelcomeConfig');
const { sendWelcome, sendGoodbye, GOODBYE_DEFAULT } = require('../cogs/modules/welcome');
const { dashboardUrl } = require('../cogs/modules/help');

function build(kind) {
  const isWelcome = kind === 'welcome';
  const what = isWelcome ? 'welcome' : 'goodbye';
  return new SlashCommandBuilder()
    .setName(kind)
    .setDescription(isWelcome ? 'Greet new members automatically' : 'Post a message when someone leaves')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((s) =>
      s
        .setName('set')
        .setDescription(`Set the ${what} channel and message (turns it on)`)
        .addChannelOption((o) =>
          o.setName('channel').setDescription('Where to post').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true)
        )
        .addStringOption((o) =>
          o.setName('message').setDescription('Text — placeholders: {user} {username} {server} {membercount}').setMaxLength(2000)
        )
    )
    .addSubcommand((s) =>
      s
        .setName('toggle')
        .setDescription(`Turn ${what} messages on or off`)
        .addBooleanOption((o) => o.setName('enabled').setDescription('On or off').setRequired(true))
    )
    .addSubcommand((s) => s.setName('test').setDescription(`Post a test ${what} message using you as the member`))
    .addSubcommand((s) => s.setName('show').setDescription(`Show the current ${what} setup`));
}

async function run(interaction, kind) {
  const sub = interaction.options.getSubcommand();
  const guildId = interaction.guildId;
  const isWelcome = kind === 'welcome';
  const doc = (await WelcomeConfig.findOne({ guildId })) || new WelcomeConfig({ guildId });
  const cfg = isWelcome ? doc : doc.goodbye;

  if (sub === 'set') {
    const channel = interaction.options.getChannel('channel');
    cfg.channelId = channel.id;
    cfg.enabled = true;
    const message = interaction.options.getString('message');
    if (message) cfg.messageContent = message;
    await doc.save();
    return interaction.reply({
      content: `✅ ${isWelcome ? 'Welcome' : 'Goodbye'} messages are **on** in ${channel}.${message ? '' : ' Using the current message text.'}\nTry it with \`/${kind} test\`. Design an embed on the dashboard: ${dashboardUrl(guildId)}`,
      ephemeral: true
    });
  }

  if (sub === 'toggle') {
    const enabled = interaction.options.getBoolean('enabled');
    if (enabled && !cfg.channelId) return interaction.reply({ content: `❌ Set a channel first with \`/${kind} set\`.`, ephemeral: true });
    cfg.enabled = enabled;
    await doc.save();
    return interaction.reply({ content: `✅ ${isWelcome ? 'Welcome' : 'Goodbye'} messages are **${enabled ? 'on' : 'off'}**.`, ephemeral: true });
  }

  if (sub === 'test') {
    await interaction.deferReply({ ephemeral: true });
    const plain = doc.toObject();
    const problem = isWelcome
      ? await sendWelcome(interaction.member, { force: true, config: plain })
      : await sendGoodbye(interaction.member, { force: true, config: plain.goodbye });
    return interaction.editReply(problem ? `❌ ${problem}` : `📨 Test posted in <#${cfg.channelId}>.`);
  }

  const text = cfg.messageContent || (isWelcome ? '' : GOODBYE_DEFAULT);
  return interaction.reply({
    content:
      `${isWelcome ? '👋 **Welcome messages**' : '🚪 **Goodbye messages**'} — ${cfg.enabled ? '**on**' : 'off'}\n` +
      `**Channel:** ${cfg.channelId ? `<#${cfg.channelId}>` : 'not set'}\n` +
      `**Message:** ${text ? `\`\`\`\n${text.slice(0, 1500)}\n\`\`\`` : '*(none)*'}` +
      `**Embed:** ${cfg.embedEnabled ? 'yes' : 'no'} — edit it on the dashboard: ${dashboardUrl(guildId)}`,
    ephemeral: true,
    allowedMentions: { parse: [] }
  });
}

const commands = ['welcome', 'goodbye'].map((kind) => ({ data: build(kind), execute: (i) => run(i, kind) }));

module.exports = { commands };
