// /calculate pets · guns — how many D summons (and gems / diamonds) it takes to reach the pets or guns
// you want, counting what you already own. Opens a form (pre-filled with your last answers), replies
// with the result and DMs you a copy.
const { SlashCommandBuilder, LabelBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const calc = require('../cogs/modules/calculator');
const CalcProfile = require('../../database/models/CalcProfile');

const EXAMPLES = {
  pets: { have: 'e.g. b 2, sss 2, xxx 1   (leave blank if you have none)', want: 'e.g. 3x zzz, 2x xxx' },
  guns: { have: 'e.g. s 1, ss 2   (leave blank if you have none)', want: 'e.g. 1x zzz, 2x x' }
};

const data = new SlashCommandBuilder()
  .setName('calculate')
  .setDescription('Work out how many gems / diamonds you need to reach your goal')
  .addSubcommand((s) =>
    s.setName('pets').setDescription('Pet upgrade calculator')
      .addStringOption((o) => o.setName('have').setDescription('Your pets, e.g. "b 2, sss 2" (skip to use the form)'))
      .addStringOption((o) => o.setName('want').setDescription('What you want, e.g. "3x zzz, 2x xxx" (skip to use the form)'))
  )
  .addSubcommand((s) =>
    s.setName('guns').setDescription('Gun upgrade calculator')
      .addStringOption((o) => o.setName('have').setDescription('Your guns, e.g. "s 1, ss 2" (skip to use the form)'))
      .addStringOption((o) => o.setName('want').setDescription('What you want, e.g. "1x zzz" (skip to use the form)'))
  );

function form(kind, saved) {
  const k = calc.KINDS[kind];
  const have = new TextInputBuilder().setCustomId('have').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(400).setPlaceholder(EXAMPLES[kind].have);
  const want = new TextInputBuilder().setCustomId('want').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(400).setPlaceholder(EXAMPLES[kind].want);
  if (saved?.have) have.setValue(saved.have.slice(0, 400));
  if (saved?.want) want.setValue(saved.want.slice(0, 400));
  return new ModalBuilder()
    .setCustomId(`calcm:${kind}`)
    .setTitle(`${k.name} Calculator`)
    .addLabelComponents(
      new LabelBuilder().setLabel(`Your ${k.plural}`).setDescription('Rarity + how many (D C B A S SS SSS X XX XXX Z ZZ ZZZ). Left out = 0.').setTextInputComponent(have),
      new LabelBuilder().setLabel(`${k.name}s you want`).setDescription('Rarity and how many, e.g. 3x ZZZ').setTextInputComponent(want)
    );
}

/** Calculates, replies (only to them) and DMs a copy. Works from the command or the form. */
async function respond(interaction, kind, haveText, wantText) {
  const have = calc.parseCounts(haveText);
  const want = calc.parseCounts(wantText);
  const unknown = [...have.unknown, ...want.unknown];
  if (!want.counts.some(Boolean)) {
    return interaction.reply({ content: `❌ Tell me what you want, e.g. \`${EXAMPLES[kind].want.replace('e.g. ', '')}\`. Rarities: ${calc.TIERS.map((t) => t.toUpperCase()).join(', ')}.`, ephemeral: true });
  }
  CalcProfile.updateOne({ userId: interaction.user.id, kind }, { $set: { have: haveText || '', want: wantText || '' } }, { upsert: true }).catch(() => null);
  const result = calc.plan(have.counts, want.counts);
  const embed = calc.resultEmbed(kind, have.counts, want.counts, result, interaction.user);
  const dm = await interaction.user.send({ embeds: [embed] }).then(() => true, () => false);
  const notes = [];
  if (unknown.length) notes.push(`⚠️ I skipped what I couldn't read: \`${unknown.join('`, `').slice(0, 300)}\``);
  notes.push(dm ? '📬 I also sent this to your DMs.' : "📭 Couldn't DM you a copy — your DMs are closed.");
  return interaction.reply({ content: notes.join('\n'), embeds: [embed], ephemeral: true });
}

async function execute(interaction) {
  const kind = interaction.options.getSubcommand();
  const have = interaction.options.getString('have');
  const want = interaction.options.getString('want');
  if (want) return respond(interaction, kind, have || '', want);
  const saved = await CalcProfile.findOne({ userId: interaction.user.id, kind }).lean().catch(() => null);
  return interaction.showModal(form(kind, saved || (have ? { have } : null)));
}

/** The form's submit button. */
async function handleCalcModal(interaction) {
  const kind = interaction.customId.split(':')[1];
  if (!calc.KINDS[kind]) return interaction.reply({ content: '❌ Unknown calculator.', ephemeral: true });
  return respond(interaction, kind, interaction.fields.getTextInputValue('have') || '', interaction.fields.getTextInputValue('want') || '');
}

module.exports = { data, execute, handleCalcModal, form };
