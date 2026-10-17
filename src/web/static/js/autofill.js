// Discord-style autofill for the guide editors: ':' server emojis, '@' members and roles, '#' channels.
// Works in plain inputs/textareas (inserts the raw tag, e.g. <:Money:123>) and in the visual editor
// (inserts the rendered emoji / mention pill). Opt a field in with the class `ac-on`; visual editors
// ([data-vmd]) are always on.
window.GuideAutofill = (function () {
  let data = { emojis: [], channels: [], roles: [], users: [] };
  const setData = (d) => (data = { ...data, ...(d || {}) });
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  // A trigger right after the start, a space or an opening bracket, then what's typed so far.
  const TRIGGER = /(?:^|[\s(>])([@#:])([^\s@#:<>()[\]]{0,32})$/;

  function items(trigger, query) {
    const q = query.toLowerCase();
    const rank = (name) => { const n = String(name || '').toLowerCase(); return n.startsWith(q) ? 0 : n.includes(q) ? 1 : 2; };
    const pick = (list, name) => list.map((x) => [rank(name(x)), x]).filter(([r]) => r < 2).sort((a, b) => a[0] - b[0] || String(name(a[1])).localeCompare(String(name(b[1])))).map(([, x]) => x);
    if (trigger === ':') {
      if (!q) return [];
      return pick(data.emojis, (e) => e.name).slice(0, 8).map((e) => ({ label: `:${e.name}:`, icon: e.url, md: `<${e.animated ? 'a' : ''}:${e.name}:${e.id}>` }));
    }
    if (trigger === '#') return pick(data.channels, (c) => c.name).slice(0, 8).map((c) => ({ label: `#${c.name}`, md: `<#${c.id}>` }));
    if (trigger === '@') {
      const users = pick(data.users, (u) => `${u.name} ${u.username || ''}`).slice(0, 6).map((u) => ({ label: `@${u.name}`, sub: u.username ? `@${u.username}` : '', md: `<@${u.id}>` }));
      const roles = pick(data.roles, (r) => r.name).slice(0, 4).map((r) => ({ label: `@${r.name}`, sub: 'role', md: `<@&${r.id}>` }));
      return [...users, ...roles].slice(0, 8);
    }
    return [];
  }

  /* ------------------------------------------------------------ dropdown */

  const box = document.createElement('div');
  box.className = 'gd-ac';
  box.setAttribute('data-vmd-keep', '');
  box.hidden = true;
  let ctx = null; // { kind: 'text'|'visual', el, start, end, node, list, hi }

  function render() {
    box.innerHTML = ctx.list.map((it, i) => `<div class="gd-ac-item ${i === ctx.hi ? 'on' : ''}" data-i="${i}">
      ${it.icon ? `<img src="${esc(it.icon)}" alt="">` : ''}<span>${esc(it.label)}</span>${it.sub ? `<small>${esc(it.sub)}</small>` : ''}</div>`).join('');
  }
  function place(rect) {
    box.hidden = false;
    const w = Math.min(300, window.innerWidth - 16);
    box.style.width = w + 'px';
    box.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - w - 8)) + 'px';
    const below = rect.bottom + 4;
    const h = box.offsetHeight;
    box.style.top = (below + h > window.innerHeight - 8 && rect.top - h - 4 > 8 ? rect.top - h - 4 : below) + 'px';
  }
  const hide = () => { ctx = null; box.hidden = true; };

  // Where the caret is inside a textarea/input (a hidden mirror with the same text and styles).
  function textCaretRect(el, pos) {
    const cs = getComputedStyle(el);
    const m = document.createElement('div');
    for (const p of ['boxSizing', 'width', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'wordSpacing', 'textIndent', 'tabSize']) m.style[p] = cs[p];
    Object.assign(m.style, { position: 'fixed', visibility: 'hidden', top: '0', left: '0', whiteSpace: el.tagName === 'TEXTAREA' ? 'pre-wrap' : 'pre', wordWrap: 'break-word', overflow: 'hidden' });
    m.textContent = el.value.slice(0, pos);
    const mark = document.createElement('span');
    mark.textContent = '​';
    m.appendChild(mark);
    document.body.appendChild(m);
    const r = el.getBoundingClientRect();
    const top = r.top + mark.offsetTop - el.scrollTop;
    const left = r.left + mark.offsetLeft - el.scrollLeft;
    const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.3;
    m.remove();
    return { left, top, bottom: Math.min(top + lh, r.bottom) };
  }

  function update(target) {
    let next = null;
    if (target?.matches?.('textarea.ac-on, input.ac-on')) {
      const pos = target.selectionStart;
      const m = pos === target.selectionEnd && target.value.slice(0, pos).match(TRIGGER);
      if (m) next = { kind: 'text', el: target, trigger: m[1], query: m[2], start: pos - m[2].length - 1, end: pos, rect: () => textCaretRect(target, pos - m[2].length - 1) };
    } else {
      const sel = window.getSelection();
      const node = sel.rangeCount && sel.isCollapsed ? sel.anchorNode : null;
      const ed = node && node.nodeType === 3 && node.parentElement?.closest('[data-vmd]');
      const m = ed && node.nodeValue.slice(0, sel.anchorOffset).match(TRIGGER);
      if (m) {
        const start = sel.anchorOffset - m[2].length - 1;
        next = { kind: 'visual', el: ed, node, trigger: m[1], query: m[2], start, end: sel.anchorOffset, rect: () => {
          const r = document.createRange(); r.setStart(node, start); r.setEnd(node, start + 1);
          return r.getClientRects()[0] || ed.getBoundingClientRect();
        } };
      }
    }
    const list = next ? items(next.trigger, next.query) : [];
    if (!list.length) return hide();
    ctx = { ...next, list, hi: 0 };
    render();
    place(ctx.rect());
  }

  function choose(i) {
    const c = ctx;
    const it = c && c.list[i];
    hide();
    if (!it) return;
    if (c.kind === 'text') {
      c.el.focus();
      c.el.setRangeText(it.md + ' ', c.start, c.end, 'end');
      c.el.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    const sel = window.getSelection();
    const r = document.createRange();
    r.setStart(c.node, c.start);
    r.setEnd(c.node, Math.min(c.end, c.node.nodeValue.length));
    r.deleteContents();
    const frag = r.createContextualFragment((window.VisualMD ? window.VisualMD.inlineToHtml(it.md) : esc(it.md)) + ' ');
    const last = frag.lastChild;
    r.insertNode(frag);
    if (last) { r.setStartAfter(last); r.collapse(true); sel.removeAllRanges(); sel.addRange(r); }
    c.el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  /* ------------------------------------------------------------ wiring */

  function init() {
    document.body.appendChild(box);
    const pickAt = (e) => { const item = e.target.closest('.gd-ac-item'); if (item) { e.preventDefault(); choose(Number(item.dataset.i)); } };
    box.addEventListener('mousedown', pickAt);
    box.addEventListener('touchstart', pickAt, { passive: false });
    document.addEventListener('input', (e) => update(e.target), true);
    document.addEventListener('click', (e) => { if (!box.contains(e.target)) update(e.target); });
    // Captured before the editors' own keys, so Enter/Tab pick a suggestion instead of a new line.
    document.addEventListener('keydown', (e) => {
      if (!ctx) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') ctx.hi = (ctx.hi + (e.key === 'ArrowDown' ? 1 : -1) + ctx.list.length) % ctx.list.length, render();
      else if (e.key === 'Enter' || e.key === 'Tab') choose(ctx.hi);
      else if (e.key === 'Escape') hide();
      else return;
      e.preventDefault();
      e.stopPropagation();
    }, true);
    window.addEventListener('scroll', () => ctx && place(ctx.rect()), true);
    window.addEventListener('resize', hide);
    document.addEventListener('focusout', (e) => setTimeout(() => { if (ctx && document.activeElement !== ctx.el && !ctx.el.contains(document.activeElement)) hide(); }, 120));
  }
  if (document.body) init();
  else document.addEventListener('DOMContentLoaded', init);

  return { setData, items, hide, get open() { return !!ctx; } };
})();
