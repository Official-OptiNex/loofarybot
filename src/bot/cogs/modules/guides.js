// Guides: editors publish server guides as posts in a forum channel. The bot owns each post, so a
// guide can be edited later and the live forum post updates in place. A pinned "📖 Guides Index" post
// is kept up to date automatically, and editors get a private channel to coordinate. Guide bodies use
// Discord message JSON ({ content, embeds }) — the same format as the Embed Builder — so they import
// and export cleanly (handy for porting an existing guide set in through the dashboard).
const { ChannelType, PermissionFlagsBits } = require('discord.js');
const GuildConfig = require('../../../database/models/GuildConfig');
const Guide = require('../../../database/models/Guide');
const EmbedJson = require('../../../web/static/js/embed-json');

const LEGEND_TITLE = '📖 Guides Index';
const START_TITLE = '📖 Start Here — Guides Index';
// A guide marked "include in index" (or tagged "Start Here") isn't posted on its own: its body is
// shown at the top of the pinned index post instead, so the forum has one pinned "start here" post.
const START_TAG = 'start here';
const isInIndex = (guide) => !!guide?.inIndex || (guide?.tags || []).some((t) => String(t).trim().toLowerCase() === START_TAG);

function guidesSettings(config) {
  const g = (config && config.guides) || {};
  return {
    enabled: !!g.enabled,
    forumChannelId: g.forumChannelId || null,
    editorRoleIds: Array.isArray(g.editorRoleIds) ? g.editorRoleIds : [],
    editorChannelId: g.editorChannelId || null,
    legendThreadId: g.legendThreadId || null,
    legendMessageId: g.legendMessageId || null,
    index: cleanIndex(g.index)
  };
}

/**
 * The pinned index post's look: post name, embed title + colour, intro text above the guide list,
 * and footer ({count} = number of guides). Empty values fall back to the defaults.
 */
function cleanIndex(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const str = (v, max) => String(v ?? '').trim().slice(0, max);
  const color = EmbedJson.colorToInt(r.color);
  return {
    name: str(r.name, 100),
    title: str(r.title, 256),
    color: Number.isInteger(color) ? color : null,
    intro: str(r.intro, 3000),
    footer: str(r.footer, 200)
  };
}

/** Saves the index post's look (dashboard) and rebuilds it. */
async function saveIndex(guild, input, settings) {
  const index = cleanIndex(resolveEmojis(guild, input));
  await GuildConfig.updateOne({ guildId: guild.id }, { $set: { 'guides.index': index } }, { upsert: true });
  await rebuildLegend(guild, { ...settings, index });
  return { index };
}

