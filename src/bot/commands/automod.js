// /automod — spam protection: turn it on, switch rules, and set warnings before the mute.
const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const automod = require('../cogs/modules/automod');
const linkSafety = require('../cogs/modules/linkSafety');
const { getOrCreateConfig } = require('../cogs/modules/leveling');
const { dashboardUrl } = require('../cogs/modules/help');

const data = new SlashCommandBuilder()
  .setName('automod')
  .setDescription('Spam protection — floods, repeats, text walls, mass mentions, invites, unsafe links')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setDMPermission(false)
  .addSubcommand((s) =>
    s.setName('toggle').setDescription('Turn auto-mod on or off').addBooleanOption((o) => o.setName('enabled').setDescription('On or off').setRequired(true))
  )
  .addSubcommand((s) =>
    s
      .setName('rule')
      .setDescription('Turn one rule on or off')
      .addStringOption((o) =>
        o
          .setName('rule')
          .setDescription('Which rule')
          .setRequired(true)
          .addChoices(...Object.entries(automod.RULES).map(([value, r]) => ({ name: `${r.emoji} ${r.label}`, value })))
      )
      .addBooleanOption((o) => o.setName('enabled').setDescription('On or off').setRequired(true))
  )
  .addSubcommand((s) =>
    s
      .setName('punishment')
      .setDescription('Warnings before the mute, and how long the mute is')
      .addIntegerOption((o) => o.setName('warnings').setDescription('Warnings before a mute (default 2)').setMinValue(0).setMaxValue(10))
      .addIntegerOption((o) => o.setName('mute_minutes').setDescription('Mute length in minutes (default 60)').setMinValue(1).setMaxValue(40320))
      .addIntegerOption((o) => o.setName('reset_hours').setDescription('Forget strikes after this many hours (default 24)').setMinValue(1).setMaxValue(720))
  )
  .addSubcommand((s) =>
    s
      .setName('exempt')
      .setDescription('Let a role or channel skip auto-mod (run again to undo)')
      .addRoleOption((o) => o.setName('role').setDescription('A role to exempt'))
      .addChannelOption((o) => o.setName('channel').setDescription('A channel to exempt'))
  )
  .addSubcommand((s) =>
    s
      .setName('links')
      .setDescription('Link safety: which links are allowed')
      .addStringOption((o) =>
        o.setName('mode').setDescription('What to remove').addChoices(
          { name: 'Only unsafe links (scams, shorteners, downloads…)', value: 'unsafe' },
          { name: 'Every link except approved sites', value: 'allowlist' }
        )
      )
      .addStringOption((o) => o.setName('allow').setDescription('Add a site to the approved list (or remove it if it’s there), e.g. example.com').setMaxLength(200))
      .addStringOption((o) => o.setName('block').setDescription('Add a site to the block list (or remove it if it’s there)').setMaxLength(200))
      .addBooleanOption((o) => o.setName('shorteners').setDescription('Remove link shorteners like bit.ly (default on)'))
      .addBooleanOption((o) => o.setName('downloads').setDescription('Remove links to programs like .exe/.apk (default on)'))
      .addBooleanOption((o) => o.setName('nsfw').setDescription('Remove adult / NSFW sites (default on; NSFW channels skip it)'))
      .addBooleanOption((o) => o.setName('scam_mute').setDescription('Mute straight away for scam links, skipping the warnings (default on)'))
  )
  .addSubcommand((s) =>
    s.setName('checklink').setDescription('Check whether a link would be allowed').addStringOption((o) => o.setName('url').setDescription('The link').setRequired(true).setMaxLength(500))
  )
  .addSubcommand((s) => s.setName('status').setDescription('Rules, punishments and recent catches'));

