const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  PermissionFlagsBits
} = require('discord.js');
const ReactionRolePanel = require('../../../database/models/ReactionRolePanel');

const MAX_ROLES = 25;

function buildPanelMessage(panel) {
  const lines = panel.roles.map((r) => `${r.emoji ? `${r.emoji} ` : ''}<@&${r.roleId}>${r.label ? ` — ${r.label}` : ''}`);
  const hint =
    panel.mode === 'buttons'
      ? 'Click a button to add or remove that role.'
      : panel.mode === 'select_single'
        ? 'Pick one role from the menu below.'
        : 'Pick any roles from the menu below — unselect to remove.';

  const embed = new EmbedBuilder()
    .setTitle(panel.title)
    .setColor(panel.color || '#5865F2')
    .setDescription(
      [panel.description, lines.length ? lines.join('\n') : '*No roles added yet — use `/reactionrole add`.*', `\n-# ${hint}`]
        .filter(Boolean)
        .join('\n\n')
    );

  const components = [];
  if (panel.roles.length > 0) {
    if (panel.mode === 'buttons') {
      for (let i = 0; i < panel.roles.length; i += 5) {
        const row = new ActionRowBuilder();
        for (const r of panel.roles.slice(i, i + 5)) {
          const btn = new ButtonBuilder().setCustomId(`rr:${r.roleId}`).setStyle(ButtonStyle.Secondary);
          const roleLabel = r.label || r.roleName || 'Role';
          btn.setLabel(roleLabel.slice(0, 80));
          if (r.emoji) btn.setEmoji(r.emoji);
          row.addComponents(btn);
        }
        components.push(row);
      }
    } else {
      const single = panel.mode === 'select_single';
      const menu = new StringSelectMenuBuilder()
        .setCustomId('rrsel')
        .setPlaceholder(single ? 'Choose a role' : 'Choose your roles')
        .setMinValues(0)
        .setMaxValues(single ? 1 : panel.roles.length)
        .addOptions(
          panel.roles.map((r) => {
            const opt = { label: (r.label || r.roleName || 'Role').slice(0, 100), value: r.roleId };
            if (r.emoji) opt.emoji = r.emoji;
            return opt;
          })
        );
      components.push(new ActionRowBuilder().addComponents(menu));
    }
  }
  return { embeds: [embed], components, allowedMentions: { parse: [] } };
}

// Button/select labels fall back to the role's current name when no custom label was given.
function withRoleNames(panel, guild) {
  const obj = panel.toObject ? panel.toObject() : panel;
  obj.roles = obj.roles.map((r) => ({ ...r, roleName: guild.roles.cache.get(r.roleId)?.name || 'Deleted role' }));
  return obj;
}

async function refreshPanel(panel, guild) {
  const channel = guild.channels.cache.get(panel.channelId);
  const msg = channel ? await channel.messages.fetch(panel.messageId).catch(() => null) : null;
  if (!msg) return false;
  await msg.edit(buildPanelMessage(withRoleNames(panel, guild)));
  return true;
}

function canManageRole(guild, role) {
  const me = guild.members.me;
  if (!me || !me.permissions.has(PermissionFlagsBits.ManageRoles)) return 'LoofaryBot needs the **Manage Roles** permission.';
  if (role.managed) return `${role} is managed by an integration and can't be self-assigned.`;
  if (role.id === guild.id) return "@everyone can't be used.";
  if (me.roles.highest.position <= role.position) return `LoofaryBot's role must be **above** ${role} in Server Settings → Roles.`;
  return null;
}

async function handleRoleButton(interaction) {
  const roleId = interaction.customId.split(':')[1];
  const panel = await ReactionRolePanel.findOne({ messageId: interaction.message.id }).lean();
  if (!panel || !panel.roles.some((r) => r.roleId === roleId)) {
    return interaction.reply({ content: '❌ This role option is no longer available.', ephemeral: true });
  }
  const role = interaction.guild.roles.cache.get(roleId);
  const problem = role ? canManageRole(interaction.guild, role) : 'That role no longer exists.';
  if (problem) return interaction.reply({ content: `❌ ${problem}`, ephemeral: true });

  const member = interaction.member;
  if (member.roles.cache.has(roleId)) {
    await member.roles.remove(roleId, 'Reaction role');
    return interaction.reply({ content: `➖ Removed ${role}.`, ephemeral: true });
  }
  await member.roles.add(roleId, 'Reaction role');
  return interaction.reply({ content: `➕ Added ${role}.`, ephemeral: true });
}

async function handleRoleSelect(interaction) {
  const panel = await ReactionRolePanel.findOne({ messageId: interaction.message.id }).lean();
  if (!panel) return interaction.reply({ content: '❌ This role menu no longer exists.', ephemeral: true });

  const member = interaction.member;
  const selected = new Set(interaction.values);
  const added = [];
  const removed = [];
  const problems = [];

  for (const { roleId } of panel.roles) {
    const role = interaction.guild.roles.cache.get(roleId);
    if (!role) continue;
    const wants = selected.has(roleId);
    const has = member.roles.cache.has(roleId);
    if (wants === has) continue;
    const problem = canManageRole(interaction.guild, role);
    if (problem) {
      problems.push(problem);
      continue;
    }
    if (wants) {
      await member.roles.add(roleId, 'Reaction role menu');
      added.push(`${role}`);
    } else {
      await member.roles.remove(roleId, 'Reaction role menu');
      removed.push(`${role}`);
    }
  }

  const parts = [];
  if (added.length) parts.push(`➕ Added ${added.join(', ')}`);
  if (removed.length) parts.push(`➖ Removed ${removed.join(', ')}`);
  if (problems.length) parts.push(`❌ ${[...new Set(problems)].join('\n❌ ')}`);
  return interaction.reply({ content: parts.join('\n') || 'No changes — you already have exactly those roles.', ephemeral: true });
}

module.exports = { MAX_ROLES, buildPanelMessage, withRoleNames, refreshPanel, canManageRole, handleRoleButton, handleRoleSelect };
