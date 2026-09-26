const { EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const commandReference = require('../../commandReference');
const { REDIRECT_URI } = require('../../../config');

const BRAND_COLOR = '#4F7CFF';

// The dashboard lives on the same host as the OAuth redirect.
function dashboardUrl(guildId) {
  if (!REDIRECT_URI) return null;
  try {
    return `${new URL(REDIRECT_URI).origin}/dashboard${guildId ? `/${guildId}` : ''}`;
  } catch {
    return null;
  }
}

const permTag = (perm) => (perm ? ` · 🔒 ${perm}` : '');

function overviewEmbed(client) {
  const total = commandReference.reduce((n, g) => n + g.commands.length, 0);
  return new EmbedBuilder()
    .setColor(BRAND_COLOR)
    .setAuthor({ name: 'LoofaryBot Help', iconURL: client.user?.displayAvatarURL({ size: 64 }) })
    .setTitle('What can I do?')
    .setDescription(
      `**${total} commands** across ${commandReference.length} categories. Pick a category from the menu below to see its commands.\n` +
        '-# 🔒 marks commands that need a permission. Most settings can also be changed on the web dashboard.'
    )
    .addFields(
      commandReference.map((g) => ({
        name: `${g.icon} ${g.group}`,
        value: `${g.blurb}\n-# ${g.commands.length} command${g.commands.length === 1 ? '' : 's'}`,
        inline: true
      }))
    )
    .setFooter({ text: 'Tip: type / in chat to see every command with its options' });
}

function categoryEmbed(group) {
  const lines = group.commands.map((c) => `**\`${c.usage}\`**${permTag(c.perm)}\n${c.description}`);
  return new EmbedBuilder()
    .setColor(BRAND_COLOR)
    .setTitle(`${group.icon} ${group.group}`)
    .setDescription(`${group.blurb}\n\n${lines.join('\n\n')}`.slice(0, 4096))
    .setFooter({ text: `${group.commands.length} commands · choose another category below` });
}

/**
 * Help message for the overview (categoryId null) or one category, with a category picker and a
 * dashboard link. Shared by /loof help and the picker's select-menu handler.
 */
function buildHelpMessage(client, guildId, categoryId = null) {
  const group = commandReference.find((g) => g.id === categoryId);
  const menu = new StringSelectMenuBuilder()
    .setCustomId('help_cat')
    .setPlaceholder('Browse a category…')
    .addOptions(
      { label: 'Overview', value: 'overview', emoji: '🏠', description: 'All categories at a glance', default: !group },
      ...commandReference.map((g) => ({
        label: g.group,
        value: g.id,
        emoji: g.icon,
        description: g.blurb.slice(0, 100),
        default: group?.id === g.id
      }))
    );

  const components = [new ActionRowBuilder().addComponents(menu)];
  const url = dashboardUrl(guildId);
  if (url) {
    components.push(
      new ActionRowBuilder().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(url).setLabel('Open web dashboard').setEmoji('🖥️'))
    );
  }
  return { embeds: [group ? categoryEmbed(group) : overviewEmbed(client)], components };
}

async function handleHelpSelect(interaction) {
  const value = interaction.values[0];
  return interaction.update(buildHelpMessage(interaction.client, interaction.guildId, value === 'overview' ? null : value));
}

module.exports = { buildHelpMessage, handleHelpSelect, dashboardUrl };