/** A stable, URL-safe id from a title (e.g. "Data Collection!" → "data-collection"). */
function slugify(title) {
  return (
    String(title || '')
      .toLowerCase()
      .trim()
      .replace(/[^\w]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'guide'
  );
}

async function uniqueSlug(guildId, title, keep = null) {
  const base = slugify(title);
  let slug = base;
  let n = 2;
  // eslint-disable-next-line no-await-in-loop
  while (true) {
    const existing = await Guide.findOne({ guildId, slug }, { slug: 1 }).lean();
    if (!existing || existing.slug === keep) return slug;
    slug = `${base}-${n++}`.slice(0, 90);
  }
}

/** True when a member may create/edit guides (an editor role, or Manage Server / Administrator). */
function isEditor(member, settings) {
  if (!member) return false;
  if (member.permissions?.has?.(PermissionFlagsBits.ManageGuild) || member.permissions?.has?.(PermissionFlagsBits.Administrator)) return true;
  return (settings.editorRoleIds || []).some((id) => member.roles?.cache?.has(id));
}

/** Accepts a body as Discord message JSON ({ content, embeds }) or a plain markdown string. */
function normalizeBody(body) {
  if (typeof body === 'string') {
    const text = body.trim();
    if (!text) return { content: '', embeds: [] };
    // A markdown string becomes an embed description so it can be long (4096) and never pings.
    return EmbedJson.normalizeMessage({ embeds: [{ description: text }] });
  }
  return EmbedJson.normalizeMessage(body || {});
}

// Links between guides are stored as [text](guide:slug) — guide:index is the pinned index post — and
// become real post links when published, so they survive posts being recreated.
const GUIDE_LINK = /\[((?:[^\[\]\\]|\\.)+)\]\(<?guide:([\w-]+)>?\)/g;
const hasGuideLinks = (body) => /\(<?guide:[\w-]+>?\)/.test(JSON.stringify(body || {}));

/** slug → post url for every guide (plus 'index'); guides shown inside the index link to it. */
async function guideLinks(guild) {
  const [all, cfg] = await Promise.all([Guide.find({ guildId: guild.id }, { slug: 1, threadId: 1 }).lean(), GuildConfig.findOne({ guildId: guild.id }, { guides: 1 }).lean()]);
  const url = (id) => (id ? `https://discord.com/channels/${guild.id}/${id}` : null);
  const map = { index: url(guidesSettings(cfg).legendThreadId) };
  for (const g of all) map[g.slug] = url(g.threadId);
  return map;
}

/** Swaps guide:slug links for post urls (an unknown or unposted guide leaves just the link text). */
function resolveGuideLinks(value, links) {
  if (!links) return value;
  if (typeof value === 'string') return value.replace(GUIDE_LINK, (m, text, slug) => (links[slug] ? `[${text}](${links[slug]})` : text));
  if (Array.isArray(value)) return value.map((v) => resolveGuideLinks(v, links));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveGuideLinks(v, links)]));
  return value;
}

/** The message payload for a guide's forum post. Never empty (Discord rejects an empty post). */
function buildPayload(guide, links = null) {
  const body = resolveGuideLinks(guide.body || {}, links);
  const content = (body.content || '').slice(0, 2000);
  const embeds = Array.isArray(body.embeds) ? body.embeds : [];
  if (!content.trim() && !embeds.length) return { content: `**${(guide.title || 'Guide').slice(0, 240)}**\n*(No content yet — edit this guide to add some.)*` };
  return { content: content || null, embeds };
}

/** Maps a guide's tag names to the forum's tag ids (case-insensitive), capped at Discord's 5. */
function mapTags(forum, tagNames) {
  const available = forum.availableTags || [];
  const ids = [];
  for (const name of tagNames || []) {
    const tag = available.find((t) => t.name.toLowerCase() === String(name).toLowerCase());
    if (tag && !ids.includes(tag.id)) ids.push(tag.id);
  }
  return ids.slice(0, 5);
}

const getForum = (guild, settings) => {
  const forum = settings.forumChannelId && guild.channels.cache.get(settings.forumChannelId);
  return forum && forum.type === ChannelType.GuildForum ? forum : null;
};

async function fetchThread(forum, id) {
  if (!id) return null;
  return forum.guild.channels.cache.get(id) || (await forum.threads.fetch(id).then((t) => t, () => null));
}

/** Creates or updates the guide's forum post (name, tags, and the starter message body). */
async function publishGuide(guild, guide, settings) {
  const forum = getForum(guild, settings);
  if (!forum) return { error: 'Set a **forum channel** for guides first (`/guide setup`).' };
  if (isInIndex(guide)) {
    // Lives inside the index post: drop any post of its own (e.g. it was just tagged Start Here).
    const { legendThreadId } = guidesSettings(await GuildConfig.findOne({ guildId: guild.id }, { guides: 1 }).lean());
    if (guide.threadId && guide.threadId !== legendThreadId) {
      const own = await fetchThread(forum, guide.threadId);
      if (own) await own.delete('Guide moved into the index post').catch(() => null);
    }
    return { threadId: legendThreadId, messageId: legendThreadId };
  }
  const payload = buildPayload(guide, await guideLinks(guild));
  const appliedTags = mapTags(forum, guide.tags);

  let thread = await fetchThread(forum, guide.threadId);
  if (thread && thread.id === guidesSettings(await GuildConfig.findOne({ guildId: guild.id }, { guides: 1 }).lean()).legendThreadId) thread = null; // was Start Here; needs its own post again
  if (thread) {
    if (thread.name !== guide.title) await thread.setName(guide.title.slice(0, 100)).catch(() => null);
    if (thread.setAppliedTags) await thread.setAppliedTags(appliedTags).catch(() => null);
    const starter = await thread.fetchStarterMessage().catch(() => null);
    if (starter) await starter.edit(payload).catch(() => null);
    return { threadId: thread.id, messageId: thread.id };
  }
  thread = await forum.threads.create({ name: guide.title.slice(0, 100), message: payload, appliedTags }).catch((e) => ({ error: e.message }));
  if (!thread || thread.error) return { error: `Couldn't post the guide. (${thread?.error || 'unknown error'})` };
  return { threadId: thread.id, messageId: thread.id };
}

