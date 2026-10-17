// /counting — set up the counting game channel (and its secret XP goals) and check how it's going.
const { SlashCommandBuilder, PermissionFlagsBits, ChannelType, EmbedBuilder } = require('discord.js');
const counting = require('../cogs/modules/counting');
const { getOrCreateConfig } = require('../cogs/modules/leveling');
const { parseDuration, formatDuration } = require('../utils/duration');
const { durationChoices } = require('../utils/autocomplete');

const data = new SlashCommandBuilder()
  .setName('counting')
  .setDescription('A counting game channel — count up together, one number at a time')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setDMPermission(false)
  .addSubcommand((s) =>
    s
      .setName('setup')
      .setDescription('Pick the counting channel (turns the game on)')
      .addChannelOption((o) => o.setName('channel').setDescription('The counting channel').setRequired(true).addChannelTypes(ChannelType.GuildText))
      .addBooleanOption((o) => o.setName('take_turns').setDescription('Members must take turns — no counting twice in a row (default on)'))
      .addBooleanOption((o) => o.setName('math').setDescription('Allow maths like 3*4, 5!, √144, ∑(i,1,5,i) (default on)'))
      .addBooleanOption((o) => o.setName('numbers_only').setDescription('Delete normal chat so the channel is numbers only (default on)'))
      .addIntegerOption((o) => o.setName('slowmode').setDescription('Slowmode in seconds, grief protection (default 1200 = 20 min; 0 = off)').setMinValue(0).setMaxValue(21600))
  )
  .addSubcommand((s) =>
    s.setName('toggle').setDescription('Turn the counting game on or off').addBooleanOption((o) => o.setName('enabled').setDescription('On or off').setRequired(true))
  )
  .addSubcommand((s) =>
    s
      .setName('set')
      .setDescription('Set the current number (e.g. to undo an unfair reset)')
      .addIntegerOption((o) => o.setName('number').setDescription('The last number counted — the next one will be this + 1').setRequired(true).setMinValue(0))
  )
  .addSubcommand((s) =>
    s
      .setName('ban')
      .setDescription('Block a member from the counting channel (adds a role + channel block automatically)')
      .addUserOption((o) => o.setName('user').setDescription('Who to block from counting').setRequired(true))
      .addStringOption((o) => o.setName('duration').setDescription('Optional — e.g. 10m, 2h, 7d (leave empty for permanent)').setAutocomplete(true))
  )
  .addSubcommand((s) =>
    s
      .setName('unban')
      .setDescription('Let a member type in the counting channel again')
      .addUserOption((o) => o.setName('user').setDescription('Who to unblock').setRequired(true))
  )
  .addSubcommand((s) =>
    s
      .setName('goals')
      .setDescription('Secret goals: every N numbers, everyone who counted this run gets XP (members aren’t told)')
      .addBooleanOption((o) => o.setName('enabled').setDescription('On or off'))
      .addIntegerOption((o) => o.setName('every').setDescription('A goal every this many numbers (default 15)').setMinValue(1).setMaxValue(100000))
      .addIntegerOption((o) => o.setName('base_xp').setDescription('XP for the first goal of a run (default 100)').setMinValue(0).setMaxValue(1000000))
      .addIntegerOption((o) => o.setName('step_xp').setDescription('Extra XP for each later goal in the same run (default 50)').setMinValue(0).setMaxValue(1000000))
      .addIntegerOption((o) => o.setName('max_xp').setDescription('Cap on base + steps, before bonuses (0 = no cap)').setMinValue(0).setMaxValue(10000000))
      .addBooleanOption((o) => o.setName('ping').setDescription('@mention everyone rewarded'))
  )
  .addSubcommand((s) => s.setName('status').setDescription('The current number, best run and settings'));

async function autocomplete(interaction) {
  return interaction.respond(durationChoices(interaction.options.getFocused()));
}

const fmt = (n) => Number(n).toLocaleString('en-US');

