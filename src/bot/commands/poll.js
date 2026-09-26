const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const Poll = require('../../database/models/Poll');
const { MAX_OPTIONS, buildPollMessage, endPoll } = require('../cogs/modules/polls');
const { parseDuration } = require('../utils/duration');
const { durationChoices, relative, clip } = require('../utils/autocomplete');

const MAX_POLL_MS = 30 * 86400000;

const data = new SlashCommandBuilder()
  .setName('poll')
  .setDescription('Interactive button polls')
  .addSubcommand((sub) =>
    sub
      .setName('create')
      .setDescription('Start a poll in this channel')
      .addStringOption((opt) => opt.setName('question').setDescription('What are you asking?').setMaxLength(250).setRequired(true))
      .addStringOption((opt) =>
        opt.setName('options').setDescription('2-10 choices separated by | (e.g. Pizza | Tacos | Sushi)').setMaxLength(1000).setRequired(true)
      )
      .addStringOption((opt) => opt.setName('duration').setDescription('Auto-close after (e.g. 30m, 1h, 2d). Leave empty to close manually').setAutocomplete(true))
      .addBooleanOption((opt) => opt.setName('anonymous').setDescription('Hide who voted for what (default: public)'))
      .addBooleanOption((opt) => opt.setName('multiple').setDescription('Allow voting for more than one option'))
  )
  .addSubcommand((sub) =>
    sub
      .setName('end')
      .setDescription('Close a poll now')
      .addStringOption((opt) => opt.setName('message_id').setDescription('Poll — start typing its question').setRequired(true).setAutocomplete(true))
  );

async function execute(interaction, client) {
  const sub = interaction.options.getSubcommand();

  if (sub === 'create') {
    const options = [
      ...new Set(
        interaction.options
          .getString('options')
          .split('|')
          .map((o) => o.trim())
          .filter(Boolean)
      )
    ];
    if (options.length < 2 || options.length > MAX_OPTIONS) {
      return interaction.reply({ content: `❌ Give between 2 and ${MAX_OPTIONS} different options, separated by \`|\`.`, ephemeral: true });
    }

    const durationRaw = interaction.options.getString('duration');
    let endTimestamp = null;
    if (durationRaw) {
      const ms = parseDuration(durationRaw);
      if (!ms || ms > MAX_POLL_MS) {
        return interaction.reply({ content: '❌ Invalid duration. Use e.g. `30m`, `1h`, `2d` (max 30 days).', ephemeral: true });
      }
      endTimestamp = Date.now() + ms;
    }

    const draft = {
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      creatorId: interaction.user.id,
      question: interaction.options.getString('question'),
      options: options.map((o) => o.slice(0, 100)),
      anonymous: interaction.options.getBoolean('anonymous') ?? false,
      multipleChoice: interaction.options.getBoolean('multiple') ?? false,
      votes: [],
      endTimestamp,
      ended: false
    };

    await interaction.reply(buildPollMessage(draft));
    const msg = await interaction.fetchReply();
    await Poll.create({ ...draft, messageId: msg.id });
    return;
  }

  if (sub === 'end') {
    const poll = await Poll.findOne({ messageId: interaction.options.getString('message_id').trim(), guildId: interaction.guildId });
    if (!poll) return interaction.reply({ content: '❌ No poll with that message ID in this server.', ephemeral: true });
    if (poll.ended) return interaction.reply({ content: 'ℹ️ That poll is already closed.', ephemeral: true });
    const canEnd = poll.creatorId === interaction.user.id || interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages);
    if (!canEnd) return interaction.reply({ content: '❌ Only the poll creator or moderators can close it.', ephemeral: true });

    await endPoll(client, poll);
    return interaction.reply({ content: '✅ Poll closed.', ephemeral: true });
  }
}

async function autocomplete(interaction) {
  const focused = interaction.options.getFocused(true);
  if (focused.name === 'duration') return interaction.respond(durationChoices(focused.value));
  const query = String(focused.value || '').toLowerCase();
  // Moderators see every open poll; everyone else only their own (they can only close those).
  const filter = { guildId: interaction.guildId, ended: false };
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages)) filter.creatorId = interaction.user.id;
  const open = await Poll.find(filter).sort({ createdAt: -1 }).limit(100).lean();
  return interaction.respond(
    open
      .filter((p) => !query || p.question.toLowerCase().includes(query))
      .slice(0, 25)
      .map((p) => ({
        name: clip(`📊 ${p.question} — ${new Set(p.votes.map((v) => v.userId)).size} voter(s)${p.endTimestamp ? ` · closes ${relative(p.endTimestamp)}` : ''}`, 100),
        value: p.messageId
      }))
  );
}

module.exports = { data, execute, autocomplete };