async function createGuide(guild, { title, tags = [], body = null, inIndex = false, authorId = null, createdBy = null }, settings, { rebuild = true } = {}) {
  const cleanTitle = String(title || '').trim().slice(0, 100);
  if (!cleanTitle) return { error: 'A guide needs a title.' };
  const slug = await uniqueSlug(guild.id, cleanTitle);
  const guide = { guildId: guild.id, slug, title: cleanTitle, tags: (tags || []).map(String).slice(0, 5), body: normalizeBody(resolveEmojis(guild, body)), inIndex: !!inIndex, authorId, createdBy };
  const pub = await publishGuide(guild, guide, settings);
  if (pub.error) return { error: pub.error };
  guide.threadId = pub.threadId;
  guide.messageId = pub.messageId;
  const doc = await Guide.create(guide);
  if (rebuild) {
    await rebuildLegend(guild, settings);
    await refreshLinkingGuides(guild, settings, [slug]);
  }
  return { guide: doc.toObject ? doc.toObject() : doc };
}

async function editGuide(guild, slug, patch, byId, settings, { rebuild = true } = {}) {
  const guide = await Guide.findOne({ guildId: guild.id, slug });
  if (!guide) return { error: 'No guide by that name.' };
  if (patch.title !== undefined) guide.title = String(patch.title).trim().slice(0, 100) || guide.title;
  if (patch.tags !== undefined) guide.tags = (patch.tags || []).map(String).slice(0, 5);
  if (patch.inIndex !== undefined) guide.inIndex = !!patch.inIndex;
  if (patch.body !== undefined) {
    guide.body = normalizeBody(resolveEmojis(guild, patch.body));
    guide.markModified('body');
  }
  if (patch.authorId !== undefined) guide.authorId = patch.authorId;
  guide.editedBy = byId;
  const pub = await publishGuide(guild, guide, settings);
  if (pub.error) return { error: pub.error };
  guide.threadId = pub.threadId;
  guide.messageId = pub.messageId;
  await guide.save();
  if (rebuild) await rebuildLegend(guild, settings);
  return { guide: guide.toObject() };
}

async function deleteGuide(guild, slug, settings) {
  const guide = await Guide.findOne({ guildId: guild.id, slug }).lean();
  if (!guide) return { error: 'No guide by that name.' };
  const forum = getForum(guild, settings);
  const { legendThreadId } = guidesSettings(await GuildConfig.findOne({ guildId: guild.id }, { guides: 1 }).lean());
  if (forum && guide.threadId && guide.threadId !== legendThreadId) {
    const thread = await fetchThread(forum, guide.threadId);
    if (thread) await thread.delete('Guide deleted').catch(() => null);
  }
  await Guide.deleteOne({ guildId: guild.id, slug });
  await rebuildLegend(guild, settings);
  await refreshLinkingGuides(guild, settings, [slug]);
  return { ok: true, title: guide.title };
}

async function listGuides(guildId) {
  return Guide.find({ guildId }).sort({ order: 1, title: 1 }).lean();
}

