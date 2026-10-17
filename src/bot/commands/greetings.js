// /welcome and /goodbye — the dashboard's Welcome tab from Discord (plus /welcome newmember for the
// "New here?" button). The full embed designer stays on
// the dashboard; these cover the channel, the text, on/off, a test and a summary.
const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const WelcomeConfig = require('../../database/models/WelcomeConfig');
const { sendWelcome, sendGoodbye, GOODBYE_DEFAULT } = require('../cogs/modules/welcome');
const { dashboardUrl } = require('../cogs/modules/help');

function build(kind) {
  const isWelcome = kind === 'welcome';
  const what = isWelcome ? 'welcome' : 'goodbye';
  const cmd = new SlashCommandBuilder()
    .setName(kind)
    .setDescription(isWelcome ? 'Greet new members automatically' : 'Post a message when someone leaves')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((s) =>
      s
        .setName('set')
        .setDescription(`Set the ${what} channel and message (turns it on)`)
        .addChannelOption((o) =>
          o.setName('channel').setDescription('Where to post').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true)
        )
        .addStringOption((o) =>
          o.setName('message').setDescription('Text — placeholders: {user} {username} {server} {membercount}').setMaxLength(2000)
        )
    )
    .addSubcommand((s) =>
      s
        .setName('toggle')
        .setDescription(`Turn ${what} messages on or off`)
        .addBooleanOption((o) => o.setName('enabled').setDescription('On or off').setRequired(true))
    )
    .addSubcommand((s) => s.setName('test').setDescription(`Post a test ${what} message using you as the member`))
    .addSubcommand((s) => s.setName('show').setDescription(`Show the current ${what} setup`));
  if (!isWelcome) return cmd;
  // The "New here?" button: new members press it for a private message (designed on the dashboard).
  return cmd
    .addSubcommand((s) =>
      s
        .setName('newmember')
        .setDescription('The "New here?" button — new members press it for a private intro message')
        .addBooleanOption((o) => o.setName('enabled').setDescription('On or off'))
        .addBooleanOption((o) => o.setName('on_welcome').setDescription('Put the button on the welcome message'))
        .addStringOption((o) => o.setName('button_label').setDescription('Button text (e.g. "New here? Click me")').setMaxLength(80))
        .addStringOption((o) => o.setName('button_emoji').setDescription('Button emoji'))
        .addStringOption((o) =>
          o.setName('button_color').setDescription('Button color').addChoices(
            { name: 'Blurple', value: 'Primary' }, { name: 'Grey', value: 'Secondary' }, { name: 'Green', value: 'Success' }, { name: 'Red', value: 'Danger' }
          )
        )
    )
    .addSubcommand((s) =>
      s
        .setName('newmember_panel')
        .setDescription('Post (or update) a panel with the "New here?" button in a channel')
        .addChannelOption((o) => o.setName('channel').setDescription('Where to post it').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true))
    )
    .addSubcommand((s) => s.setName('newmember_preview').setDescription('See the private "New here?" message as a new member would'));
}

