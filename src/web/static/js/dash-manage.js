// Dashboard pages for the action commands: Giveaways, Reaction Roles, Polls & Reminders, Moderation,
// and the leaderboard's "adjust a member's XP" card. Loaded before the page's inline script, so it only
// defines functions — the globals it uses (guildId, roles, channels, viewer, esc, showToast, LoofMentions)
// exist by the time any of them run.

/* ------------------------------------------------------------------ shared helpers */

async function manageApi(method, path, body) {
  const res = await fetch(`/api/guilds/${guildId}/${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

// Runs an API call with a button disabled, toasting the result. Returns the data or null.
async function withButton(btn, fn, okMsg) {
  if (btn) btn.disabled = true;
  try {
    const data = await fn();
    if (okMsg) showToast(typeof okMsg === 'function' ? okMsg(data) : okMsg);
    return data;
  } catch (err) {
    showToast(`❌ ${err.message}`);
    return null;
  } finally {
    if (btn) btn.disabled = false;
  }
}

const DUR_UNITS = { s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 };
function parseDurationInput(str) {
  const cleaned = String(str || '').trim().toLowerCase().replace(/\s+/g, '');
  if (!/^(\d+[smhdw])+$/.test(cleaned)) return null;
  let total = 0;
  for (const [, n, u] of cleaned.matchAll(/(\d+)([smhdw])/g)) total += Number(n) * DUR_UNITS[u];
  return total || null;
}

// "in 3h" / "5m ago" — like Discord's relative timestamps.
function fromNow(ts) {
  const diff = ts - Date.now();
  const abs = Math.abs(diff);
  const steps = [[86400000, 'day'], [3600000, 'hour'], [60000, 'minute']];
  let text = 'a few seconds';
  for (const [ms, unit] of steps) {
    if (abs >= ms) {
      const n = Math.round(abs / ms);
      text = `${n} ${unit}${n === 1 ? '' : 's'}`;
      break;
    }
  }
  return diff >= 0 ? `in ${text}` : `${text} ago`;
}

const channelLabel = (id) => {
  const c = channels.find((x) => x.id === id);
  return `#${c ? c.name : 'deleted-channel'}`;
};
const roleLabel = (id) => {
  const r = roles.find((x) => x.id === id);
  return `@${r ? r.name : 'deleted-role'}`;
};
const pill = (text) => `<span class="mention-pill">${esc(text)}</span>`;
// Discord-style text: escape, turn <@&id>/<#id> into pills, then light markdown.
const discordText = (text) => LoofMentions.markdown(LoofMentions.render(text));

function emptyCard(icon, text) {
  return `<div class="card empty-state"><div class="big">${icon}</div>${text}</div>`;
}

// A tiny member search box: type a name, pick from the list; the chosen ID lands in input.dataset.userId.
function attachMemberPicker(input) {
  if (!input || input.dataset.picker) return;
  input.dataset.picker = '1';
  const wrap = document.createElement('div');
  wrap.className = 'autocomplete-wrapper';
  wrap.style.flex = '1';
  wrap.style.minWidth = '160px';
  input.parentNode.insertBefore(wrap, input);
  wrap.appendChild(input);
  const list = document.createElement('div');
  list.className = 'autocomplete-dropdown';
  wrap.appendChild(list);
  let matches = [];

  const close = () => {
    list.classList.remove('visible');
    list.innerHTML = '';
  };
  const pick = (u) => {
    input.value = u.name;
    input.dataset.userId = u.id;
    close();
  };
  input.addEventListener('input', () => {
    delete input.dataset.userId;
    const q = input.value.trim().toLowerCase();
    const users = LoofMentions.data.users || [];
    matches = q ? users.filter((u) => `${u.name} ${u.username}`.toLowerCase().includes(q)).slice(0, 8) : [];
    if (!matches.length) return close();
    list.innerHTML = matches
      .map((u, i) => `<div class="autocomplete-item" data-i="${i}"><span>${esc(u.name)}</span><span class="muted" style="font-size:0.8rem;">@${esc(u.username)}</span></div>`)
      .join('');
    list.classList.add('visible');
    list.querySelectorAll('.autocomplete-item').forEach((el) =>
      el.addEventListener('mousedown', (e) => {
        e.preventDefault();
        pick(matches[Number(el.dataset.i)]);
      })
    );
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && matches.length) {
      e.preventDefault();
      pick(matches[0]);
    }
  });
  input.addEventListener('blur', () => setTimeout(close, 150));
  LoofMentions.load(guildId);
}

// Called by showTab() whenever a page opens.
function onManageTabShown(tab) {
  if (tab === 'giveaways') {
    if (!gwState.loaded) loadGiveaways();
    LoofMentions.load(guildId).then(renderGiveawayPreview);
  }
  if (tab === 'reactionroles' && !rrState.loaded) loadPanels();
  if (tab === 'community') {
    if (!pollState.loaded) initPolls();
    loadReminders();
  }
  if (tab === 'moderation') {
    loadModeration();
    loadMediaOnly();
    attachMemberPicker(document.getElementById('pgUser'));
  }
  if (tab === 'leaderboard') attachMemberPicker(document.getElementById('mxUser'));
}

/* ------------------------------------------------------------------ Giveaways */

const gwState = { loaded: false, running: [], ended: [], filter: 'running' };
const gwType = () => (document.querySelector('input[name="gwType"]:checked') || {}).value || 'timed';
const GW_DEFAULT_DESC = { timed: 'Click the button below to enter!', drop: 'Be quick — first come, first served!' };

async function loadGiveaways() {
  gwState.loaded = true;
  try {
    const data = await manageApi('GET', 'giveaways');
    gwState.running = data.running;
    gwState.ended = data.ended;
    renderGiveawayList();
  } catch (err) {
    document.getElementById('gwList').innerHTML = emptyCard('⚠️', esc(err.message));
  }
}

function requirementLines(req) {
  const lines = [];
  if (req && req.roleId) lines.push(`• Have the <@&${req.roleId}> role`);
  if (req && req.minDaysInServer) lines.push(`• Be in the server for **${req.minDaysInServer}+ day(s)**`);
  if (req && req.minLevel) lines.push(`• Be **Level ${req.minLevel}+**`);
  return lines;
}