/** Sets the manual order of guides (by slug, in the given order) and refreshes the legend. */
async function reorderGuides(guild, orderedSlugs, settings) {
  const slugs = Array.isArray(orderedSlugs) ? orderedSlugs : [];
  for (let i = 0; i < slugs.length; i++) await Guide.updateOne({ guildId: guild.id, slug: slugs[i] }, { $set: { order: i } });
  await rebuildLegend(guild, settings);
  return { ok: true };
}

async function getGuide(guildId, query) {
  const q = String(query || '').trim();
  if (!q) return null;
  const bySlug = await Guide.findOne({ guildId, slug: slugify(q) }).lean();
  if (bySlug) return bySlug;
  const all = await Guide.find({ guildId }).lean();
  const lower = q.toLowerCase();
  return all.find((g) => g.title.toLowerCase() === lower) || all.find((g) => g.title.toLowerCase().includes(lower)) || null;
}

async function searchGuides(guildId, text, limit = 25) {
  const q = String(text || '').trim().toLowerCase();
  const all = await Guide.find({ guildId }).sort({ title: 1 }).lean();
  if (!q) return all.slice(0, limit);
  return all
    .filter((g) => g.title.toLowerCase().includes(q) || (g.tags || []).some((t) => t.toLowerCase().includes(q)) || JSON.stringify(g.body || '').toLowerCase().includes(q))
    .slice(0, limit);
}

/** Rebuilds the pinned "📖 Guides Index" post: guides included in the index first, then every other guide grouped by tag, with jump links. */
async function rebuildLegend(guild, settings) {
  const forum = getForum(guild, settings);
  if (!forum) return;
  const all = await Guide.find({ guildId: guild.id }).sort({ order: 1, title: 1 }).lean();
  const fresh = guidesSettings(await GuildConfig.findOne({ guildId: guild.id }, { guides: 1 }).lean());
  const look = fresh.index;
  const included = all.filter(isInIndex);
  const guides = all.filter((g) => !isInIndex(g));
  const byTag = {};
  for (const g of guides) {
    const tags = (g.tags || []).length ? g.tags : ['Other'];
    for (const t of tags) (byTag[t] = byTag[t] || []).push(g);
  }
  const link = (g) => `https://discord.com/channels/${guild.id}/${g.threadId}`;
  const parts = [];
  for (const tag of Object.keys(byTag).sort((a, b) => a.localeCompare(b))) {
    parts.push(`\n**${tag}**`);
    for (const g of byTag[tag]) parts.push(`• [${g.title}](${link(g)})`);
  }
  const links = await guideLinks(guild);
  const intros = included.map((g) => buildPayload(g, links));
  const introContent = intros.map((p) => p.content).filter(Boolean).join('\n\n').slice(0, 2000);
  const introEmbeds = intros.flatMap((p) => p.embeds || []).slice(0, 9);
  // Discord caps a message's embeds at 6000 characters in total, so the index gets what the intro leaves.
  const title = look.title || LEGEND_TITLE;
  const count = `${guides.length} guide${guides.length === 1 ? '' : 's'}`;
  const footer = (look.footer ? look.footer.replace(/\{count\}/gi, count) : count).slice(0, 2048);
  const list = parts.join('\n').trim() || '_No guides yet._';
  const room = 6000 - introEmbeds.reduce((n, e) => n + EmbedJson.embedLength(e), 0) - title.length - footer.length - 20;
  const description = ((look.intro ? `${look.intro}\n\n` : '') + list).slice(0, Math.max(0, Math.min(4096, room)));
  const embed = { title, description, color: look.color ?? 0x5865f2, footer: { text: footer } };
  const payload = { content: introContent || null, embeds: [...introEmbeds, embed] };
  const name = look.name || (included.length ? START_TITLE : LEGEND_TITLE);

  const linkStart = async (id) => {
    const stale = included.filter((g) => g.threadId !== id).map((g) => g.slug);
    if (stale.length) await Guide.updateMany({ guildId: guild.id, slug: { $in: stale } }, { $set: { threadId: id, messageId: id } });
  };
  let thread = await fetchThread(forum, fresh.legendThreadId);
  if (thread) {
    const starter = await thread.fetchStarterMessage().catch(() => null);
    if (starter) {
      if (thread.name !== name) await thread.setName(name).catch(() => null);
      await starter.edit(payload).catch(() => null);
      await linkStart(thread.id);
      return;
    }
  }
  thread = await forum.threads.create({ name, message: payload }).catch(() => null);
  if (thread) {
    await linkStart(thread.id);
    await thread.pin?.().catch(() => null);
    await thread.setAppliedTags?.([]).catch(() => null);
    await GuildConfig.updateOne({ guildId: guild.id }, { $set: { 'guides.legendThreadId': thread.id, 'guides.legendMessageId': thread.id } }, { upsert: true });
  }
}

