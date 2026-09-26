const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const GuildConfig = require('../../database/models/GuildConfig');
const { getOrCreateConfig } = require('../cogs/modules/leveling'); // shared per-guild config helper

const data = new SlashCommandBuilder()
  .setName('autorole')
  .setDescription('Automatically grant a role to new members')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
  .addSubcommand((sub) =>
    sub
      .setName('set')
      .setDescription('Choose the role every new member should receive on join')
      .addRoleOption((opt) => opt.setName('role').setDescription('Role to auto-assign').setRequired(true))
  )
  .addSubcommand((sub) => sub.setName('disable').setDescription('Turn off auto-role assignment'))
  .addSubcommand((sub) => sub.setName('status').setDescription('Show the current auto-role configuration'))
  .addSubcommand((sub) =>
    sub
      .setName('sync')
      .setDescription('Retroactively grant the configured auto-role to every existing member who lacks it')
  );

function checkRoleHierarchy(guild, role) {
  const botMember = guild.members.me;
  if (!botMember || !role) return true;
  return botMember.roles.highest.position > role.position;
}

async function execute(interaction) {
  const sub = interaction.options.getSubcommand();

  if (sub === 'set') {
    const role = interaction.options.getRole('role');
    const config = await getOrCreateConfig(interaction.guildId);
    config.autoRoleId = role.id;
    config.autoRoleEnabled = true;
    await config.save();

    const hierarchyOk = checkRoleHierarchy(interaction.guild, role);
    const warning = hierarchyOk
      ? ''
      : `\n⚠️ **Heads up:** LoofaryBot's role is currently *below* ${role} in Server Settings → Roles, ` +
        `so it won't be able to grant it until you move LoofaryBot's role above it.`;

    return interaction.reply({
      content: `✅ New members will now automatically receive ${role}. Use \`/autorole sync\` to grant it to existing members too.${warning}`,
      ephemeral: true
    });
  }

  if (sub === 'disable') {
    const config = await getOrCreateConfig(interaction.guildId);
    config.autoRoleEnabled = false;
    await config.save();
    return interaction.reply({ content: '✅ Auto-role has been disabled.', ephemeral: true });
  }

  if (sub === 'status') {
    const config = await GuildConfig.findOne({ guildId: interaction.guildId });
    if (!config || !config.autoRoleId) {
      return interaction.reply({ content: 'Auto-role has not been configured yet. Use `/autorole set`.', ephemeral: true });
    }
    const embed = new EmbedBuilder()
      .setTitle('Auto-Role Status')
      .setColor('#5865F2')
      .addFields(
        { name: 'Role', value: `<@&${config.autoRoleId}>`, inline: true },
        { name: 'Enabled', value: config.autoRoleEnabled ? 'Yes' : 'No', inline: true }
      );
    return interaction.reply({ embeds: [embed], ephemeral: true });
  }

  if (sub === 'sync') {
    const config = await GuildConfig.findOne({ guildId: interaction.guildId });
    if (!config || !config.autoRoleId) {
      return interaction.reply({ content: '❌ No auto-role is configured. Use `/autorole set` first.', ephemeral: true });
    }

    const role = interaction.guild.roles.cache.get(config.autoRoleId);
    if (!role) {
      return interaction.reply({ content: '❌ The configured role no longer exists.', ephemeral: true });
    }
    if (!checkRoleHierarchy(interaction.guild, role)) {
      return interaction.reply({
        content: `❌ LoofaryBot's role is below ${role} in Server Settings → Roles — move it above before syncing.`,
        ephemeral: true
      });
    }

    // Syncing can take a while on large servers (one API call per member that needs the role),
    // so defer immediately and report progress once it's done.
    await interaction.deferReply({ ephemeral: true });

    const members = await interaction.guild.members.fetch();
    const needsRole = members.filter((m) => !m.user.bot && !m.roles.cache.has(role.id));

    let granted = 0;
    let failed = 0;
    for (const member of needsRole.values()) {
      try {
        await member.roles.add(role, 'Auto-role sync');
        granted++;
      } catch (err) {
        failed++;
      }
    }

    return interaction.editReply({
      content:
        `✅ Sync complete. Granted ${role} to **${granted}** member(s).` +
        (failed > 0 ? ` Failed for ${failed} member(s) (check the bot's permissions/hierarchy).` : '')
    });
  }
}

module.exports = { data, execute };