function renderGiveawayList() {
  const { running, ended, filter } = gwState;
  document.getElementById('gwStatus').innerHTML =
    `<span class="status-chip ${running.length ? 'good' : ''}"><span class="dot"></span>${running.length} running</span>` +
    `<span class="status-chip"><span class="dot"></span>${ended.length} recently ended</span>`;
  document.querySelectorAll('#gwFilter button').forEach((b) => b.classList.toggle('active', b.dataset.filter === filter));

  const items = filter === 'running' ? running : ended;
  const list = document.getElementById('gwList');
  if (!items.length) {
    list.innerHTML = filter === 'running' ? emptyCard('🎁', 'No giveaways running. Start one with <strong>+ New giveaway</strong>.') : emptyCard('🗂️', 'No ended giveaways yet.');
    return;
  }
  list.innerHTML = items
    .map((g) => {
      const isDrop = g.type === 'drop';
      const reqs = requirementLines(g.requirements).map((l) => l.replace(/^• /, '')).join(' · ');
      const entries = isDrop ? `${g.entryCount}/${g.winnerCount} claimed` : `${g.entryCount} ${g.entryCount === 1 ? 'entry' : 'entries'} · ${g.winnerCount} winner${g.winnerCount === 1 ? '' : 's'}`;
      const when = g.ended ? `ended ${fromNow(g.endTimestamp)}` : `${isDrop ? 'expires' : 'ends'} ${fromNow(g.endTimestamp)}`;
      const winners = g.ended
        ? `<div class="item-meta">🏆 ${g.winners.length ? g.winners.map((w) => pill('@' + (w.name || 'unknown-user'))).join(' ') : 'No winners'}</div>`
        : '';
      const dup = `<button class="btn secondary small" title="Start a new one with the same settings" onclick="openGiveawayEditor('${g.messageId}', { copy: true })">⧉ Duplicate</button>`;
      const actions = g.ended
        ? `${isDrop ? '' : `<button class="btn secondary small" onclick="rerollGiveaway('${g.messageId}', this)">🎲 Reroll</button>`}
           ${dup}
           <button class="btn danger small" onclick="deleteGiveaway('${g.messageId}')">Delete</button>`
        : `<button class="btn secondary small" onclick="openGiveawayEditor('${g.messageId}')">Edit</button>
           ${dup}
           <button class="btn secondary small" onclick="endGiveaway('${g.messageId}', this)">End now</button>
           <button class="btn danger small" onclick="deleteGiveaway('${g.messageId}')">Delete</button>`;
      return `<div class="card item-card">
        <div class="item-icon" style="background:${esc(g.colorHex)}22; color:${esc(g.colorHex)};">${isDrop ? '⚡' : '🎁'}</div>
        <div class="item-main">
          <div class="item-title">${esc(g.prize)} ${isDrop ? '<span class="status-chip warn"><span class="dot"></span>Drop</span>' : ''}</div>
          <div class="item-meta">${esc(channelLabel(g.channelId))} · ${entries} · ${when}${g.hostName ? ` · by ${esc(g.hostName)}` : ''}</div>
          ${reqs ? `<div class="item-meta">🔒 ${LoofMentions.render(reqs).replace(/\*\*/g, '')}</div>` : ''}
          ${winners}
        </div>
        <div class="item-actions">
          <a class="btn secondary small" href="${esc(g.url)}" target="_blank" rel="noopener">Open ↗</a>
          ${actions}
        </div>
      </div>`;
    })
    .join('');
}

function applyGiveawayTypeUi() {
  const isDrop = gwType() === 'drop';
  const editing = !!document.getElementById('gwId').value;
  const current = editing ? gwState.running.find((g) => g.messageId === document.getElementById('gwId').value) : null;
  document.getElementById('gwDurationTitle').textContent = editing ? 'Change end time' : isDrop ? 'Expires after' : 'Duration';
  document.getElementById('gwDurationHelp').textContent = editing
    ? `Blank keeps the current end (${current ? fromNow(current.endTimestamp) : ''}). Enter e.g. 2h to end 2 hours from now.`
    : isDrop
      ? 'Closes early if nobody claims — e.g. 10m, 1h. Blank = 24h.'
      : 'e.g. 30m, 2h, 1d12h';
  document.getElementById('gwDuration').placeholder = editing ? 'Keep current' : isDrop ? '24h' : '1d';
  document.getElementById('gwWinnersTitle').textContent = isDrop ? 'Prizes' : 'Winners';
  document.getElementById('gwWinnersHelp').textContent = isDrop ? 'How many people can claim.' : 'How many people win.';
  document.getElementById('gwEmoji').style.display = isDrop ? 'none' : '';
  document.getElementById('gwLookHelp').textContent = isDrop ? 'Embed color (drops always use a ⚡ Claim button).' : "Embed color and the entry button's emoji.";
  document.getElementById('gwDesc').placeholder = GW_DEFAULT_DESC[gwType()];
  renderGiveawayPreview();
}

