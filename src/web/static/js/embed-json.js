// Discord message JSON helpers shared by the Embed Builder (browser, window.EmbedJson) and the
// server (require). Messages use Discord's own format — { content, embeds: [...] } — the same
// thing Discohook and webhooks use, so saves can be moved between tools freely.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EmbedJson = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const LIMITS = {
    content: 2000,
    embeds: 10,
    title: 256,
    description: 4096,
    fields: 25,
    fieldName: 256,
    fieldValue: 1024,
    footer: 2048,
    author: 256,
    total: 6000 // characters across one embed's title, description, fields, footer and author
  };

  const str = (v, max) => (typeof v === 'string' ? v : v == null ? '' : String(v)).slice(0, max);
  const isUrl = (v) => typeof v === 'string' && /^https?:\/\/\S+$/i.test(v.trim());
  const url = (v) => (isUrl(v) ? v.trim().slice(0, 2048) : undefined);

  function colorToInt(v) {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'number' && Number.isFinite(v)) return Math.max(0, Math.min(0xffffff, Math.round(v)));
    const hex = String(v).trim().replace(/^#/, '');
    if (/^[0-9a-f]{6}$/i.test(hex)) return parseInt(hex, 16);
    if (/^[0-9a-f]{3}$/i.test(hex)) return parseInt(hex.split('').map((c) => c + c).join(''), 16);
    if (/^\d+$/.test(String(v))) return Math.min(0xffffff, Number(v));
    return null;
  }
  const intToHex = (n) => (n === null || n === undefined ? null : `#${Number(n).toString(16).padStart(6, '0')}`);

  // Returns a clean Discord embed object, or null if nothing visible is left.
  function normalizeEmbed(e) {
    if (!e || typeof e !== 'object') return null;
    const out = {};
    const author = e.author && typeof e.author === 'object' ? e.author : null;
    if (author && str(author.name, LIMITS.author).trim()) {
      out.author = { name: str(author.name, LIMITS.author) };
      if (url(author.url)) out.author.url = url(author.url);
      if (url(author.icon_url || author.iconURL || author.iconUrl)) out.author.icon_url = url(author.icon_url || author.iconURL || author.iconUrl);
    }
    if (str(e.title, LIMITS.title).trim()) out.title = str(e.title, LIMITS.title);
    if (url(e.url)) out.url = url(e.url);
    if (str(e.description, LIMITS.description).trim()) out.description = str(e.description, LIMITS.description);
    const color = colorToInt(e.color);
    if (color !== null) out.color = color;
    const fields = (Array.isArray(e.fields) ? e.fields : [])
      .filter((f) => f && (str(f.name, 1).trim() || str(f.value, 1).trim()))
      .slice(0, LIMITS.fields)
      .map((f) => ({
        // Discord requires both; a zero-width space stands in for an intentionally blank side.
        name: str(f.name, LIMITS.fieldName).trim() ? str(f.name, LIMITS.fieldName) : '​',
        value: str(f.value, LIMITS.fieldValue).trim() ? str(f.value, LIMITS.fieldValue) : '​',
        inline: !!f.inline
      }));
    if (fields.length) out.fields = fields;
    const image = e.image && typeof e.image === 'object' ? e.image.url : e.image;
    if (url(image)) out.image = { url: url(image) };
    const thumb = e.thumbnail && typeof e.thumbnail === 'object' ? e.thumbnail.url : e.thumbnail;
    if (url(thumb)) out.thumbnail = { url: url(thumb) };
    const footer = e.footer && typeof e.footer === 'object' ? e.footer : typeof e.footer === 'string' ? { text: e.footer } : null;
    if (footer && str(footer.text, LIMITS.footer).trim()) {
      out.footer = { text: str(footer.text, LIMITS.footer) };
      if (url(footer.icon_url || footer.iconURL || footer.iconUrl)) out.footer.icon_url = url(footer.icon_url || footer.iconURL || footer.iconUrl);
    }
    if (e.timestamp) {
      const d = new Date(e.timestamp);
      if (!Number.isNaN(d.getTime())) out.timestamp = d.toISOString();
    }
    const visible = out.title || out.description || out.fields || out.image || out.thumbnail || out.footer || out.author;
    return visible ? out : null;
  }

  function embedLength(e) {
    return (
      (e.title || '').length +
      (e.description || '').length +
      (e.footer?.text || '').length +
      (e.author?.name || '').length +
      (e.fields || []).reduce((n, f) => n + f.name.length + f.value.length, 0)
    );
  }

  function normalizeMessage(m) {
    const src = m && typeof m === 'object' ? m : {};
    const embeds = (Array.isArray(src.embeds) ? src.embeds : []).map(normalizeEmbed).filter(Boolean).slice(0, LIMITS.embeds);
    const out = { content: str(src.content, LIMITS.content), embeds };
    return out;
  }

  // Problems that would make Discord reject the message (empty, or an embed over 6000 characters).
  function validateMessage(m) {
    const errors = [];
    if (!m.content.trim() && !m.embeds.length) errors.push('Add some message text or an embed first.');
    m.embeds.forEach((e, i) => {
      const n = embedLength(e);
      if (n > LIMITS.total) errors.push(`Embed ${i + 1} has ${n.toLocaleString()} characters — Discord allows ${LIMITS.total.toLocaleString()} per embed.`);
    });
    return errors;
  }

  // The old builder saved one embed as flat fields — turn that into a message.
  function legacyToMessage(t) {
    const e = normalizeEmbed({
      title: t.title,
      description: t.description,
      color: t.color,
      footer: t.footer ? { text: t.footer } : null,
      image: t.imageUrl ? { url: t.imageUrl } : null,
      thumbnail: t.thumbnailUrl ? { url: t.thumbnailUrl } : null,
      fields: t.fields
    });
    return { content: str(t.content, LIMITS.content), embeds: e ? [e] : [] };
  }

  const looksLikeEmbed = (o) =>
    o && typeof o === 'object' && !Array.isArray(o) && !('embeds' in o) && ['title', 'description', 'fields', 'author', 'footer', 'image', 'thumbnail'].some((k) => k in o);
  const looksLikeMessage = (o) => o && typeof o === 'object' && !Array.isArray(o) && ('embeds' in o || 'content' in o);

  function base64UrlDecode(s) {
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=');
    if (typeof atob === 'function') {
      const bin = atob(b64);
      const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
      return new TextDecoder().decode(bytes);
    }
    return Buffer.from(b64, 'base64').toString('utf8');
  }

  /**
   * Reads anything people are likely to paste or upload and returns [{ name, message }]:
   * - a Discord message / webhook payload: { content, embeds }
   * - a single embed object, or an array of embeds
   * - Discohook JSON ({ messages: [{ data: {...} }] }) and Discohook backup files ({ backups: [...] })
   * - an old-style Discohook share link (…?data=base64)
   * - LoofaryBot's own template export ({ templates: [{ name, message }] })
   * Throws an Error with a readable message when nothing usable is found.
   */
  function parseImport(input, fallbackName = 'Imported') {
    let data = input;
    if (typeof data === 'string') {
      const text = data.trim();
      if (!text) throw new Error('Paste some JSON or choose a file first.');
      if (/^https?:\/\//i.test(text)) {
        let param = null;
        try {
          param = new URL(text).searchParams.get('data');
        } catch (e) {
          /* not a URL after all */
        }
        if (!param) {
          throw new Error("That link doesn't contain the message itself. In Discohook, open the JSON editor (or Backups → Export) and copy the JSON instead.");
        }
        try {
          data = JSON.parse(base64UrlDecode(param));
        } catch (e) {
          throw new Error("Couldn't read the data in that share link.");
        }
      } else {
        try {
          data = JSON.parse(text);
        } catch (e) {
          throw new Error(`That isn't valid JSON (${e.message}).`);
        }
      }
    }

    const results = [];
    const push = (name, msg) => {
      const message = normalizeMessage(msg);
      if (message.content.trim() || message.embeds.length) results.push({ name: str(name || fallbackName, 100).trim() || fallbackName, message });
    };
    const fromMessages = (name, messages) => {
      const list = (messages || []).map((m) => (m && m.data ? m.data : m)).filter(Boolean);
      list.forEach((m, i) => push(list.length > 1 ? `${name} (${i + 1})` : name, m));
    };

    if (Array.isArray(data)) {
      if (data.every(looksLikeEmbed)) push(fallbackName, { embeds: data });
      else data.forEach((m, i) => (looksLikeEmbed(m) ? push(`${fallbackName} (${i + 1})`, { embeds: [m] }) : push(m?.name || `${fallbackName} (${i + 1})`, m?.message || m?.data || m)));
    } else if (data && typeof data === 'object') {
      if (Array.isArray(data.templates)) {
        data.templates.forEach((t, i) => push(t.name || `${fallbackName} (${i + 1})`, t.message || t.data || t));
      } else if (Array.isArray(data.backups)) {
        data.backups.forEach((b, i) => fromMessages(b.name || `Backup ${i + 1}`, b.messages || b.data?.messages || []));
      } else if (Array.isArray(data.messages)) {
        fromMessages(data.name || fallbackName, data.messages);
      } else if (data.data && looksLikeMessage(data.data)) {
        push(data.name || fallbackName, data.data);
      } else if (looksLikeMessage(data)) {
        push(data.name || fallbackName, data);
      } else if (looksLikeEmbed(data)) {
        push(fallbackName, { embeds: [data] });
      }
    }
    if (!results.length) throw new Error('No message text or embeds were found in that JSON.');
    return results;
  }

  return { LIMITS, colorToInt, intToHex, normalizeEmbed, normalizeMessage, validateMessage, embedLength, legacyToMessage, parseImport };
});