/** Swaps :Name: shortcodes for the server's custom emojis (<:Name:id>), exact name first, then any case. */
function resolveEmojis(guild, value) {
  const emojis = guild.emojis?.cache;
  if (!emojis?.size) return value;
  const find = (name) => emojis.find((e) => e.name === name) || emojis.find((e) => e.name?.toLowerCase() === name.toLowerCase());
  const swap = (text) => text.replace(/(?<!<a?):(\w{2,32}):(?!\d)/g, (m, name) => {
    const e = find(name);
    return e ? `<${e.animated ? 'a' : ''}:${e.name}:${e.id}>` : m;
  });
  const walk = (v) => {
    if (typeof v === 'string') return swap(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === 'url' ? x : walk(x)]));
    return v;
  };
  return walk(value);
}

/** Re-publishes guides whose guide:links point at `slugs` (all linking guides when omitted), e.g. after a post is created. */
async function refreshLinkingGuides(guild, settings, slugs = null) {
  const all = await Guide.find({ guildId: guild.id }).lean();
  const wanted = slugs && new Set(slugs);
  for (const g of all) {
    if (!hasGuideLinks(g.body) || isInIndex(g)) continue;
    if (wanted && ![...JSON.stringify(g.body).matchAll(/guide:([\w-]+)/g)].some((m) => wanted.has(m[1]))) continue;
    await publishGuide(guild, g, settings);
  }
}

/**
 * Bulk import (dashboard, admins): [{ title, tags, body, images, inIndex }]. A guide whose title matches
 * an existing one updates it in place (same post); new guides are added after the rest in file order.
 */
async function importGuides(guild, items, byId, settings) {
  const list = Array.isArray(items) ? items.slice(0, 200) : [];
  const imported = [];
  const updated = [];
  const skipped = [];
  const existing = await Guide.find({ guildId: guild.id }, { slug: 1, title: 1, order: 1 }).lean();
  let nextOrder = existing.reduce((n, g) => Math.max(n, (g.order || 0) + 1), 0);
  for (const raw of list) {
    const title = String(raw?.title || '').trim();
    if (!title) {
      skipped.push(raw?.title || '(no title)');
      continue;
    }
    // Merge any image URLs into the body as extra embeds, after normalising the body.
    const base = normalizeBody(resolveEmojis(guild, raw.body));
    const images = (Array.isArray(raw.images) ? raw.images : []).filter((u) => /^https?:\/\/\S+$/i.test(String(u)));
    if (images.length) {
      base.embeds = base.embeds || [];
      if (base.embeds[0] && !base.embeds[0].image) base.embeds[0].image = { url: images.shift() };
      for (const u of images) {
        if (base.embeds.length >= 10) break;
        base.embeds.push({ image: { url: u } });
      }
    }
    const fields = { title, tags: raw.tags || raw.category ? [].concat(raw.tags || raw.category) : [], body: base, inIndex: !!(raw.inIndex ?? raw.includeInIndex) };
    const same = existing.find((g) => g.title.trim().toLowerCase() === title.toLowerCase());
    if (same) {
      const res = await editGuide(guild, same.slug, fields, byId, settings, { rebuild: false });
      (res.error ? skipped : updated).push(title);
      continue;
    }
    const res = await createGuide(guild, { ...fields, authorId: byId, createdBy: byId }, settings, { rebuild: false });
    if (res.error) skipped.push(title);
    else {
      imported.push(title);
      await Guide.updateOne({ guildId: guild.id, slug: res.guide.slug }, { $set: { order: nextOrder++ } });
    }
  }
  await rebuildLegend(guild, settings);
  // Links to guides created later in the file couldn't resolve when the earlier ones were posted.
  await refreshLinkingGuides(guild, settings);
  return { imported, updated, skipped };
}

