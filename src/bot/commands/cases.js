const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const ModCase = require('../../database/models/ModCase');
const { getOrCreateConfig } = require('../cogs/modules/leveling');
const { TYPES, listCases, getCase, revokeCase, updateReason, deleteCase, caseEmbed, MAX_TIMEOUT_MS } = require('../cogs/modules/modCases');
const { parseDuration, formatDuration } = require('../utils/duration');
const { durationChoices, clip } = require('../utils/autocomplete');

const idOption = (o) => o.setName('id').setDescription('Case number').setRequired(true).setMinValue(1).setAutocomplete(true);

const data = new SlashCommandBuilder()
  .setName('cases')
  .setDescription('Moderation history: warnings, timeouts, kicks and bans')
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
  .addSubcommand((s) =>
    s
      .setName('user')
      .setDescription("A member's moderation history")
      .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true))
      .addIntegerOption((o) => o.setName('page').setDescription('Page').setMinValue(1))
  )
  .addSubcommand((s) => s.setName('recent').setDescription('The latest cases in this server').addIntegerOption((o) => o.setName('page').setDescription('Page').setMinValue(1)))
  .addSubcommand((s) => s.setName('view').setDescription('Show one case').addIntegerOption(idOption))
  .addSubcommand((s) =>
    s
      .setName('reason')
      .setDescription("Change a case's reason")
      .addIntegerOption(idOption)
      .addStringOption((o) => o.setName('reason').setDescription('New reason').setRequired(true).setMaxLength(500))
  )
  .addSubcommand((s) => s.setName('revoke').setDescription("Revoke a warning (it stays on record but stops counting)").addIntegerOption(idOption))
  .addSubcommand((s) => s.setName('delete').setDescription('Delete a case from the record').addIntegerOption(idOption))
  .addSubcommandGroup((g) =>
    g
      .setName('escalation')
      .setDescription('Automatic actions when a member reaches a number of warnings')
      .addSubcommand((s) =>
        s
          .setName('add')
          .setDescription('At N active warnings, automatically time out / kick / ban')
          .addIntegerOption((o) => o.setName('warnings').setDescription('Number of active warnings').setRequired(true).setMinValue(1).setMaxValue(50))
          .addStringOption((o) =>
            o
              .setName('action')
              .setDescription('What happens')
              .setRequired(true)
              .addChoices({ name: 'Timeout', value: 'timeout' }, { name: 'Kick', value: 'kick' }, { name: 'Ban', value: 'ban' })
          )
          .addStringOption((o) => o.setName('duration').setDescription('Timeout length, or temporary ban length (e.g. 1h, 1d)').setAutocomplete(true))
      )
      .addSubcommand((s) =>
        s
          .setName('remove')
          .setDescription('Remove an escalation rule')
          .addIntegerOption((o) => o.setName('warnings').setDescription('The rule’s warning count').setRequired(true).setMinValue(1))
      )
      .addSubcommand((s) => s.setName('list').setDescription('Show the escalation rules'))
  )
  .addSubcommand((s) =>
    s
      .setName('dm')
      .setDescription('DM members when they’re warned, timed out, kicked or banned')
      .addBooleanOption((o) => o.setName('enabled').setDescription('On or off').setRequired(true))
  );

const caseLine = (c) => {
  const t = TYPES[c.type];
  const when = `<t:${Math.floor(new Date(c.createdAt).getTime() / 1000)}:d>`;
  const extra = [c.durationMs ? formatDuration(c.durationMs) : null, c.auto ? 'auto' : null, c.type === 'warn' && !c.active ? 'revoked' : null].filter(Boolean);
  return `\`#${c.caseId}\` ${t.emoji} **${t.label}** · <@${c.userId}> · ${when}${extra.length ? ` · ${extra.join(' · ')}` : ''}\n-# ${clip(c.reason || 'No reason given', 90)} — by ${c.moderatorTag || 'LoofaryBot'}`;
};

const describeRule = (r) => `**${r.count}** warning${r.count === 1 ? '' : 's'} → ${TYPES[r.action].label.toLowerCase()}${r.durationMs ? ` (${formatDuration(r.durationMs)})` : r.action === 'ban' ? ' (permanent)' : ''}`;