// openGiveawayEditor() → new; (id) → edit a running one; (id, { copy: true }) → new, prefilled from any giveaway.
function openGiveawayEditor(messageId = null, { copy = false } = {}) {
  const source = messageId ? [...gwState.running, ...gwState.ended].find((x) => x.messageId === messageId) : null;
  const g = copy ? null : source; // the giveaway being edited (null when creating)
  const from = source || null; // where the form's values come from
  const editor = document.getElementById('gwEditor');
  editor.style.display = '';
  document.getElementById('gwEditorTitle').textContent = g ? `Edit “${g.prize}”` : copy ? `New giveaway (copy of “${from.prize}”)` : 'New giveaway';
  document.getElementById('gwSaveBtn').textContent = g ? 'Save changes' : 'Start giveaway';
  document.getElementById('gwId').value = g ? g.messageId : '';
  document.querySelector(`input[name="gwType"][value="${from ? from.type : 'timed'}"]`).checked = true;
  document.querySelectorAll('input[name="gwType"]').forEach((r) => (r.disabled = !!g));
  document.getElementById('gwTypeCards').style.opacity = g ? '0.6' : '';
  document.getElementById('gwChannelRow').style.display = g ? 'none' : '';
  document.getElementById('gwPingRow').style.display = g ? 'none' : '';
  if (from && channels.some((c) => c.id === from.channelId)) document.getElementById('gwChannel').value = from.channelId;
  document.getElementById('gwPrize').value = from ? from.prize : '';
  document.getElementById('gwDuration').value = '';
  document.getElementById('gwWinners').value = from ? from.winnerCount : 1;
  document.getElementById('gwPing').value = '';
  document.getElementById('gwColor').value = from && /^#[0-9a-f]{6}$/i.test(from.colorHex) ? from.colorHex.toLowerCase() : '#5865f2';
  document.getElementById('gwEmoji').value = from && from.type !== 'drop' ? from.emoji : '';
  // Show the saved text unless it's just the default (the placeholder already shows that).
  document.getElementById('gwDesc').value = from && from.customDesc !== GW_DEFAULT_DESC[from.type] ? from.customDesc : '';
  const req = (from && from.requirements) || {};
  document.getElementById('gwReqRole').value = req.roleId && roles.some((r) => r.id === req.roleId) ? req.roleId : '';
  document.getElementById('gwReqDays').value = req.minDaysInServer || '';
  document.getElementById('gwReqLevel').value = req.minLevel || '';
  applyGiveawayTypeUi();
  editor.scrollIntoView({ behavior: 'smooth', block: 'start' });
  document.getElementById(g ? 'gwPrize' : 'gwDuration').focus({ preventScroll: true });
}

function closeGiveawayEditor() {
  document.getElementById('gwEditor').style.display = 'none';
  document.getElementById('gwId').value = '';
}

function readGiveawayForm() {
  return {
    type: gwType(),
    channelId: document.getElementById('gwChannel').value,
    prize: document.getElementById('gwPrize').value.trim(),
    duration: document.getElementById('gwDuration').value.trim(),
    winners: document.getElementById('gwWinners').value,
    ping: document.getElementById('gwPing').value,
    color: document.getElementById('gwColor').value,
    emoji: document.getElementById('gwEmoji').value.trim(),
    description: document.getElementById('gwDesc').value.trim(),
    requirements: {
      roleId: document.getElementById('gwReqRole').value || null,
      minDaysInServer: document.getElementById('gwReqDays').value,
      minLevel: document.getElementById('gwReqLevel').value
    }
  };
}

// Mirrors buildGiveawayEmbed() in the bot so the preview matches what gets posted.
function renderGiveawayPreview() {
  if (!document.getElementById('gwpTitle')) return;
  const f = readGiveawayForm();
  const isDrop = f.type === 'drop';
  const editingId = document.getElementById('gwId').value;
  const editing = editingId ? gwState.running.find((g) => g.messageId === editingId) : null;
  const winners = Math.max(1, Number(f.winners) || 1);
  const ms = parseDurationInput(f.duration);
  const endTs = ms ? Date.now() + ms : editing ? editing.endTimestamp : Date.now() + 86400000;
  const prize = f.prize || 'Your prize';
  const reqs = requirementLines({ roleId: f.requirements.roleId, minDaysInServer: Number(f.requirements.minDaysInServer) || 0, minLevel: Number(f.requirements.minLevel) || 0 });
  const reqText = reqs.length ? `\n\n**Requirements:**\n${reqs.join('\n')}` : '';
  const desc = f.description || GW_DEFAULT_DESC[f.type];
  const host = '\u0001HOST\u0001'; // swapped for a pill below so it never depends on the member cache
  const hostName = editing ? editing.hostName || 'host' : viewer.username;
  const entries = editing ? editing.entryCount : 0;

  const body = isDrop
    ? `${desc}${reqText}\n\n**Prizes:** ${winners} · **First ${winners} to click win!**\n**Expires:** ${fromNow(endTs)}\n**Hosted By:** ${host}`
    : `${desc}${reqText}\n\n**Ends:** ${fromNow(endTs)}\n**Winners:** ${winners}\n**Hosted By:** ${host}`;

  const ch = channels.find((c) => c.id === (editing ? editing.channelId : f.channelId));
  document.getElementById('gwpChannel').textContent = `# ${ch ? ch.name : 'giveaways'}`;
  const pingText = !editing && f.ping ? (f.ping === 'everyone' ? '@everyone' : f.ping === 'here' ? '@here' : roleLabel(f.ping)) : '';
  document.getElementById('gwpPing').innerHTML = pingText ? pill(pingText) : '';
  document.getElementById('gwpEmbed').style.borderLeftColor = f.color;
  document.getElementById('gwpTitle').textContent = `${isDrop ? '⚡ Drop' : '🎁 Giveaway'}: ${prize}`;
  document.getElementById('gwpDesc').innerHTML = discordText(body).replace('\u0001HOST\u0001', pill('@' + hostName));
  document.getElementById('gwpFooter').textContent = isDrop ? `Claimed: ${entries}/${winners}` : `Entries: ${entries}`;
  const btn = document.getElementById('gwpButton');
  btn.className = `mock-button ${isDrop ? 'success' : 'primary'}`;
  btn.textContent = isDrop ? '⚡ Claim!' : `${f.emoji || '🎉'} Enter`;
}

async function saveGiveaway() {
  const id = document.getElementById('gwId').value;
  const f = readGiveawayForm();
  if (!id && !f.channelId) return showToast('❌ Pick a channel.');
  if (!f.prize) return showToast('❌ Enter a prize.');
  if (f.duration && !parseDurationInput(f.duration)) return showToast('❌ Invalid duration — use e.g. 30m, 2h, 1d12h.');
  if (!id && f.type === 'timed' && !f.duration) return showToast('❌ Enter how long the giveaway runs.');
  const data = await withButton(
    document.getElementById('gwSaveBtn'),
    () => manageApi('POST', id ? `giveaways/${id}` : 'giveaways', f),
    (d) =>
      id
        ? d.messageMissing
          ? "⚠️ Saved — but its message was deleted in Discord, so there's nothing to update there."
          : '✅ Giveaway updated.'
        : f.type === 'drop'
          ? '⚡ Drop posted!'
          : '🎉 Giveaway started!'
  );
  if (!data) return;
  closeGiveawayEditor();
  gwState.filter = 'running';
  loadGiveaways();
}