/** Creates (or locks an existing) private channel only guide editors + admins can see. */
async function ensureEditorChannel(guild, settings, { existingId = null, name = 'guide-editors' } = {}) {
  const me = guild.members.me;
  const overwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    ...(settings.editorRoleIds || []).map((id) => ({ id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] })),
    ...(me ? [{ id: me.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels] }] : [])
  ];
  let channel = existingId && guild.channels.cache.get(existingId);
  if (channel) {
    await channel.permissionOverwrites?.set(overwrites, 'Guide editor channel').catch(() => null);
  } else {
    if (!me?.permissions?.has(PermissionFlagsBits.ManageChannels)) return { error: 'I need **Manage Channels** to make the editor channel.' };
    channel = await guild.channels.create({ name, type: ChannelType.GuildText, topic: 'Private channel for guide editors.', permissionOverwrites: overwrites }).catch(() => null);
    if (!channel) return { error: "I couldn't create the editor channel." };
  }
  await GuildConfig.updateOne({ guildId: guild.id }, { $set: { 'guides.editorChannelId': channel.id } }, { upsert: true });
  return { channel };
}

// Re-applies the editor-role permissions to the editor channel (after the editor roles change).
async function syncEditorChannel(guild, settings) {
  if (!settings.editorChannelId) return;
  await ensureEditorChannel(guild, settings, { existingId: settings.editorChannelId });
}

/** Validates a settings update from /guide or the dashboard. Returns { patch } or { error }. */
function cleanSettings(guild, input) {
  const patch = {};
  if (input.enabled !== undefined) patch['guides.enabled'] = !!input.enabled;
  if (input.forumChannelId !== undefined) {
    const id = input.forumChannelId ? String(input.forumChannelId) : null;
    if (id) {
      const ch = guild.channels.cache.get(id);
      if (!ch || ch.type !== ChannelType.GuildForum) return { error: 'Pick a **forum** channel for guides.' };
    }
    patch['guides.forumChannelId'] = id;
  }
  if (input.editorRoleIds !== undefined) {
    const ids = (Array.isArray(input.editorRoleIds) ? input.editorRoleIds : []).map(String).filter((id) => guild.roles.cache.has(id));
    patch['guides.editorRoleIds'] = [...new Set(ids)].slice(0, 10);
  }
  if (input.editorChannelId !== undefined) patch['guides.editorChannelId'] = input.editorChannelId ? String(input.editorChannelId) : null;
  return { patch };
}

async function saveSettings(guild, input) {
  const { patch, error } = cleanSettings(guild, input);
  if (error) return { error };
  await GuildConfig.updateOne({ guildId: guild.id }, { $set: patch }, { upsert: true });
  const fresh = guidesSettings(await GuildConfig.findOne({ guildId: guild.id }, { guides: 1 }).lean());
  if (patch['guides.editorRoleIds'] !== undefined) await syncEditorChannel(guild, fresh);
  return { settings: fresh };
}

module.exports = {
  guidesSettings,
  slugify,
  uniqueSlug,
  isEditor,
  normalizeBody,
  buildPayload,
  resolveGuideLinks,
  mapTags,
  publishGuide,
  createGuide,
  editGuide,
  deleteGuide,
  listGuides,
  reorderGuides,
  getGuide,
  searchGuides,
  rebuildLegend,
  importGuides,
  cleanIndex,
  saveIndex,
  resolveEmojis,
  ensureEditorChannel,
  syncEditorChannel,
  cleanSettings,
  saveSettings,
  LEGEND_TITLE,
  isInIndex
};
