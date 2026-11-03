// FAQ editor: a click-to-edit visual editor for the server's FAQ (title, intro, colour + a list of
// question → answer entries). The Discord-looking canvas IS the editor — click any text to edit it.
// Built on visual-md.js (WYSIWYG markdown), autofill.js (@/#/: autocomplete) and embed-json.js.
(function () {
  const { guildId, defaultTitle } = window.FAQ_CONFIG;
  const E = window.EmbedJson;
  const V = window.VisualMD;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const readJson = (id) => { try { return JSON.parse($(id).textContent); } catch (e) { return null; } };

  const EDITOR_DATA = readJson('editorData') || { emojis: [], channels: [], roles: [] };
  const UNICODE_EMOJIS = '📖 📌 ✅ ❌ ⚠️ 💡 🎉 ⭐ 🔥 💎 💰 💸 🏆 🎯 📋 📈 📉 🔒 🗺️ 🎮 🏁 ➡️ 👉 ❗ ❓ 🤔 👍 👀 ⏱️ 🎲 🌀 🌟 🌳 🪜 🎬 📅 📝 🧮 🐷 🛒 ⚙️ 🔗 🆕 ❤️'.split(' ');
  const DEFAULT_COLOR = '#5865f2';

  const saved = readJson('faqData') || {};
  const state = {
    title: saved.title || '',
    intro: saved.intro || '',
    color: /^#[0-9a-f]{6}$/i.test(saved.color) ? saved.color : DEFAULT_COLOR,
    items: Array.isArray(saved.items) ? saved.items.map((it) => ({ q: it.q || '', a: it.a || '' })) : []
  };
  let mode = 'visual';
  let isDirty = false;
  const dirty = () => { isDirty = true; updateCount(); };
  window.addEventListener('beforeunload', (e) => { if (isDirty) { e.preventDefault(); e.returnValue = ''; } });

  /* ------------------------------------------------------------ helpers */

  function showToast(msg) { const t = $('toast'); t.textContent = msg; t.style.display = 'block'; clearTimeout(showToast.t); showToast.t = setTimeout(() => (t.style.display = 'none'), 3200); }
  function flash(msg) { $('editorStatus').textContent = msg; clearTimeout(flash.t); flash.t = setTimeout(() => { if ($('editorStatus').textContent === msg) $('editorStatus').textContent = ''; }, 3000); }
  async function api(method, path, body) {
    const res = await fetch(path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
    return data;
  }
  function el(tag, cls, html) { const n = document.createElement(tag); if (cls) n.className = cls; if (html !== undefined) n.innerHTML = html; return n; }
  function editable(cls, md, opts) { const n = el('div', cls + ' v-ed'); V.attach(n, md, opts); return n; }
  function toolBtn(label, title, fn, disabled) { const b = el('button', 'gd-tbtn', label); b.type = 'button'; b.title = title; b.disabled = !!disabled; b.addEventListener('click', fn); return b; }

  /* ------------------------------------------------------------ visual editor */

  function renderVisual() {
    $('faqColor').value = state.color;
    $('faqEmbed').style.borderLeftColor = state.color;
    $('vTitle').replaceChildren(editable('p-title', state.title, { multiline: false, placeholder: defaultTitle, onChange: (v) => { state.title = v; dirty(); } }));
    $('vIntro').replaceChildren(editable('p-desc', state.intro, { placeholder: 'Intro text above the questions (optional) — e.g. “Answers to the questions we get most.”', onChange: (v) => { state.intro = v; dirty(); } }));
    const wrap = $('vItems');
    wrap.replaceChildren();
    state.items.forEach((it, i) => wrap.appendChild(itemCard(it, i)));
    $('vAddItem').style.display = state.items.length >= 100 ? 'none' : '';
    updateCount();
  }

  function itemCard(it, i) {
    const box = el('div', 'p-field v-field');
    box.appendChild(el('div', 'faq-q-label', `Question ${i + 1}`));
    box.appendChild(editable('p-field-name', it.q, { multiline: false, placeholder: 'Type the question…', onChange: (v) => { it.q = v; dirty(); } }));
    box.appendChild(el('div', 'faq-a-label', 'Answer'));
    box.appendChild(editable('p-field-value p-desc', it.a, { placeholder: 'Type the answer… (markdown, @mentions, :emoji: all work)', onChange: (v) => { it.a = v; dirty(); } }));
    const ctl = el('div', 'v-field-ctl');
    ctl.append(
      toolBtn('▲', 'Move up', () => moveItem(i, -1), i === 0),
      toolBtn('▼', 'Move down', () => moveItem(i, 1), i === state.items.length - 1),
      toolBtn('⧉', 'Duplicate', () => { state.items.splice(i + 1, 0, { q: it.q, a: it.a }); renderVisual(); dirty(); }, state.items.length >= 100),
      toolBtn('🗑 Remove', 'Remove this question', () => { if (confirm('Remove this question?')) { state.items.splice(i, 1); renderVisual(); dirty(); } })
    );
    box.appendChild(ctl);
    return box;
  }

  window.addItem = () => { if (state.items.length >= 100) return; state.items.push({ q: '', a: '' }); renderVisual(); dirty(); const names = document.querySelectorAll('#vItems .p-field-name'); names[names.length - 1]?.focus(); };
  function moveItem(i, d) { const j = i + d; if (j < 0 || j >= state.items.length) return; [state.items[i], state.items[j]] = [state.items[j], state.items[i]]; renderVisual(); dirty(); }

  $('faqColor').addEventListener('input', () => { state.color = $('faqColor').value; $('faqEmbed').style.borderLeftColor = state.color; dirty(); });

  /* ------------------------------------------------------------ size hint */

  function embedChunks() {
    // Mirror cogs/modules/faq.js renderEmbeds chunking so the count warns about Discord's limits.
    const chunks = [];
    let cur = null;
    let len = 0;
    const open = (header) => { cur = { fields: 0, chars: 0 }; if (header) cur.chars = (state.title || defaultTitle).length + (state.intro || '').length; len = cur.chars; chunks.push(cur); };
    open(true);
    for (const it of state.items.filter((x) => x.q.trim() && x.a.trim())) {
      const add = Math.min(it.q.length, 256) + Math.min(it.a.length, 1024);
      if (cur.fields >= 25 || len + add > 5800) { if (chunks.length >= 10) break; open(false); }
      cur.fields++; cur.chars += add; len += add;
    }
    return chunks;
  }
  function updateCount() {
    const n = state.items.filter((x) => x.q.trim() && x.a.trim()).length;
    const chunks = embedChunks();
    const box = $('sizeCount');
    box.textContent = `${n} question${n === 1 ? '' : 's'}${chunks.length > 1 ? ` · ${chunks.length} embeds` : ''}`;
    box.classList.toggle('over', n > 100);
  }

  /* ------------------------------------------------------------ toolbar + emoji (visual mode) */

  function runTool(cmd, block, arg) { if (!V.format(block ? 'block' : cmd, block || arg)) flash('Click into the text you want to change first.'); }
  $('toolbar').addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
  $('toolbar').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.id === 'emojiBtn') return toggleEmoji();
    if (b.dataset.block) return runTool(null, b.dataset.block);
    if (b.dataset.cmd === 'link') {
      const url = prompt('Link to (https://…) — the selected text becomes the link:', 'https://');
      if (url && /^https?:\/\/\S+$/.test(url.trim())) runTool('link', null, url.trim());
      return;
    }
    runTool(b.dataset.cmd);
  });
  function toggleEmoji() { const p = $('emojiPop'); const open = p.style.display === 'none'; p.style.display = open ? '' : 'none'; if (open) { renderEmojiPicker(); $('emojiSearch').focus({ preventScroll: true }); } }
  window.renderEmojiPicker = () => {
    const q = $('emojiSearch').value.trim().toLowerCase();
    const custom = EDITOR_DATA.emojis.filter((e) => !q || e.name.toLowerCase().includes(q));
    $('emojiGrid').innerHTML =
      (custom.length ? `<div class="gd-emoji-head">Server emojis</div>` + custom.map((e) => `<button type="button" data-c="${EDITOR_DATA.emojis.indexOf(e)}" title=":${esc(e.name)}:"><img src="${esc(e.url)}" alt=":${esc(e.name)}:"></button>`).join('') : (q ? '' : '<div class="gd-emoji-head">No server emojis</div>')) +
      (q ? '' : `<div class="gd-emoji-head">Common</div>` + UNICODE_EMOJIS.map((u) => `<button type="button" data-u="${u}">${u}</button>`).join(''));
  };
  $('emojiPop').addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
  $('emojiGrid').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const emoji = b.dataset.c !== undefined ? EDITOR_DATA.emojis[Number(b.dataset.c)] : b.dataset.u;
    if (!V.format('insert', V.emojiInsertHtml(emoji))) flash('Click into the text where the emoji should go first.');
  });
  document.addEventListener('mousedown', (e) => { if (!e.target.closest('#emojiPop') && !e.target.closest('#emojiBtn')) $('emojiPop').style.display = 'none'; });

  /* ------------------------------------------------------------ JSON mode */

  const cleanState = () => ({ title: state.title, intro: state.intro, color: state.color, items: state.items.filter((it) => it.q.trim() && it.a.trim()).map((it) => ({ q: it.q, a: it.a })) });
  function fillJson() { $('jsonEditor').value = JSON.stringify(cleanState(), null, 2); }
  function setJsonStatus(msg, ok) { const el2 = $('jsonStatus'); el2.textContent = msg || ''; el2.style.color = msg ? (ok ? 'var(--good,#3ba55d)' : 'var(--danger,#ed4245)') : ''; }
  window.applyJson = () => {
    let parsed;
    try { parsed = JSON.parse($('jsonEditor').value); } catch (err) { return setJsonStatus(`Invalid JSON: ${err.message}`, false); }
    loadFromObject(parsed);
    setJsonStatus('✓ Applied', true);
    showToast('✅ Applied the JSON.');
  };
  window.formatJson = () => { try { $('jsonEditor').value = JSON.stringify(JSON.parse($('jsonEditor').value), null, 2); setJsonStatus('✓ Formatted', true); } catch (err) { setJsonStatus(`Invalid JSON: ${err.message}`, false); } };
  window.copyJson = async () => { try { await navigator.clipboard.writeText(JSON.stringify(cleanState(), null, 2)); showToast('📋 JSON copied.'); } catch (e) { showToast('❌ Clipboard blocked.'); } };
  $('jsonFile').addEventListener('change', async (e) => {
    const file = e.target.files[0]; if (!file) return;
    try { const obj = JSON.parse(await file.text()); loadFromObject(obj); $('jsonEditor').value = JSON.stringify(cleanState(), null, 2); setJsonStatus('✓ Imported — press Apply or switch to Visual', true); showToast('📥 Imported.'); }
    catch (err) { setJsonStatus(`Couldn’t read that file: ${err.message}`, false); }
    e.target.value = '';
  });
  // Accept { title, intro, color, items:[{q,a}] }, or a bare array of {q,a} / {question,answer}.
  function loadFromObject(obj) {
    const o = Array.isArray(obj) ? { items: obj } : (obj && typeof obj === 'object' ? obj : {});
    state.title = typeof o.title === 'string' ? o.title : state.title;
    state.intro = typeof o.intro === 'string' ? o.intro : state.intro;
    if (typeof o.color === 'string') { const hex = E.intToHex(E.colorToInt(o.color)); if (hex) state.color = hex; }
    else if (typeof o.color === 'number') { const hex = E.intToHex(o.color); if (hex) state.color = hex; }
    if (Array.isArray(o.items)) state.items = o.items.map((it) => ({ q: String(it.q ?? it.question ?? it.name ?? '').slice(0, 256), a: String(it.a ?? it.answer ?? it.value ?? '').slice(0, 1024) }));
    dirty();
    if (mode === 'visual') renderVisual();
  }

  /* ------------------------------------------------------------ mode switch */

  window.setMode = (m) => {
    mode = m;
    $('modeVisual').classList.toggle('on', m === 'visual');
    $('modeJson').classList.toggle('on', m === 'json');
    $('visualWrap').style.display = m === 'visual' ? '' : 'none';
    $('jsonWrap').style.display = m === 'json' ? '' : 'none';
    $('toolbar').style.display = m === 'visual' ? '' : 'none';
    if (m !== 'visual') $('emojiPop').style.display = 'none';
    if (m === 'visual') renderVisual();
    else fillJson();
  };

  /* ------------------------------------------------------------ save / post */

  window.saveFaq = async () => {
    const btn = $('saveBtn'); btn.disabled = true;
    try { const d = await api('POST', `/dashboard/${guildId}/faq/save`, { faq: cleanState() }); state.items = d.faq.items; isDirty = false; showToast('💾 FAQ saved — /faq will post this.'); }
    catch (e) { showToast(`❌ ${e.message}`); }
    finally { btn.disabled = false; }
  };
  window.postFaq = async () => {
    const channelId = $('postChannel').value;
    if (!channelId) return showToast('❌ Pick a channel first.');
    const btn = $('postBtn'); btn.disabled = true;
    try { const d = await api('POST', `/dashboard/${guildId}/faq/post`, { faq: cleanState(), channelId }); isDirty = false; showToast('✅ Posted the FAQ!'); if (d.url) window.open(d.url, '_blank', 'noopener'); }
    catch (e) { showToast(`❌ ${e.message}`); }
    finally { btn.disabled = false; }
  };

  // Ctrl/Cmd+S saves.
  document.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); window.saveFaq(); } });

  /* ------------------------------------------------------------ start */

  const fitTop = () => { const bar = document.querySelector('.site-bar'); document.documentElement.style.setProperty('--gd-top', (bar && getComputedStyle(bar).position !== 'static' ? bar.offsetHeight : 0) + 'px'); };
  window.addEventListener('resize', fitTop); fitTop();

  V.setData(EDITOR_DATA);
  if (window.GuideAutofill) window.GuideAutofill.setData(EDITOR_DATA);
  // Members for @-mentions (same endpoint the other editors use).
  fetch(`/api/guilds/${guildId}/mentionable`).then((r) => (r.ok ? r.json() : null)).then((d) => {
    if (!d) return;
    const data = { users: d.users || [], roles: d.roles?.length ? d.roles : EDITOR_DATA.roles, channels: d.channels?.length ? d.channels : EDITOR_DATA.channels, emojis: EDITOR_DATA.emojis };
    V.setData({ users: data.users });
    if (window.GuideAutofill) window.GuideAutofill.setData(data);
  }).catch(() => {});

  if (!state.items.length) state.items.push({ q: '', a: '' });
  renderVisual();
})();