async function endGiveaway(id, btn) {
  const g = gwState.running.find((x) => x.messageId === id);
  if (!confirm(`End “${g ? g.prize : 'this giveaway'}” now and draw the winners?`)) return;
  const data = await withButton(btn, () => manageApi('POST', `giveaways/${id}/end`), '🏁 Giveaway ended — winners announced.');
  if (data) loadGiveaways();
}

async function rerollGiveaway(id, btn) {
  const data = await withButton(btn, () => manageApi('POST', `giveaways/${id}/reroll`), (d) => `🎲 New winner: ${d.winner.name || d.winner.id}`);
  if (data) loadGiveaways();
}

async function deleteGiveaway(id) {
  const g = [...gwState.running, ...gwState.ended].find((x) => x.messageId === id);
  if (!confirm(`Delete “${g ? g.prize : 'this giveaway'}” and its message? This can't be undone.`)) return;
  const data = await withButton(null, () => manageApi('DELETE', `giveaways/${id}`), '🗑️ Giveaway deleted.');
  if (data) loadGiveaways();
}

document.addEventListener('DOMContentLoaded', () => {
  if (!document.getElementById('tab-giveaways')) return;
  document.querySelectorAll('#gwFilter button').forEach((b) =>
    b.addEventListener('click', () => {
      gwState.filter = b.dataset.filter;
      renderGiveawayList();
    })
  );
  document.querySelectorAll('input[name="gwType"]').forEach((r) =>
    r.addEventListener('change', () => {
      const other = r.value === 'drop' ? 'timed' : 'drop';
      const desc = document.getElementById('gwDesc');
      if (!desc.value || desc.value === GW_DEFAULT_DESC[other]) desc.value = '';
      document.getElementById('gwColor').value = r.value === 'drop' ? '#F1C40F' : '#5865F2';
      applyGiveawayTypeUi();
    })
  );
  document.querySelectorAll('#tab-giveaways [data-duration]').forEach((chipEl) =>
    chipEl.addEventListener('click', () => {
      document.getElementById('gwDuration').value = chipEl.dataset.duration;
      renderGiveawayPreview();
    })
  );
  ['gwChannel', 'gwPrize', 'gwDuration', 'gwWinners', 'gwPing', 'gwColor', 'gwEmoji', 'gwDesc', 'gwReqRole', 'gwReqDays', 'gwReqLevel'].forEach((id) => {
    const el = document.getElementById(id);
    el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', renderGiveawayPreview);
  });
  renderGiveawayPreview();
});

/* ------------------------------------------------------------------ Reaction role panels */

const rrState = { loaded: false, panels: [] };
const rrMode = () => (document.querySelector('input[name="rrMode"]:checked') || {}).value || 'buttons';
const RR_MODE_LABEL = { buttons: 'Buttons', select: 'Dropdown · many', select_single: 'Dropdown · one' };

async function loadPanels() {
  rrState.loaded = true;
  try {
    const data = await manageApi('GET', 'reactionroles');
    rrState.panels = data.panels;
    renderPanelList();
  } catch (err) {
    document.getElementById('rrList').innerHTML = emptyCard('⚠️', esc(err.message));
  }
}

function renderPanelList() {
  const panels = rrState.panels;
  const roleCount = panels.reduce((n, p) => n + p.roles.length, 0);
  document.getElementById('rrStatus').innerHTML =
    `<span class="status-chip ${panels.length ? 'good' : ''}"><span class="dot"></span>${panels.length} panel${panels.length === 1 ? '' : 's'}</span>` +
    `<span class="status-chip"><span class="dot"></span>${roleCount} self-assignable role${roleCount === 1 ? '' : 's'}</span>`;
  const list = document.getElementById('rrList');
  if (!panels.length) {
    list.innerHTML = emptyCard('🎭', 'No role panels yet. Create one with <strong>+ New panel</strong>.');
    return;
  }
  list.innerHTML = panels
    .map(
      (p) => `<div class="card item-card">
        <div class="item-icon" style="background:${esc(p.color)}22; color:${esc(p.color)};">🎭</div>
        <div class="item-main">
          <div class="item-title">${esc(p.title)}</div>
          <div class="item-meta">${esc(channelLabel(p.channelId))} · ${RR_MODE_LABEL[p.mode]} · ${p.roles.length} role${p.roles.length === 1 ? '' : 's'}</div>
          <div class="item-meta">${p.roles.length ? p.roles.map((r) => pill(`${r.emoji ? r.emoji + ' ' : ''}${roleLabel(r.roleId)}`)).join(' ') : 'No roles yet'}</div>
        </div>
        <div class="item-actions">
          <a class="btn secondary small" href="${esc(p.url)}" target="_blank" rel="noopener">Open ↗</a>
          <button class="btn secondary small" onclick="openPanelEditor('${p.messageId}')">Edit</button>
          <button class="btn danger small" onclick="deletePanel('${p.messageId}')">Delete</button>
        </div>
      </div>`
    )
    .join('');
}

function panelRoleOptions(selectedId) {
  return (
    '<option value="">— Pick a role —</option>' +
    roles
      .map((r) => `<option value="${r.id}" ${r.id === selectedId ? 'selected' : ''} ${r.assignable ? '' : 'disabled'}>@${esc(r.name)}${r.assignable ? '' : ' ⚠️'}</option>`)
      .join('')
  );
}