async function execute(interaction) {
  const sub = interaction.options.getSubcommand();
  const guild = interaction.guild;
  const o = interaction.options;
  const reply = (content) => interaction.reply({ content, ephemeral: true, allowedMentions: { parse: [] } });

  if (sub === 'toggle') {
    const saved = await automod.saveSettings(guild, { enabled: o.getBoolean('enabled') });
    if (saved.error) return reply(`❌ ${saved.error}`);
    const missing = automod.missingPermissions(guild);
    return reply(
      saved.settings.enabled
        ? `✅ Auto-mod is **on** — ${saved.settings.warnings} warning(s), then a ${saved.settings.muteMinutes} min mute.${missing.length ? `\n⚠️ LoofaryBot needs: ${missing.join(', ')}` : ''}`
        : '⏸️ Auto-mod is **off**.'
    );
  }

  if (sub === 'rule') {
    const rule = o.getString('rule');
    const saved = await automod.saveSettings(guild, { rules: { [rule]: { enabled: o.getBoolean('enabled') } } });
    if (saved.error) return reply(`❌ ${saved.error}`);
    return reply(`${automod.RULES[rule].emoji} **${automod.RULES[rule].label}** is now **${o.getBoolean('enabled') ? 'on' : 'off'}**.`);
  }

  if (sub === 'punishment') {
    const input = {};
    if (o.getInteger('warnings') !== null) input.warnings = o.getInteger('warnings');
    if (o.getInteger('mute_minutes') !== null) input.muteMinutes = o.getInteger('mute_minutes');
    if (o.getInteger('reset_hours') !== null) input.strikeResetHours = o.getInteger('reset_hours');
    const saved = await automod.saveSettings(guild, input);
    if (saved.error) return reply(`❌ ${saved.error}`);
    const s = saved.settings;
    return reply(`✅ ${s.warnings} warning(s), then a **${s.muteMinutes} min** mute. Strikes are forgotten after ${s.strikeResetHours}h.`);
  }

  const s = automod.automodSettings(await getOrCreateConfig(guild.id));

  if (sub === 'exempt') {
    const role = o.getRole('role');
    const channel = o.getChannel('channel');
    if (!role && !channel) return reply('Pick a role or a channel.');
    const input = {};
    const lines = [];
    if (role) {
      const has = s.exemptRoleIds.includes(role.id);
      input.exemptRoleIds = has ? s.exemptRoleIds.filter((id) => id !== role.id) : [...s.exemptRoleIds, role.id];
      lines.push(has ? `${role} is checked by auto-mod again.` : `${role} now skips auto-mod.`);
    }
    if (channel) {
      const has = s.exemptChannelIds.includes(channel.id);
      input.exemptChannelIds = has ? s.exemptChannelIds.filter((id) => id !== channel.id) : [...s.exemptChannelIds, channel.id];
      lines.push(has ? `${channel} is checked by auto-mod again.` : `${channel} now skips auto-mod.`);
    }
    const saved = await automod.saveSettings(guild, input);
    return reply(saved.error ? `❌ ${saved.error}` : `✅ ${lines.join('\n')}`);
  }

  if (sub === 'links') {
    const L = s.unsafeLinks;
    const u = {};
    const lines = [];
    if (o.getString('mode')) u.mode = o.getString('mode');
    const toggle = (list, raw, label) => {
      const [d] = linkSafety.cleanDomains([raw]);
      if (!d) return { error: `“${raw}” isn’t a website address (try example.com).` };
      const has = list.includes(d);
      lines.push(has ? `Removed **${d}** from the ${label} list.` : `Added **${d}** to the ${label} list.`);
      return { list: has ? list.filter((x) => x !== d) : [...list, d] };
    };
    for (const [opt, key, label] of [['allow', 'allow', 'approved'], ['block', 'block', 'block']]) {
      if (!o.getString(opt)) continue;
      const t = toggle(L[key], o.getString(opt), label);
      if (t.error) return reply(`❌ ${t.error}`);
      u[key] = t.list;
    }
    for (const [opt, key] of [['shorteners', 'shorteners'], ['downloads', 'files'], ['nsfw', 'nsfw'], ['scam_mute', 'scamMute']]) if (o.getBoolean(opt) !== null) u[key] = o.getBoolean(opt);
    const saved = await automod.saveSettings(guild, Object.keys(u).length ? { rules: { unsafeLinks: { enabled: true, ...u } } } : {});
    if (saved.error) return reply(`❌ ${saved.error}`);
    const n = saved.settings.unsafeLinks;
    return reply(
      `${lines.length ? `✅ ${lines.join('\n')}\n\n` : ''}🛡️ **Link safety** is ${n.enabled ? 'on' : 'off'}${s.enabled ? '' : ' (auto-mod itself is off — `/automod toggle`)'}.\n` +
        `Mode: **${n.mode === 'allowlist' ? 'only approved sites' : 'remove unsafe links'}** · shorteners ${n.shorteners ? 'removed' : 'allowed'} · downloads ${n.files ? 'removed' : 'allowed'} · adult sites ${n.nsfw ? 'removed' : 'allowed'} · scam links ${n.scamMute ? 'mute straight away' : 'count as a warning'}\n` +
        `Approved: ${n.allow.length ? n.allow.join(', ') : '— (well-known sites are always fine)'}\nBlocked: ${n.block.length ? n.block.join(', ') : '—'}`
    );
  }

  if (sub === 'checklink') {
    const raw = o.getString('url').trim();
    const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    const bad = linkSafety.checkContent(url, s.unsafeLinks);
    if (!bad) return reply(`✅ <${url}> would be **allowed**.`);
    return reply(`🛡️ <${url}> would be **removed** — ${bad.reason}.${bad.scam && s.unsafeLinks.scamMute ? ' It counts as a scam, so the sender is muted straight away.' : bad.unapproved ? ' (No strike — it just isn’t on the approved list.)' : ''}`);
  }

  const recent = await automod.recentActions(guild.id, 5);
  const ruleLine = (key) => {
    const r = automod.RULES[key];
    const cfg = s[key];
    const extra = {
      flood: `${cfg.messages} msgs / ${cfg.seconds}s`,
      duplicates: `${cfg.count}× in ${cfg.seconds}s`,
      walls: `> ${cfg.maxLines} lines or repeated text`,
      mentions: `${cfg.max}+ mentions${cfg.everyone ? ', @everyone' : ''}`,
      invites: 'other servers',
      unsafeLinks: cfg.mode === 'allowlist' ? 'only approved sites' : `scams, shorteners, downloads${cfg.nsfw ? ', adult sites' : ''}`,
      links: `${cfg.max}+ links`,
      caps: `${cfg.percent}%+ caps`
    }[key];
    return `${cfg.enabled ? '✅' : '▫️'} ${r.emoji} ${r.label} — ${extra}`;
  };
  const embed = new EmbedBuilder()
    .setColor(s.enabled ? '#57F287' : '#4E5058')
    .setTitle(`🛡️ Auto-mod — ${s.enabled ? 'on' : 'off'}`)
    .setDescription(Object.keys(automod.RULES).map(ruleLine).join('\n'))
    .addFields(
      { name: 'Punishment', value: `${s.warnings} warning(s) → ${s.muteMinutes} min mute · strikes reset after ${s.strikeResetHours}h`, inline: false },
      { name: 'Skips', value: [...s.exemptRoleIds.map((id) => `<@&${id}>`), ...s.exemptChannelIds.map((id) => `<#${id}>`), 'staff (Manage Messages)'].join(' '), inline: false },
      { name: 'Recent', value: recent.length ? recent.map((c) => `<t:${Math.floor(new Date(c.createdAt).getTime() / 1000)}:R> <@${c.userId}> — ${c.type === 'timeout' ? '⏳ muted' : '⚠️ warned'} · ${c.reason.replace(/^Auto-mod: /, '')}`).join('\n').slice(0, 1024) : 'Nothing caught yet.' }
    )
    .setFooter({ text: `More options on the dashboard: ${dashboardUrl(guild.id)}`.slice(0, 2048) });
  return interaction.reply({ embeds: [embed], ephemeral: true, allowedMentions: { parse: [] } });
}

module.exports = { data, execute };
