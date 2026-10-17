// "New here?" message: a button on the welcome message (and optionally a panel in any channel) that
// shows whoever presses it a private "Only you can see this" message — a multi-embed intro to the
// server. Discord only allows private messages as a reply to a click or command, so it's a button
// rather than something sent on join. Everything (text, embeds, button, panel) is set on the dashboard
// (Welcome → New members) or with /welcome newmember.
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } = require('discord.js');
const WelcomeConfig = require('../../../database/models/WelcomeConfig');
const EmbedJson = require('../../../web/static/js/embed-json');
const { applyPlaceholders } = require('./welcome');

const BUTTON_ID = 'nm:show';
const STYLES = ['Primary', 'Secondary', 'Success', 'Danger'];

// The starter message — edit it on the dashboard to link your own channels.
const DEFAULT_MESSAGE = {
  content: '',
  embeds: [
    {
      title: '👋 Welcome to {server}, {username}!',
      description: "Here's everything you need to get going. Only you can see this — press the button again any time to bring it back.",
      color: 0x5865f2,
      thumbnail: { url: '{avatar}' }
    },
    {
      title: '🤖 Commands you’ll use',
      color: 0xf1c40f,
      fields: [
        {
          name: '📈 Leveling & XP',
          value:
            '`/daily` — claim daily XP; claiming on consecutive days builds a streak with bigger rewards.\n' +
            '`/levels rank` — your level, XP and server rank.\n' +
            '`/levels leaderboard` — the server’s XP leaderboard.\n' +
            '`/levels card` — change your rank card’s colour, background and tagline.'
        },
        {
          name: '🧰 Game tools',
          value: '`/calculate` — what it costs to reach your pet, gun or fish goal.\n`/guide view · list · search` — open, list or search the guides.'
        },
        {
          name: '🛍️ Spending XP',
          value:
            '`/shop view` · `/shop buy` — browse and buy items.\n' +
            '`/shop inventory` — see what you own.\n' +
            '`/gamble coinflip · dice · limbo · blackjack · mines · highlow` — the XP games.\n' +
            '`/gamble info` — payouts, and how many plays and XP you have left today.\n' +
            '`/pot view` — today’s Daily XP Pot.\n' +
            '`/idle play` — the Bubble Factory idle game (no gambling).'
        },
        {
          name: '🧭 Everyday',
          value:
            '`/remind me` — DM yourself a reminder, e.g. in 2h.\n' +
            '`/birthday set` — save your birthday.\n' +
            '`/music play` — lofi radio in your voice channel.\n' +
            '`/userinfo` · `/avatar` · `/serverinfo` — info about a member or the server.\n' +
            '`/loof help` — every command.'
        }
      ]
    },
    {
      title: '📍 Good to know',
      color: 0x57f287,
      description:
        '🎁 **XP drops** — every so often an XP drop pops up in chat. Be the first to press **Claim** to win the XP!\n' +
        '🔢 **Counting** — count up one number at a time with the others in the counting channel (maths works too).'
    }
  ]
};

const DEFAULT_PANEL = {
  content: '',
  embeds: [{ title: '👋 New here?', description: 'Press the button below for a quick guide to the server — only you will see it.', color: 0x5865f2 }]
};

/** Settings with defaults filled in. */
function settings(doc) {
  const n = (doc && doc.newMember) || {};
  return {
    enabled: !!n.enabled,
    onWelcome: n.onWelcome !== false,
    buttonLabel: (n.buttonLabel ?? 'New here? Click me').slice(0, 80),
    buttonEmoji: n.buttonEmoji ?? '👋',
    buttonStyle: STYLES.includes(n.buttonStyle) ? n.buttonStyle : 'Primary',
    message: n.message && typeof n.message === 'object' ? n.message : DEFAULT_MESSAGE,
    panelChannelId: n.panelChannelId || null,
    panelMessageId: n.panelMessageId || null,
    panel: n.panel && typeof n.panel === 'object' ? n.panel : DEFAULT_PANEL
  };
}

/** The button that opens the private message. */
function button(s) {
  const b = new ButtonBuilder().setCustomId(BUTTON_ID).setStyle(ButtonStyle[s.buttonStyle] || ButtonStyle.Primary);
  if (s.buttonLabel) b.setLabel(s.buttonLabel);
  if (s.buttonEmoji) b.setEmoji(s.buttonEmoji);
  if (!s.buttonLabel && !s.buttonEmoji) b.setLabel('Start here');
  return b;
}
const buttonRow = (s) => new ActionRowBuilder().addComponents(button(s));

/** Fills the placeholders across a Discord message JSON ({avatar} works in image / thumbnail URLs). */
function fillMessage(message, member) {
  const fill = (v) => (typeof v === 'string' ? applyPlaceholders(v, member) : v);
  const avatar = (u) => (u === '{avatar}' ? member.user.displayAvatarURL({ size: 256 }) : u);
  const m = EmbedJson.normalizeMessage({
    content: fill(message.content),
    embeds: (message.embeds || []).map((e) => ({
      ...e,
      title: fill(e.title),
      description: fill(e.description),
      author: e.author ? { ...e.author, name: fill(e.author.name) } : undefined,
      footer: e.footer ? (typeof e.footer === 'string' ? { text: fill(e.footer) } : { ...e.footer, text: fill(e.footer.text) }) : undefined,
      fields: (e.fields || []).map((f) => ({ ...f, name: fill(f.name), value: fill(f.value) })),
      image: e.image ? { url: avatar(e.image.url ?? e.image) } : undefined,
      thumbnail: e.thumbnail ? { url: avatar(e.thumbnail.url ?? e.thumbnail) } : undefined
    }))
  });
  const out = { embeds: m.embeds, allowedMentions: { parse: [] } };
  if (m.content.trim()) out.content = m.content;
  return out;
}