function addPanelRoleRow(r = {}) {
  const rows = document.getElementById('rrRoleRows');
  if (rows.children.length >= 25) return showToast('❌ A panel can hold at most 25 roles.');
  const row = document.createElement('div');
  row.className = 'field-row rr-role-row';
  row.innerHTML = `
    <select class="rr-role" aria-label="Role">${panelRoleOptions(r.roleId)}</select>
    <input class="rr-label" maxlength="80" placeholder="Label (optional)" value="${esc(r.label || '')}">
    <input class="rr-emoji" maxlength="64" placeholder="Emoji" value="${esc(r.emoji || '')}" style="flex:0 0 90px;">
    <button class="btn secondary small" type="button" aria-label="Remove role">✕</button>`;
  row.querySelector('button').addEventListener('click', () => {
    row.remove();
    renderPanelPreview();
  });
  row.querySelectorAll('select, input').forEach((el) => el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', renderPanelPreview));
  rows.appendChild(row);
  renderPanelPreview();
}

function readPanelForm() {
  return {
    channelId: document.getElementById('rrChannel').value,
    title: document.getElementById('rrTitle').value.trim(),
    description: document.getElementById('rrDesc').value.trim(),
    color: document.getElementById('rrColor').value,
    mode: rrMode(),
    roles: [...document.querySelectorAll('.rr-role-row')]
      .map((row) => ({
        roleId: row.querySelector('.rr-role').value,
        label: row.querySelector('.rr-label').value.trim(),
        emoji: row.querySelector('.rr-emoji').value.trim()
      }))
      .filter((r) => r.roleId)
  };
}

function openPanelEditor(messageId = null) {
  const p = messageId ? rrState.panels.find((x) => x.messageId === messageId) : null;
  document.getElementById('rrEditor').style.display = '';
  document.getElementById('rrEditorTitle').textContent = p ? `Edit “${p.title}”` : 'New role panel';
  document.getElementById('rrSaveBtn').textContent = p ? 'Save changes' : 'Post panel';
  document.getElementById('rrId').value = p ? p.messageId : '';
  document.getElementById('rrChannelRow').style.display = p ? 'none' : '';
  if (p) document.getElementById('rrChannel').value = p.channelId;
  document.getElementById('rrTitle').value = p ? p.title : '';
  document.getElementById('rrDesc').value = p ? p.description : '';
  document.getElementById('rrColor').value = p ? p.color : '#5865F2';
  document.querySelector(`input[name="rrMode"][value="${p ? p.mode : 'buttons'}"]`).checked = true;
  document.getElementById('rrRoleRows').innerHTML = '';
  (p ? p.roles : [{}]).forEach((r) => addPanelRoleRow(r));
  renderPanelPreview();
  document.getElementById('rrEditor').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function closePanelEditor() {
  document.getElementById('rrEditor').style.display = 'none';
  document.getElementById('rrId').value = '';
}

// Mirrors buildPanelMessage() in the bot.
function renderPanelPreview() {
  if (!document.getElementById('rrpTitle')) return;
  const f = readPanelForm();
  const ch = channels.find((c) => c.id === f.channelId);
  const editing = rrState.panels.find((p) => p.messageId === document.getElementById('rrId').value);
  document.getElementById('rrpChannel').textContent = `# ${editing ? channelLabel(editing.channelId).slice(1) : ch ? ch.name : 'roles'}`;
  document.getElementById('rrpEmbed').style.borderLeftColor = f.color;
  document.getElementById('rrpTitle').textContent = f.title || 'Pick your roles';
  const lines = f.roles.map((r) => `${r.emoji ? esc(r.emoji) + ' ' : ''}${pill(roleLabel(r.roleId))}${r.label ? ` — ${esc(r.label)}` : ''}`);
  const hint = f.mode === 'buttons' ? 'Click a button to add or remove that role.' : f.mode === 'select_single' ? 'Pick one role from the menu below.' : 'Pick any roles from the menu below — unselect to remove.';
  document.getElementById('rrpDesc').innerHTML = [
    f.description ? discordText(f.description) : '',
    lines.length ? lines.join('\n') : '<em>No roles added yet.</em>',
    `<span class="muted" style="font-size:0.78rem;">${hint}</span>`
  ]
    .filter(Boolean)
    .join('\n\n');
  const comps = document.getElementById('rrpComponents');
  if (!f.roles.length) {
    comps.innerHTML = '';
  } else if (f.mode === 'buttons') {
    comps.innerHTML = f.roles
      .map((r) => `<span class="mock-button">${r.emoji ? esc(r.emoji) + ' ' : ''}${esc(r.label || roleLabel(r.roleId).slice(1))}</span>`)
      .join('');
  } else {
    comps.innerHTML = `<div class="mock-select"><span>${f.mode === 'select_single' ? 'Choose a role' : 'Choose your roles'}</span><span>▾</span></div>`;
  }
}

async function savePanel() {
  const id = document.getElementById('rrId').value;
  const f = readPanelForm();
  if (!id && !f.channelId) return showToast('❌ Pick a channel.');
  if (!f.title) return showToast('❌ Give the panel a title.');
  if (!f.roles.length) return showToast('❌ Add at least one role.');
  const data = await withButton(
    document.getElementById('rrSaveBtn'),
    () => manageApi('POST', id ? `reactionroles/${id}` : 'reactionroles', f),
    id ? '✅ Panel updated.' : '🎭 Role panel posted!'
  );
  if (!data) return;
  closePanelEditor();
  loadPanels();
}

async function deletePanel(id) {
  const p = rrState.panels.find((x) => x.messageId === id);
  if (!confirm(`Delete the “${p ? p.title : 'role'}” panel and its message? Members keep the roles they already have.`)) return;
  const data = await withButton(null, () => manageApi('DELETE', `reactionroles/${id}`), '🗑️ Panel deleted.');
  if (data) loadPanels();
}

document.addEventListener('DOMContentLoaded', () => {
  if (!document.getElementById('tab-reactionroles')) return;
  ['rrChannel', 'rrTitle', 'rrDesc', 'rrColor'].forEach((id) => {
    const el = document.getElementById(id);
    el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', renderPanelPreview);
  });
  document.querySelectorAll('input[name="rrMode"]').forEach((r) => r.addEventListener('change', renderPanelPreview));
});

/* ------------------------------------------------------------------ Polls & reminders */

const pollState = { loaded: false };
const NUMBER_EMOJI = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

function initPolls() {
  pollState.loaded = true;
  const rows = document.getElementById('plOptionRows');
  if (!rows.children.length) {
    addPollOption();
    addPollOption();
  }
  loadPolls();
}

function addPollOption(value = '') {
  const rows = document.getElementById('plOptionRows');
  if (rows.children.length >= 10) return;
  const row = document.createElement('div');
  row.className = 'field-row poll-option-row';
  row.innerHTML = `<input class="pl-option" maxlength="100" value="${esc(value)}"><button class="btn secondary small" type="button" aria-label="Remove option">✕</button>`;
  row.querySelector('input').addEventListener('input', renderPollPreview);
  row.querySelector('button').addEventListener('click', () => {
    if (rows.children.length <= 2) return showToast('A poll needs at least 2 options.');
    row.remove();
    renumberPollOptions();
  });
  rows.appendChild(row);
  renumberPollOptions();
}

function renumberPollOptions() {
  const rows = [...document.querySelectorAll('.poll-option-row')];
  rows.forEach((row, i) => (row.querySelector('input').placeholder = `Option ${i + 1}`));
  document.getElementById('plAddOption').style.display = rows.length >= 10 ? 'none' : '';
  renderPollPreview();
}

function readPollForm() {
  return {
    channelId: document.getElementById('plChannel').value,
    question: document.getElementById('plQuestion').value.trim(),
    options: [...document.querySelectorAll('.pl-option')].map((el) => el.value.trim()).filter(Boolean),
    duration: document.getElementById('plDuration').value.trim(),
    anonymous: document.getElementById('plAnon').checked,
    multiple: document.getElementById('plMulti').checked
  };
}

const bar = (ratio, size = 14) => `${'█'.repeat(Math.round(ratio * size))}${'░'.repeat(size - Math.round(ratio * size))}`;

// Mirrors buildPollMessage() with no votes yet.
function renderPollPreview() {
  if (!document.getElementById('plpTitle')) return;
  const f = readPollForm();
  const opts = f.options.length ? f.options : ['Option 1', 'Option 2'];
  const ch = channels.find((c) => c.id === f.channelId);
  document.getElementById('plpChannel').textContent = `# ${ch ? ch.name : 'general'}`;
  document.getElementById('plpTitle').textContent = `📊 ${f.question || 'Your question'}`;
  const ms = parseDurationInput(f.duration);
  const status = ms ? `Closes ${fromNow(Date.now() + ms)}` : 'Open until closed with `/poll end`';
  document.getElementById('plpDesc').innerHTML = discordText(
    `${opts.map((o, i) => `${NUMBER_EMOJI[i]} **${o}**\n\`${bar(0)}\` 0 vote(s) · 0%`).join('\n\n')}\n\n${status}`
  );
  document.getElementById('plpFooter').textContent = `${f.anonymous ? '🕶️ Anonymous' : '👀 Public votes'} · ${f.multiple ? 'Multiple choice' : 'Single choice'} · 0 voter(s) · click again to remove your vote`;
  document.getElementById('plpButtons').innerHTML = opts.map((o, i) => `<span class="mock-button">${NUMBER_EMOJI[i]} ${esc(o.slice(0, 70))}</span>`).join('');
}

async function loadPolls() {
  try {
    const data = await manageApi('GET', 'polls');
    const render = (p) => {
      const total = p.counts.reduce((a, b) => a + b, 0);
      const max = Math.max(0, ...p.counts);
      const rows = p.options
        .map((o, i) => {
          const pct = total ? Math.round((p.counts[i] / total) * 100) : 0;
          return `<div class="poll-row"><span class="poll-opt">${NUMBER_EMOJI[i]} ${esc(o)}${p.ended && max > 0 && p.counts[i] === max ? ' 🏆' : ''}</span>
            <span class="poll-bar"><span style="width:${pct}%"></span></span><span class="poll-count">${p.counts[i]} · ${pct}%</span></div>`;
        })
        .join('');
      const when = p.ended ? 'closed' : p.endTimestamp ? `closes ${fromNow(p.endTimestamp)}` : 'open until closed';
      return `<div class="card item-card" style="align-items:flex-start;">
        <div class="item-icon">📊</div>
        <div class="item-main">
          <div class="item-title">${esc(p.question)}</div>
          <div class="item-meta">${esc(channelLabel(p.channelId))} · ${p.voters} voter${p.voters === 1 ? '' : 's'} · ${when}${p.anonymous ? ' · anonymous' : ''}${p.multipleChoice ? ' · multiple choice' : ''}</div>
          <div class="poll-rows">${rows}</div>
        </div>
        <div class="item-actions">
          <a class="btn secondary small" href="${esc(p.url)}" target="_blank" rel="noopener">Open ↗</a>
          ${p.ended ? '' : `<button class="btn secondary small" onclick="closePoll('${p.messageId}', this)">Close now</button>`}
        </div>
      </div>`;
    };
    document.getElementById('plOpenList').innerHTML = data.open.length ? data.open.map(render).join('') : emptyCard('📊', 'No open polls.');
    document.getElementById('plClosedList').innerHTML = data.closed.length ? data.closed.map(render).join('') : '<p class="muted" style="font-size:0.85rem;">Nothing yet.</p>';
    pollState.open = data.open.length;
    renderCommunityStatus();
  } catch (err) {
    document.getElementById('plOpenList').innerHTML = emptyCard('⚠️', esc(err.message));
  }
}

function renderCommunityStatus() {
  const el = document.getElementById('cmStatus');
  if (!el) return;
  el.innerHTML =
    `<span class="status-chip ${pollState.open ? 'good' : ''}"><span class="dot"></span>${pollState.open || 0} open poll${pollState.open === 1 ? '' : 's'}</span>` +
    `<span class="status-chip"><span class="dot"></span>${pollState.reminders || 0} scheduled reminder${pollState.reminders === 1 ? '' : 's'}</span>`;
}

async function postPoll() {
  const f = readPollForm();
  if (!f.channelId) return showToast('❌ Pick a channel.');
  if (!f.question) return showToast('❌ Enter a question.');
  if (new Set(f.options).size < 2) return showToast('❌ Give at least 2 different options.');
  if (f.duration && !parseDurationInput(f.duration)) return showToast('❌ Invalid duration — use e.g. 1h, 2d.');
  const data = await withButton(document.getElementById('plPostBtn'), () => manageApi('POST', 'polls', f), '📊 Poll posted!');
  if (!data) return;
  document.getElementById('plQuestion').value = '';
  document.getElementById('plOptionRows').innerHTML = '';
  addPollOption();
  addPollOption();
  loadPolls();
}

async function closePoll(id, btn) {
  if (!confirm('Close this poll now? Final results are shown in the message.')) return;
  const data = await withButton(btn, () => manageApi('POST', `polls/${id}/end`), '✅ Poll closed.');
  if (data) loadPolls();
}

async function loadReminders() {
  const list = document.getElementById('rmList');
  if (!list) return;
  try {
    const data = await manageApi('GET', 'reminders');
    pollState.reminders = data.reminders.length;
    renderCommunityStatus();
    list.innerHTML = data.reminders.length
      ? data.reminders
          .map(
            (r) => `<div class="card item-card">
              <div class="item-icon">⏰</div>
              <div class="item-main">
                <div class="item-title" style="white-space:pre-wrap;">${esc(r.message.length > 160 ? r.message.slice(0, 160) + '…' : r.message)}</div>
                <div class="item-meta">${esc(channelLabel(r.channelId))} · ${fromNow(r.remindAt)}${r.userName ? ` · by ${esc(r.userName)}` : ''}</div>
              </div>
              <div class="item-actions"><button class="btn danger small" onclick="cancelReminder('${r.id}', this)">Cancel</button></div>
            </div>`
          )
          .join('')
      : emptyCard('⏰', 'No channel reminders scheduled.');
  } catch (err) {
    list.innerHTML = emptyCard('⚠️', esc(err.message));
  }
}

async function scheduleReminder() {
  const body = {
    channelId: document.getElementById('rmChannel').value,
    in: document.getElementById('rmIn').value.trim(),
    message: document.getElementById('rmMessage').value.trim()
  };
  if (!body.channelId) return showToast('❌ Pick a channel.');
  if (!parseDurationInput(body.in)) return showToast('❌ Enter when — e.g. 30m, 2h, 1d.');
  if (!body.message) return showToast('❌ Enter the reminder text.');
  const data = await withButton(document.getElementById('rmSaveBtn'), () => manageApi('POST', 'reminders', body), `⏰ Reminder scheduled ${fromNow(Date.now() + parseDurationInput(body.in))}.`);
  if (!data) return;
  document.getElementById('rmMessage').value = '';
  document.getElementById('rmIn').value = '';
  loadReminders();
}

async function cancelReminder(id, btn) {
  if (!confirm('Cancel this reminder?')) return;
  const data = await withButton(btn, () => manageApi('DELETE', `reminders/${id}`), '🗑️ Reminder cancelled.');
  if (data) loadReminders();
}

document.addEventListener('DOMContentLoaded', () => {
  if (!document.getElementById('tab-community')) return;
  ['plChannel', 'plQuestion', 'plDuration', 'plAnon', 'plMulti'].forEach((id) => {
    const el = document.getElementById(id);
    el.addEventListener(el.tagName === 'SELECT' || el.type === 'checkbox' ? 'change' : 'input', renderPollPreview);
  });
});

/* ------------------------------------------------------------------ Moderation */

const ldScope = () => (document.querySelector('input[name="ldScope"]:checked') || {}).value || 'channel';

async function loadModeration() {
  const list = document.getElementById('ldLockedList');
  try {
    const data = await manageApi('GET', 'moderation');
    document.getElementById('modStatus').innerHTML = data.locked.length
      ? `<span class="status-chip off"><span class="dot"></span>${data.locked.length} channel${data.locked.length === 1 ? '' : 's'} locked</span>`
      : '<span class="status-chip good"><span class="dot"></span>No lockdowns</span>';
    list.innerHTML = data.locked.length
      ? data.locked
          .map((c) => `<div class="locked-row"><span>🔒 #${esc(c.name)}</span><button class="btn secondary small" onclick="runUnlock('${c.id}', this)">Unlock</button></div>`)
          .join('') +
        (data.locked.length > 1 ? `<div style="margin-top:0.6rem;"><button class="btn secondary small" onclick="runUnlock('all', this)">🔓 Lift all lockdowns</button></div>` : '')
      : '<p class="muted" style="margin:0; font-size:0.85rem;">Nothing is locked right now.</p>';
  } catch (err) {
    list.textContent = `❌ ${err.message}`;
  }
}

