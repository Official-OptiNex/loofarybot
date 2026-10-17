// /guide — browse server guides (everyone) and manage them (editors / admins). Guides are forum posts
// the bot owns, with a pinned auto-updating index. Rich editing happens on the dashboard.
const { SlashCommandBuilder, PermissionFlagsBits, ChannelType, EmbedBuilder } = require('discord.js');
const guides = require('../cogs/modules/guides');
const { getOrCreateConfig } = require('../cogs/modules/leveling');
const { REDIRECT_URI } = require('../../config');

const dashBase = () => {
  try {
    return new URL(REDIRECT_URI).origin;
  } catch {
    return null;
  }
};
const editorLink = (guildId, slug) => {
  const base = dashBase();
  return base ? `${base}/dashboard/${guildId}/guides${slug ? `?edit=${encodeURIComponent(slug)}` : ''}` : null;
};

const data = new SlashCommandBuilder()
  .setName('guide')
  .setDescription('Browse and manage server guides')
  .setDMPermission(false)
  .addSubcommand((s) =>
    s.setName('view').setDescription('Open a guide').addStringOption((o) => o.setName('name').setDescription('Which guide').setRequired(true).setAutocomplete(true))
  )
  .addSubcommand((s) => s.setName('list').setDescription('List all guides').addStringOption((o) => o.setName('tag').setDescription('Filter by category/tag')))
  .addSubcommand((s) => s.setName('search').setDescription('Search guides').addStringOption((o) => o.setName('text').setDescription('What to look for').setRequired(true)))
  .addSubcommand((s) =>
    s
      .setName('create')
      .setDescription('Create a new guide (editors) — opens the web editor to fill it in')
      .addStringOption((o) => o.setName('title').setDescription('Guide title').setRequired(true))
      .addStringOption((o) => o.setName('tag').setDescription('Category/tag (must exist in the forum)'))
  )
  .addSubcommand((s) =>
    s.setName('edit').setDescription('Edit a guide in the web editor (editors)').addStringOption((o) => o.setName('name').setDescription('Which guide').setRequired(true).setAutocomplete(true))
  )
  .addSubcommand((s) =>
    s.setName('delete').setDescription('Delete a guide (editors)').addStringOption((o) => o.setName('name').setDescription('Which guide').setRequired(true).setAutocomplete(true))
  )
  .addSubcommand((s) =>
    s
      .setName('setup')
      .setDescription('Set up guides (admin)')
      .addChannelOption((o) => o.setName('forum').setDescription('The forum channel guides are posted in').setRequired(true).addChannelTypes(ChannelType.GuildForum))
      .addRoleOption((o) => o.setName('editor_role').setDescription('Role allowed to create/edit guides'))
      .addChannelOption((o) => o.setName('editor_channel').setDescription('Existing channel to use as the private editor channel (leave empty to create one)').addChannelTypes(ChannelType.GuildText))
      .addBooleanOption((o) => o.setName('make_editor_channel').setDescription('Create a private #guide-editors channel (default yes)'))
  )
  .addSubcommand((s) => s.setName('editor_add').setDescription('Add a guide editor role (admin)').addRoleOption((o) => o.setName('role').setDescription('Role').setRequired(true)))
  .addSubcommand((s) => s.setName('editor_remove').setDescription('Remove a guide editor role (admin)').addRoleOption((o) => o.setName('role').setDescription('Role').setRequired(true)))
  .addSubcommand((s) => s.setName('legend').setDescription('Rebuild the pinned guides index (admin)'));

const isAdmin = (interaction) =>
  interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) || interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);

async function autocomplete(interaction) {
  const typed = (interaction.options.getFocused() || '').toLowerCase();
  const list = await guides.listGuides(interaction.guildId);
  const choices = list
    .filter((g) => g.title.toLowerCase().includes(typed))
    .slice(0, 25)
    .map((g) => ({ name: g.title.slice(0, 100), value: g.slug }));
  return interaction.respond(choices);
}

