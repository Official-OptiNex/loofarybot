// /ticket — set up the support ticket panel and manage tickets from inside a ticket channel.
const { SlashCommandBuilder, PermissionFlagsBits, ChannelType, EmbedBuilder } = require('discord.js');
const Ticket = require('../../database/models/Ticket');
const tickets = require('../cogs/modules/tickets');
const { dashboardUrl } = require('../cogs/modules/help');

const data = new SlashCommandBuilder()
  .setName('ticket')
  .setDescription('Support tickets')
  .addSubcommand((s) =>
    s
      .setName('setup')
      .setDescription('Set up tickets and post (or update) the "Open a ticket" panel')
      .addChannelOption((o) =>
        o.setName('channel').setDescription('Where to post the panel').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true)
      )
      .addChannelOption((o) => o.setName('category').setDescription('Category to create ticket channels in').addChannelTypes(ChannelType.GuildCategory))
      .addRoleOption((o) => o.setName('support_role').setDescription('Role that can see and manage tickets'))
      .addRoleOption((o) => o.setName('support_role_2').setDescription('Another support role'))
      .addRoleOption((o) => o.setName('support_role_3').setDescription('Another support role'))
      .addStringOption((o) =>
        o
          .setName('name_format')
          .setDescription('Ticket channel names')
          .addChoices(
            { name: 'ticket-0001', value: 'ticket-{number}' },
            { name: 'ticket-username', value: 'ticket-{username}' },
            { name: 'username-0001', value: '{username}-{number}' }
          )
      )
      .addStringOption((o) => o.setName('title').setDescription('Panel title').setMaxLength(256))
      .addStringOption((o) => o.setName('description').setDescription('Panel text (use the dashboard for multiple lines)').setMaxLength(2000))
      .addStringOption((o) => o.setName('color').setDescription('Panel color, e.g. #5865F2').setMaxLength(7))
      .addStringOption((o) => o.setName('thumbnail').setDescription('Small image link (top right)').setMaxLength(500))
      .addStringOption((o) => o.setName('banner').setDescription('Large image link (bottom)').setMaxLength(500))
      .addStringOption((o) => o.setName('footer').setDescription('Panel footer text').setMaxLength(2048))
      .addStringOption((o) => o.setName('button_label').setDescription('Button text (default "Open a ticket")').setMaxLength(80))
      .addStringOption((o) =>
        o
          .setName('button_style')
          .setDescription('Button color')
          .addChoices(
            { name: 'Blurple (Primary)', value: 'Primary' },
            { name: 'Green (Success)', value: 'Success' },
            { name: 'Grey (Secondary)', value: 'Secondary' },
            { name: 'Red (Danger)', value: 'Danger' }
          )
      )
      .addStringOption((o) => o.setName('button_emoji').setDescription('Button emoji (default 🎫)').setMaxLength(64))
      .addIntegerOption((o) => o.setName('max_open').setDescription('Open tickets allowed per member (default 1, 0 = no limit)').setMinValue(0).setMaxValue(10))
      .addBooleanOption((o) => o.setName('ask_reason').setDescription('Ask members what they need help with before opening'))
      .addChannelOption((o) =>
        o.setName('log_channel').setDescription('Post a summary + transcript here when tickets close').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
      )
      .addBooleanOption((o) => o.setName('dm_on_close').setDescription('DM members when their ticket is closed (default on)'))
  )
  .addSubcommand((s) =>
    s.setName('close').setDescription('Close this ticket').addStringOption((o) => o.setName('reason').setDescription('Why it was closed').setMaxLength(500))
  )
  .addSubcommand((s) => s.setName('claim').setDescription('Claim this ticket (or unclaim it if it is yours)'))
  .addSubcommand((s) =>
    s.setName('add').setDescription('Let someone else see this ticket').addUserOption((o) => o.setName('user').setDescription('Member to add').setRequired(true))
  )
  .addSubcommand((s) =>
    s.setName('remove').setDescription('Remove someone you added from this ticket').addUserOption((o) => o.setName('user').setDescription('Member to remove').setRequired(true))
  )
  .addSubcommand((s) =>
    s.setName('rename').setDescription('Rename this ticket channel').addStringOption((o) => o.setName('name').setDescription('New channel name').setRequired(true).setMaxLength(90))
  )
  .addSubcommand((s) => s.setName('list').setDescription('Open tickets in this server (support team)'))
  .addSubcommand((s) => s.setName('panel').setDescription('Re-post the ticket panel (e.g. after it was deleted)'))
  .addSubcommand((s) =>
    s.setName('toggle').setDescription('Turn the ticket system on or off').addBooleanOption((o) => o.setName('enabled').setDescription('On or off').setRequired(true))
  );

