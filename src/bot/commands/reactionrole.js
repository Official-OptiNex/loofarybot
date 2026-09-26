const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const ReactionRolePanel = require('../../database/models/ReactionRolePanel');
const { MAX_ROLES, buildPanelMessage, withRoleNames, refreshPanel, canManageRole } = require('../cogs/modules/reactionRoles');
const { resolveColor } = require('../cogs/modules/giveaways');

const messageIdOption = (opt) => opt.setName('message_id').setDescription('Role panel — start typing its title').setRequired(true).setAutocomplete(true);

const data = new SlashCommandBuilder()
  .setName('reactionrole')
  .setDescription('Self-assignable role panels (buttons or dropdowns)')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
  .addSubcommand((sub) =>
    sub
      .setName('create')
      .setDescription('Post a new role panel')
      .addChannelOption((opt) =>
        opt.setName('channel').setDescription('Where to post it').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true)
      )
      .addStringOption((opt) => opt.setName('title').setDescription('Panel title').setMaxLength(256).setRequired(true))
      .addStringOption((opt) =>
        opt
          .setName('mode')
          .setDescription('How members pick roles (default: buttons)')
          .addChoices(
            { name: 'Buttons (toggle each role)', value: 'buttons' },
            { name: 'Dropdown — pick many', value: 'select' },
            { name: 'Dropdown — pick one', value: 'select_single' }
          )
      )
      .addStringOption((opt) => opt.setName('description').setDescription('Text shown above the role list').setMaxLength(2000))
      .addStringOption((opt) => opt.setName('color').setDescription('Hex or name color'))
      .addRoleOption((opt) => opt.setName('role1').setDescription('First role (optional — you can add more later)'))
      .addRoleOption((opt) => opt.setName('role2').setDescription('Another role'))
      .addRoleOption((opt) => opt.setName('role3').setDescription('Another role'))
  )
  .addSubcommand((sub) =>
    sub
      .setName('add')
      .setDescription('Add a role to a panel')
      .addStringOption(messageIdOption)
      .addRoleOption((opt) => opt.setName('role').setDescription('Role to add').setRequired(true))
      .addStringOption((opt) => opt.setName('label').setDescription('Button/option text (defaults to the role name)').setMaxLength(80))
      .addStringOption((opt) => opt.setName('emoji').setDescription('Emoji to show next to it'))
  )
  .addSubcommand((sub) =>
    sub
      .setName('remove')
      .setDescription('Remove a role from a panel')
      .addStringOption(messageIdOption)
      .addRoleOption((opt) => opt.setName('role').setDescription('Role to remove').setRequired(true))
  )
  .addSubcommand((sub) => sub.setName('delete').setDescription('Delete a role panel').addStringOption(messageIdOption))
  .addSubcommand((sub) => sub.setName('list').setDescription('List role panels in this server'));

async function findPanel(interaction) {
  const messageId = interaction.options.getString('message_id').trim();
  return ReactionRolePanel.findOne({ messageId, guildId: interaction.guildId });
}

