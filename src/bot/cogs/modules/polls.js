const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const Poll = require('../../../database/models/Poll');

const MAX_OPTIONS = 10;
const NUMBER_EMOJI = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

function tally(poll) {
  const counts = poll.options.map(() => 0);
  const voters = poll.options.map(() => []);
  for (const v of poll.votes) {
    if (counts[v.option] === undefined) continue;
    counts[v.option] += 1;
    voters[v.option].push(v.userId);
  }
  const uniqueVoters = new Set(poll.votes.map((v) => v.userId)).size;
  return { counts, voters, uniqueVoters };
}

function bar(ratio, size = 14) {
  const filled = Math.round(ratio * size);
  return `${'█'.repeat(filled)}${'░'.repeat(size - filled)}`;
}

function buildPollMessage(poll) {
  const { counts, voters, uniqueVoters } = tally(poll);
  const totalVotes = counts.reduce((a, b) => a + b, 0);
  const max = Math.max(...counts);

  const lines = poll.options.map((opt, i) => {
    const pct = totalVotes ? counts[i] / totalVotes : 0;
    const crown = poll.ended && max > 0 && counts[i] === max ? ' 🏆' : '';
    let line = `${NUMBER_EMOJI[i]} **${opt}**${crown}\n\`${bar(pct)}\` ${counts[i]} vote(s) · ${Math.round(pct * 100)}%`;
    if (!poll.anonymous && voters[i].length) {
      const shown = voters[i].slice(0, 15).map((id) => `<@${id}>`).join(' ');
      line += `\n-# ${shown}${voters[i].length > 15 ? ` +${voters[i].length - 15} more` : ''}`;
    }
    return line;
  });

  const meta = [
    poll.anonymous ? '🕶️ Anonymous' : '👀 Public votes',
    poll.multipleChoice ? 'Multiple choice' : 'Single choice',
    `${uniqueVoters} voter(s)`
  ];
  let status;
  if (poll.ended) status = '**Poll closed — final results.**';
  else if (poll.endTimestamp) status = `Closes <t:${Math.floor(poll.endTimestamp / 1000)}:R>`;
  else status = 'Open until closed with `/poll end`';

  const embed = new EmbedBuilder()
    .setTitle(`📊 ${poll.question}`)
    .setColor(poll.ended ? '#2B2D31' : '#5865F2')
    .setDescription(`${lines.join('\n\n')}\n\n${status}`)
    .setFooter({ text: `${meta.join(' · ')}${poll.ended ? '' : ' · click again to remove your vote'}` });

  const rows = [];
  for (let i = 0; i < poll.options.length; i += 5) {
    const row = new ActionRowBuilder();
    poll.options.slice(i, i + 5).forEach((opt, j) => {
      const idx = i + j;
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`poll:${idx}`)
          .setEmoji(NUMBER_EMOJI[idx])
          .setLabel(opt.slice(0, 70))
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(!!poll.ended)
      );
    });
    rows.push(row);
  }
  return { embeds: [embed], components: rows, allowedMentions: { parse: [] } };
}

async function handleVote(interaction) {
  const option = Number(interaction.customId.split(':')[1]);
  const poll = await Poll.findOne({ messageId: interaction.message.id });
  if (!poll || poll.ended) return interaction.reply({ content: '❌ This poll is closed.', ephemeral: true });
  if (!Number.isInteger(option) || option < 0 || option >= poll.options.length) return interaction.deferUpdate();

  const userId = interaction.user.id;
  const alreadyVotedThis = poll.votes.some((v) => v.userId === userId && v.option === option);
  let reply;

  if (alreadyVotedThis) {
    await Poll.updateOne({ _id: poll._id }, { $pull: { votes: { userId, option } } });
    reply = `Removed your vote for **${poll.options[option]}**.`;
  } else if (poll.multipleChoice) {
    await Poll.updateOne({ _id: poll._id }, { $addToSet: { votes: { userId, option } } });
    reply = `Voted for **${poll.options[option]}**.`;
  } else {
    // Single choice: replace any previous vote.
    await Poll.updateOne({ _id: poll._id }, { $pull: { votes: { userId } } });
    await Poll.updateOne({ _id: poll._id }, { $push: { votes: { userId, option } } });
    reply = `Voted for **${poll.options[option]}**.`;
  }

  const fresh = await Poll.findById(poll._id);
  await interaction.update(buildPollMessage(fresh));
  return interaction.followUp({ content: `🗳️ ${reply}`, ephemeral: true });
}

async function endPoll(client, poll) {
  const claimed = await Poll.findOneAndUpdate({ _id: poll._id, ended: false }, { $set: { ended: true } }, { new: true });
  if (!claimed) return null;
  const channel = await client.channels.fetch(claimed.channelId).catch(() => null);
  const msg = channel ? await channel.messages.fetch(claimed.messageId).catch(() => null) : null;
  if (msg) await msg.edit(buildPollMessage(claimed)).catch(() => null);
  return claimed;
}

async function sweepPolls(client) {
  const due = await Poll.find({ ended: false, endTimestamp: { $ne: null, $lte: Date.now() } }).limit(50);
  for (const poll of due) await endPoll(client, poll).catch(console.error);
}

module.exports = { MAX_OPTIONS, buildPollMessage, handleVote, endPoll, sweepPolls };
