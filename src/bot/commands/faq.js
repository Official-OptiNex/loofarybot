// /faq — anyone can post the server FAQ in the current channel.
// /faqedit — guide editors manage it: open the dashboard, or add / remove / edit a question quickly.
// The FAQ is a list of question → answer entries rendered into an embed. See cogs/modules/faq.js.
const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
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

/* --------------------------------------------------------------- /faq (everyone) */

const faqData = new SlashCommandBuilder()
  .setName('faq')
  .setDescription('Post the server FAQ in this channel')
  .setDMPermission(false)
  .addBooleanOption((o) => o.setName('private').setDescription('Show it only to you (invisible to everyone else)'));

async function faqExecute(interaction) {
  const invisible = interaction.options.getBoolean('private') ?? false;
  const f = await faq.getFaq(interaction.guildId);
  if (!faq.hasFaq(f)) {
    const link = editorLink(interaction.guildId);
    return interaction.reply({ content: `❌ The FAQ hasn't been set up yet. ${link ? `An editor can add questions here: ${link}` : 'An editor can set it up on the dashboard.'}`, ephemeral: true });
  }
  // Public by default (everyone in the channel sees it); `private:true` makes it an ephemeral reply only
  // the runner can see. Embed text never pings either way.
  return interaction.reply({ embeds: faq.toPayload(f).embeds, ephemeral: invisible, allowedMentions: { parse: [] } });
}

/* --------------------------------------------------------------- /faqedit (editors) */

const faqEditData = new SlashCommandBuilder()
  .setName('faqedit')
  .setDescription('Manage the server FAQ (guide editors)')
  .setDMPermission(false)
  .addSubcommand((s) => s.setName('dashboard').setDescription('Open the FAQ editor on the dashboard'))
  .addSubcommand((s) =>
    s
      .setName('add')
      .setDescription('Add a question and answer')
      .addStringOption((o) => o.setName('question').setDescription('The question').setRequired(true).setMaxLength(faq.LIMITS.question))
      .addStringOption((o) => o.setName('answer').setDescription('The answer (markdown allowed)').setRequired(true).setMaxLength(faq.LIMITS.answer))
  )
  .addSubcommand((s) =>
    s
      .setName('remove')
      .setDescription('Remove a question')
      .addStringOption((o) => o.setName('question').setDescription('Which question').setRequired(true).setAutocomplete(true))
  )
  .addSubcommand((s) =>
    s
      .setName('edit')
      .setDescription('Edit a question or its answer')
      .addStringOption((o) => o.setName('question').setDescription('Which question').setRequired(true).setAutocomplete(true))
      .addStringOption((o) => o.setName('answer').setDescription('New answer').setMaxLength(faq.LIMITS.answer))
      .addStringOption((o) => o.setName('new_question').setDescription('Reword the question').setMaxLength(faq.LIMITS.question))
  );

async function faqEditAutocomplete(interaction) {
  const typed = (interaction.options.getFocused() || '').toLowerCase();
  const { items } = await faq.getFaq(interaction.guildId);
  const choices = items
    .filter((it) => it.q.toLowerCase().includes(typed))
    .slice(0, 25)
    .map((it) => ({ name: it.q.slice(0, 100), value: it.q.slice(0, 100) }));
  return interaction.respond(choices);
}

async function faqEditExecute(interaction) {
  const reply = (content) => interaction.reply({ content, ephemeral: true, allowedMentions: { parse: [] } });
  if (!(await faq.isEditor(interaction.member, interaction.guildId))) {
    return reply('🔒 Only guide editors (or admins) can manage the FAQ.');
  }
  const sub = interaction.options.getSubcommand();
  const o = interaction.options;

  if (sub === 'dashboard') {
    const link = editorLink(interaction.guildId);
    return reply(link ? `✍️ Edit the FAQ here: ${link}` : 'Open the dashboard’s **FAQ** page to edit it.');
  }

  let res;
  if (sub === 'add') res = await faq.addItem(interaction.guild, o.getString('question'), o.getString('answer'), interaction.user.id);
  else if (sub === 'remove') res = await faq.removeItem(interaction.guild, o.getString('question'), interaction.user.id);
  else if (sub === 'edit') res = await faq.editItem(interaction.guild, o.getString('question'), { newQuestion: o.getString('new_question'), answer: o.getString('answer') }, interaction.user.id);

  if (!res || res.error) return reply(`❌ ${res ? res.error : 'Unknown action.'}`);
  const count = res.faq.items.length;
  const verb = sub === 'add' ? 'Added' : sub === 'remove' ? 'Removed' : 'Updated';
  return reply(`✅ ${verb}. The FAQ now has **${count}** question${count === 1 ? '' : 's'}. Run **/faq** to post it.`);
}

module.exports = {
  commands: [
    { data: faqData, execute: faqExecute },
    { data: faqEditData, execute: faqEditExecute, autocomplete: faqEditAutocomplete }
  ]
};
