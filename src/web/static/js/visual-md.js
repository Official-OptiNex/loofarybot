// Visual (WYSIWYG) editing for Discord markdown: renders markdown into contenteditable HTML and
// serializes the edited DOM back to markdown. Text the editor doesn't touch round-trips unchanged —
// every block keeps its original prefix and every token (emoji, mention, escape) its original source.
window.VisualMD = (function () {
  let data = { emojis: [], channels: [], roles: [] };
  const setData = (d) => (data = { ...data, ...(d || {}) });

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const findEmoji = (name) => data.emojis.find((e) => e.name === name) || data.emojis.find((e) => e.name.toLowerCase() === name.toLowerCase());
  const emojiTag = (e) => `<${e.animated ? 'a' : ''}:${e.name}:${e.id}>`;

  /* ------------------------------------------------------------ markdown → HTML */

  // A non-editable token that serializes back to exactly `md`.
  const atom = (md, inner, cls = 'v-atom') => `<span class="${cls}" contenteditable="false" data-md="${esc(md)}">${inner}</span>`;
  function emojiAtom(md, name, id) {
    const e = data.emojis.find((x) => x.id === id) || (!id && findEmoji(name));
    return e ? `<img class="v-emoji" contenteditable="false" data-md="${esc(md)}" src="${esc(e.url)}" alt=":${esc(name)}:" title=":${esc(name)}:" draggable="false">` : atom(md, `:${esc(name)}:`, 'v-atom v-emoji-missing');
  }

  // Finds the closing `mark` for an opener at i (closer must follow a non-space; inner non-empty).
  function closer(s, from, mark) {
    for (let j = from; j <= s.length - mark.length; j++) {
      if (s[j] === '\\') { j++; continue; }
      if (s.startsWith(mark, j) && j > from && !/\s/.test(s[j - 1])) {
        if (mark === '*' && s[j + 1] === '*') { j++; continue; } // `**` belongs to bold
        if (mark === '_' && s[j + 1] === '_') { j++; continue; }
        return j;
      }
    }
    return -1;
  }

  const WRAPS = [
    ['***', (x) => `<b><i>${x}</i></b>`],
    ['**', (x) => `<b>${x}</b>`],
    ['__', (x) => `<u>${x}</u>`],
    ['~~', (x) => `<s>${x}</s>`],
    ['||', (x) => `<span class="v-spoiler">${x}</span>`],
    ['*', (x) => `<i>${x}</i>`],
    ['_', (x) => `<i data-m="_">${x}</i>`]
  ];

  function inlineToHtml(s) {
    let out = '';
    let text = '';
    const flush = () => ((out += esc(text)), (text = ''));
    let i = 0;
    while (i < s.length) {
      const rest = s.slice(i);
      let m;
      if (rest[0] === '\\' && rest.length > 1 && /[\\*_~`|<>#\-:\[\]()]/.test(rest[1])) {
        flush(); out += atom(rest.slice(0, 2), esc(rest[1]), 'v-atom v-esc'); i += 2; continue;
      }
      if ((m = rest.match(/^<(a?):(\w{2,32}):(\d{5,25})>/))) { flush(); out += emojiAtom(m[0], m[2], m[3]); i += m[0].length; continue; }
      if ((m = rest.match(/^<@&(\d+)>/))) { flush(); const r = data.roles.find((x) => x.id === m[1]); out += atom(m[0], `@${esc(r ? r.name : 'role')}`, 'v-atom mention-pill'); i += m[0].length; continue; }
      if ((m = rest.match(/^<@!?(\d+)>/))) { flush(); const u = (data.users || []).find((x) => x.id === m[1]); out += atom(m[0], `@${esc(u ? u.name : 'user')}`, 'v-atom mention-pill'); i += m[0].length; continue; }
      if ((m = rest.match(/^<#(\d+)>/))) { flush(); const c = data.channels.find((x) => x.id === m[1]); out += atom(m[0], `#${esc(c ? c.name : 'channel')}`, 'v-atom mention-pill'); i += m[0].length; continue; }
      if ((m = rest.match(/^<(t:\d+(?::[tTdDfFR])?|\/[\w -]+:\d+)>/))) { flush(); out += atom(m[0], esc(m[0]), 'v-atom mention-pill'); i += m[0].length; continue; }
      if ((m = rest.match(/^:(\w{2,32}):/)) && findEmoji(m[1])) { flush(); const e = findEmoji(m[1]); out += emojiAtom(emojiTag(e), e.name, e.id); i += m[0].length; continue; }
      if ((m = rest.match(/^\[((?:[^\[\]\\]|\\.)+)\]\((<?(?:https?:\/\/|guide:)[^\s)>]+>?)\)/))) {
        flush(); out += `<a href="${esc(m[2].replace(/^<|>$/g, ''))}" data-href="${esc(m[2])}">${inlineToHtml(m[1])}</a>`; i += m[0].length; continue;
      }
      if ((m = rest.match(/^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/))) { flush(); out += `<code data-m="${m[1]}">${esc(m[2])}</code>`; i += m[0].length; continue; }
      let wrapped = false;
      for (const [mark, wrap] of WRAPS) {
        if (!rest.startsWith(mark) || /\s/.test(rest[mark.length] || ' ')) continue;
        if (mark === '_' && i > 0 && /\w/.test(s[i - 1])) continue;
        const j = closer(s, i + mark.length, mark);
        if (j < 0) continue;
        flush(); out += wrap(inlineToHtml(s.slice(i + mark.length, j))); i = j + mark.length; wrapped = true; break;
      }
      if (wrapped) continue;
      text += s[i]; i++;
    }
    flush();
    return out;
  }

  const BLOCKS = [
    [/^(#{1,3}) /, (m) => `h${m[1].length}`],
    [/^-# /, () => 'sub'],
    [/^>>> /, () => 'quote'],
    [/^> /, () => 'quote'],
    [/^(\s*)[-*] /, () => 'li'],
    [/^(\s*)\d+\. /, () => 'ol']
  ];
  const DEFAULT_PREFIX = { p: '', h1: '# ', h2: '## ', h3: '### ', sub: '-# ', quote: '> ', li: '- ', ol: '1. ' };

  function blockHtml(kind, prefix, inner) {
    const indent = (prefix.match(/^\s*/) || [''])[0].length;
    const style = indent ? ` style="margin-left:${Math.min(indent, 8) * 0.6}em"` : '';
    const n = kind === 'ol' ? ` data-n="${esc(prefix.trim().replace('.', ''))}"` : '';
    return `<div class="vb vb-${kind}" data-kind="${kind}" data-prefix="${esc(prefix)}"${n}${style}>${inner || '<br>'}</div>`;
  }

  /** Markdown → block HTML for a multi-line editor. */
  function toHtml(md) {
    const lines = String(md ?? '').split('\n');
    let html = '';
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^```/.test(line)) {
        const body = [];
        let j = i + 1;
        while (j < lines.length && !/^```\s*$/.test(lines[j])) body.push(lines[j++]);
        if (j < lines.length) {
          html += `<pre class="vb vb-code" data-kind="code" data-open="${esc(line)}">${esc(body.join('\n')) || '<br>'}</pre>`;
          i = j;
          continue;
        }
      }
      let kind = 'p';
      let prefix = '';
      for (const [re, k] of BLOCKS) {
        const m = line.match(re);
        if (m) { kind = k(m); prefix = m[0]; break; }
      }
      html += blockHtml(kind, prefix, inlineToHtml(line.slice(prefix.length)));
    }
    return html;
  }

  /* ------------------------------------------------------------ DOM → markdown */

  const isBlockEl = (n) => n.nodeType === 1 && /^(DIV|P|PRE|H[1-6]|LI|UL|OL|BLOCKQUOTE)$/.test(n.tagName);

  // Moves edge whitespace outside a marker pair, as Discord ignores `** bold**`.
  function wrapMd(mark, inner, closeMark = mark) {
    if (!inner.trim()) return inner;
    const m = inner.match(/^(\s*)([\s\S]*?)(\s*)$/);
    return `${m[1]}${mark}${m[2]}${closeMark}${m[3]}`;
  }

  function inlineToMd(node) {
    let s = '';
    node.childNodes.forEach((n, idx) => {
      if (n.nodeType === 3) { s += n.nodeValue.replace(/\u00a0/g, ' ').replace(/[\u200b\ufeff]/g, ''); return; }
      if (n.nodeType !== 1) return;
      if (n.dataset && n.dataset.md !== undefined) { s += n.dataset.md; return; }
      const tag = n.tagName;
      if (tag === 'BR') { if (idx < node.childNodes.length - 1) s += '\n'; return; }
      if (tag === 'IMG') { if (/^\p{Extended_Pictographic}/u.test(n.alt || '')) s += n.alt; return; }
      if (isBlockEl(n)) { s += '\n' + inlineToMd(n); return; }
      const inner = inlineToMd(n);
      const st = n.style || {};
      if (tag === 'CODE') { const t = n.textContent.replace(/\u00a0/g, ' '); s += t ? `${n.dataset.m || '`'}${t}${n.dataset.m || '`'}` : ''; return; }
      if (tag === 'A') { const href = n.dataset.href || n.getAttribute('href') || ''; s += inner.trim() ? `[${inner}](${href})` : ''; return; }
      let out = inner;
      if (tag === 'SPAN' && n.classList.contains('v-spoiler')) out = wrapMd('||', out);
      if (tag === 'I' || tag === 'EM' || st.fontStyle === 'italic') out = wrapMd(n.dataset?.m || '*', out);
      if (tag === 'B' || tag === 'STRONG' || Number(st.fontWeight) >= 600 || st.fontWeight === 'bold') out = wrapMd('**', out);
      if (tag === 'U' || /underline/.test(st.textDecoration || st.textDecorationLine || '')) out = wrapMd('__', out);
      if (tag === 'S' || tag === 'STRIKE' || tag === 'DEL' || /line-through/.test(st.textDecoration || st.textDecorationLine || '')) out = wrapMd('~~', out);
      s += out;
    });
    return s;
  }

  /** Block editor DOM → markdown (one line per block; numbered lists renumbered in sequence). */
  function fromDom(root) {
    const lines = [];
    let prevOl = null; // { indent, n }
    const push = (kind, prefix, text) => {
      if (kind === 'ol') {
        const indent = (prefix.match(/^\s*/) || [''])[0];
        const own = parseInt(prefix, 10) || 1;
        const n = prevOl && prevOl.indent === indent ? prevOl.n + 1 : own;
        prefix = `${indent}${n}. `;
        prevOl = { indent, n };
      } else prevOl = null;
      lines.push(...(prefix + text).split('\n').map((l, i) => (i ? l : l)));
    };
    let loose = null; // inline nodes sitting directly in the root
    const flushLoose = () => {
      if (!loose) return;
      push('p', '', inlineToMd(loose));
      loose = null;
    };
    root.childNodes.forEach((n) => {
      if (n.nodeType === 1 && n.dataset?.kind === 'code') {
        flushLoose();
        prevOl = null;
        lines.push(n.dataset.open || '```', ...n.textContent.replace(/\u00a0/g, ' ').split('\n'), '```');
        return;
      }
      if (isBlockEl(n)) {
        flushLoose();
        const kind = n.dataset?.kind || 'p';
        const prefix = n.dataset?.prefix ?? DEFAULT_PREFIX[kind] ?? '';
        // Chrome sometimes nests a new line's <div> inside the previous one: split those out.
        const parts = [];
        let cur = document.createElement('div');
        n.childNodes.forEach((c) => {
          if (isBlockEl(c)) { parts.push([kind, prefix, cur]); cur = document.createElement('div'); parts.push([c.dataset?.kind || kind, c.dataset?.prefix ?? prefix, c]); }
          else cur.appendChild(c.cloneNode(true));
        });
        if (cur.childNodes.length || !parts.length) parts.push([kind, prefix, cur]);
        parts.forEach(([k, p, el]) => push(k, k === 'p' ? '' : p, inlineToMd(el)));
        return;
      }
      if (n.nodeType === 3 && !n.nodeValue.trim() && !loose && /\n/.test(n.nodeValue)) return; // formatting whitespace
      (loose = loose || document.createElement('div')).appendChild(n.cloneNode(true));
    });
    flushLoose();
    return lines.join('\n');
  }

  /* ------------------------------------------------------------ editor behaviour */

  let lastRange = null;
  let lastEditor = null;
  document.addEventListener('selectionchange', () => {
    const sel = window.getSelection();
    if (!sel.rangeCount) return;
    const ed = sel.anchorNode && (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement)?.closest?.('[data-vmd]');
    if (ed) { lastRange = sel.getRangeAt(0).cloneRange(); lastEditor = ed; }
  });

  function restoreSelection() {
    if (!lastEditor || !document.body.contains(lastEditor)) return null;
    lastEditor.focus();
    if (lastRange) { const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(lastRange); }
    return lastEditor;
  }

  const blockOf = (node, root) => {
    let n = node && node.nodeType === 3 ? node.parentElement : node;
    while (n && n !== root && n.parentElement !== root) n = n.parentElement;
    return n && n !== root ? n : null;
  };

  function selectedBlocks(root) {
    const sel = window.getSelection();
    if (!sel.rangeCount) return [];
    const r = sel.getRangeAt(0);
    const a = blockOf(r.startContainer, root);
    const b = blockOf(r.endContainer, root);
    if (!a) return [];
    const out = [];
    for (let n = a; n; n = n.nextElementSibling) { out.push(n); if (n === b || !b) break; }
    return out;
  }

  function setKind(el, kind) {
    el.dataset.kind = kind;
    el.dataset.prefix = DEFAULT_PREFIX[kind];
    el.className = `vb vb-${kind}`;
    el.removeAttribute('style');
  }

  // Shows each numbered-list line's number the way it will be saved (a list continues the previous
  // line's number; a new list starts from its own).
  function renumber(root) {
    let prev = null;
    root.querySelectorAll(':scope > .vb').forEach((b) => {
      if (b.dataset.kind !== 'ol') { prev = null; return; }
      const indent = (b.dataset.prefix.match(/^\s*/) || [''])[0];
      const n = prev && prev.indent === indent ? prev.n + 1 : parseInt(b.dataset.prefix, 10) || 1;
      b.dataset.n = n;
      prev = { indent, n };
    });
  }

  // Wraps every bare text/inline node sitting directly in the editor into a paragraph block.
  function tidy(root) {
    let wrap = null;
    [...root.childNodes].forEach((n) => {
      if (isBlockEl(n)) {
        wrap = null;
        if (!n.dataset.kind) { n.dataset.kind = 'p'; n.dataset.prefix = ''; n.className = 'vb vb-p'; }
        return;
      }
      if (!wrap) { wrap = document.createElement('div'); wrap.className = 'vb vb-p'; wrap.dataset.kind = 'p'; wrap.dataset.prefix = ''; root.insertBefore(wrap, n); }
      wrap.appendChild(n);
    });
    if (!root.childNodes.length) root.innerHTML = blockHtml('p', '', '');
    renumber(root);
  }

  /**
   * Makes `el` a visual editor holding `md`. multiline=false gives a single-line (title/name) editor.
   * onChange(md) runs after every edit.
   */
  function attach(el, md, { multiline = true, onChange = () => {}, placeholder = '' } = {}) {
    el.setAttribute('contenteditable', 'true');
    el.dataset.vmd = multiline ? 'block' : 'inline';
    el.dataset.placeholder = placeholder;
    el.spellcheck = true;
    const read = () => (multiline ? fromDom(el) : inlineToMd(el).replace(/\n/g, ' '));
    const render = (text) => {
      el.innerHTML = multiline ? toHtml(text) : inlineToHtml(text);
      if (multiline) renumber(el);
      el.classList.toggle('is-empty', !text);
    };
    render(md);
    let current = String(md ?? '');
    const changed = () => {
      if (multiline) tidy(el);
      current = read();
      el.classList.toggle('is-empty', !current);
      onChange(current);
    };
    el.addEventListener('input', changed);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !multiline) { e.preventDefault(); return; }
      if (e.key === 'Enter' && multiline && !e.shiftKey) {
        const [b] = selectedBlocks(el);
        if (b && ['li', 'ol', 'quote', 'sub'].includes(b.dataset.kind) && !b.textContent.trim() && !b.querySelector('[data-md]')) {
          e.preventDefault(); setKind(b, 'p'); changed();
          return;
        }
        // A new line starts plain: don't carry bold/italic/etc. over from the end of the last line.
        setTimeout(() => {
          const [nb] = selectedBlocks(el);
          if (!nb || nb === b || nb.textContent.replace(/[\u200b\u00a0]/g, '').trim() || nb.querySelector('[data-md]')) return;
          nb.innerHTML = '<br>';
          const r = document.createRange();
          r.setStart(nb, 0);
          r.collapse(true);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(r);
        });
        if (b && /^h[123]$/.test(b.dataset.kind)) {
          // A new line after a heading is a normal paragraph.
          setTimeout(() => { const [nb] = selectedBlocks(el); if (nb && nb !== b && nb.dataset.kind === b.dataset.kind && !nb.textContent.trim()) { setKind(nb, 'p'); changed(); } });
        }
      }
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && ['b', 'i', 'u'].includes(e.key.toLowerCase())) {
        e.preventDefault(); format({ b: 'bold', i: 'italic', u: 'underline' }[e.key.toLowerCase()]);
      }
    });
    el.addEventListener('paste', (e) => {
      e.preventDefault();
      const t = (e.clipboardData || window.clipboardData).getData('text/plain');
      document.execCommand('insertText', false, multiline ? t : t.replace(/\n/g, ' '));
    });
    // Re-render on blur so typed markdown (e.g. **bold**, :Emoji:) shows formatted — but not while
    // the user is in the toolbar / emoji picker (that would lose the caret they're inserting at).
    el.addEventListener('blur', (e) => {
      if (e.relatedTarget?.closest?.('[data-vmd-keep]')) return;
      const text = read();
      if (text !== current || el.innerHTML !== (multiline ? toHtml(text) : inlineToHtml(text))) { render(text); current = text; onChange(text); }
    });
    return { get value() { return current; }, set value(v) { current = String(v ?? ''); render(current); } };
  }

  /* ------------------------------------------------------------ toolbar commands */

  function format(cmd, arg) {
    const ed = restoreSelection();
    if (!ed) return false;
    document.execCommand('styleWithCSS', false, false);
    if (['bold', 'italic', 'underline', 'strikeThrough', 'removeFormat'].includes(cmd)) document.execCommand(cmd);
    else if (cmd === 'code' || cmd === 'spoiler') {
      const sel = window.getSelection();
      const text = sel.toString();
      if (!text) return false;
      const el = document.createElement(cmd === 'code' ? 'code' : 'span');
      if (cmd === 'spoiler') el.className = 'v-spoiler';
      el.textContent = text;
      const r = sel.getRangeAt(0);
      r.deleteContents();
      r.insertNode(el);
      r.setStartAfter(el);
      sel.removeAllRanges();
      sel.addRange(r);
    } else if (cmd === 'link') {
      if (!arg) return false;
      if (window.getSelection().isCollapsed) document.execCommand('insertHTML', false, `<a href="${esc(arg)}">${esc(arg)}</a>`);
      else document.execCommand('createLink', false, arg);
    } else if (cmd === 'insert') {
      // Inserted by hand: Chrome's insertHTML adds a stray empty line after non-editable images.
      const sel = window.getSelection();
      const r = sel.getRangeAt(0);
      r.deleteContents();
      const frag = r.createContextualFragment(arg);
      const last = frag.lastChild;
      r.insertNode(frag);
      if (last) { r.setStartAfter(last); r.collapse(true); sel.removeAllRanges(); sel.addRange(r); }
    } else if (cmd === 'block' && ed.dataset.vmd === 'block') {
      const blocks = selectedBlocks(ed);
      const all = blocks.length && blocks.every((b) => b.dataset.kind === arg);
      blocks.forEach((b) => setKind(b, all ? 'p' : arg));
    }
    ed.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }

  /** HTML for inserting an emoji (custom: by object; unicode: by string). */
  const emojiInsertHtml = (e) => (typeof e === 'string' ? esc(e) : emojiAtom(emojiTag(e), e.name, e.id) + '&#8203;');

  const activeEditor = () => (lastEditor && document.body.contains(lastEditor) ? lastEditor : null);

  return { setData, toHtml, inlineToHtml, fromDom, inlineToMd, attach, format, emojiInsertHtml, restoreSelection, activeEditor, get data() { return data; } };
})();