/** Staff-only summary of the hidden goals, e.g. "every 15 · 100 XP, +50 per goal …". */
function goalsText(s) {
  const g = s.goals;
  if (!g.enabled) return 'Off — turn on with `/counting goals enabled:true`.';
  const nextAt = counting.nextGoal(g, s.current);
  const next = counting.goalReward(g, nextAt, s.goalsHit);
  return (
    `On · every **${fmt(g.every)}** numbers · first goal **${fmt(g.baseXp)} XP**, then **+${fmt(g.stepXp)}** per goal${g.maxXp ? ` (cap ${fmt(g.maxXp)})` : ''}` +
    `${g.bonuses.length ? ` · bonus goals: ${g.bonuses.map((b) => `every ${fmt(b.every)} +${fmt(b.xp)}`).join(', ')}` : ''}${g.ping ? ' · pings winners' : ''}\n` +
    `This run: **${fmt(s.participants.length)}** counter${s.participants.length === 1 ? '' : 's'}, ${fmt(s.goalsHit)} goal${s.goalsHit === 1 ? '' : 's'} reached · next at **${fmt(nextAt)}** → **${fmt(next.xp)} XP** each`
  );
}

async function execute(interaction) {
  const sub = interaction.options.getSubcommand();
  const guild = interaction.guild;
  const o = interaction.options;

  if (sub === 'setup') {
    const input = { enabled: true, channelId: o.getChannel('channel').id };
    if (o.getBoolean('take_turns') !== null) input.allowSameUser = !o.getBoolean('take_turns');
    if (o.getBoolean('math') !== null) input.mathAllowed = o.getBoolean('math');
    if (o.getBoolean('numbers_only') !== null) input.numbersOnly = o.getBoolean('numbers_only');
    if (o.getInteger('slowmode') !== null) input.slowmodeSeconds = o.getInteger('slowmode');
    const saved = await counting.saveSettings(guild, input);
    if (saved.error) return interaction.reply({ content: `❌ ${saved.error}`, ephemeral: true });
    const s = saved.settings;
    const channel = guild.channels.cache.get(s.channelId);
    await channel
      ?.send(`🔢 **Counting game!** Count up one number at a time${s.allowSameUser ? '' : ' — and take turns'}. A wrong number resets the count.\nThe next number is **${fmt(s.current + 1)}**.`)
      .catch(() => null);
    const slowLabel = s.slowmodeSeconds >= 60 ? `${Math.round(s.slowmodeSeconds / 60)} min` : `${s.slowmodeSeconds}s`;
    return interaction.reply({
      content:
        `✅ Counting is on in <#${s.channelId}> · ${s.allowSameUser ? 'same person can count again' : 'members take turns'} · ${s.mathAllowed ? 'sums allowed' : 'plain numbers only'} · ` +
        `${s.numbersOnly ? 'numbers-only (chat removed)' : 'chat allowed'} · slowmode ${s.slowmodeSeconds ? slowLabel : 'off'}.`,
      ephemeral: true
    });
  }

  if (sub === 'toggle') {
    const saved = await counting.saveSettings(guild, { enabled: o.getBoolean('enabled') });
    if (saved.error) return interaction.reply({ content: `❌ ${saved.error} Use \`/counting setup\`.`, ephemeral: true });
    return interaction.reply({ content: saved.settings.enabled ? '✅ Counting is **on**.' : '⏸️ Counting is **off**.', ephemeral: true });
  }

  if (sub === 'set') {
    const saved = await counting.saveSettings(guild, { current: o.getInteger('number') });
    if (saved.error) return interaction.reply({ content: `❌ ${saved.error}`, ephemeral: true });
    const s = saved.settings;
    if (s.enabled && s.channelId) {
      await guild.channels.cache
        .get(s.channelId)
        ?.send({ content: `🛠️ A moderator set the count to **${fmt(s.current)}**. The next number is **${fmt(s.current + 1)}**.`, allowedMentions: { parse: [] } })
        .catch(() => null);
    }
    return interaction.reply({ content: `✅ Count set to **${fmt(s.current)}** — next is **${fmt(s.current + 1)}**.`, ephemeral: true });
  }

  if (sub === 'goals') {
    const goals = {};
    if (o.getBoolean('enabled') !== null) goals.enabled = o.getBoolean('enabled');
    for (const [opt, key] of [['every', 'every'], ['base_xp', 'baseXp'], ['step_xp', 'stepXp'], ['max_xp', 'maxXp']]) if (o.getInteger(opt) !== null) goals[key] = o.getInteger(opt);
    if (o.getBoolean('ping') !== null) goals.ping = o.getBoolean('ping');
    let s;
    if (Object.keys(goals).length) {
      const saved = await counting.saveSettings(guild, { goals });
      if (saved.error) return interaction.reply({ content: `❌ ${saved.error}`, ephemeral: true });
      s = saved.settings;
    } else s = counting.countingSettings(await getOrCreateConfig(guild.id));
    return interaction.reply({ content: `🎯 **Secret counting goals**\n${goalsText(s)}\n-# Bonuses and the announcement text are on the dashboard (Engagement → Counting).`, ephemeral: true });
  }

  if (sub === 'ban') {
    const target = o.getUser('user');
    const durStr = o.getString('duration');
    let durationMs = null;
    if (durStr) {
      durationMs = parseDuration(durStr);
      if (!durationMs) return interaction.reply({ content: '❌ Invalid duration — use e.g. `10m`, `2h`, `7d`.', ephemeral: true });
    }
    await interaction.deferReply({ ephemeral: true });
    const res = await counting.banUser(guild, target.id, { durationMs, by: interaction.user.tag });
    if (res.error) return interaction.editReply({ content: `❌ ${res.error}` });
    const when = res.until ? ` until <t:${Math.floor(res.until.getTime() / 1000)}:R>` : ' **permanently**';
    return interaction.editReply({ content: `🔇 ${target} is now blocked from counting${when}.${durationMs ? '' : ' Lift it any time with `/counting unban`.'}` });
  }

  if (sub === 'unban') {
    const target = o.getUser('user');
    await interaction.deferReply({ ephemeral: true });
    const res = await counting.unbanUser(guild, target.id);
    return interaction.editReply({ content: res.wasBanned ? `✅ ${target} can count again.` : `${target} wasn’t blocked from counting.` });
  }

  const s = counting.countingSettings(await getOrCreateConfig(guild.id));
  const embed = new EmbedBuilder()
    .setColor(s.enabled ? '#57F287' : '#4E5058')
    .setTitle(`🔢 Counting — ${s.enabled ? 'on' : 'off'}`)
    .addFields(
      { name: 'Channel', value: s.channelId ? `<#${s.channelId}>` : 'not set', inline: true },
      { name: 'Next number', value: `**${fmt(s.current + 1)}**`, inline: true },
      { name: 'Best run', value: fmt(s.record), inline: true },
      { name: 'Last counted by', value: s.lastUserId ? `<@${s.lastUserId}>` : '—', inline: true },
      { name: 'Resets', value: fmt(s.resets) + (s.lastResetBy ? ` (last: <@${s.lastResetBy}>)` : ''), inline: true },
      { name: 'Rules', value: `${s.allowSameUser ? 'Same person can count again' : 'Take turns'} · ${s.mathAllowed ? 'sums allowed' : 'plain numbers'}`, inline: true },
      {
        name: 'Anti-grief',
        value: `${s.numbersOnly ? 'Numbers only (chat deleted)' : 'Chat allowed'} · slowmode ${s.slowmodeSeconds ? (s.slowmodeSeconds >= 60 ? `${Math.round(s.slowmodeSeconds / 60)} min` : `${s.slowmodeSeconds}s`) : 'off'}`,
        inline: true
      }
    );
  embed.addFields({ name: '🎯 Secret goals (only staff see this)', value: goalsText(s), inline: false });
  if (s.bans.length) {
    const lines = s.bans
      .slice(0, 10)
      .map((b) => `<@${b.userId}>${b.until ? ` — until <t:${Math.floor(new Date(b.until).getTime() / 1000)}:R>` : ' — permanent'}`);
    embed.addFields({ name: `🔇 Blocked from counting (${s.bans.length})`, value: lines.join('\n') + (s.bans.length > 10 ? `\n…and ${s.bans.length - 10} more` : ''), inline: false });
  }
  return interaction.reply({ embeds: [embed], ephemeral: true, allowedMentions: { parse: [] } });
}

module.exports = { data, execute, autocomplete };
