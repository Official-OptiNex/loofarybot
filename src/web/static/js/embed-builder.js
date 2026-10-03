// Embed Builder: multi-embed editor with templates, JSON import/export, message editing and a
// Discord-accurate preview (including inline field layout).
(function () {
  const { guildId } = window.EB_CONFIG;
  const E = window.EmbedJson;
  const esc = LoofMentions.esc;
  const $ = (id) => document.getElementById(id);
  const DRAFT_KEY = `loofary-embed-draft:${guildId}`;
  const DEFAULT_COLOR = '#5865f2';

  let templates = [];
  let loadedTemplate = ''; // name of the template the editor came from (Save overwrites it)
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

  // Raw editor state (unvalidated): { content, embeds: [{ author, title, url, description, color, fields, image, thumbnail, footer, timestamp }] }
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

  // Structural edits: read the form, change the state, re-render.
  function mutate(fn) {
    const state = readState();
    fn(state);
    renderEditor(state);
  }

  /* ------------------------------------------------------------ preview */

  // Discord-flavoured markdown on escaped text (mentions already turned into pills).
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
      // Block lines are display:block already — drop the newline after them so there's no double gap.
      .replace(/(<span class="md-(?:h1|h2|h3|sub|quote|li)">[^\n]*?<\/span>)\n/g, '$1');
    html = LoofMentions.markdown(html)
      .replace(/\|\|(.+?)\|\|/g, '<span class="md-spoiler">$1</span>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    return html.replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[Number(i)]);
  }

  // Discord's layout: consecutive inline fields share a row, 3 per row (2 when there's a thumbnail).
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
        const span = 12 / r.length; // a lone field (inline or not) spans the whole row, like Discord
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
    saveDraft(state);
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

  window.clearAll = () => {
    const s = readState();
    const hasSomething = s.content.trim() || s.embeds.some((e) => E.normalizeEmbed(e));
    if (hasSomething && !confirm('Clear everything and start a new message from scratch?')) return;
    loadedTemplate = '';
    $('templateSelect').value = '';
    $('editUrl').value = '';
    renderEditor({ content: '', embeds: [blankEmbed()] });
    showToast('🧹 Cleared — starting fresh.');
  };

  $('content').addEventListener('input', onEdit);
  LoofMentions.attach($('content'), { onChange: onEdit });

  document.querySelectorAll('input[name="sendMode"]').forEach((r) =>
    r.addEventListener('change', () => {
      const edit = r.value === 'edit' && r.checked;
      $('sendNewRow').style.display = edit ? 'none' : '';
      $('sendEditRow').style.display = edit ? '' : 'none';
      $('sendBtn').textContent = edit ? '💾 Update message' : '🚀 Send';
    })
  );

  window.toggleMenu = (id) => {
    const menu = $(id);
    const open = !menu.classList.contains('open');
    document.querySelectorAll('.menu.open').forEach((m) => m.classList.remove('open'));
    menu.classList.toggle('open', open);
  };
  document.addEventListener('click', (ev) => {
    if (!ev.target.closest('.menu-wrap')) document.querySelectorAll('.menu.open').forEach((m) => m.classList.remove('open'));
  });

  /* ------------------------------------------------------------ drafts */

  function saveDraft(state) {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({ state: { content: state.content, embeds: state.embeds.map(({ _open, ...e }) => e) }, template: loadedTemplate, at: Date.now() }));
      $('draftStatus').textContent = loadedTemplate ? `Editing “${loadedTemplate}” · draft autosaved` : 'Draft autosaved in this browser';
    } catch (e) {
      /* storage blocked — drafts just aren't kept */
    }
  }
  function readDraft() {
    try {
      return JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
    } catch (e) {
      return null;
    }
  }

  /* ------------------------------------------------------------ templates */

  async function loadTemplates() {
    try {
      const data = await api('GET', `/api/guilds/${guildId}/embed-templates`);
      templates = data.templates || [];
      $('templateSelect').innerHTML =
        `<option value="">— New / unsaved — (${templates.length} saved)</option>` +
        templates.map((t) => `<option value="${esc(t.name)}" ${t.name === loadedTemplate ? 'selected' : ''}>${esc(t.name)}</option>`).join('');
    } catch (e) {
      showToast(`❌ ${e.message}`);
    }
  }

  function toEditorState(message) {
    const m = E.normalizeMessage(message);
    return { content: m.content, embeds: m.embeds.length ? m.embeds : [] };
  }

  window.loadSelectedTemplate = () => {
    const name = $('templateSelect').value;
    const t = templates.find((x) => x.name === name);
    if (!t) return showToast('Pick a saved template first.');
    loadedTemplate = t.name;
    renderEditor(toEditorState(t.message));
    showToast(`📂 Loaded “${t.name}”.`);
  };
  $('templateSelect').addEventListener('dblclick', window.loadSelectedTemplate);

  window.saveTemplate = async (asNew) => {
    let name = loadedTemplate;
    if (asNew || !name) {
      name = prompt('Template name:', asNew ? `${loadedTemplate || 'New template'} copy` : '');
      if (!name || !name.trim()) return;
      name = name.trim();
      if (templates.some((t) => t.name === name) && !confirm(`A template called “${name}” exists. Overwrite it?`)) return;
    }
    const message = E.normalizeMessage(readState());
    const errors = E.validateMessage(message);
    if (errors.length) return showToast(`❌ ${errors[0]}`);
    try {
      await api('POST', `/api/guilds/${guildId}/embed-templates`, { name, message });
      loadedTemplate = name;
      await loadTemplates();
      onEdit();
      showToast(`💾 Saved “${name}”.`);
    } catch (e) {
      showToast(`❌ ${e.message}`);
    }
  };

  window.deleteSelectedTemplate = async () => {
    const name = $('templateSelect').value;
    if (!name) return showToast('Pick a template to delete first.');
    if (!confirm(`Delete template “${name}”? This can't be undone.`)) return;
    try {
      await api('DELETE', `/api/guilds/${guildId}/embed-templates/${encodeURIComponent(name)}`);
      if (loadedTemplate === name) loadedTemplate = '';
      await loadTemplates();
      showToast(`🗑️ Deleted “${name}”.`);
    } catch (e) {
      showToast(`❌ ${e.message}`);
    }
  };

  document.addEventListener('keydown', (ev) => {
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 's') {
      ev.preventDefault();
      window.saveTemplate(false);
    }
  });

  /* ------------------------------------------------------------ import / export */

  window.openImport = () => {
    $('importText').value = '';
    $('importFile').value = '';
    $('importResults').innerHTML = '';
    imported = [];
    $('importSaveBtn').disabled = true;
    $('importOpenBtn').disabled = true;
    $('importDialog').showModal();
    $('importText').focus();
  };

  function showImported() {
    $('importResults').innerHTML = `<div class="eb-import-list">
      <div class="muted" style="font-size:0.82rem; margin-bottom:0.4rem;">Found ${imported.length} message${imported.length === 1 ? '' : 's'} — untick any you don't want, and rename them if you like.</div>
      ${imported
        .map(
          (m, i) => `<label class="eb-import-item"><input type="checkbox" data-i="${i}" checked>
            <input class="eb-import-name" data-i="${i}" value="${esc(m.name)}" maxlength="100">
            <span class="muted">${m.message.embeds.length} embed${m.message.embeds.length === 1 ? '' : 's'}${m.message.content ? ' · text' : ''}</span></label>`
        )
        .join('')}
    </div>`;
    $('importSaveBtn').disabled = false;
    $('importOpenBtn').disabled = false;
  }

  window.parseImportInput = async () => {
    const file = $('importFile').files[0];
    try {
      const text = file ? await file.text() : $('importText').value;
      const fallback = file ? file.name.replace(/\.json$/i, '') : 'Imported';
      imported = E.parseImport(text, fallback);
      showImported();
    } catch (e) {
      $('importResults').innerHTML = `<p class="eb-error">❌ ${esc(e.message)}</p>`;
      $('importSaveBtn').disabled = true;
      $('importOpenBtn').disabled = true;
    }
  };
  $('importFile').addEventListener('change', window.parseImportInput);
  $('importText').addEventListener('paste', () => setTimeout(window.parseImportInput, 0));

  const selectedImports = () =>
    [...document.querySelectorAll('.eb-import-item input[type=checkbox]')]
      .filter((c) => c.checked)
      .map((c) => ({ ...imported[Number(c.dataset.i)], name: document.querySelector(`.eb-import-name[data-i="${c.dataset.i}"]`).value.trim() || imported[Number(c.dataset.i)].name }));

  window.openImported = () => {
    const pick = selectedImports()[0];
    if (!pick) return showToast('Tick a message to open.');
    loadedTemplate = '';
    $('templateSelect').value = '';
    renderEditor(toEditorState(pick.message));
    $('importDialog').close();
    showToast(`📥 Opened “${pick.name}” in the editor — save it to keep it.`);
  };

  window.saveImported = async () => {
    const picks = selectedImports();
    if (!picks.length) return showToast('Tick at least one message.');
    try {
      const data = await api('POST', `/api/guilds/${guildId}/embed-templates/import`, {
        templates: picks.map((p) => ({ name: p.name, message: p.message })),
        overwrite: $('importOverwrite').checked
      });
      await loadTemplates();
      $('importDialog').close();
      showToast(`✅ Imported ${data.saved.length} template${data.saved.length === 1 ? '' : 's'}${data.skipped.length ? ` · ${data.skipped.length} skipped (too long or over the limit)` : ''}.`);
    } catch (e) {
      showToast(`❌ ${e.message}`);
    }
  };

  function currentJson() {
    return JSON.stringify(E.normalizeMessage(readState()), null, 2);
  }
  window.exportCurrent = () => {
    const blob = new Blob([currentJson()], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${(loadedTemplate || 'message').replace(/[^\w-]+/g, '-')}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    document.querySelectorAll('.menu.open').forEach((m) => m.classList.remove('open'));
  };
  window.copyJson = async () => {
    try {
      await navigator.clipboard.writeText(currentJson());
      showToast('📋 JSON copied — paste it into Discohook\'s JSON editor or anywhere else.');
    } catch (e) {
      showToast('❌ Your browser blocked the clipboard — use Download instead.');
    }
    document.querySelectorAll('.menu.open').forEach((m) => m.classList.remove('open'));
  };

  /* ------------------------------------------------------------ send / edit / load from link */

  window.loadFromLink = async (inputId) => {
    const url = $(inputId).value.trim();
    if (!url) return showToast('Paste a message link first.');
    try {
      const data = await api('GET', `/dashboard/${guildId}/embed/message?url=${encodeURIComponent(url)}`);
      renderEditor(toEditorState(data.message));
      if (inputId === 'editUrl' && !data.editable) showToast("⚠️ Loaded — but that message wasn't sent by LoofaryBot, so it can only be sent as a new message.");
      else showToast('📥 Message loaded into the editor.');
    } catch (e) {
      showToast(`❌ ${e.message}`);
    }
  };

  window.sendMessage = async () => {
    const editing = document.querySelector('input[name="sendMode"]:checked').value === 'edit';
    const message = E.normalizeMessage(readState());
    const errors = E.validateMessage(message);
    if (errors.length) return showToast(`❌ ${errors[0]}`);
    const body = { message };
    if (editing) {
      body.editUrl = $('editUrl').value.trim();
      if (!body.editUrl) return showToast('❌ Paste the link of the message to edit.');
    } else {
      body.channelId = $('channel').value;
      if (!body.channelId) return showToast('❌ Pick a channel first.');
      const forum = forumById(body.channelId);
      if (forum) {
        body.postTitle = $('postTitle').value.trim();
        if (!body.postTitle) return showToast('❌ Give the forum post a title.');
        body.tagIds = [...document.querySelectorAll('#forumTags input:checked')].map((i) => i.value);
        if (forum.requireTag && !body.tagIds.length) return showToast('❌ This forum requires a tag — pick at least one.');
      }
    }
    const btn = $('sendBtn');
    btn.disabled = true;
    try {
      const data = await api('POST', `/dashboard/${guildId}/embed/send`, body);
      showToast(data.edited ? '✅ Message updated.' : data.forum ? '✅ Forum post created!' : '✅ Sent!');
      if (!editing && data.url) {
        $('editUrl').value = data.url; // so "Edit a bot message" can fix a typo right away
      }
    } catch (e) {
      showToast(`❌ ${e.message}`);
    } finally {
      btn.disabled = false;
    }
  };

  /* ------------------------------------------------------------ forum channels */

  let forumList = [];
  try {
    forumList = JSON.parse(($('forumData') || {}).textContent || '[]');
  } catch (e) {
    forumList = [];
  }
  const forumById = (id) => forumList.find((f) => f.id === id) || null;

  // Picking a forum asks for a post title and its tags (at most 5, as Discord allows).
  function renderForumRow() {
    const forum = forumById($('channel').value);
    $('forumRow').style.display = forum ? '' : 'none';
    if (!forum) return;
    $('forumTagsWrap').style.display = forum.tags.length ? '' : 'none';
    $('forumTagHint').textContent = forum.requireTag ? '(pick at least one, up to 5)' : '(optional, up to 5)';
    $('forumTags').innerHTML = '';
    forum.tags.forEach((t) => {
      const label = document.createElement('label');
      label.className = 'mention-pill';
      label.style.cssText = 'cursor:pointer; display:inline-flex; align-items:center; gap:0.3rem; margin:0; padding:0.25rem 0.55rem;';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.value = t.id;
      box.style.cssText = 'width:auto; margin:0;';
      box.addEventListener('change', () => {
        const picked = document.querySelectorAll('#forumTags input:checked');
        if (picked.length > 5) {
          box.checked = false;
          showToast('❌ Up to 5 tags.');
        }
      });
      label.append(box, document.createTextNode(`${t.emoji ? t.emoji + ' ' : ''}${t.name}`));
      $('forumTags').append(label);
    });
  }
  if ($('channel')) $('channel').addEventListener('change', renderForumRow);

  /* ------------------------------------------------------------ welcome tie-in */

  window.useAsWelcome = async () => {
    const s = readState();
    const e = s.embeds[0] || {};
    const payload = {
      content: s.content,
      title: e.title || '',
      description: e.description || '',
      color: e.color === null || e.color === undefined ? DEFAULT_COLOR : E.intToHex(e.color),
      footer: e.footer?.text || '',
      imageUrl: (e.image?.url || '').trim(),
      thumbnailUrl: (e.thumbnail?.url || '').trim()
    };
    try {
      await api('POST', `/api/guilds/${guildId}/welcome/from-embed`, payload);
      showToast('✅ Saved as the welcome message — opening the Welcome tab…');
      setTimeout(() => (location.href = `/dashboard/${guildId}#welcome`), 900);
    } catch (err) {
      showToast(`❌ ${err.message}`);
    }
  };

  async function loadWelcomeIntoBuilder() {
    const res = await fetch(`/api/guilds/${guildId}/welcome`);
    const { config } = await res.json();
    const e = (config && config.embedConfig) || {};
    renderEditor({
      content: config.messageContent || '',
      embeds: [
        {
          title: e.title || '',
          description: e.description || '',
          color: E.colorToInt(e.color || DEFAULT_COLOR),
          footer: { text: e.footer || '' },
          image: { url: e.imageUrl || '' },
          thumbnail: { url: e.thumbnailUrl || '' },
          fields: []
        }
      ]
    });
    showToast('👋 Loaded your welcome message — edit it, then click “Use as welcome message”.');
  }

  /* ------------------------------------------------------------ start */

  (async () => {
    await Promise.all([LoofMentions.load(guildId), loadTemplates()]);
    if (new URLSearchParams(location.search).get('welcome') === '1') {
      await loadWelcomeIntoBuilder().catch(() => renderEditor({ content: '', embeds: [blankEmbed()] }));
      return;
    }
    const draft = readDraft();
    if (draft && draft.state && (draft.state.content || (draft.state.embeds || []).some((e) => E.normalizeEmbed(e)))) {
      loadedTemplate = templates.some((t) => t.name === draft.template) ? draft.template : '';
      $('templateSelect').value = loadedTemplate;
      renderEditor({ content: draft.state.content || '', embeds: draft.state.embeds || [] });
      showToast('↩️ Restored your unsaved draft. Use “Clear all” to start fresh.');
    } else {
      renderEditor({ content: '', embeds: [blankEmbed()] });
    }
  })();
})();