async function runLockdown() {
  const server = ldScope() === 'server';
  const channelId = server ? null : document.getElementById('ldChannel').value;
  if (!server && !channelId) return showToast('❌ Pick a channel to lock.');
  const reason = document.getElementById('ldReason').value.trim();
  if (!confirm(server ? 'Lock EVERY channel in the server? Only staff will be able to talk.' : `Lock ${channelLabel(channelId)}?`)) return;
  const data = await withButton(
    document.getElementById('ldLockBtn'),
    () => manageApi('POST', 'moderation/lockdown', { channelId, reason }),
    (d) => `🔒 Locked ${d.locked} channel${d.locked === 1 ? '' : 's'}${d.failed.length ? ` (${d.failed.length} failed — check permissions)` : ''}.`
  );
  if (data) loadModeration();
}

// runUnlock() uses the form; runUnlock(id) unlocks one listed channel; runUnlock('all') lifts everything.
async function runUnlock(target, btn) {
  let channelId;
  if (target === 'all') channelId = null;
  else if (target) channelId = target;
  else channelId = ldScope() === 'server' ? null : document.getElementById('ldChannel').value;
  if (target === undefined && ldScope() === 'channel' && !channelId) return showToast('❌ Pick a channel to unlock.');
  const data = await withButton(
    btn || document.getElementById('ldUnlockBtn'),
    () => manageApi('POST', 'moderation/unlock', { channelId }),
    (d) => (d.unlocked ? `🔓 Unlocked ${d.unlocked} channel${d.unlocked === 1 ? '' : 's'}.` : 'ℹ️ Nothing was locked there.')
  );
  if (data) loadModeration();
}

