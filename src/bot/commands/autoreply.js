// /autoreply — keyword auto-replies that watch every channel. Admins add triggers (keyword(s) →
// response), with optional channel/role exclusions. Rich embed responses are edited on the dashboard.
const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const autoReplies = require('../cogs/modules/autoReplies');

const MATCH_CHOICES = [
  { name: 'Whole word (default)', value: 'word' },
  { name: 'Contains (anywhere)', value: 'contains' },
  { name: 'Exact message', value: 'exact' },
  { name: 'Starts with', value: 'starts' },
  { name: 'Regex (advanced)', value: 'regex' }
];

const data = new SlashCommandBuilder()
  .setName('autoreply')
  .setDescription('Keyword auto-replies that watch every channel')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setDMPermission(false)
  .addSubcommand((s) =>
    s
      .setName('add')
      .setDescription('Add (or update) an auto-reply')
      .addStringOption((o) => o.setName('keywords').setDescription('Comma-separated words/phrases to watch for').setRequired(true))
      .addStringOption((o) => o.setName('response').setDescription('What the bot replies — {user} {username} {server} {channel} work').setRequired(true).setMaxLength(2000))
      .addStringOption((o) => o.setName('name').setDescription('A label for this auto-reply (default: first keyword)'))
      .addStringOption((o) => o.setName('match').setDescription('How to match (default: whole word)').addChoices(...MATCH_CHOICES))
      .addBooleanOption((o) => o.setName('require_all').setDescription('Require ALL keywords in the message, not just one (great for questions)'))
      .addBooleanOption((o) => o.setName('as_reply').setDescription('Reply to the message (default) vs a plain message'))
      .addBooleanOption((o) => o.setName('case_sensitive').setDescription('Match the exact case (default off)'))
      .addBooleanOption((o) => o.setName('delete_trigger').setDescription('Delete the message that triggered it'))
      .addChannelOption((o) => o.setName('ignore_channel').setDescription('A channel to ignore (add more with /autoreply exclude or the dashboard)'))
      .addRoleOption((o) => o.setName('ignore_role').setDescription('Members with this role won’t trigger it'))
  )
  .addSubcommand((s) => s.setName('list').setDescription('Show every auto-reply'))
  .addSubcommand((s) => s.setName('remove').setDescription('Delete an auto-reply').addStringOption((o) => o.setName('id').setDescription('Which one').setRequired(true).setAutocomplete(true)))
  .addSubcommand((s) =>
    s
      .setName('toggle')
      .setDescription('Turn one auto-reply on or off')
      .addStringOption((o) => o.setName('id').setDescription('Which one').setRequired(true).setAutocomplete(true))
      .addBooleanOption((o) => o.setName('on').setDescription('On or off (leave empty to flip it)'))
  )
  .addSubcommand((s) =>
    s
      .setName('exclude')
      .setDescription('Add or remove a channel/role exclusion on an auto-reply')
      .addStringOption((o) => o.setName('id').setDescription('Which auto-reply').setRequired(true).setAutocomplete(true))
      .addChannelOption((o) => o.setName('channel').setDescription('Channel to ignore'))
      .addRoleOption((o) => o.setName('role').setDescription('Role to ignore'))
      .addBooleanOption((o) => o.setName('remove').setDescription('Remove this exclusion instead of adding it'))
  )
  .addSubcommand((s) =>
    s
      .setName('settings')
      .setDescription('Turn auto-replies on/off and set the anti-spam cooldown')
      .addBooleanOption((o) => o.setName('enabled').setDescription('Master switch for all auto-replies'))
      .addIntegerOption((o) => o.setName('cooldown').setDescription('Seconds before the same trigger fires again in a channel (default 3)').setMinValue(0).setMaxValue(3600))
  );

async function autocomplete(interaction) {
  const typed = (interaction.options.getFocused() || '').toLowerCase();
  const triggers = await autoReplies.listTriggers(interaction.guildId);
  return interaction.respond(
    triggers
      .filter((t) => t.name.toLowerCase().includes(typed) || t.keywords.join(' ').toLowerCase().includes(typed) || t.id.includes(typed))
      .slice(0, 25)
      .map((t) => ({ name: `${t.name} (${t.keywords.slice(0, 3).join(', ')})`.slice(0, 100), value: t.id }))
  );
}

