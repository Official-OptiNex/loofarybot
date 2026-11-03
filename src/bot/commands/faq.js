// /faq — post the server's FAQ publicly (guide editors), or open the dashboard editor for it.
// The FAQ is one message (text + up to 10 embeds) edited on the dashboard in the same visual /
// markdown / JSON embed editor as the Embed Builder. See cogs/modules/faq.js.
const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const faq = require('../cogs/modules/faq');
const { REDIRECT_URI } = require('../../config');

const dashBase = () => {
  try {
    return new URL(REDIRECT_URI).origin;
  } catch {
    return null;
  }
};
const editorLink = (guildId) => {
  const base = dashBase();
  return base ? `${base}/dashboard/${guildId}/faq` : null;
};

const data = new SlashCommandBuilder()
  .setName('faq')
  .setDescription('Post the server FAQ, or edit it')
  .setDMPermission(false)
  .addSubcommand((s) =>
    s
      .setName('show')
      .setDescription('Post the FAQ in this channel (guide editors)')
      .addChannelOption((o) =>
        o
          .setName('channel')
          .setDescription('Post it here instead of the current channel')
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
      )
  )
  .addSubcommand((s) => s.setName('edit').setDescription('Open the FAQ editor on the dashboard (guide editors)'));

async function execute(interaction) {
  const sub = interaction.options.getSubcommand();
  const reply = (content) => interaction.reply({ content, ephemeral: true, allowedMentions: { parse: [] } });

  if (!(await faq.isEditor(interaction.member, interaction.guildId))) {
    return reply('🔒 Only guide editors (or admins) can use `/faq`.');
  }

  if (sub === 'edit') {
    const link = editorLink(interaction.guildId);
    return reply(link ? `✍️ Edit the FAQ here: ${link}` : 'Open the dashboard’s **FAQ** page to edit it.');
  }

  // show → post the saved FAQ publicly
  const { message } = await faq.getFaq(interaction.guildId);
  if (!faq.hasFaq(message)) {
    const link = editorLink(interaction.guildId);
    return reply(`❌ The FAQ is empty. ${link ? `Set it up here: ${link}` : 'Set it up on the dashboard’s FAQ page.'}`);
  }

  const target = interaction.options.getChannel('channel') || interaction.channel;
  if (!target || !target.isTextBased?.()) return reply('❌ Pick a text channel to post the FAQ in.');

  const me = interaction.guild.members.me;
  if (!me || !target.permissionsFor(me)?.has([PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
    return reply(`❌ I need **Send Messages** and **Embed Links** in ${target}.`);
  }

  try {
    const sent = await target.send(faq.toPayload(message));
    // Remember where it was posted (a handy default for the dashboard's "Post to channel").
    await faq.rememberChannel(interaction.guildId, target.id);
    return reply(`✅ Posted the FAQ in ${target}. ${sent.url}`);
  } catch (err) {
    return reply(`❌ Discord rejected the FAQ message — check the image/link URLs. (${err.message})`);
  }
}

module.exports = { data, execute };