async function runPurge() {
  const channelId = document.getElementById('pgChannel').value;
  const count = Number(document.getElementById('pgCount').value);
  const userInput = document.getElementById('pgUser');
  if (!channelId) return showToast('❌ Pick a channel.');
  if (!(count >= 1 && count <= 100)) return showToast('❌ Count must be 1–100.');
  if (userInput.value.trim() && !userInput.dataset.userId) return showToast('❌ Pick the member from the list (or clear the box).');
  const who = userInput.dataset.userId ? ` from ${userInput.value}` : '';
  if (!confirm(`Delete the last ${count} message(s)${who} in ${channelLabel(channelId)}? This can't be undone.`)) return;
  await withButton(
    document.getElementById('pgBtn'),
    () => manageApi('POST', 'moderation/purge', { channelId, count, userId: userInput.dataset.userId || null }),
    (d) => (d.deleted ? `🧹 Deleted ${d.deleted} message(s)${d.skipped ? ` · ${d.skipped} older than 14 days skipped` : ''}.` : 'No matching messages found.')
  );
}

document.addEventListener('DOMContentLoaded', () => {
  if (!document.getElementById('tab-moderation')) return;
  const sync = () => {
    const server = ldScope() === 'server';
    document.getElementById('ldChannelRow').style.display = server ? 'none' : '';
    document.getElementById('ldLockBtn').textContent = server ? '🔒 Lock server' : '🔒 Lock channel';
    document.getElementById('ldUnlockBtn').textContent = server ? '🔓 Lift server lockdown' : '🔓 Unlock channel';
  };
  document.querySelectorAll('input[name="ldScope"]').forEach((r) => r.addEventListener('change', sync));
  sync();
});

