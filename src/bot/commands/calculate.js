// /calculate — upgrade calculator for pets, guns and fish (names, costs and odds set per server on the
// dashboard), all in one private message:
//   1. pick 🐾 Pets, 🔫 Guns or 🐟 Fish;
//   2. 📦 inventory panel: a button per rarity (D → ZZZ) opens a box to type how many you own;
//   3. 🎯 goal panel: the same 13 buttons for how many you want;
//   4. 🧮 Calculate: the D summons and gems / diamonds needed (counting what you own), also DMed to you.
// Numbers save as you go, so it reopens where you left off.
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, LabelBuilder, ModalBuilder, SlashCommandBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const calc = require('../cogs/modules/calculator');
const CalcProfile = require('../../database/models/CalcProfile');

const N = calc.TIERS.length;
const MAX = 1000;
const data = new SlashCommandBuilder().setName('calculate').setDescription('Pet, gun & fish upgrade calculator — what you need to reach your goal');

// ---------------------------------------------------------------- saved numbers

const counts = (arr) => Array.from({ length: N }, (_, i) => Math.max(0, Math.min(MAX, Math.floor(Number(arr?.[i]) || 0))));
async function load(userId, kind) {
  const p = await CalcProfile.findOne({ userId, kind }).lean().catch(() => null);
  return { have: counts(p?.haveCounts), want: counts(p?.wantCounts) };
}
// This server's calculators (names, costs, odds and which are on — dashboard Engagement → Calculator).
async function kindsOf(interaction) {
  if (!interaction.guildId) return calc.KINDS;
  const config = await require('../../database/models/GuildConfig').findOne({ guildId: interaction.guildId }, { calculator: 1 }).lean().catch(() => null);
  return calc.kindsFor(config);
}

const save = (userId, kind, s) => CalcProfile.updateOne({ userId, kind }, { $set: { haveCounts: s.have, wantCounts: s.want } }, { upsert: true }).catch(() => null);

// ---------------------------------------------------------------- views

const button = (id, label, style = ButtonStyle.Secondary, emoji = null) => {
  const b = new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);
  if (emoji) b.setEmoji(emoji);
  return b;
};

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const MENU_STYLE = { pets: ButtonStyle.Primary, guns: ButtonStyle.Danger, fish: ButtonStyle.Success };

function menuView(note = null, kinds = calc.KINDS) {
  const on = calc.KIND_KEYS.filter((key) => kinds[key].enabled !== false);
  const line = (key) => {
    const k = kinds[key];
    return k.draws
      ? `${k.emoji} **${cap(k.plural)}** — epic draws (${k.draws.epic.currency || 'Diamonds'})${k.draws.free.perDay ? ' or days of free draws' : ''} to reach your ${k.plural}`
      : `${k.emoji} **${cap(k.plural)}** — ${k.currencies.join(' / ')} to reach your ${k.plural}`;
  };
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('🧮 Calculator')
    .setDescription(on.length ? `What do you want to calculate?\n\n${on.map(line).join('\n')}` : 'No calculators are switched on in this server.');
  return {
    content: note,
    embeds: [embed],
    components: on.length ? [new ActionRowBuilder().addComponents(on.map((key) => button(`calc:${key}:have`, cap(kinds[key].plural), MENU_STYLE[key], kinds[key].emoji)))] : []
  };
}

/** The inventory ('have') or goal ('want') panel: the two lists + a button per rarity. */
function panelView(kind, view, s, note = null, kinds = calc.KINDS) {
  const k = kinds[kind];
  const editing = view === 'have';
  const embed = new EmbedBuilder()
    .setColor(k.color)
    .setTitle(`${k.emoji} ${k.name} Calculator — ${editing ? 'Step 1: your inventory' : 'Step 2: your goal'}`)
    .setDescription(
      (editing
        ? `Press a rarity below to type **how many ${k.plural} you own** of it.\n`
        : `Press a rarity below to type **how many ${k.plural} you want** of it.\n`) +
        `📦 **Inventory** · 🎯 **Goal** switch lists · 🧮 **Calculate** works out the cost.\n*Saved automatically.*`
    )
    .addFields(
      { name: `📦 Your ${k.plural}${editing ? ' ✏️' : ''}`, value: calc.countsText(s.have) || '*None — all 0*' },
      { name: `🎯 You want${editing ? '' : ' ✏️'}`, value: calc.countsText(s.want) || '*Nothing yet*' }
    );
  const list = editing ? s.have : s.want;
  const tierButton = (t) => button(`calc:${kind}:set:${view}:${t}`, `${calc.label(t)} · ${list[t]}`, list[t] ? ButtonStyle.Primary : ButtonStyle.Secondary);
  const rows = [
    new ActionRowBuilder().addComponents([0, 1, 2, 3, 4].map(tierButton)),
    new ActionRowBuilder().addComponents([5, 6, 7, 8, 9].map(tierButton)),
    new ActionRowBuilder().addComponents([10, 11, 12].map(tierButton)),
    new ActionRowBuilder().addComponents(
      button(`calc:${kind}:have`, 'Inventory', editing ? ButtonStyle.Success : ButtonStyle.Secondary, '📦').setDisabled(editing),
      button(`calc:${kind}:want`, 'Goal', editing ? ButtonStyle.Secondary : ButtonStyle.Success, '🎯').setDisabled(!editing),
      button(`calc:${kind}:calc`, 'Calculate', ButtonStyle.Primary, '🧮'),
      button(`calc:${kind}:reset:${view}`, `Reset ${editing ? 'inventory' : 'goal'}`, ButtonStyle.Danger, '🗑️'),
      button('calc:menu', 'Back', ButtonStyle.Secondary, '↩️')
    )
  ];
  return { content: note, embeds: [embed], components: rows };
}