async function execute(interaction) {
  const sub = interaction.options.getSubcommand();
  const guild = interaction.guild;
  const o = interaction.options;
  const settings = guides.guidesSettings(await getOrCreateConfig(guild.id));
  const reply = (content, ephemeral = true) => interaction.reply({ content, ephemeral, allowedMentions: { parse: [] } });

  // ---- browse (everyone)
  if (sub === 'view') {
    const g = await guides.getGuide(guild.id, o.getString('name'));
    if (!g) return reply('❌ No guide by that name.');
    const link = g.threadId ? `https://discord.com/channels/${guild.id}/${g.threadId}` : null;
    const body = g.body || {};
    const embeds = [];
    // Show a preview: the guide's first embed, or its content as a description.
    if (Array.isArray(body.embeds) && body.embeds.length) {
      embeds.push(EmbedBuilder.from(body.embeds[0]));
    } else if (body.content) {
      embeds.push(new EmbedBuilder().setColor('#5865f2').setDescription(String(body.content).slice(0, 4096)));
    }
    const header = embeds[0] || new EmbedBuilder().setColor('#5865f2');
    header.setAuthor({ name: `📖 ${g.title}`.slice(0, 256) });
    if (g.tags?.length) header.setFooter({ text: g.tags.join(' · ') });
    const rows = link
      ? [{ type: 1, components: [{ type: 2, style: 5, label: 'Open full guide', url: link }] }]
      : [];
    return interaction.reply({ embeds: [header], components: rows, ephemeral: true, allowedMentions: { parse: [] } });
  }

  if (sub === 'list' || sub === 'search') {
    const tag = sub === 'list' ? o.getString('tag') : null;
    let list = sub === 'search' ? await guides.searchGuides(guild.id, o.getString('text')) : await guides.listGuides(guild.id);
    if (tag) list = list.filter((g) => (g.tags || []).some((t) => t.toLowerCase() === tag.toLowerCase()));
    if (!list.length) return reply(sub === 'search' ? 'No guides matched that.' : 'No guides yet.');
    const lines = list.slice(0, 40).map((g) => `• [${g.title}](https://discord.com/channels/${guild.id}/${g.threadId})${g.tags?.length ? ` — ${g.tags.join(', ')}` : ''}`);
    const embed = new EmbedBuilder()
      .setColor('#5865f2')
      .setTitle(sub === 'search' ? `🔎 Guides matching “${o.getString('text')}”` : tag ? `📖 Guides · ${tag}` : '📖 Guides')
      .setDescription(lines.join('\n').slice(0, 4096))
      .setFooter({ text: `${list.length} guide${list.length === 1 ? '' : 's'}` });
    return interaction.reply({ embeds: [embed], ephemeral: true, allowedMentions: { parse: [] } });
  }

  // ---- editor actions
  if (sub === 'create' || sub === 'edit' || sub === 'delete') {
    if (!guides.isEditor(interaction.member, settings)) return reply('🔒 Only guide editors can do that.');
    if (!settings.forumChannelId) return reply('❌ Guides aren’t set up yet — an admin needs to run `/guide setup`.');

    const approvals = require('../cogs/modules/guideApprovals');
    const by = { id: interaction.user.id, tag: interaction.user.tag || interaction.user.username };
    if (sub === 'create') {
      await interaction.deferReply({ ephemeral: true });
      const tag = o.getString('tag');
      if (approvals.needsApproval(settings, 'create', isAdmin(interaction))) {
        const req = await approvals.requestChange(guild, { type: 'create', payload: { title: o.getString('title'), tags: tag ? [tag] : [], body: { embeds: [] } } }, by, settings);
        return interaction.editReply({ content: req.error ? `❌ ${req.error}` : `⏳ Sent to an admin for approval — you'll get a DM when it's decided. Once it's approved, fill it in on the dashboard.` });
      }
      const res = await guides.createGuide(
        guild,
        { title: o.getString('title'), tags: tag ? [tag] : [], authorId: interaction.user.id, createdBy: interaction.user.id },
        settings
      );
      if (res.error) return interaction.editReply({ content: `❌ ${res.error}` });
      const link = editorLink(guild.id, res.guide.slug);
      const post = `https://discord.com/channels/${guild.id}/${res.guide.threadId}`;
      return interaction.editReply({ content: `✅ Created **${res.guide.title}** → ${post}\n${link ? `✍️ Fill it in here: ${link}` : 'Edit it on the dashboard’s Guides page.'}` });
    }

    const g = await guides.getGuide(guild.id, o.getString('name'));
    if (!g) return reply('❌ No guide by that name.');

    if (sub === 'delete') {
      await interaction.deferReply({ ephemeral: true });
      if (approvals.needsApproval(settings, 'delete', isAdmin(interaction))) {
        const req = await approvals.requestChange(guild, { type: 'delete', slug: g.slug }, by, settings);
        return interaction.editReply({ content: req.error ? `❌ ${req.error}` : `⏳ Asked an admin to delete **${g.title}** — you'll get a DM when it's decided.` });
      }
      const res = await guides.deleteGuide(guild, g.slug, settings);
      return interaction.editReply({ content: res.error ? `❌ ${res.error}` : `🗑️ Deleted **${res.title}**.` });
    }
    // edit → hand off to the web editor
    const link = editorLink(guild.id, g.slug);
    const post = `https://discord.com/channels/${guild.id}/${g.threadId}`;
    return reply(link ? `✍️ Edit **${g.title}** in the web editor: ${link}\n(The forum post: ${post})` : `Open the dashboard’s Guides page to edit **${g.title}**.`);
  }

  // ---- admin
  if (!isAdmin(interaction)) return reply('🔒 You need **Manage Server** for that.');

  if (sub === 'setup') {
    await interaction.deferReply({ ephemeral: true });
    const forum = o.getChannel('forum');
    const editorRole = o.getRole('editor_role');
    const saved = await guides.saveSettings(guild, {
      enabled: true,
      forumChannelId: forum.id,
      editorRoleIds: editorRole ? [...new Set([...settings.editorRoleIds, editorRole.id])] : settings.editorRoleIds
    });
    if (saved.error) return interaction.editReply({ content: `❌ ${saved.error}` });
    let note = `✅ Guides are on in <#${forum.id}>${editorRole ? ` · editor role ${editorRole}` : ''}.`;
    // Editor channel: use the one given, or create one unless told not to.
    const existing = o.getChannel('editor_channel');
    const make = o.getBoolean('make_editor_channel');
    if (existing || make !== false) {
      const ec = await guides.ensureEditorChannel(guild, saved.settings, existing ? { existingId: existing.id } : {});
      note += ec.error ? `\n⚠️ Editor channel: ${ec.error}` : `\n🔒 Editor channel: <#${ec.channel.id}>`;
    }
    await guides.rebuildLegend(guild, saved.settings);
    const link = editorLink(guild.id, null);
    if (link) note += `\n🧭 Manage guides on the dashboard: ${link}`;
    return interaction.editReply({ content: note, allowedMentions: { parse: [] } });
  }

  if (sub === 'editor_add' || sub === 'editor_remove') {
    const role = o.getRole('role');
    const next =
      sub === 'editor_add'
        ? [...new Set([...settings.editorRoleIds, role.id])]
        : settings.editorRoleIds.filter((id) => id !== role.id);
    const saved = await guides.saveSettings(guild, { editorRoleIds: next });
    if (saved.error) return reply(`❌ ${saved.error}`);
    return reply(sub === 'editor_add' ? `✅ ${role} can now edit guides.` : `✅ ${role} can no longer edit guides.`);
  }

  if (sub === 'legend') {
    if (!settings.forumChannelId) return reply('❌ Set a forum channel first with `/guide setup`.');
    await interaction.deferReply({ ephemeral: true });
    await guides.rebuildLegend(guild, settings);
    return interaction.editReply({ content: '✅ Rebuilt the 📖 Guides Index.' });
  }

  return reply('Unknown subcommand.');
}

module.exports = { data, execute, autocomplete };