const needsManageServer = new Set(['setup', 'panel', 'toggle']);

async function execute(interaction) {
  const sub = interaction.options.getSubcommand();
  const guild = interaction.guild;

  if (needsManageServer.has(sub) && !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    return interaction.reply({ content: '❌ Setting up tickets needs **Manage Server**.', ephemeral: true });
  }

  if (sub === 'setup') {
    const o = interaction.options;
    const input = {};
    const cat = o.getChannel('category');
    if (cat) input.categoryId = cat.id;
    const roles = ['support_role', 'support_role_2', 'support_role_3'].map((k) => o.getRole(k)).filter(Boolean);
    if (roles.length) input.supportRoleIds = roles.map((r) => r.id);
    if (o.getString('name_format')) input.nameFormat = o.getString('name_format');
    if (o.getInteger('max_open') !== null) input.maxOpenPerUser = o.getInteger('max_open');
    if (o.getBoolean('ask_reason') !== null) input.askReason = o.getBoolean('ask_reason');
    if (o.getBoolean('dm_on_close') !== null) input.dmOnClose = o.getBoolean('dm_on_close');
    if (o.getChannel('log_channel')) input.logChannelId = o.getChannel('log_channel').id;
    const panel = {};
    for (const [opt, key] of [['title', 'title'], ['description', 'description'], ['color', 'color'], ['thumbnail', 'thumbnailUrl'], ['banner', 'imageUrl'], ['footer', 'footer']]) {
      if (o.getString(opt) !== null) panel[key] = key === 'description' ? o.getString(opt).replace(/\\n/g, '\n') : o.getString(opt);
    }
    if (Object.keys(panel).length) input.panel = panel;
    const button = {};
    if (o.getString('button_label')) button.label = o.getString('button_label');
    if (o.getString('button_style')) button.style = o.getString('button_style');
    if (o.getString('button_emoji')) button.emoji = o.getString('button_emoji');
    if (Object.keys(button).length) input.button = button;
    input.enabled = true;

    const { patch, error } = tickets.cleanSettings(guild, input);
    if (error) return interaction.reply({ content: `❌ ${error}`, ephemeral: true });
    await interaction.deferReply({ ephemeral: true });
    const s = await tickets.saveSettings(guild.id, patch);
    const posted = await tickets.publishPanel(guild, o.getChannel('channel').id);
    if (posted.error) return interaction.editReply(`⚠️ Settings saved, but the panel couldn't be posted: ${posted.error}`);
    const missing = tickets.missingBotPerms(guild, s);
    return interaction.editReply(
      `✅ **Tickets are set up.** Panel: ${posted.message.url}\n` +
        `**Category:** ${s.categoryId ? `<#${s.categoryId}>` : 'none (top of the channel list)'} · **Support:** ${s.supportRoleIds.map((id) => `<@&${id}>`).join(' ') || 'admins only'} · ` +
        `**Names:** \`${tickets.channelName(s.nameFormat, 1, interaction.user)}\` · **Per member:** ${s.maxOpenPerUser || 'no limit'}` +
        (missing.length ? `\n⚠️ LoofaryBot still needs **${missing.join(', ')}** to create ticket channels.` : '') +
        `\n-# Change the look, welcome message and more on the dashboard: ${dashboardUrl(guild.id)}`
    );
  }

  if (sub === 'panel') {
    await interaction.deferReply({ ephemeral: true });
    const posted = await tickets.publishPanel(guild);
    return interaction.editReply(posted.error ? `❌ ${posted.error}` : `✅ Panel posted: ${posted.message.url}`);
  }

  if (sub === 'toggle') {
    const s = await tickets.saveSettings(guild.id, { enabled: interaction.options.getBoolean('enabled') });
    return interaction.reply({
      content: s.enabled ? '✅ Tickets are **on** — members can open tickets from the panel.' : '⏸️ Tickets are **off** — the panel button tells members tickets are closed. Open tickets keep working.',
      ephemeral: true
    });
  }

  const s = await tickets.getSettings(guild.id);
  const staff = tickets.isStaff(interaction.member, s);

  if (sub === 'list') {
    if (!staff) return interaction.reply({ content: '❌ Only the support team can list tickets.', ephemeral: true });
    const open = await Ticket.find({ guildId: guild.id, status: 'OPEN' }).sort({ number: 1 }).limit(40).lean();
    if (!open.length) return interaction.reply({ content: '✨ No open tickets.', ephemeral: true });
    const lines = open.map(
      (t) => `**#${t.number}** <#${t.channelId}> · <@${t.openerId}> · <t:${Math.floor(new Date(t.createdAt).getTime() / 1000)}:R>${t.claimedBy ? ` · 📌 <@${t.claimedBy}>` : ' · unclaimed'}`
    );
    return interaction.reply({
      embeds: [new EmbedBuilder().setColor('#5865F2').setTitle(`🎫 Open tickets (${open.length})`).setDescription(lines.join('\n').slice(0, 4000))],
      ephemeral: true,
      allowedMentions: { parse: [] }
    });
  }

  // Everything below works inside a ticket channel.
  const ticket = await tickets.ticketForChannel(interaction.channelId);
  if (!ticket) return interaction.reply({ content: '❌ Use this inside an open ticket channel.', ephemeral: true });

  if (sub === 'close') {
    if (!staff && interaction.user.id !== ticket.openerId) {
      return interaction.reply({ content: '❌ Only the person who opened this ticket or the support team can close it.', ephemeral: true });
    }
    await interaction.deferReply();
    const result = await tickets.closeTicket(guild, ticket, interaction.user, interaction.options.getString('reason'));
    return interaction.editReply(result.error ? `❌ ${result.error}` : `🔒 Closing ticket #${ticket.number}…${result.dmSent ? ' The member was sent a DM.' : ''}`).catch(() => null);
  }

  if (!staff) return interaction.reply({ content: '❌ Only the support team can do that.', ephemeral: true });

  if (sub === 'claim') {
    const result = await tickets.toggleClaim(ticket, interaction.user);
    if (result.error) return interaction.reply({ content: `❌ ${result.error}`, ephemeral: true });
    await tickets.refreshButtons(interaction.channel, result.ticket);
    return interaction.reply({
      content: result.claimed ? `📌 ${interaction.user} claimed this ticket and will be helping you.` : `📌 ${interaction.user} unclaimed this ticket.`,
      allowedMentions: { parse: [] }
    });
  }

  if (sub === 'add' || sub === 'remove') {
    const user = interaction.options.getUser('user');
    if (user.bot) return interaction.reply({ content: '❌ Bots can’t be added to tickets.', ephemeral: true });
    if (user.id === ticket.openerId) return interaction.reply({ content: '❌ That’s the person who opened the ticket.', ephemeral: true });
    try {
      await tickets.setMemberAccess(interaction.channel, ticket, user.id, sub === 'add');
    } catch (err) {
      return interaction.reply({ content: `❌ Couldn't change who can see this ticket — LoofaryBot needs Manage Roles. (${err.message})`, ephemeral: true });
    }
    return interaction.reply({ content: sub === 'add' ? `➕ ${user} can now see this ticket.` : `➖ ${user} was removed from this ticket.`, allowedMentions: { users: sub === 'add' ? [user.id] : [] } });
  }

  if (sub === 'rename') {
    const name = interaction.options.getString('name').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-|-$/g, '') || `ticket-${ticket.number}`;
    await interaction.deferReply();
    // Discord allows 2 renames per channel per 10 minutes; don't wait out the rate limit.
    const renamed = await Promise.race([
      interaction.channel.setName(name, `Renamed by ${interaction.user.tag}`).then(() => true, (err) => err),
      new Promise((r) => setTimeout(() => r('slow'), 8000))
    ]);
    if (renamed === true) return interaction.editReply(`✏️ Renamed to **${name}**.`);
    return interaction.editReply(
      renamed === 'slow'
        ? `⏳ Discord only allows 2 renames per channel every 10 minutes — it'll become **${name}** when that runs out.`
        : `❌ Couldn't rename this channel. (${renamed.message})`
    );
  }
  return interaction.reply({ content: '❌ Unknown subcommand.', ephemeral: true });
}

module.exports = { data, execute };