async function execute(interaction) {
  const sub = interaction.options.getSubcommand();
  await interaction.deferReply({ ephemeral: true });

  if (sub === 'create') {
    const channel = interaction.options.getChannel('channel');
    const roles = ['role1', 'role2', 'role3'].map((n) => interaction.options.getRole(n)).filter(Boolean);
    for (const role of roles) {
      const problem = canManageRole(interaction.guild, role);
      if (problem) return interaction.editReply(`❌ ${problem}`);
    }

    const panel = new ReactionRolePanel({
      guildId: interaction.guildId,
      channelId: channel.id,
      messageId: 'pending',
      title: interaction.options.getString('title'),
      description: interaction.options.getString('description') || '',
      color: resolveColor(interaction.options.getString('color')),
      mode: interaction.options.getString('mode') || 'buttons',
      roles: [...new Map(roles.map((r) => [r.id, { roleId: r.id }])).values()]
    });

    let msg;
    try {
      msg = await channel.send(buildPanelMessage(withRoleNames(panel, interaction.guild)));
    } catch {
      return interaction.editReply(`❌ Couldn't post in ${channel} — check LoofaryBot's permissions there.`);
    }
    panel.messageId = msg.id;
    await panel.save();

    return interaction.editReply(
      `✅ Role panel posted in ${channel} — [jump](${msg.url}).\nMessage ID: \`${msg.id}\`\nAdd roles with \`/reactionrole add message_id:${msg.id}\`.`
    );
  }

  if (sub === 'list') {
    const panels = await ReactionRolePanel.find({ guildId: interaction.guildId }).lean();
    if (!panels.length) return interaction.editReply('No role panels yet. Create one with `/reactionrole create`.');
    return interaction.editReply(
      panels.map((p) => `• **${p.title}** in <#${p.channelId}> — \`${p.messageId}\` · ${p.roles.length} role(s) · ${p.mode}`).join('\n')
    );
  }

  const panel = await findPanel(interaction);
  if (!panel) return interaction.editReply('❌ No role panel with that message ID in this server.');

  if (sub === 'add') {
    const role = interaction.options.getRole('role');
    const problem = canManageRole(interaction.guild, role);
    if (problem) return interaction.editReply(`❌ ${problem}`);

    const label = interaction.options.getString('label');
    const emoji = interaction.options.getString('emoji');
    const existing = panel.roles.find((r) => r.roleId === role.id);
    if (existing) {
      if (label) existing.label = label;
      if (emoji) existing.emoji = emoji;
    } else {
      if (panel.roles.length >= MAX_ROLES) return interaction.editReply(`❌ A panel can hold at most ${MAX_ROLES} roles.`);
      panel.roles.push({ roleId: role.id, label: label || null, emoji: emoji || null });
    }

    try {
      if (!(await refreshPanel(panel, interaction.guild))) return interaction.editReply('❌ The panel message was deleted.');
    } catch (err) {
      return interaction.editReply(`❌ Discord rejected the update — is \`${emoji}\` a valid emoji? (${err.message})`);
    }
    await panel.save();
    return interaction.editReply(`✅ ${existing ? 'Updated' : 'Added'} ${role} on the panel.`);
  }

  if (sub === 'remove') {
    const role = interaction.options.getRole('role');
    const before = panel.roles.length;
    panel.roles = panel.roles.filter((r) => r.roleId !== role.id);
    if (panel.roles.length === before) return interaction.editReply(`❌ ${role} isn't on that panel.`);
    await panel.save();
    await refreshPanel(panel, interaction.guild).catch(() => null);
    return interaction.editReply(`✅ Removed ${role} from the panel.`);
  }

  if (sub === 'delete') {
    const channel = interaction.guild.channels.cache.get(panel.channelId);
    const msg = channel ? await channel.messages.fetch(panel.messageId).catch(() => null) : null;
    if (msg) await msg.delete().catch(() => null);
    await panel.deleteOne();
    return interaction.editReply('✅ Role panel deleted.');
  }
}

async function autocomplete(interaction) {
  const query = String(interaction.options.getFocused() || '').toLowerCase();
  const panels = await ReactionRolePanel.find({ guildId: interaction.guildId }).sort({ createdAt: -1 }).limit(100).lean();
  return interaction.respond(
    panels
      .filter((p) => !query || p.title.toLowerCase().includes(query) || p.messageId.includes(query))
      .slice(0, 25)
      .map((p) => ({
        name: `🎭 ${p.title.slice(0, 60)} — #${interaction.guild.channels.cache.get(p.channelId)?.name || 'deleted-channel'} · ${p.roles.length} role(s)`.slice(0, 100),
        value: p.messageId
      }))
  );
}

module.exports = { data, execute, autocomplete };