const describe = (t) =>
  `\`${t.id}\` ${t.enabled ? '🟢' : '⚪'} **${t.name}** — ${t.match}${t.requireAll ? ' (all)' : ''} · [${t.keywords.join(', ')}]` +
  `${t.ignoreChannelIds.length ? ` · skips ${t.ignoreChannelIds.map((c) => `<#${c}>`).join(' ')}` : ''}` +
  `${t.ignoreRoleIds.length ? ` · not ${t.ignoreRoleIds.map((r) => `<@&${r}>`).join(' ')}` : ''}`;

async function execute(interaction) {
  const sub = interaction.options.getSubcommand();
  const guild = interaction.guild;
  const o = interaction.options;
  const reply = (content) => interaction.reply({ content, ephemeral: true, allowedMentions: { parse: [] } });

  if (sub === 'add') {
    const res = await autoReplies.addTrigger(guild, {
      name: o.getString('name'),
      keywords: o.getString('keywords'),
      response: o.getString('response'),
      match: o.getString('match'),
      reply: o.getBoolean('as_reply') ?? true,
      caseSensitive: o.getBoolean('case_sensitive') ?? false,
      deleteTrigger: o.getBoolean('delete_trigger') ?? false,
      requireAll: o.getBoolean('require_all') ?? false,
      ignoreChannelIds: o.getChannel('ignore_channel') ? [o.getChannel('ignore_channel').id] : [],
      ignoreRoleIds: o.getRole('ignore_role') ? [o.getRole('ignore_role').id] : []
    });
    if (res.error) return reply(`❌ ${res.error}`);
    return reply(`✅ Auto-reply saved.\n${describe(res.trigger)}`);
  }

  if (sub === 'list') {
    const s = autoReplies.autoRepliesSettings(await require('../cogs/modules/leveling').getOrCreateConfig(guild.id));
    if (!s.triggers.length) return reply('No auto-replies yet. Add one with `/autoreply add`.');
    const embed = new EmbedBuilder()
      .setColor(s.enabled ? '#57F287' : '#4E5058')
      .setTitle(`💬 Auto-replies — ${s.enabled ? 'on' : 'off'}`)
      .setDescription(s.triggers.map(describe).join('\n').slice(0, 4096))
      .setFooter({ text: `${s.triggers.length} trigger(s) · cooldown ${s.cooldownSeconds}s · toggle the whole system with /autoreply settings` });
    return interaction.reply({ embeds: [embed], ephemeral: true, allowedMentions: { parse: [] } });
  }

  if (sub === 'remove') {
    const res = await autoReplies.removeTrigger(guild, o.getString('id'));
    return reply(res.error ? `❌ ${res.error}` : `🗑️ Removed **${res.trigger.name}**.`);
  }

  if (sub === 'toggle') {
    const res = await autoReplies.toggleTrigger(guild, o.getString('id'), o.getBoolean('on'));
    return reply(res.error ? `❌ ${res.error}` : `${res.enabled ? '🟢 Enabled' : '⚪ Disabled'} **${res.trigger.name}**.`);
  }

  if (sub === 'exclude') {
    const list = await autoReplies.listTriggers(guild.id);
    const t = list.find((x) => x.id === o.getString('id'));
    if (!t) return reply('❌ No auto-reply with that ID.');
    const channel = o.getChannel('channel');
    const role = o.getRole('role');
    if (!channel && !role) return reply('Pick a channel or a role to exclude.');
    const remove = o.getBoolean('remove');
    const upd = (arr, id) => (remove ? arr.filter((x) => x !== id) : [...new Set([...arr, id])]);
    const next = {
      ...t,
      ignoreChannelIds: channel ? upd(t.ignoreChannelIds, channel.id) : t.ignoreChannelIds,
      ignoreRoleIds: role ? upd(t.ignoreRoleIds, role.id) : t.ignoreRoleIds
    };
    const res = await autoReplies.addTrigger(guild, next);
    if (res.error) return reply(`❌ ${res.error}`);
    return reply(`✅ ${remove ? 'Removed exclusion' : 'Excluded'} ${channel ? `${channel}` : ''}${channel && role ? ' and ' : ''}${role ? `${role}` : ''} on **${t.name}**.\n${describe(res.trigger)}`);
  }

  // settings
  const res = await autoReplies.saveSettings(guild, { enabled: o.getBoolean('enabled') ?? undefined, cooldownSeconds: o.getInteger('cooldown') ?? undefined });
  if (res.error) return reply(`❌ ${res.error}`);
  return reply(`✅ Auto-replies are **${res.settings.enabled ? 'on' : 'off'}** · cooldown **${res.settings.cooldownSeconds}s**.`);
}

module.exports = { data, execute, autocomplete };