async function execute(interaction) {
  const group = interaction.options.getSubcommandGroup(false);
  const sub = interaction.options.getSubcommand();
  const guildId = interaction.guildId;

  if (group === 'escalation') {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply({ content: '❌ Changing escalation rules needs **Manage Server**.', ephemeral: true });
    }
    const config = await getOrCreateConfig(guildId);
    const rules = [...(config.warnEscalation || [])].map((r) => (r.toObject ? r.toObject() : r));
    if (sub === 'add') {
      const count = interaction.options.getInteger('warnings');
      const action = interaction.options.getString('action');
      const raw = interaction.options.getString('duration');
      const durationMs = raw ? parseDuration(raw) : null;
      if (raw && !durationMs) return interaction.reply({ content: '❌ Invalid duration — use e.g. `1h`, `1d`.', ephemeral: true });
      if (action === 'timeout' && !durationMs) return interaction.reply({ content: '❌ A timeout rule needs a `duration`.', ephemeral: true });
      const rule = { count, action, durationMs: action === 'kick' ? null : action === 'timeout' ? Math.min(durationMs, MAX_TIMEOUT_MS) : durationMs };
      config.warnEscalation = [...rules.filter((r) => r.count !== count), rule].sort((a, b) => a.count - b.count);
      await config.save();
      return interaction.reply({ content: `✅ Rule saved: ${describeRule(rule)}.`, ephemeral: true });
    }
    if (sub === 'remove') {
      const count = interaction.options.getInteger('warnings');
      if (!rules.some((r) => r.count === count)) return interaction.reply({ content: `ℹ️ There's no rule for ${count} warnings.`, ephemeral: true });
      config.warnEscalation = rules.filter((r) => r.count !== count);
      await config.save();
      return interaction.reply({ content: `✅ Removed the ${count}-warning rule.`, ephemeral: true });
    }
    return interaction.reply({
      content: rules.length ? `🔺 **Warning escalation**\n${rules.map((r) => `• ${describeRule(r)}`).join('\n')}` : 'No escalation rules. Add one with `/cases escalation add`.',
      ephemeral: true
    });
  }

  if (sub === 'dm') {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply({ content: '❌ This needs **Manage Server**.', ephemeral: true });
    }
    const config = await getOrCreateConfig(guildId);
    config.modDmEnabled = interaction.options.getBoolean('enabled');
    await config.save();
    return interaction.reply({ content: `✅ Members will ${config.modDmEnabled ? '' : '**not** '}be DM'd about moderation actions.`, ephemeral: true });
  }

  if (sub === 'user' || sub === 'recent') {
    const user = sub === 'user' ? interaction.options.getUser('user') : null;
    const page = interaction.options.getInteger('page') || 1;
    const { cases, total, totalPages } = await listCases(guildId, { userId: user?.id, page, pageSize: 10 });
    if (!total) return interaction.reply({ content: user ? `✨ **${user.tag}** has a clean record.` : 'No cases yet.', ephemeral: true });
    let header = user ? `📁 **${user.tag}** — ${total} case${total === 1 ? '' : 's'}` : `📁 **Latest cases** — ${total} total`;
    if (user) {
      const warns = await ModCase.countDocuments({ guildId, userId: user.id, type: 'warn', active: true });
      header += ` · **${warns}** active warning${warns === 1 ? '' : 's'}`;
    }
    return interaction.reply({
      content: `${header}\n\n${cases.map(caseLine).join('\n')}${totalPages > 1 ? `\n\nPage ${page}/${totalPages}` : ''}`.slice(0, 2000),
      ephemeral: true,
      allowedMentions: { parse: [] }
    });
  }

  const id = interaction.options.getInteger('id');
  if (sub === 'view') {
    const c = await getCase(guildId, id);
    if (!c) return interaction.reply({ content: `❌ Case #${id} doesn't exist.`, ephemeral: true });
    return interaction.reply({ embeds: [caseEmbed(c)], ephemeral: true });
  }
  const result =
    sub === 'reason'
      ? await updateReason(guildId, id, interaction.options.getString('reason'))
      : sub === 'revoke'
        ? await revokeCase(guildId, id, interaction.user.id)
        : await deleteCase(guildId, id);
  if (result.error) return interaction.reply({ content: `❌ ${result.error}`, ephemeral: true });
  const done = { reason: `✏️ Updated the reason on case #${id}.`, revoke: `↩️ Warning #${id} revoked — it no longer counts toward escalation.`, delete: `🗑️ Case #${id} deleted.` }[sub];
  return interaction.reply({ content: done, ephemeral: true });
}

async function autocomplete(interaction) {
  const focused = interaction.options.getFocused(true);
  if (focused.name === 'duration') return interaction.respond(durationChoices(focused.value));
  const typed = String(focused.value || '');
  const filter = { guildId: interaction.guildId };
  if (interaction.options.getSubcommand() === 'revoke') Object.assign(filter, { type: 'warn', active: true });
  if (/^\d+$/.test(typed)) filter.caseId = { $gte: Number(typed) };
  const cases = await ModCase.find(filter).sort(typed ? { caseId: 1 } : { caseId: -1 }).limit(25).lean();
  return interaction.respond(
    cases.map((c) => ({ name: clip(`#${c.caseId} ${TYPES[c.type].label} — ${c.userTag || c.userId}: ${c.reason || 'no reason'}`, 100), value: c.caseId }))
  );
}

module.exports = { data, execute, autocomplete };