/** The private message for `member` (a reply payload), or null when it's empty. */
function privatePayload(s, member) {
  const p = fillMessage(s.message, member);
  return p.content || p.embeds.length ? { ...p, ephemeral: true } : null;
}

/** Someone pressed the button: show them the message, only to them. */
async function handleNewMemberButton(interaction) {
  const s = settings(await WelcomeConfig.findOne({ guildId: interaction.guildId }).lean().catch(() => null));
  if (!s.enabled) return interaction.reply({ content: 'This isn’t set up right now — ask a moderator.', ephemeral: true });
  const payload = privatePayload(s, interaction.member);
  if (!payload) return interaction.reply({ content: 'This message is empty — ask a moderator to set it up.', ephemeral: true });
  return interaction.reply(payload);
}

/** Adds the button to a welcome payload when it's switched on. */
function withWelcomeButton(payload, doc) {
  const s = settings(doc);
  if (!payload || !s.enabled || !s.onWelcome) return payload;
  return { ...payload, components: [...(payload.components || []), buttonRow(s)] };
}

/**
 * Posts (or updates in place) the panel in `channelId`. Returns { error } or { messageId }.
 * The panel's placeholders use the server only ({user}/{username} would be whoever set it up).
 */
async function postPanel(guild, s, channelId) {
  const channel = guild.channels.cache.get(channelId);
  if (!channel || !channel.isTextBased() || channel.isThread?.()) return { error: 'Pick a text channel for the panel.' };
  const me = guild.members.me;
  if (!me || !channel.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
    return { error: `LoofaryBot needs View Channel, Send Messages and Embed Links in #${channel.name}.` };
  }
  const fake = { id: '0', guild, user: { username: 'member', displayAvatarURL: () => guild.iconURL?.() || '' } };
  const body = fillMessage(s.panel, fake);
  if (!body.content && !body.embeds.length) body.content = '👋 New here? Press the button below.';
  const payload = { ...body, components: [buttonRow(s)] };
  // Same channel as before: edit the existing panel instead of posting a new one.
  if (s.panelMessageId && s.panelChannelId === channelId) {
    const old = await channel.messages.fetch(s.panelMessageId).catch(() => null);
    if (old) {
      await old.edit({ content: payload.content ?? '', embeds: payload.embeds, components: payload.components });
      return { messageId: old.id, edited: true };
    }
  }
  const msg = await channel.send(payload);
  return { messageId: msg.id };
}

/** Cleans dashboard / command input. Returns { errors, data } (only the keys given). */
function cleanInput(body = {}) {
  const errors = [];
  const data = {};
  if ('enabled' in body) data.enabled = !!body.enabled;
  if ('onWelcome' in body) data.onWelcome = !!body.onWelcome;
  if ('buttonLabel' in body) data.buttonLabel = String(body.buttonLabel || '').trim().slice(0, 80);
  if ('buttonEmoji' in body) data.buttonEmoji = String(body.buttonEmoji || '').trim().slice(0, 64);
  if ('buttonStyle' in body) data.buttonStyle = STYLES.includes(body.buttonStyle) ? body.buttonStyle : 'Primary';
  if (data.buttonLabel === '' && data.buttonEmoji === '') errors.push('The button needs a label or an emoji.');
  if (data.buttonEmoji && !/^(<a?:\w+:\d+>|\p{Extended_Pictographic}[\u{FE0F}\u{200D}\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}]*|[\u{1F1E6}-\u{1F1FF}]{2}|[#*0-9]\u{FE0F}?\u{20E3})$/u.test(data.buttonEmoji)) {
    errors.push('The button emoji must be a single emoji (or a custom server emoji).');
  }
  for (const key of ['message', 'panel']) {
    if (!(key in body)) continue;
    if (body[key] === null) { data[key] = null; continue; } // back to the starter
    const m = EmbedJson.normalizeMessage(body[key]);
    // Keep {avatar} image / thumbnail URLs, which the normaliser would drop.
    (body[key].embeds || []).forEach((e, i) => {
      if (!m.embeds[i]) return;
      for (const k of ['image', 'thumbnail']) if ((e?.[k]?.url ?? e?.[k]) === '{avatar}') m.embeds[i][k] = { url: '{avatar}' };
    });
    const problems = EmbedJson.validateMessage(m);
    if (problems.length) errors.push(`${key === 'panel' ? 'Panel' : 'Message'}: ${problems[0]}`);
    data[key] = m;
  }
  return { errors, data };
}

async function saveSettings(guildId, input) {
  const { errors, data } = cleanInput(input);
  if (errors.length) return { error: errors[0] };
  const $set = Object.fromEntries(Object.entries(data).map(([k, v]) => [`newMember.${k}`, v]));
  const doc = await WelcomeConfig.findOneAndUpdate({ guildId }, { $set }, { upsert: true, new: true, setDefaultsOnInsert: true }).lean();
  return { settings: settings(doc), doc };
}

module.exports = {
  BUTTON_ID, STYLES, DEFAULT_MESSAGE, DEFAULT_PANEL,
  settings, button, fillMessage, privatePayload, handleNewMemberButton, withWelcomeButton, postPanel, cleanInput, saveSettings
};