/* ------------------------------------------------------------------ Media-only channels */

const moState = { rules: [] };

async function loadMediaOnly() {
  const list = document.getElementById('moList');
  if (!list) return;
  try {
    const data = await manageApi('GET', 'mediaonly');
    moState.rules = data.rules;
    list.innerHTML = data.rules.length
      ? data.rules
          .map((r) => {
            const bits = [r.allowLinks ? 'attachments or links' : 'attachments only', r.autoThread ? 'comment threads' : null, r.staffBypass ? 'staff exempt' : 'applies to staff'].filter(Boolean);
            return `<div class="locked-row">
              <span>📸 #${esc(r.name)} <span class="muted" style="font-size:0.8rem;">· ${bits.join(' · ')}</span>${r.missing.length ? ` <span class="status-chip off"><span class="dot"></span>Missing ${esc(r.missing.join(', '))}</span>` : ''}</span>
              <span class="item-actions">
                <button class="btn secondary small" onclick="editMediaOnly('${r.channelId}')">Edit</button>
                <button class="btn secondary small" onclick="removeMediaOnly('${r.channelId}', this)">Turn off</button>
              </span>
            </div>`;
          })
          .join('')
      : '<p class="muted" style="margin:0; font-size:0.85rem;">No media-only channels yet.</p>';
  } catch (err) {
    list.textContent = `❌ ${err.message}`;
  }
}

function editMediaOnly(channelId) {
  const r = moState.rules.find((x) => x.channelId === channelId);
  if (!r) return;
  document.getElementById('moChannel').value = r.channelId;
  document.getElementById('moLinks').checked = r.allowLinks;
  document.getElementById('moThread').checked = r.autoThread;
  document.getElementById('moStaff').checked = r.staffBypass;
  document.getElementById('moSaveBtn').textContent = 'Save changes';
  document.getElementById('moChannel').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function saveMediaOnly() {
  const channelId = document.getElementById('moChannel').value;
  if (!channelId) return showToast('❌ Pick a channel.');
  const data = await withButton(
    document.getElementById('moSaveBtn'),
    () =>
      manageApi('POST', 'mediaonly', {
        channelId,
        allowLinks: document.getElementById('moLinks').checked,
        autoThread: document.getElementById('moThread').checked,
        staffBypass: document.getElementById('moStaff').checked
      }),
    (d) => `📸 ${channelLabel(channelId)} is media-only.${d.missing.length ? ` ⚠️ LoofaryBot is missing ${d.missing.join(', ')} there.` : ''}`
  );
  if (!data) return;
  document.getElementById('moSaveBtn').textContent = 'Make media-only';
  loadMediaOnly();
}

async function removeMediaOnly(channelId, btn) {
  if (!confirm(`Turn off media-only in ${channelLabel(channelId)}?`)) return;
  const data = await withButton(btn, () => manageApi('DELETE', `mediaonly/${channelId}`), '✅ Media-only turned off.');
  if (data) loadMediaOnly();
}

/* ------------------------------------------------------------------ Member XP (leaderboard page) */

async function applyMemberXp() {
  const userInput = document.getElementById('mxUser');
  const action = document.getElementById('mxAction').value;
  const amount = Number(document.getElementById('mxAmount').value);
  if (!userInput.dataset.userId) return showToast('❌ Type a name and pick the member from the list.');
  if (action !== 'reset' && !(amount >= 1)) return showToast('❌ Enter an amount.');
  if (action === 'reset' && !confirm(`Reset ${userInput.value}'s XP and level to 0?`)) return;
  const data = await withButton(
    document.getElementById('mxBtn'),
    () => manageApi('POST', 'levels/member-xp', { userId: userInput.dataset.userId, action, amount }),
    (d) => `✅ ${userInput.value} now has ${Number(d.xp).toLocaleString()} XP (level ${d.level})${d.roleFailures ? ' — some role rewards could not be given' : ''}.`
  );
  if (data && typeof loadLeaderboard === 'function') loadLeaderboard();
}

document.addEventListener('DOMContentLoaded', () => {
  const action = document.getElementById('mxAction');
  if (!action) return;
  action.addEventListener('change', () => (document.getElementById('mxAmount').disabled = action.value === 'reset'));
});