async function runNewMember(interaction, sub) {
  const nm = require('../cogs/modules/newMember');
  const doc = await WelcomeConfig.findOne({ guildId: interaction.guildId }).lean();
  let s = nm.settings(doc);
  if (sub === 'newmember_preview') {
    const payload = nm.privatePayload(s, interaction.member);
    if (!payload) return interaction.reply({ content: '❌ The message is empty — design it on the dashboard.', ephemeral: true });
    return interaction.reply({ ...payload, components: [], content: `${s.enabled ? '' : '*(off right now)*\n'}${payload.content || ''}`.trim() || undefined });
  }
  if (sub === 'newmember_panel') {
    const channel = interaction.options.getChannel('channel');
    await interaction.deferReply({ ephemeral: true });
    const r = await nm.postPanel(interaction.guild, s, channel.id);
    if (r.error) return interaction.editReply(`❌ ${r.error}`);
    await WelcomeConfig.updateOne({ guildId: interaction.guildId }, { $set: { 'newMember.panelChannelId': channel.id, 'newMember.panelMessageId': r.messageId } }, { upsert: true });
    return interaction.editReply(`✅ Panel ${r.edited ? 'updated' : 'posted'} in ${channel}.${s.enabled ? '' : ' ⚠️ The button is **off** — turn it on with `/welcome newmember enabled:true`.'}`);
  }
  const input = {};
  const map = { enabled: 'enabled', on_welcome: 'onWelcome' };
  for (const [opt, key] of Object.entries(map)) { const v = interaction.options.getBoolean(opt); if (v !== null) input[key] = v; }
  const strs = { button_label: 'buttonLabel', button_emoji: 'buttonEmoji', button_color: 'buttonStyle' };
  for (const [opt, key] of Object.entries(strs)) { const v = interaction.options.getString(opt); if (v !== null) input[key] = v; }
  if (Object.keys(input).length) {
    const r = await nm.saveSettings(interaction.guildId, input);
    if (r.error) return interaction.reply({ content: `❌ ${r.error}`, ephemeral: true });
    s = r.settings;
  }
  const welcomeOn = doc?.enabled && doc?.channelId;
  return interaction.reply({
    content:
      `👋 **"New here?" button** — ${s.enabled ? '**on**' : 'off'}\n` +
      `**On the welcome message:** ${s.onWelcome ? (welcomeOn ? 'yes' : 'yes (but welcome messages are off — `/welcome set`)') : 'no'}\n` +
      `**Panel:** ${s.panelChannelId ? `<#${s.panelChannelId}>` : 'none — `/welcome newmember_panel`'}\n` +
      `**Button:** ${s.buttonEmoji || ''} ${s.buttonLabel || ''} (${s.buttonStyle})\n` +
      `**Message:** ${s.message.embeds?.length || 0} embed(s) — preview with \`/welcome newmember_preview\`, design it on the dashboard: ${dashboardUrl(interaction.guildId)}`,
    ephemeral: true,
    allowedMentions: { parse: [] }
  });
}

async function run(interaction, kind) {
  const sub = interaction.options.getSubcommand();
  if (sub.startsWith('newmember')) return runNewMember(interaction, sub);
  const guildId = interaction.guildId;
  const isWelcome = kind === 'welcome';
  const doc = (await WelcomeConfig.findOne({ guildId })) || new WelcomeConfig({ guildId });
  const cfg = isWelcome ? doc : doc.goodbye;

  if (sub === 'set') {
    const channel = interaction.options.getChannel('channel');
    cfg.channelId = channel.id;
    cfg.enabled = true;
    const message = interaction.options.getString('message');
    if (message) cfg.messageContent = message;
    await doc.save();
    return interaction.reply({
      content: `✅ ${isWelcome ? 'Welcome' : 'Goodbye'} messages are **on** in ${channel}.${message ? '' : ' Using the current message text.'}\nTry it with \`/${kind} test\`. Design an embed on the dashboard: ${dashboardUrl(guildId)}`,
      ephemeral: true
    });
  }

  if (sub === 'toggle') {
    const enabled = interaction.options.getBoolean('enabled');
    if (enabled && !cfg.channelId) return interaction.reply({ content: `❌ Set a channel first with \`/${kind} set\`.`, ephemeral: true });
    cfg.enabled = enabled;
    await doc.save();
    return interaction.reply({ content: `✅ ${isWelcome ? 'Welcome' : 'Goodbye'} messages are **${enabled ? 'on' : 'off'}**.`, ephemeral: true });
  }

  if (sub === 'test') {
    await interaction.deferReply({ ephemeral: true });
    const plain = doc.toObject();
    const problem = isWelcome
      ? await sendWelcome(interaction.member, { force: true, config: plain })
      : await sendGoodbye(interaction.member, { force: true, config: plain.goodbye });
    return interaction.editReply(problem ? `❌ ${problem}` : `📨 Test posted in <#${cfg.channelId}>.`);
  }

  const text = cfg.messageContent || (isWelcome ? '' : GOODBYE_DEFAULT);
  return interaction.reply({
    content:
      `${isWelcome ? '👋 **Welcome messages**' : '🚪 **Goodbye messages**'} — ${cfg.enabled ? '**on**' : 'off'}\n` +
      `**Channel:** ${cfg.channelId ? `<#${cfg.channelId}>` : 'not set'}\n` +
      `**Message:** ${text ? `\`\`\`\n${text.slice(0, 1500)}\n\`\`\`` : '*(none)*'}` +
      `**Embed:** ${cfg.embedEnabled ? 'yes' : 'no'} — edit it on the dashboard: ${dashboardUrl(guildId)}`,
    ephemeral: true,
    allowedMentions: { parse: [] }
  });
}

const commands = ['welcome', 'goodbye'].map((kind) => ({ data: build(kind), execute: (i) => run(i, kind) }));

module.exports = { commands };