function resultView(kind, s, embed, note) {
  return {
    content: note,
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(
        button(`calc:${kind}:have`, 'Edit inventory', ButtonStyle.Secondary, '📦'),
        button(`calc:${kind}:want`, 'Edit goal', ButtonStyle.Secondary, '🎯'),
        button('calc:menu', 'Another calculator', ButtonStyle.Secondary, '🔁')
      )
    ]
  };
}

// ---------------------------------------------------------------- handlers

async function execute(interaction) {
  return interaction.reply({ ...menuView(null, await kindsOf(interaction)), ephemeral: true });
}

/** All calculator buttons (customId calc:…). */
async function handleCalcButton(interaction) {
  const [, kind, action, view, tier] = interaction.customId.split(':');
  const kinds = await kindsOf(interaction);
  if (kind === 'menu') return interaction.update(menuView(null, kinds));
  if (!calc.KIND_KEYS.includes(kind)) return interaction.reply({ content: '❌ Unknown calculator.', ephemeral: true });
  if (kinds[kind].enabled === false) return interaction.update(menuView(`🚫 The ${kinds[kind].name} calculator is switched off.`, kinds));
  const s = await load(interaction.user.id, kind);

  if (action === 'have' || action === 'want') return interaction.update(panelView(kind, action, s, null, kinds));
  if (action === 'reset') {
    s[view === 'want' ? 'want' : 'have'] = counts([]);
    await save(interaction.user.id, kind, s);
    return interaction.update(panelView(kind, view === 'want' ? 'want' : 'have', s, view === 'want' ? '🗑️ Goal cleared.' : '🗑️ Inventory cleared.', kinds));
  }
  if (action === 'set') {
    const t = Number(tier);
    const list = view === 'want' ? s.want : s.have;
    const k = kinds[kind];
    const input = new TextInputBuilder().setCustomId('n').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(4).setPlaceholder('0');
    if (list[t]) input.setValue(String(list[t]));
    return interaction.showModal(
      new ModalBuilder()
        .setCustomId(`calcm:${kind}:${view}:${t}`)
        .setTitle(`${calc.label(t)} ${k.plural}`)
        .addLabelComponents(new LabelBuilder().setLabel(view === 'want' ? `How many ${calc.label(t)} ${k.plural} do you want?` : `How many ${calc.label(t)} ${k.plural} do you own?`).setDescription(`A number from 0 to ${MAX}.`).setTextInputComponent(input))
    );
  }
  if (action === 'calc') {
    if (!s.want.some(Boolean)) return interaction.update(panelView(kind, 'want', s, '🎯 Set your goal first — press a rarity and type how many you want.', kinds));
    const embed = calc.resultEmbed(kind, s.have, s.want, calc.plan(s.have, s.want), interaction.user, kinds);
    const dm = await interaction.user.send({ embeds: [embed] }).then(() => true, () => false);
    return interaction.update(resultView(kind, s, embed, dm ? '📬 I also sent this to your DMs.' : "📭 Couldn't DM you a copy — your DMs are closed."));
  }
  return interaction.reply({ content: '❌ Unknown button.', ephemeral: true });
}

/** A rarity's number box was submitted: save it and refresh the panel. */
async function handleCalcModal(interaction) {
  const [, kind, view, tier] = interaction.customId.split(':');
  if (!calc.KIND_KEYS.includes(kind) || !['have', 'want'].includes(view)) return interaction.reply({ content: '❌ Unknown calculator.', ephemeral: true });
  const t = Number(tier);
  const raw = (interaction.fields.getTextInputValue('n') || '').trim().replace(/[x,\s]/gi, '');
  const s = await load(interaction.user.id, kind);
  let note = null;
  if (raw && !/^\d+$/.test(raw)) note = `⚠️ “${raw.slice(0, 20)}” isn't a number — ${calc.label(t)} wasn't changed.`;
  else {
    const n = Math.min(MAX, Number(raw || 0));
    s[view][t] = n;
    await save(interaction.user.id, kind, s);
    note = `✅ ${calc.label(t)}: **${n}**${Number(raw) > MAX ? ` (max ${MAX})` : ''}`;
  }
  const view2 = panelView(kind, view, s, note, await kindsOf(interaction));
  return interaction.isFromMessage?.() ? interaction.update(view2) : interaction.reply({ ...view2, ephemeral: true });
}

module.exports = { data, execute, handleCalcButton, handleCalcModal, menuView, panelView };
