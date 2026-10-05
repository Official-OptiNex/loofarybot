// /music — a Lofi / chill radio player for voice channels (free, ToS-safe internet radio).
const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const music = require('../cogs/modules/music');
const { getOrCreateConfig } = require('../cogs/modules/leveling');

const data = new SlashCommandBuilder()
  .setName('music')
  .setDescription('Play Lofi / chill radio in a voice channel')
  .setDMPermission(false)
  .addSubcommand((s) =>
    s
      .setName('play')
      .setDescription('Play a station in your voice channel')
      .addStringOption((o) => o.setName('station').setDescription('Station name (see /music stations). Defaults to Lofi.'))
  )
  .addSubcommand((s) => s.setName('skip').setDescription('Switch to the next station'))
  .addSubcommand((s) => s.setName('stop').setDescription('Stop and leave the voice channel'))
  .addSubcommand((s) => s.setName('nowplaying').setDescription('What’s playing right now'))
  .addSubcommand((s) => s.setName('stations').setDescription('List the stations you can play'))
  .addSubcommand((s) =>
    s.setName('volume').setDescription('Set the volume (0–100)').addIntegerOption((o) => o.setName('percent').setDescription('0–100').setRequired(true).setMinValue(0).setMaxValue(100))
  )
  .addSubcommand((s) =>
    s
      .setName('config')
      .setDescription('(Admin) Turn music on/off and set basics — full setup is on the dashboard')
      .addBooleanOption((o) => o.setName('enabled').setDescription('Turn music on or off'))
      .addRoleOption((o) => o.setName('dj_role').setDescription('Only this role may control music (clear by leaving blank over time on the dashboard)'))
      .addIntegerOption((o) => o.setName('default_volume').setDescription('Default volume 0–100').setMinValue(0).setMaxValue(100))
  );

async function execute(interaction) {
  const sub = interaction.options.getSubcommand();
  const guild = interaction.guild;
  const settings = music.musicSettings(await getOrCreateConfig(guild.id));
  const ephemeral = { ephemeral: true, allowedMentions: { parse: [] } };

  if (sub === 'config') {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply({ content: '❌ That needs the **Manage Server** permission.', ...ephemeral });
    }
    const input = {};
    if (interaction.options.getBoolean('enabled') !== null) input.enabled = interaction.options.getBoolean('enabled');
    if (interaction.options.getRole('dj_role')) input.djRoleId = interaction.options.getRole('dj_role').id;
    if (interaction.options.getInteger('default_volume') !== null) input.defaultVolume = interaction.options.getInteger('default_volume');
    const saved = await music.saveSettings(guild, input);
    return interaction.reply({
      content: `🎵 Music is **${saved.settings.enabled ? 'on' : 'off'}** · default volume **${saved.settings.defaultVolume}%**${saved.settings.djRoleId ? ` · DJ role <@&${saved.settings.djRoleId}>` : ''}.\nFull setup (command & voice channels, stations) is on the **dashboard → Community → Music**.`,
      ...ephemeral
    });
  }

  if (sub === 'stations') {
    const list = music.allStations(settings).map((s) => `• **${s.name}** — ${s.genre} \`(${s.key})\``).join('\n');
    const embed = new EmbedBuilder().setColor(0x9b6bff).setTitle('🎶 Stations').setDescription(list).setFooter({ text: 'Play one with /music play station:<name>' });
    return interaction.reply({ embeds: [embed], ...ephemeral });
  }

  if (sub === 'nowplaying') {
    const np = music.nowPlaying(guild.id);
    if (!np?.station) return interaction.reply({ content: '🔇 Nothing is playing right now. Start something with `/music play`.', ...ephemeral });
    return interaction.reply({ content: `🎶 Now playing **${np.station.name}** (${np.station.genre}) · volume **${np.volume}%**.`, ...ephemeral });
  }

  if (sub === 'stop') {
    const check = music.checkUsable(interaction, settings);
    if (check.error) return interaction.reply({ content: check.error, ...ephemeral });
    return interaction.reply({ content: music.stop(guild.id) ? '⏹️ Stopped the music and left the channel.' : '🔇 Nothing was playing.', ...ephemeral });
  }

  if (sub === 'volume') {
    const check = music.checkUsable(interaction, settings);
    if (check.error) return interaction.reply({ content: check.error, ...ephemeral });
    const res = music.setVolume(guild.id, interaction.options.getInteger('percent'));
    return interaction.reply({ content: res.error ? `🔇 ${res.error} Start something with \`/music play\`.` : `🔊 Volume set to **${res.volume}%**.`, ...ephemeral });
  }

  // play / skip both join and start a station
  const check = music.checkUsable(interaction, settings);
  if (check.error) return interaction.reply({ content: check.error, ...ephemeral });
  if (!music.playbackAvailable()) {
    return interaction.reply({ content: "🎛️ Voice playback isn't available on this host yet (the bot owner needs ffmpeg + the voice libraries installed).", ...ephemeral });
  }

  let station;
  if (sub === 'skip') {
    const stations = music.allStations(settings);
    const current = music.nowPlaying(guild.id)?.station;
    const idx = current ? stations.findIndex((s) => s.key === current.key) : -1;
    station = stations[(idx + 1) % stations.length];
  } else {
    const q = interaction.options.getString('station');
    station = q ? music.findStation(settings, q) : music.allStations(settings)[0];
    if (!station) return interaction.reply({ content: '🔎 No station by that name. See `/music stations`.', ...ephemeral });
  }

  await interaction.deferReply({ ephemeral: true });
  const res = await music.play(guild, check.voiceChannel, interaction.channelId, station, settings.defaultVolume);
  if (res.error) return interaction.editReply({ content: res.error });
  return interaction.editReply({ content: `${sub === 'skip' ? '⏭️ Skipped to' : '▶️ Now playing'} **${station.name}** (${station.genre}) in **${check.voiceChannel.name}**.` });
}

module.exports = { data, execute };
