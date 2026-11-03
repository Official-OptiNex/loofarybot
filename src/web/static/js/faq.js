// FAQ editor: the same visual + markdown + JSON multi-embed editor as the Embed Builder (shares
// embed-json.js and mentions.js), trimmed to one message you Save (so /faq show posts it) or Post to a
// channel. Mentions (@user, #channel, :emoji:) autocomplete and render exactly as in the Embed Builder.
(function () {
  const { guildId } = window.FAQ_CONFIG;
  const E = window.EmbedJson;
  const esc = LoofMentions.esc;
  const $ = (id) => document.getElementById(id);
  const DEFAULT_COLOR = '#5865f2';

  let imported = [];

  /* ------------------------------------------------------------ helpers */

  function showToast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.style.display = 'block';
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => (t.style.display = 'none'), 3200);
  }

  async function api(method, path, body) {
    const res = await fetch(path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
    return data;
  }

  const blankEmbed = () => ({ color: E.colorToInt(DEFAULT_COLOR), fields: [] });

  /* ------------------------------------------------------------ editor <-> state */

  function readState() {
    return {
      content: $('content').value,
      embeds: [...document.querySelectorAll('.eb-embed')].map((card) => {
        const v = (k) => card.querySelector(`[data-k="${k}"]`).value;
        const colorOn = card.querySelector('[data-k="colorOn"]').checked;
        return {
          author: { name: v('authorName'), url: v('authorUrl'), icon_url: v('authorIcon') },
          title: v('title'),
          url: v('url'),
          description: v('description'),
          color: colorOn ? E.colorToInt(v('color')) : null,
          fields: [...card.querySelectorAll('.eb-field')].map((f) => ({
            name: f.querySelector('[data-f="name"]').value,
            value: f.querySelector('[data-f="value"]').value,
            inline: f.querySelector('[data-f="inline"]').checked
          })),
          image: { url: v('image') },
          thumbnail: { url: v('thumbnail') },
          footer: { text: v('footer'), icon_url: v('footerIcon') },
          timestamp: v('timestamp') ? new Date(v('timestamp')).toISOString() : null,
          _open: card.open
        };
      })
    };
  }

  const toLocalInput = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  function fieldRow(f = {}) {
    return `<div class="eb-field">
      <div class="eb-field-top">
        <input data-f="name" maxlength="256" placeholder="Field name" value="${esc(f.name === '​' ? '' : f.name || '')}">
        <label class="switch sm eb-inline" title="Show next to other inline fields (up to 3 per row)"><input type="checkbox" data-f="inline" ${f.inline ? 'checked' : ''}><span class="track"></span><span>Inline</span></label>
        <div class="eb-mini">
          <button type="button" data-act="fieldUp" title="Move up">↑</button>
          <button type="button" data-act="fieldDown" title="Move down">↓</button>
          <button type="button" data-act="fieldCopy" title="Duplicate">⧉</button>
          <button type="button" data-act="fieldRemove" title="Remove">✕</button>
        </div>
      </div>
      <textarea data-f="value" maxlength="1024" rows="2" placeholder="Field value">${esc(f.value === '​' ? '' : f.value || '')}</textarea>
    </div>`;
  }

  function embedCard(e, i, total) {
    const a = e.author || {};
    const ft = e.footer || {};
    const colorHex = e.color === null || e.color === undefined ? DEFAULT_COLOR : E.intToHex(e.color);
    const colorOn = e.color !== null && e.color !== undefined;
    const title = (e.title || e.author?.name || e.description || '').replace(/\s+/g, ' ').slice(0, 40);
    return `<details class="card eb-embed" ${e._open === false ? '' : 'open'} data-i="${i}">
      <summary>
        <span class="eb-swatch" style="background:${colorOn ? colorHex : 'var(--border-strong)'}"></span>
        <strong>Embed ${i + 1}</strong><span class="muted eb-sum">${esc(title)}</span>
        <span class="counter" data-count></span>
        <span class="eb-mini" onclick="event.preventDefault()">
          <button type="button" data-act="embedUp" title="Move up" ${i === 0 ? 'disabled' : ''}>↑</button>
          <button type="button" data-act="embedDown" title="Move down" ${i === total - 1 ? 'disabled' : ''}>↓</button>
          <button type="button" data-act="embedCopy" title="Duplicate">⧉</button>
          <button type="button" data-act="embedRemove" title="Remove">✕</button>
        </span>
      </summary>
      <div class="eb-section">
        <div class="eb-section-title">Author</div>
        <div class="eb-grid-2">
          <input data-k="authorName" maxlength="256" placeholder="Author name" value="${esc(a.name || '')}">
          <input data-k="authorUrl" placeholder="Author link (https://…)" value="${esc(a.url || '')}">
        </div>
        <input data-k="authorIcon" placeholder="Author icon URL" value="${esc(a.icon_url || '')}">
      </div>
      <div class="eb-section">
        <div class="eb-section-title">Body</div>
        <div class="eb-grid-2">
          <input data-k="title" maxlength="256" placeholder="Title" value="${esc(e.title || '')}">
          <input data-k="url" placeholder="Title link (https://…)" value="${esc(e.url || '')}">
        </div>
        <textarea data-k="description" maxlength="4096" rows="4" placeholder="Description — supports **bold**, *italic*, __underline__, ~~strike~~, \`code\`, > quotes, # headings, [links](https://…)">${esc(e.description || '')}</textarea>
        <div class="eb-color">
          <label class="switch sm" title="Use a color"><input type="checkbox" data-k="colorOn" ${colorOn ? 'checked' : ''}><span class="track"></span><span>Color</span></label>
          <input type="color" data-k="color" value="${colorHex}">
          <input data-k="colorHex" value="${colorHex}" maxlength="7" style="max-width:110px;" aria-label="Hex color">
        </div>
      </div>
      <div class="eb-section">
        <div class="eb-section-title">Fields <span class="muted" style="font-weight:400;">(up to 25)</span></div>
        <div class="eb-fields">${(e.fields || []).map(fieldRow).join('')}</div>
        <button class="btn secondary small" type="button" data-act="fieldAdd">+ Add field</button>
      </div>
      <div class="eb-section">
        <div class="eb-section-title">Images</div>
        <div class="eb-grid-2">
          <input data-k="image" placeholder="Large image URL" value="${esc(e.image?.url || '')}">
          <input data-k="thumbnail" placeholder="Thumbnail URL (top right)" value="${esc(e.thumbnail?.url || '')}">
        </div>
      </div>
      <div class="eb-section">
        <div class="eb-section-title">Footer</div>
        <div class="eb-grid-2">
          <input data-k="footer" maxlength="2048" placeholder="Footer text" value="${esc(ft.text || '')}">
          <input data-k="footerIcon" placeholder="Footer icon URL" value="${esc(ft.icon_url || '')}">
        </div>
        <div class="eb-color">
          <span class="muted" style="font-size:0.82rem;">Timestamp</span>
          <input type="datetime-local" data-k="timestamp" value="${toLocalInput(e.timestamp)}" style="max-width:230px;">
          <button class="btn secondary small" type="button" data-act="now">Now</button>
          <button class="btn secondary small" type="button" data-act="clearTime">Clear</button>
        </div>
      </div>
    </details>`;
  }

  function renderEditor(state) {
    $('content').value = state.content || '';
    const list = state.embeds || [];
    $('embeds').innerHTML = list.map((e, i) => embedCard(e, i, list.length)).join('');
    $('addEmbedBtn').style.display = list.length >= E.LIMITS.embeds ? 'none' : '';
    document.querySelectorAll('.eb-embed input:not([type=checkbox]):not([type=color]):not([type=datetime-local]), .eb-embed textarea').forEach((el) => {
      if (['title', 'description', 'footer', 'authorName', 'name', 'value'].includes(el.dataset.k || el.dataset.f)) {
        LoofMentions.attach(el, { onChange: onEdit });
      }
    });
    onEdit();
  }

  function mutate(fn) {
    const state = readState();
    fn(state);
    renderEditor(state);
  }

  /* ------------------------------------------------------------ preview */

  function md(raw) {
    let html = LoofMentions.render(raw || '');
    const blocks = [];
    html = html.replace(/```(?:[a-z0-9]+\n)?([\s\S]*?)```/gi, (_, code) => `\u0000${blocks.push(`<pre class="md-code">${code.replace(/^\n/, '')}</pre>`) - 1}\u0000`);
    html = html
      .split('\n')
      .map((line) => {
        if (/^### /.test(line)) return `<span class="md-h3">${line.slice(4)}</span>`;
        if (/^## /.test(line)) return `<span class="md-h2">${line.slice(3)}</span>`;
        if (/^# /.test(line)) return `<span class="md-h1">${line.slice(2)}</span>`;
        if (/^-# /.test(line)) return `<span class="md-sub">${line.slice(3)}</span>`;
        if (/^&gt; /.test(line)) return `<span class="md-quote">${line.slice(5)}</span>`;
        if (/^\s*[-*] /.test(line)) return `<span class="md-li">• ${line.replace(/^\s*[-*] /, '')}</span>`;
        return line;
      })
      .join('\n')
      .replace(/(<span class="md-(?:h1|h2|h3|sub|quote|li)">[^\n]*?<\/span>)\n/g, '$1');
    html = LoofMentions.markdown(html)
      .replace(/\|\|(.+?)\|\|/g, '<span class="md-spoiler">$1</span>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    return html.replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[Number(i)]);
  }

  function fieldsHtml(fields, hasThumb) {
    const perRow = hasThumb ? 2 : 3;
    const rows = [];
    let row = [];
    for (const f of fields) {
      if (f.inline && row.length < perRow) {
        row.push(f);
        continue;
      }
      if (row.length) rows.push(row);
      row = f.inline ? [f] : [];
      if (!f.inline) rows.push([f]);
    }
    if (row.length) rows.push(row);
    return rows
      .map((r) => {
        const span = 12 / r.length;
        return r
          .map((f, i) => `<div class="p-field" style="grid-column:${i * span + 1} / span ${span};"><div class="p-field-name">${md(f.name)}</div><div class="p-field-value">${md(f.value)}</div></div>`)
          .join('');
      })
      .join('');
  }

  function previewEmbed(raw) {
    const e = E.normalizeEmbed(raw);
    if (!e) return '';
    const color = e.color === undefined ? 'var(--p-embed-border, #1e1f22)' : E.intToHex(e.color);
    const author = e.author
      ? `<div class="p-author">${e.author.icon_url ? `<img src="${esc(e.author.icon_url)}" alt="">` : ''}${e.author.url ? `<a href="${esc(e.author.url)}" target="_blank" rel="noopener">${esc(e.author.name)}</a>` : esc(e.author.name)}</div>`
      : '';
    const title = e.title ? `<div class="p-title">${e.url ? `<a href="${esc(e.url)}" target="_blank" rel="noopener">${md(e.title)}</a>` : md(e.title)}</div>` : '';
    const when = e.timestamp ? new Date(e.timestamp).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }) : '';
    const footer =
      e.footer || e.timestamp
        ? `<div class="p-footer">${e.footer?.icon_url ? `<img src="${esc(e.footer.icon_url)}" alt="">` : ''}<span>${esc(e.footer?.text || '')}${e.footer?.text && when ? ' • ' : ''}${esc(when)}</span></div>`
        : '';
    return `<div class="p-embed" style="border-left-color:${color};">
      <div class="p-embed-grid ${e.thumbnail ? 'has-thumb' : ''}">
        <div class="p-embed-main">
          ${author}${title}
          ${e.description ? `<div class="p-desc md">${md(e.description)}</div>` : ''}
          ${e.fields ? `<div class="p-fields">${fieldsHtml(e.fields, !!e.thumbnail)}</div>` : ''}
        </div>
        ${e.thumbnail ? `<img class="p-thumb" src="${esc(e.thumbnail.url)}" alt="">` : ''}
      </div>
      ${e.image ? `<img class="p-image" src="${esc(e.image.url)}" alt="">` : ''}
      ${footer}
    </div>`;
  }

  function onEdit() {
    const state = readState();
    $('pContent').innerHTML = md(state.content);
    $('pEmbeds').innerHTML = state.embeds.map(previewEmbed).join('');
    $('contentCount').textContent = `${state.content.length}/2000`;
    let total = 0;
    document.querySelectorAll('.eb-embed').forEach((card, i) => {
      const n = E.embedLength(E.normalizeEmbed(state.embeds[i]) || {});
      total += n;
      const c = card.querySelector('[data-count]');
      c.textContent = `${n.toLocaleString()}/6,000`;
      c.classList.toggle('over', n > 6000);
      card.querySelector('[data-act="fieldAdd"]').disabled = card.querySelectorAll('.eb-field').length >= 25;
    });
    $('totalHint').textContent = `${state.embeds.length}/10 embeds · ${total.toLocaleString()} characters`;
    syncJsonFromBuilder();
  }

  /* ------------------------------------------------------------ editor events (delegated) */

  $('embeds').addEventListener('input', (ev) => {
    const card = ev.target.closest('.eb-embed');
    if (ev.target.dataset.k === 'colorHex') {
      const int = E.colorToInt(ev.target.value);
      if (int !== null) {
        card.querySelector('[data-k="color"]').value = E.intToHex(int);
        card.querySelector('[data-k="colorOn"]').checked = true;
      }
    }
    if (ev.target.dataset.k === 'color') {
      card.querySelector('[data-k="colorHex"]').value = ev.target.value;
      card.querySelector('[data-k="colorOn"]').checked = true;
    }
    if (ev.target.dataset.k === 'color' || ev.target.dataset.k === 'colorHex' || ev.target.dataset.k === 'colorOn') {
      card.querySelector('.eb-swatch').style.background = card.querySelector('[data-k="colorOn"]').checked ? card.querySelector('[data-k="color"]').value : 'var(--border-strong)';
    }
    onEdit();
  });
  $('embeds').addEventListener('change', onEdit);
  $('embeds').addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-act]');
    if (!btn) return;
    ev.preventDefault();
    const card = btn.closest('.eb-embed');
    const i = Number(card.dataset.i);
    const fieldEl = btn.closest('.eb-field');
    const fi = fieldEl ? [...card.querySelectorAll('.eb-field')].indexOf(fieldEl) : -1;
    const act = btn.dataset.act;
    const swap = (arr, a, b) => ([arr[a], arr[b]] = [arr[b], arr[a]]);
    if (act === 'now' || act === 'clearTime') {
      card.querySelector('[data-k="timestamp"]').value = act === 'now' ? toLocalInput(new Date().toISOString()) : '';
      return onEdit();
    }
    mutate((s) => {
      const emb = s.embeds[i];
      if (act === 'embedUp' && i > 0) swap(s.embeds, i, i - 1);
      if (act === 'embedDown' && i < s.embeds.length - 1) swap(s.embeds, i, i + 1);
      if (act === 'embedCopy' && s.embeds.length < 10) s.embeds.splice(i + 1, 0, JSON.parse(JSON.stringify(emb)));
      if (act === 'embedRemove' && confirm(`Remove embed ${i + 1}?`)) s.embeds.splice(i, 1);
      if (act === 'fieldAdd' && emb.fields.length < 25) emb.fields.push({ name: '', value: '', inline: false });
      if (act === 'fieldUp' && fi > 0) swap(emb.fields, fi, fi - 1);
      if (act === 'fieldDown' && fi < emb.fields.length - 1) swap(emb.fields, fi, fi + 1);
      if (act === 'fieldCopy' && emb.fields.length < 25) emb.fields.splice(fi + 1, 0, { ...emb.fields[fi] });
      if (act === 'fieldRemove') emb.fields.splice(fi, 1);
    });
    if (act === 'fieldAdd') {
      const fields = document.querySelectorAll(`.eb-embed[data-i="${i}"] .eb-field [data-f="name"]`);
      fields[fields.length - 1]?.focus();
    }
  });

  window.addEmbed = () =>
    mutate((s) => {
      if (s.embeds.length < 10) s.embeds.push(blankEmbed());
    });

  $('content').addEventListener('input', onEdit);
  LoofMentions.attach($('content'), { onChange: onEdit });

  $('jsonPanel').addEventListener('toggle', () => {
    if ($('jsonPanel').open) syncJsonFromBuilder();
  });

  window.toggleMenu = (id) => {
    const menu = $(id);
    const open = !menu.classList.contains('open');
    document.querySelectorAll('.menu.open').forEach((m) => m.classList.remove('open'));
    menu.classList.toggle('open', open);
  };
  document.addEventListener('click', (ev) => {
    if (!ev.target.closest('.menu-wrap')) document.querySelectorAll('.menu.open').forEach((m) => m.classList.remove('open'));
  });

  /* ------------------------------------------------------------ JSON editor */

  function currentJson() {
    return JSON.stringify(E.normalizeMessage(readState()), null, 2);
  }
  function syncJsonFromBuilder() {
    const el = $('jsonEditor');
    if (!el || !$('jsonPanel').open || document.activeElement === el) return;
    el.value = currentJson();
  }
  function setJsonStatus(msg, ok) {
    const el = $('jsonStatus');
    if (el) {
      el.textContent = msg || '';
      el.style.color = msg ? (ok ? 'var(--good, #3ba55d)' : 'var(--danger, #ed4245)') : '';
    }
  }
  function toEditorState(message) {
    const m = E.normalizeMessage(message);
    return { content: m.content, embeds: m.embeds.length ? m.embeds : [] };
  }
  window.applyJson = () => {
    const el = $('jsonEditor');
    let parsed;
    try {
      parsed = JSON.parse(el.value);
    } catch (err) {
      return setJsonStatus(`Invalid JSON: ${err.message}`, false);
    }
    const message = E.normalizeMessage(parsed);
    const errors = E.validateMessage(message);
    if (errors.length) return setJsonStatus(errors[0], false);
    el.blur();
    renderEditor(toEditorState(message));
    setJsonStatus('✓ Applied to the builder', true);
    showToast('✅ Applied the JSON to the builder.');
  };
  window.formatJson = () => {
    const el = $('jsonEditor');
    try {
      el.value = JSON.stringify(JSON.parse(el.value), null, 2);
      setJsonStatus('✓ Formatted', true);
    } catch (err) {
      setJsonStatus(`Invalid JSON: ${err.message}`, false);
    }
  };
  window.exportCurrent = () => {
    const blob = new Blob([currentJson()], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'faq.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    document.querySelectorAll('.menu.open').forEach((m) => m.classList.remove('open'));
  };
  window.copyJson = async () => {
    try {
      await navigator.clipboard.writeText(currentJson());
      showToast('📋 JSON copied — paste it into Discohook or anywhere else.');
    } catch (e) {
      showToast('❌ Your browser blocked the clipboard — use Download instead.');
    }
    document.querySelectorAll('.menu.open').forEach((m) => m.classList.remove('open'));
  };

  /* ------------------------------------------------------------ import */

  window.openImport = () => {
    $('importText').value = '';
    $('importFile').value = '';
    $('importResults').innerHTML = '';
    imported = [];
    $('importOpenBtn').disabled = true;
    $('importDialog').showModal();
    $('importText').focus();
  };
  window.parseImportInput = async () => {
    const file = $('importFile').files[0];
    try {
      const text = file ? await file.text() : $('importText').value;
      imported = E.parseImport(text, file ? file.name.replace(/\.json$/i, '') : 'FAQ');
      $('importResults').innerHTML = `<div class="muted" style="font-size:0.84rem;">Found ${imported.length} message${imported.length === 1 ? '' : 's'} — the first will be opened.</div>`;
      $('importOpenBtn').disabled = false;
    } catch (e) {
      $('importResults').innerHTML = `<p class="eb-error">❌ ${esc(e.message)}</p>`;
      $('importOpenBtn').disabled = true;
    }
  };
  $('importFile').addEventListener('change', window.parseImportInput);
  $('importText').addEventListener('paste', () => setTimeout(window.parseImportInput, 0));
  window.openImported = () => {
    const pick = imported[0];
    if (!pick) return showToast('Read some JSON first.');
    renderEditor(toEditorState(pick.message));
    $('importDialog').close();
    showToast(`📥 Opened “${pick.name}” in the editor — Save it to keep it.`);
  };

  /* ------------------------------------------------------------ save / post */

  function currentMessageOrError() {
    const message = E.normalizeMessage(readState());
    const errors = E.validateMessage(message);
    if (errors.length) {
      showToast(`❌ ${errors[0]}`);
      return null;
    }
    return message;
  }

  window.saveFaq = async () => {
    const message = currentMessageOrError();
    if (!message) return;
    const btn = $('saveBtn');
    btn.disabled = true;
    try {
      await api('POST', `/dashboard/${guildId}/faq/save`, { message });
      showToast('💾 FAQ saved — /faq show will post this.');
    } catch (e) {
      showToast(`❌ ${e.message}`);
    } finally {
      btn.disabled = false;
    }
  };

  window.postFaq = async () => {
    const message = currentMessageOrError();
    if (!message) return;
    const channelId = $('postChannel').value;
    if (!channelId) return showToast('❌ Pick a channel first.');
    const btn = $('postBtn');
    btn.disabled = true;
    try {
      const data = await api('POST', `/dashboard/${guildId}/faq/post`, { message, channelId });
      showToast('✅ Posted the FAQ!');
      if (data.url) window.open(data.url, '_blank', 'noopener');
    } catch (e) {
      showToast(`❌ ${e.message}`);
    } finally {
      btn.disabled = false;
    }
  };

  /* ------------------------------------------------------------ start */

  (async () => {
    await LoofMentions.load(guildId);
    let saved = { content: '', embeds: [] };
    try {
      saved = JSON.parse($('faqData').textContent) || saved;
    } catch (e) {
      /* fall back to empty */
    }
    renderEditor({ content: saved.content || '', embeds: (saved.embeds && saved.embeds.length ? saved.embeds : [blankEmbed()]).map((e) => ({ ...e })) });
  })();
})();
