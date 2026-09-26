// Shared @member / @role / #channel / :emoji: autocomplete + Discord-style preview rendering,
// used by the Embed Builder and every dashboard field whose text the bot sends.
window.LoofMentions = (function () {
  let data = { users: [], channels: [], roles: [], emojis: [] };
  let loading = null;

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  function load(guildId) {
    if (!loading) {
      loading = fetch(`/api/guilds/${guildId}/mentionable`)
        .then((r) => (r.ok ? r.json() : data))
        .then((d) => (data = { ...data, ...d }))
        .catch(() => data);
    }
    return loading;
  }

  function findTrigger(text, cursorPos) {
    const upToCursor = text.slice(0, cursorPos);
    const match = upToCursor.match(/(?:^|\s)([@#:])([^\s@#:<>]*)$/);
    if (!match) return null;
    return { trigger: match[1], query: match[2].toLowerCase(), start: cursorPos - match[2].length - 1 };
  }

  function getMatches(trigger, query) {
    const has = (s) => String(s || '').toLowerCase().includes(query);
    if (trigger === '@') {
      const users = data.users
        .filter((u) => has(u.name) || has(u.username))
        .slice(0, 6)
        .map((u) => ({ label: u.name, sublabel: `@${u.username}`, insert: `<@${u.id}>` }));
      const roles = data.roles
        .filter((r) => has(r.name))
        .slice(0, 4)
        .map((r) => ({ label: `@${r.name}`, sublabel: 'role', insert: `<@&${r.id}>` }));
      return [...users, ...roles].slice(0, 8);
    }
    if (trigger === '#') {
      return data.channels.filter((c) => has(c.name)).slice(0, 8).map((c) => ({ label: `#${c.name}`, insert: `<#${c.id}>` }));
    }
    if (trigger === ':' && query.length >= 1) {
      return data.emojis
        .filter((e) => has(e.name))
        .slice(0, 8)
        .map((e) => ({ label: e.name, iconUrl: e.url, insert: `<${e.animated ? 'a' : ''}:${e.name}:${e.id}>` }));
    }
    return [];
  }

  /**
   * Adds autocomplete to an <input>/<textarea>. Creates its own dropdown unless one is passed.
   * onChange runs after every edit (typing or picking a suggestion) — use it to refresh previews.
   */
  function attach(inputEl, { onChange = () => {}, dropdown = null } = {}) {
    if (!inputEl || inputEl.dataset.mentions) return;
    inputEl.dataset.mentions = '1';
    let dropdownEl = dropdown;
    if (!dropdownEl) {
      const wrapper = document.createElement('div');
      wrapper.className = 'autocomplete-wrapper';
      inputEl.parentNode.insertBefore(wrapper, inputEl);
      wrapper.appendChild(inputEl);
      dropdownEl = document.createElement('div');
      dropdownEl.className = 'autocomplete-dropdown';
      wrapper.appendChild(dropdownEl);
    }
    let matches = [];
    let highlighted = 0;

    function render() {
      if (!matches.length) {
        dropdownEl.classList.remove('visible');
        dropdownEl.innerHTML = '';
        return;
      }
      dropdownEl.innerHTML = matches
        .map(
          (m, i) => `<div class="autocomplete-item ${i === highlighted ? 'highlighted' : ''}" data-index="${i}">
            ${m.iconUrl ? `<img src="${esc(m.iconUrl)}" alt="">` : ''}
            <span>${esc(m.label)}</span>
            ${m.sublabel ? `<span class="muted" style="font-size:0.8rem;">${esc(m.sublabel)}</span>` : ''}
          </div>`
        )
        .join('');
      dropdownEl.classList.add('visible');
      dropdownEl.querySelectorAll('.autocomplete-item').forEach((el) =>
        el.addEventListener('mousedown', (e) => {
          e.preventDefault();
          select(matches[Number(el.dataset.index)]);
        })
      );
    }

    function select(match) {
      const trig = findTrigger(inputEl.value, inputEl.selectionStart);
      if (!trig || !match) return;
      const before = inputEl.value.slice(0, trig.start);
      const after = inputEl.value.slice(inputEl.selectionStart);
      inputEl.value = `${before}${match.insert} ${after}`;
      const cursor = (before + match.insert + ' ').length;
      inputEl.setSelectionRange(cursor, cursor);
      matches = [];
      render();
      onChange();
      inputEl.focus();
    }

    inputEl.addEventListener('input', () => {
      const trig = findTrigger(inputEl.value, inputEl.selectionStart);
      matches = trig ? getMatches(trig.trigger, trig.query) : [];
      highlighted = 0;
      render();
      onChange();
    });
    inputEl.addEventListener('keydown', (e) => {
      if (!matches.length) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        highlighted = (highlighted + (e.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length;
        render();
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        select(matches[highlighted]);
      } else if (e.key === 'Escape') {
        matches = [];
        render();
      }
    });
    inputEl.addEventListener('blur', () => setTimeout(() => ((matches = []), render()), 150));
  }

  // Escapes text and turns mention/emoji tokens into Discord-looking pills for previews.
  function render(raw) {
    if (!raw) return '';
    return esc(raw)
      .replace(/&lt;@&amp;(\d+)&gt;/g, (_, id) => {
        const r = data.roles.find((x) => x.id === id);
        return `<span class="mention-pill">@${esc(r ? r.name : 'unknown-role')}</span>`;
      })
      .replace(/&lt;@!?(\d+)&gt;/g, (_, id) => {
        const u = data.users.find((x) => x.id === id);
        return `<span class="mention-pill">@${esc(u ? u.name : 'unknown-user')}</span>`;
      })
      .replace(/&lt;#(\d+)&gt;/g, (_, id) => {
        const c = data.channels.find((x) => x.id === id);
        return `<span class="channel-pill">#${esc(c ? c.name : 'unknown-channel')}</span>`;
      })
      .replace(/&lt;a?:(\w+):(\d+)&gt;/g, (_, name, id) => {
        const e = data.emojis.find((x) => x.id === id);
        return e ? `<img class="custom-emoji" src="${esc(e.url)}" alt=":${esc(name)}:">` : `:${esc(name)}:`;
      });
  }

  // Light Discord markdown on already-escaped HTML: **bold**, __underline__, *italic*, ~~strike~~, `code`.
  function markdown(html) {
    return html
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/__(.+?)__/g, '<u>$1</u>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/~~(.+?)~~/g, '<s>$1</s>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');
  }

  return { load, attach, render, markdown, esc, get data() { return data; } };
})();
