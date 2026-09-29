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
  if (method !== 'GET' && typeof markSaved === 'function') markSaved();
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
function attachMemberPicker(input, { onPick = null } = {}) {
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
    if (onPick) onPick(u);
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
    initCases();
    attachMemberPicker(document.getElementById('pgUser'));
  }
  if (tab === 'leaderboard') attachMemberPicker(document.getElementById('mxUser'));
  if (tab === 'leveling') loadChatDrops();
  if (tab === 'gambling') loadGambleStats();
  if (tab === 'engagement') loadEngagement();
  if (tab === 'tickets') {
    loadTickets();
    loadTicketHistory(tkState.page || 1);
  }
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
          ${g.entryCount ? `<button class="btn secondary small" onclick="openEntrants('${g.messageId}')">👥 ${isDrop ? 'Claims' : 'Entrants'}</button>` : ''}
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
  document.getElementById('gwBonusRow').style.display = isDrop ? 'none' : '';
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
  const type = from && from.type === 'drop' ? 'drop' : 'timed';
  document.querySelector(`input[name="gwType"][value="${type}"]`).checked = true;
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
  document.getElementById('gwEmoji').value = from && type !== 'drop' ? from.emoji || '' : '';
  // Show the saved text unless it's just the default (the placeholder already shows that).
  document.getElementById('gwDesc').value = from && from.customDesc && from.customDesc !== GW_DEFAULT_DESC[type] ? from.customDesc : '';
  const req = (from && from.requirements) || {};
  document.getElementById('gwReqRole').value = req.roleId && roles.some((r) => r.id === req.roleId) ? req.roleId : '';
  document.getElementById('gwReqDays').value = req.minDaysInServer || '';
  document.getElementById('gwReqLevel').value = req.minLevel || '';
  document.getElementById('gwBonusRows').innerHTML = '';
  ((from && from.bonusEntries) || []).filter((b) => roles.some((r) => r.id === b.roleId)).forEach((b) => addBonusRow(b));
  applyGiveawayTypeUi();
  editor.scrollIntoView({ behavior: 'smooth', block: 'start' });
  document.getElementById(g ? 'gwPrize' : 'gwDuration').focus({ preventScroll: true });
}

function closeGiveawayEditor() {
  document.getElementById('gwEditor').style.display = 'none';
  document.getElementById('gwId').value = '';
  if (typeof markSaved === 'function') markSaved(); // closing an editor discards its edits
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
    },
    bonusEntries: [...document.querySelectorAll('.gw-bonus-row')]
      .map((row) => ({ roleId: row.querySelector('.gb-role').value, extra: row.querySelector('.gb-extra').value }))
      .filter((b) => b.roleId && Number(b.extra) > 0)
  };
}

function addBonusRow(b = { roleId: '', extra: 1 }) {
  const rows = document.getElementById('gwBonusRows');
  if (rows.children.length >= 5) return showToast('Up to 5 bonus roles.');
  const row = document.createElement('div');
  row.className = 'field-row gw-bonus-row';
  row.innerHTML = `
    <select class="gb-role" aria-label="Bonus role"><option value="">— Pick a role —</option>${roles.map((r) => `<option value="${r.id}" ${r.id === b.roleId ? 'selected' : ''}>@${esc(r.name)}</option>`).join('')}</select>
    <input type="number" class="gb-extra" min="1" max="10" value="${esc(b.extra || 1)}" style="flex:0 0 110px;" aria-label="Extra entries" title="Extra entries">
    <button class="btn secondary small" type="button" aria-label="Remove bonus role">✕</button>`;
  row.querySelector('button').addEventListener('click', () => {
    row.remove();
    renderGiveawayPreview();
  });
  row.querySelectorAll('select, input').forEach((el) => el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', renderGiveawayPreview));
  rows.appendChild(row);
  renderGiveawayPreview();
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
  // Same as the real embed: role bonuses, plus the booster perk saved on the giveaway (or the server's current one for new giveaways).
  const boosterExtra = isDrop ? 0 : editing && typeof editing.boosterEntries === 'number' ? editing.boosterEntries : typeof boosterGiveawayEntries === 'number' ? boosterGiveawayEntries : 0;
  const bonusParts = [...(!isDrop ? f.bonusEntries.map((b) => `<@&${b.roleId}> +${Number(b.extra)}`) : []), ...(boosterExtra > 0 ? [`💎 Server boosters +${boosterExtra}`] : [])];
  const reqText = (reqs.length ? `\n\n**Requirements:**\n${reqs.join('\n')}` : '') + (bonusParts.length ? `\n\n**Bonus entries:** ${bonusParts.join(' · ')}` : '');
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

const entrantState = { id: null, list: [] };

async function openEntrants(id) {
  const g = [...gwState.running, ...gwState.ended].find((x) => x.messageId === id);
  entrantState.id = id;
  entrantState.ended = g ? g.ended : true;
  document.getElementById('gwEntrantsTitle').textContent = `👥 ${g ? g.prize : 'Entrants'}`;
  document.getElementById('gwEntrantsSearch').value = '';
  document.getElementById('gwEntrantsList').innerHTML = '<p class="muted">Loading…</p>';
  document.getElementById('gwEntrantsDialog').showModal();
  try {
    const data = await manageApi('GET', `giveaways/${id}/entrants`);
    entrantState.list = data.entrants;
    document.getElementById('gwEntrantsSummary').textContent =
      `${data.total} ${data.total === 1 ? 'person' : 'people'}${data.tickets !== data.total ? ` · ${data.tickets} tickets with bonuses` : ''}`;
    renderEntrants();
  } catch (err) {
    document.getElementById('gwEntrantsList').innerHTML = `<p class="muted">❌ ${esc(err.message)}</p>`;
  }
}

function renderEntrants() {
  const q = document.getElementById('gwEntrantsSearch').value.trim().toLowerCase();
  const list = entrantState.list.filter((e) => !q || `${e.name || ''} ${e.username || ''} ${e.id}`.toLowerCase().includes(q));
  document.getElementById('gwEntrantsList').innerHTML = list.length
    ? list
        .map(
          (e) => `<div class="entrant-row">
            ${e.avatarUrl ? `<img src="${esc(e.avatarUrl)}" alt="">` : '<span class="entrant-avatar"></span>'}
            <div style="flex:1; min-width:0;"><strong>${esc(e.name || 'Left the server')}</strong> <span class="muted" style="font-size:0.78rem;">${esc(e.username ? '@' + e.username : e.id)}</span></div>
            ${e.won ? '<span class="status-chip good"><span class="dot"></span>Winner</span>' : ''}
            ${e.tickets > 1 ? `<span class="status-chip"><span class="dot"></span>${e.tickets} tickets</span>` : ''}
            ${entrantState.ended ? '' : `<button class="btn secondary small" onclick="removeEntrant('${e.id}', this)">Remove</button>`}
          </div>`
        )
        .join('')
    : '<p class="muted">Nobody matches.</p>';
}

async function removeEntrant(userId, btn) {
  const e = entrantState.list.find((x) => x.id === userId);
  if (!confirm(`Remove ${e && e.name ? e.name : userId} from this giveaway? They can enter again unless requirements stop them.`)) return;
  const data = await withButton(btn, () => manageApi('DELETE', `giveaways/${entrantState.id}/entrants/${userId}`), '👋 Entrant removed.');
  if (!data) return;
  entrantState.list = entrantState.list.filter((x) => x.id !== userId);
  renderEntrants();
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
  document.getElementById('gwEntrantsSearch').addEventListener('input', renderEntrants);
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
      .filter((r) => !r.managed)
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
  if (typeof markSaved === 'function') markSaved(); // closing an editor discards its edits
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

/* ------------------------------------------------------------------ Moderation cases */

const CASE_TYPES = {
  warn: { label: 'Warning', emoji: '⚠️', tone: 'warn' },
  timeout: { label: 'Timeout', emoji: '⏳', tone: 'warn' },
  untimeout: { label: 'Timeout removed', emoji: '🔊', tone: 'good' },
  kick: { label: 'Kick', emoji: '👢', tone: 'off' },
  ban: { label: 'Ban', emoji: '🔨', tone: 'off' },
  unban: { label: 'Unban', emoji: '🕊️', tone: 'good' }
};
const caseState = { page: 1, init: false, cases: [] };

function fmtDuration(ms) {
  const parts = [];
  let s = Math.round(ms / 1000);
  for (const [l, n] of [['d', 86400], ['h', 3600], ['m', 60], ['s', 1]]) {
    const v = Math.floor(s / n);
    if (v) parts.push(`${v}${l}`);
    s -= v * n;
  }
  return parts.join(' ') || '0s';
}

// A picked member, or a pasted user ID (for banning people who already left, or unbanning).
function pickedUserId(input) {
  if (input.dataset.userId) return input.dataset.userId;
  const raw = input.value.trim().replace(/[<@!>]/g, '');
  return /^\d{5,25}$/.test(raw) ? raw : null;
}

function initCases() {
  if (!document.getElementById('csList')) return;
  if (!caseState.init) {
    caseState.init = true;
    attachMemberPicker(document.getElementById('csUser'));
    attachMemberPicker(document.getElementById('csFilterUser'), { onPick: () => loadCases(1) });
    document.getElementById('csFilterType').addEventListener('change', () => loadCases(1));
    document.getElementById('csType').addEventListener('change', syncCaseForm);
    syncCaseForm();
  }
  loadCases(caseState.page);
}

function syncCaseForm() {
  const type = document.getElementById('csType').value;
  const dur = document.getElementById('csDuration');
  dur.style.display = type === 'timeout' || type === 'ban' ? '' : 'none';
  dur.placeholder = type === 'ban' ? 'Temp ban? e.g. 7d (empty = permanent)' : 'Duration, e.g. 10m, 1h, 1d';
  document.getElementById('csDelete').style.display = type === 'ban' ? '' : 'none';
  const btn = document.getElementById('csBtn');
  btn.textContent = { warn: 'Warn', timeout: 'Time out', untimeout: 'Remove timeout', kick: 'Kick', ban: 'Ban', unban: 'Unban' }[type];
  btn.classList.toggle('danger', ['kick', 'ban'].includes(type));
  document.getElementById('csHint').textContent =
    type === 'unban' ? 'Paste the user ID of someone who is banned (right-click them → Copy User ID).' : type === 'ban' ? 'You can ban people who already left by pasting their user ID.' : '';
}

async function loadCases(page = 1) {
  const list = document.getElementById('csList');
  if (!list) return;
  const params = new URLSearchParams({ page: Math.max(1, page) });
  const userId = pickedUserId(document.getElementById('csFilterUser'));
  if (userId) params.set('user', userId);
  const type = document.getElementById('csFilterType').value;
  if (type) params.set('type', type);
  try {
    const data = await manageApi('GET', `cases?${params}`);
    caseState.page = data.page;
    caseState.cases = data.cases;
    caseState.settings = data.settings;
    renderEscalation(data.settings);
    document.getElementById('csSummary').textContent = userId
      ? `${data.total} case${data.total === 1 ? '' : 's'} · ${data.activeWarnings} active warning${data.activeWarnings === 1 ? '' : 's'}`
      : `${data.total} case${data.total === 1 ? '' : 's'} in total`;
    document.getElementById('csPage').textContent = `Page ${data.page} / ${data.totalPages}`;
    document.getElementById('csPrev').disabled = data.page <= 1;
    document.getElementById('csNext').disabled = data.page >= data.totalPages;
    list.innerHTML = data.cases.length
      ? data.cases
          .map((c) => {
            const t = CASE_TYPES[c.type];
            const extras = [c.durationMs ? fmtDuration(c.durationMs) : '', c.auto ? 'automatic' : '', c.type === 'warn' && !c.active ? 'revoked' : '', c.expiresAt && c.active ? `ends ${fromNow(new Date(c.expiresAt).getTime())}` : '']
              .filter(Boolean)
              .join(' · ');
            return `<div class="case-row ${c.type === 'warn' && !c.active ? 'revoked' : ''}">
              <span class="case-id">#${c.caseId}</span>
              <span class="status-chip ${t.tone}"><span class="dot"></span>${t.emoji} ${t.label}</span>
              <div class="case-main">
                <div><strong>${esc(c.userName || c.userTag || c.userId)}</strong> <span class="muted" style="font-size:0.78rem;">${esc(c.userTag || '')}</span>${extras ? ` <span class="muted" style="font-size:0.78rem;">· ${esc(extras)}</span>` : ''}</div>
                <div class="muted" style="font-size:0.82rem;">${esc(c.reason || 'No reason given')} — ${esc(c.moderatorTag || 'LoofaryBot')} · ${fromNow(new Date(c.createdAt).getTime())}</div>
              </div>
              <span class="item-actions">
                ${c.type === 'warn' && c.active ? `<button class="btn secondary small" onclick="revokeCaseRow(${c.caseId}, this)">Revoke</button>` : ''}
                <button class="btn secondary small" onclick="editCaseReason(${c.caseId})">Edit reason</button>
                <button class="btn secondary small" title="Show this member's cases" onclick="filterCasesBy('${c.userId}', ${JSON.stringify(esc(c.userName || c.userTag || c.userId)).replace(/"/g, '&quot;')})">History</button>
                <button class="btn danger small" onclick="deleteCaseRow(${c.caseId})">Delete</button>
              </span>
            </div>`;
          })
          .join('')
      : '<p class="muted" style="margin:0;">No cases match.</p>';
  } catch (err) {
    list.textContent = `❌ ${err.message}`;
  }
}

function filterCasesBy(userId, name) {
  const input = document.getElementById('csFilterUser');
  input.value = name;
  input.dataset.userId = userId;
  loadCases(1);
  input.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function clearCaseFilter() {
  const input = document.getElementById('csFilterUser');
  input.value = '';
  delete input.dataset.userId;
  document.getElementById('csFilterType').value = '';
  loadCases(1);
}

async function runCaseAction() {
  const type = document.getElementById('csType').value;
  const input = document.getElementById('csUser');
  const userId = pickedUserId(input);
  if (!userId) return showToast('❌ Pick a member from the list, or paste a user ID.');
  const reason = document.getElementById('csReason').value.trim();
  if (type === 'warn' && !reason) return showToast('❌ Give a reason for the warning.');
  const duration = document.getElementById('csDuration').value.trim();
  if (type === 'timeout' && !parseDurationInput(duration)) return showToast('❌ Give a timeout length, e.g. 10m, 1h, 1d.');
  if (duration && ['timeout', 'ban'].includes(type) && !parseDurationInput(duration)) return showToast('❌ Invalid duration.');
  const who = input.value.trim() || userId;
  const verb = { kick: 'Kick', ban: duration ? `Ban (for ${duration})` : 'Permanently ban' }[type];
  if (verb && !confirm(`${verb} ${who}?`)) return;
  const data = await withButton(
    document.getElementById('csBtn'),
    () => manageApi('POST', 'cases/action', { type, userId, reason, duration, deleteMessageSeconds: document.getElementById('csDelete').value }),
    (d) => {
      let msg = `✅ Case #${d.case.caseId}: ${CASE_TYPES[type].label.toLowerCase()} — ${d.case.userTag}`;
      if (['warn', 'timeout', 'kick', 'ban'].includes(type)) msg += d.dmSent ? ' · DM sent' : ' · DM not delivered';
      if (d.escalated) msg += d.escalated.error ? ` · ⚠️ escalation failed: ${d.escalated.error}` : ` · 🔺 auto ${CASE_TYPES[d.escalated.case.type].label.toLowerCase()} (case #${d.escalated.case.caseId})`;
      return msg;
    }
  );
  if (!data) return;
  document.getElementById('csReason').value = '';
  document.getElementById('csDuration').value = '';
  loadCases(1);
}

async function revokeCaseRow(id, btn) {
  if (!confirm(`Revoke warning #${id}? It stays on record but no longer counts toward escalation.`)) return;
  const data = await withButton(btn, () => manageApi('POST', `cases/${id}/revoke`), `↩️ Warning #${id} revoked.`);
  if (data) loadCases(caseState.page);
}

async function editCaseReason(id) {
  const c = caseState.cases.find((x) => x.caseId === id);
  const reason = prompt(`New reason for case #${id}:`, c ? c.reason : '');
  if (reason === null) return;
  const data = await withButton(null, () => manageApi('POST', `cases/${id}/reason`, { reason }), `✏️ Case #${id} updated.`);
  if (data) loadCases(caseState.page);
}

async function deleteCaseRow(id) {
  if (!confirm(`Delete case #${id} from the record? This doesn't undo the action itself.`)) return;
  const data = await withButton(null, () => manageApi('DELETE', `cases/${id}`), `🗑️ Case #${id} deleted.`);
  if (data) loadCases(caseState.page);
}

function escalationRow(r = { count: '', action: 'timeout', durationMs: null }) {
  const row = document.createElement('div');
  row.className = 'field-row esc-row';
  row.innerHTML = `
    <input type="number" class="esc-count" min="1" max="50" placeholder="Warnings" value="${esc(r.count)}" style="flex:0 0 110px;" aria-label="Warnings">
    <select class="esc-action" aria-label="Action">
      <option value="timeout" ${r.action === 'timeout' ? 'selected' : ''}>⏳ Timeout</option>
      <option value="kick" ${r.action === 'kick' ? 'selected' : ''}>👢 Kick</option>
      <option value="ban" ${r.action === 'ban' ? 'selected' : ''}>🔨 Ban</option>
    </select>
    <input class="esc-duration" placeholder="Duration (e.g. 1h)" value="${r.durationMs ? fmtDuration(r.durationMs).replace(/ /g, '') : ''}" aria-label="Duration">
    <button class="btn secondary small" type="button" aria-label="Remove rule">✕</button>`;
  const sync = () => {
    const a = row.querySelector('.esc-action').value;
    const d = row.querySelector('.esc-duration');
    d.style.display = a === 'kick' ? 'none' : '';
    d.placeholder = a === 'ban' ? 'Temp ban (empty = permanent)' : 'Duration (e.g. 1h)';
  };
  row.querySelector('.esc-action').addEventListener('change', sync);
  row.querySelector('button').addEventListener('click', () => row.remove());
  sync();
  return row;
}

function renderEscalation(settings) {
  const rows = document.getElementById('escRows');
  if (!rows || !settings || rows.dataset.loaded) return;
  rows.dataset.loaded = '1';
  rows.innerHTML = '';
  settings.escalation.forEach((r) => rows.appendChild(escalationRow(r)));
  if (!settings.escalation.length) rows.innerHTML = '<p class="muted esc-empty" style="margin:0; font-size:0.84rem;">No rules yet — e.g. 3 warnings → 1h timeout, 5 → kick.</p>';
  document.getElementById('escDm').checked = settings.dmEnabled;
}

function addEscalationRow() {
  const rows = document.getElementById('escRows');
  rows.querySelector('.esc-empty')?.remove();
  rows.appendChild(escalationRow());
}

async function saveEscalation() {
  const escalation = [...document.querySelectorAll('.esc-row')]
    .map((row) => ({
      count: row.querySelector('.esc-count').value,
      action: row.querySelector('.esc-action').value,
      duration: row.querySelector('.esc-action').value === 'kick' ? '' : row.querySelector('.esc-duration').value.trim()
    }))
    .filter((r) => r.count);
  await withButton(
    document.getElementById('escSaveBtn'),
    () => manageApi('POST', 'cases/settings', { escalation, dmEnabled: document.getElementById('escDm').checked }),
    (d) => `✅ Saved ${d.escalation.length} escalation rule${d.escalation.length === 1 ? '' : 's'}.`
  );
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

/* ------------------------------------------------------------------ Tickets */

const tkState = { loaded: false, settings: null, open: [], history: [], page: 1, searchTimer: null };
const TK_STYLE_CLASS = { Primary: 'primary', Success: 'success', Secondary: 'secondary', Danger: 'danger' };

async function loadTickets() {
  const list = document.getElementById('tkOpenList');
  if (!list) return;
  let data;
  try {
    data = await manageApi('GET', 'tickets');
  } catch (err) {
    list.innerHTML = emptyCard('⚠️', esc(err.message));
    return;
  }
  tkState.open = data.open;
  const st = data.stats;
  document.getElementById('tkStatus').innerHTML = [
    `<span class="status-chip ${st.open ? 'warn' : 'good'}"><span class="dot"></span>${st.open} open</span>`,
    st.open ? `<span class="status-chip ${st.unclaimed ? 'warn' : ''}"><span class="dot"></span>${st.unclaimed} unclaimed</span>` : '',
    `<span class="status-chip"><span class="dot"></span>${st.week} this week</span>`,
    `<span class="status-chip"><span class="dot"></span>${st.closed} closed in total</span>`,
    data.panelUrl ? '' : '<span class="status-chip warn"><span class="dot"></span>No panel posted yet</span>'
  ].join('');
  const warn = document.getElementById('tkPermWarn');
  warn.style.display = data.missingPerms.length ? '' : 'none';
  warn.innerHTML = data.missingPerms.length
    ? `⚠️ LoofaryBot can't create ticket channels yet — give its role <strong>${data.missingPerms.map(esc).join(', ')}</strong>${data.settings.categoryId ? ' (in the ticket category too)' : ''}.`
    : '';
  const link = document.getElementById('tkPanelLink');
  link.style.display = data.panelUrl ? '' : 'none';
  if (data.panelUrl) link.href = data.panelUrl;
  document.getElementById('tkPublishBtn').textContent = data.panelUrl ? 'Save & update panel' : 'Save & post panel';

  const cat = document.getElementById('tkCategory');
  const keep = cat.value || data.settings.categoryId || '';
  cat.innerHTML =
    '<option value="">No category (top of the list)</option>' +
    data.categories.map((c) => `<option value="${c.id}">${esc(c.name)} (${c.children}/50)</option>`).join('');
  cat.value = keep;
  if (!tkState.loaded) fillTicketForm(data.settings);
  tkState.loaded = true;
  renderOpenTickets();
}

function renderOpenTickets() {
  const list = document.getElementById('tkOpenList');
  document.getElementById('tkOpenSummary').textContent = tkState.open.length
    ? `${tkState.open.length} open ticket${tkState.open.length === 1 ? '' : 's'}`
    : '';
  if (!tkState.open.length) {
    list.innerHTML = emptyCard('✨', 'No open tickets. New ones show up here as members open them.');
    return;
  }
  list.innerHTML = tkState.open
    .map(
      (t) => `<div class="card item-card">
        <span class="ticket-num">#${t.number}</span>
        <div class="item-main">
          <div class="item-title">${esc(t.openerName)} <span class="muted" style="font-size:0.78rem; font-weight:400;">${esc(t.openerTag || '')}</span>
            ${t.claimedBy ? `<span class="status-chip good"><span class="dot"></span>📌 ${esc(t.claimedByName)}</span>` : '<span class="status-chip warn"><span class="dot"></span>Unclaimed</span>'}
            ${t.channelExists ? '' : '<span class="status-chip off"><span class="dot"></span>Channel missing</span>'}</div>
          <div class="item-meta">Opened ${fromNow(new Date(t.createdAt).getTime())}${t.reason ? ` · ${esc(t.reason.slice(0, 140))}` : ''}</div>
        </div>
        <span class="item-actions">
          <a class="btn secondary small" href="${t.channelUrl}" target="_blank" rel="noopener">Jump ↗</a>
          <button class="btn danger small" onclick="closeTicketRow('${t.id}', this)">Close</button>
        </span>
      </div>`
    )
    .join('');
}

async function closeTicketRow(id, btn) {
  const t = tkState.open.find((x) => x.id === id);
  const reason = prompt(`Close ticket #${t ? t.number : ''}? Reason (optional — sent to the member):`, '');
  if (reason === null) return;
  const data = await withButton(btn, () => manageApi('POST', `tickets/${id}/close`, { reason }), (d) => `🔒 Ticket #${d.ticket.number} closed${d.dmSent ? ' — the member was sent a DM' : ''}.`);
  if (data) {
    loadTickets();
    loadTicketHistory(1);
  }
}

function fillTicketForm(s) {
  tkState.settings = s;
  const v = (id, val) => (document.getElementById(id).value = val ?? '');
  const c = (id, val) => (document.getElementById(id).checked = !!val);
  v('tkPanelChannel', s.panelChannelId || '');
  v('tkCategory', s.categoryId || '');
  document.querySelectorAll('.tk-role').forEach((el) => (el.checked = s.supportRoleIds.includes(el.value)));
  v('tkNameFormat', s.nameFormat);
  v('tkMaxOpen', s.maxOpenPerUser);
  c('tkAskReason', s.askReason);
  c('tkPingSupport', s.pingSupport);
  c('tkLockPanel', s.lockPanelChannel);
  c('tkLockCategory', s.lockCategory);
  v('tkWelcome', s.welcomeMessage);
  v('tkTitle', s.panel.title);
  v('tkDesc', s.panel.description);
  v('tkColor', /^#[0-9a-f]{6}$/i.test(s.panel.color) ? s.panel.color : '#5865F2');
  v('tkThumb', s.panel.thumbnailUrl);
  v('tkImage', s.panel.imageUrl);
  v('tkFooter', s.panel.footer);
  v('tkBtnLabel', s.button.label);
  v('tkBtnStyle', s.button.style);
  v('tkBtnEmoji', s.button.emoji);
  c('tkDm', s.dmOnClose);
  v('tkDelay', s.closeDelaySeconds);
  c('tkTranscripts', s.saveTranscripts);
  v('tkLogChannel', s.logChannelId || '');
  renderTicketPreview();
}

function readTicketForm() {
  const v = (id) => document.getElementById(id).value;
  const c = (id) => document.getElementById(id).checked;
  return {
    panelChannelId: v('tkPanelChannel') || null,
    categoryId: v('tkCategory') || null,
    supportRoleIds: [...document.querySelectorAll('.tk-role:checked')].map((el) => el.value),
    nameFormat: v('tkNameFormat').trim() || 'ticket-{number}',
    maxOpenPerUser: v('tkMaxOpen') === '' ? 1 : Number(v('tkMaxOpen')),
    askReason: c('tkAskReason'),
    pingSupport: c('tkPingSupport'),
    lockPanelChannel: c('tkLockPanel'),
    lockCategory: c('tkLockCategory'),
    welcomeMessage: v('tkWelcome'),
    panel: { title: v('tkTitle'), description: v('tkDesc'), color: v('tkColor'), thumbnailUrl: v('tkThumb').trim(), imageUrl: v('tkImage').trim(), footer: v('tkFooter') },
    button: { label: v('tkBtnLabel'), style: v('tkBtnStyle'), emoji: v('tkBtnEmoji').trim() },
    dmOnClose: c('tkDm'),
    closeDelaySeconds: v('tkDelay') === '' ? 5 : Number(v('tkDelay')),
    saveTranscripts: c('tkTranscripts'),
    logChannelId: v('tkLogChannel') || null
  };
}

function ticketNameExample(format) {
  const name = (typeof viewer !== 'undefined' && viewer.username) || 'member';
  return (format || 'ticket-{number}')
    .toLowerCase()
    .replace(/\{number\}/g, '0001')
    .replace(/\{username\}/g, name.toLowerCase().replace(/[^a-z0-9_-]+/g, ''))
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '');
}

function renderTicketPreview() {
  const f = readTicketForm();
  document.getElementById('tkpChannel').textContent = f.panelChannelId ? channelLabel(f.panelChannelId) : '# support';
  document.getElementById('tkpEmbed').style.borderLeftColor = f.panel.color;
  document.getElementById('tkpTitle').textContent = f.panel.title || '🎫 Need help?';
  document.getElementById('tkpDesc').innerHTML = discordText(f.panel.description);
  const img = (id, url) => {
    const el = document.getElementById(id);
    el.style.display = /^https?:\/\//i.test(url) ? '' : 'none';
    if (/^https?:\/\//i.test(url)) el.src = url;
  };
  img('tkpThumb', f.panel.thumbnailUrl);
  img('tkpImage', f.panel.imageUrl);
  document.getElementById('tkpFooter').textContent = f.panel.footer || '';
  const btn = document.getElementById('tkpButton');
  btn.className = `mock-button ${TK_STYLE_CLASS[f.button.style] || 'primary'}`;
  btn.textContent = `${f.button.emoji ? `${f.button.emoji} ` : ''}${f.button.label || 'Open a ticket'}`;
  document.getElementById('tkNameExample').textContent = ticketNameExample(f.nameFormat);
}

async function saveTicketSettings(publish) {
  const body = readTicketForm();
  if (publish && !body.panelChannelId) return showToast('❌ Pick a panel channel first.');
  const data = await withButton(document.getElementById(publish ? 'tkPublishBtn' : null), () => manageApi('POST', 'tickets/settings', { ...body, publish }), publish ? '✅ Saved — the panel is live.' : '✅ Ticket settings saved.');
  if (data) {
    tkState.settings = data.settings;
    if (data.warnings?.length) showToast(`⚠️ ${data.warnings[0]}`);
    loadTickets();
  }
}

async function loadTicketHistory(page = 1) {
  const list = document.getElementById('tkHistList');
  if (!list) return;
  const q = document.getElementById('tkSearch').value.trim();
  let data;
  try {
    data = await manageApi('GET', `tickets/history?page=${Math.max(1, page)}&q=${encodeURIComponent(q)}`);
  } catch (err) {
    list.innerHTML = emptyCard('⚠️', esc(err.message));
    return;
  }
  tkState.page = data.page;
  tkState.history = data.tickets;
  document.getElementById('tkHistSummary').textContent = `${data.total} closed ticket${data.total === 1 ? '' : 's'}${q ? ` matching “${q}”` : ''}`;
  document.getElementById('tkPage').textContent = `Page ${data.page} / ${data.totalPages}`;
  document.getElementById('tkPrev').disabled = data.page <= 1;
  document.getElementById('tkNext').disabled = data.page >= data.totalPages;
  list.innerHTML = data.tickets.length
    ? data.tickets
        .map((t) => {
          const openFor = t.closedAt ? Math.max(0, new Date(t.closedAt) - new Date(t.createdAt)) : 0;
          return `<div class="card item-card">
            <span class="ticket-num">#${t.number}</span>
            <div class="item-main">
              <div class="item-title">${esc(t.openerName)} <span class="muted" style="font-size:0.78rem; font-weight:400;">${esc(t.openerTag || '')}</span></div>
              <div class="item-meta">Closed ${t.closedAt ? fromNow(new Date(t.closedAt).getTime()) : ''} by ${esc(t.closedByName || 'the system')}${t.claimedByName ? ` · handled by ${esc(t.claimedByName)}` : ''} · open ${fmtDuration(openFor) || 'under a minute'}</div>
              <div class="item-meta">${t.reason ? `Opened for: ${esc(t.reason.slice(0, 120))}` : ''}${t.reason && t.closeReason ? ' · ' : ''}${t.closeReason ? `Closed: ${esc(t.closeReason.slice(0, 120))}` : ''}</div>
            </div>
            <span class="item-actions">
              <button class="btn secondary small" onclick="openTranscript('${t.id}')" ${t.messageCount ? '' : 'disabled title="No transcript saved"'}>📜 Transcript${t.messageCount ? ` (${t.messageCount})` : ''}</button>
            </span>
          </div>`;
        })
        .join('')
    : emptyCard('🗂️', q ? 'No closed tickets match that search.' : 'Closed tickets show up here with their transcripts.');
}

async function openTranscript(id) {
  const data = await withButton(null, () => manageApi('GET', `tickets/${id}`));
  if (!data) return;
  const t = data.ticket;
  document.getElementById('tkTranscriptTitle').textContent = `Ticket #${t.number} — ${t.openerName}`;
  document.getElementById('tkTranscriptMeta').textContent =
    `Opened ${new Date(t.createdAt).toLocaleString()} · closed ${t.closedAt ? new Date(t.closedAt).toLocaleString() : '—'} by ${t.closedByName || 'the system'}${t.closeReason ? ` — ${t.closeReason}` : ''}`;
  document.getElementById('tkTranscriptBody').innerHTML = data.transcript.length
    ? data.transcript
        .map(
          (l) => `<div class="transcript-line">
            <span class="who ${l.bot ? 'bot' : ''}">${esc(l.authorTag || l.authorId)}${l.bot ? ' <span class="discord-bot-badge">BOT</span>' : ''}</span>
            <span class="when">${new Date(l.at).toLocaleString()}</span>
            <div class="text">${esc(l.content || '')}</div>
            ${l.attachments?.length ? `<div class="files">${l.attachments.map((u, i) => `<a href="${esc(u)}" target="_blank" rel="noopener">📎 file ${i + 1}</a>`).join('')}</div>` : ''}
          </div>`
        )
        .join('')
    : emptyCard('📜', 'No messages were saved for this ticket.');
  document.getElementById('tkTranscriptDownload').onclick = () => {
    const text = [
      `Ticket #${t.number} — ${t.openerTag || t.openerName}`,
      t.reason ? `Reason: ${t.reason}` : null,
      `Closed by ${t.closedByName || 'the system'}${t.closeReason ? ` — ${t.closeReason}` : ''}`,
      '-'.repeat(60),
      ...data.transcript.map((l) => `[${new Date(l.at).toISOString().replace('T', ' ').slice(0, 19)}] ${l.authorTag}${l.bot ? ' [BOT]' : ''}: ${l.content || ''}${l.attachments?.length ? ` ${l.attachments.join(' ')}` : ''}`)
    ]
      .filter((x) => x !== null)
      .join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    a.download = `ticket-${t.number}.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  document.getElementById('tkTranscriptDialog').showModal();
}

(function initTicketUi() {
  const panel = document.getElementById('tab-tickets');
  if (!panel) return;
  panel.querySelectorAll('input, textarea, select').forEach((el) => {
    if (el.id === 'tkSearch' || el.id === 'tkRoleSearch') return;
    el.addEventListener('input', renderTicketPreview);
    el.addEventListener('change', renderTicketPreview);
  });
  panel.querySelectorAll('[data-tk-format]').forEach((b) =>
    b.addEventListener('click', () => {
      document.getElementById('tkNameFormat').value = b.dataset.tkFormat;
      renderTicketPreview();
    })
  );
  document.getElementById('tkRoleSearch').addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    panel.querySelectorAll('#tkRoles .check-pill').forEach((p) => (p.style.display = !q || p.dataset.name.includes(q) ? '' : 'none'));
  });
  document.getElementById('tkSearch').addEventListener('input', () => {
    clearTimeout(tkState.searchTimer);
    tkState.searchTimer = setTimeout(() => loadTicketHistory(1), 300);
  });
})();

/* ------------------------------------------------------------------ Chat drops (Leveling tab) */

function readChatDrops() {
  const n = (id) => document.getElementById(id).value;
  return {
    enabled: document.getElementById('cdEnabled').checked,
    channelIds: [...document.querySelectorAll('.cd-channel:checked')].map((el) => el.value),
    minXp: n('cdMinXp'),
    maxXp: n('cdMaxXp'),
    minMinutes: n('cdMinMin'),
    maxMinutes: n('cdMaxMin'),
    minActivity: n('cdActivity'),
    claimSeconds: n('cdClaim')
  };
}

async function loadChatDrops() {
  const status = document.getElementById('cdStatus');
  if (!status) return;
  let data;
  try {
    data = await manageApi('GET', 'levels/chatdrops');
  } catch (err) {
    status.textContent = `⚠️ ${err.message}`;
    return;
  }
  const s = data.settings;
  // Fill the form from the live settings once (they may have changed via /xpdrop since the page loaded).
  if (!loadChatDrops.filled) {
    loadChatDrops.filled = true;
    document.getElementById('cdEnabled').checked = s.enabled;
    document.querySelectorAll('.cd-channel').forEach((el) => (el.checked = s.channelIds.includes(el.value)));
    for (const [id, v] of [['cdMinXp', s.minXp], ['cdMaxXp', s.maxXp], ['cdMinMin', s.minMinutes], ['cdMaxMin', s.maxMinutes], ['cdActivity', s.minActivity], ['cdClaim', s.claimSeconds]]) {
      document.getElementById(id).value = v;
    }
  }
  const active = Object.entries(data.activity || {})
    .map(([id, count]) => `${esc(channelLabel(id))}: ${count} msg${count === 1 ? '' : 's'}`)
    .join(' · ');
  status.innerHTML = [
    !data.levelingEnabled ? '⚠️ Leveling is off, so no drops will happen.' : '',
    s.enabled
      ? `🟢 On · next drop ${s.nextDropAt ? fromNow(new Date(s.nextDropAt).getTime()) : 'soon'} <span class="muted">(or as soon as a channel is active after that)</span>`
      : '⚪ Off',
    s.enabled && active ? `<span style="font-size:0.82rem;">Last 10 min — ${active} (needs ${s.minActivity})</span>` : '',
    s.lastDropAt ? `Last drop ${fromNow(new Date(s.lastDropAt).getTime())}` : ''
  ]
    .filter(Boolean)
    .join('<br>');
  document.getElementById('cdRecent').innerHTML = data.recent.length
    ? data.recent
        .map(
          (d) =>
            `<div style="font-size:0.84rem; padding:0.3rem 0; border-bottom:1px solid var(--border-card);">🎁 <strong>${fmt(d.amount)} XP</strong>${d.winners > 1 ? ` ×${d.winners}` : ''} in ${esc(channelLabel(d.channelId))} · ${fromNow(new Date(d.createdAt).getTime())}${d.manual ? ' · manual' : ''}<br><span class="muted">${
              d.claimedBy.length ? `→ ${d.claimedBy.map((w) => esc(w.name || w.id)).join(', ')}` : d.status === 'open' ? 'open now' : 'nobody claimed it'
            }</span></div>`
        )
        .join('')
    : 'No drops yet.';
}

async function saveChatDrops() {
  const body = readChatDrops();
  if (body.enabled && !body.channelIds.length) throw new Error('Chat drops: pick at least one channel.');
  await manageApi('POST', 'levels/chatdrops', body);
  loadChatDrops();
}

async function dropNow(btn) {
  const channelId = document.getElementById('cdNowChannel').value;
  if (!channelId) return showToast('❌ Pick a channel to drop in.');
  const data = await withButton(btn, () => manageApi('POST', 'levels/chatdrops/now', { channelId }), (d) => `🎁 Dropped ${fmt(d.amount)} XP (${d.winners} winner${d.winners === 1 ? '' : 's'}).`);
  if (data) setTimeout(loadChatDrops, 800);
}

/* ------------------------------------------------------------------ Gambling stats */

const GAME_ICON = { coinflip: '🪙', dice: '🎲', limbo: '🚀', mines: '💣', highlow: '🃏', blackjack: '🂡' };

async function loadGambleStats() {
  const table = document.getElementById('gStatsTable');
  if (!table) return;
  let data;
  try {
    data = await manageApi('GET', 'gambling/stats');
  } catch (err) {
    table.innerHTML = `<tr><td class="muted">⚠️ ${esc(err.message)}</td></tr>`;
    return;
  }
  const t = data.totals;
  const signed = (n) => `${n > 0 ? '+' : n < 0 ? '−' : '±'}${fmt(Math.abs(n))}`;
  document.getElementById('gStatsTotals').textContent = t.games
    ? `${fmt(t.games)} games · ${fmt(t.players)} players · ${fmt(t.wagered)} XP wagered · players ${signed(t.net)} XP overall`
    : '';
  table.innerHTML = data.top.length
    ? '<tr><th>#</th><th>Member</th><th>Games</th><th>Win rate</th><th>Biggest win</th><th style="text-align:right;">Net XP</th></tr>' +
      data.top
        .map(
          (p, i) => `<tr><td>${i + 1}</td><td>${esc(p.name)}</td><td>${fmt(p.games)}</td><td>${p.games ? Math.round((p.wins / p.games) * 100) : 0}%</td>
            <td class="muted">${p.biggestWin > 0 ? `+${fmt(p.biggestWin)} ${GAME_ICON[p.biggestWinGame] || ''}` : '—'}</td>
            <td style="color:${p.net >= 0 ? 'var(--accent-green)' : 'var(--accent-red)'};">${signed(p.net)}</td></tr>`
        )
        .join('')
    : '<tr><td class="muted">Nobody has gambled yet.</td></tr>';
}

/* ------------------------------------------------------------------ Engagement: birthdays, counting, starboard */

const enState = { loaded: false, data: null };

function fillEngagementForms(d) {
  const v = (id, val) => (document.getElementById(id).value = val ?? '');
  const c = (id, val) => (document.getElementById(id).checked = !!val);
  const b = d.birthdays.settings;
  c('bdEnabled', b.enabled);
  v('bdChannel', b.channelId || '');
  v('bdHour', b.announceHour);
  v('bdRole', b.roleId || '');
  v('bdXp', b.xpGift);
  v('bdMessage', b.message);
  const ct = d.counting.settings;
  c('ctEnabled', ct.enabled);
  v('ctChannel', ct.channelId || '');
  c('ctTurns', !ct.allowSameUser);
  c('ctMath', ct.mathAllowed);
  const sb = d.starboard.settings;
  c('sbEnabled', sb.enabled);
  v('sbChannel', sb.channelId || '');
  v('sbThreshold', sb.threshold);
  v('sbEmoji', sb.emoji);
  c('sbSelf', sb.selfStar);
  document.querySelectorAll('.sb-ignore').forEach((el) => (el.checked = sb.ignoredChannelIds.includes(el.value)));
  renderBirthdayPreview();
}

function renderEngagementStatus(d) {
  const chip = (on, text) => `<span class="status-chip ${on ? 'good' : 'off'}"><span class="dot"></span>${text}</span>`;
  document.getElementById('enStatus').innerHTML = [
    chip(d.birthdays.settings.enabled, `🎂 Birthdays ${d.birthdays.settings.enabled ? 'on' : 'off'}`),
    chip(d.counting.settings.enabled, `🔢 Counting ${d.counting.settings.enabled ? `on · next ${fmt(d.counting.settings.current + 1)}` : 'off'}`),
    chip(d.starboard.settings.enabled, `⭐ Starboard ${d.starboard.settings.enabled ? 'on' : 'off'}`)
  ].join('');

  const warn = (id, items, what) => {
    const el = document.getElementById(id);
    el.style.display = items.length ? '' : 'none';
    el.innerHTML = items.length ? `⚠️ For ${what}, LoofaryBot needs <strong>${items.map(esc).join(', ')}</strong>.` : '';
  };
  warn('bdWarn', d.birthdays.missingPerms, 'birthdays');
  warn('sbWarn', d.starboard.missingPerms, 'the starboard');

  const bd = d.birthdays;
  document.getElementById('bdCount').textContent = `· ${fmt(bd.saved)} saved`;
  const when = (n) => (n === 0 ? '<strong>today 🎉</strong>' : n === 1 ? 'tomorrow' : `in ${n} days`);
  document.getElementById('bdUpcoming').innerHTML = bd.upcoming.length
    ? `<div class="payout-table-wrap"><table class="payout-table"><tbody>${bd.upcoming
        .map((u) => `<tr><td>${esc(u.name || u.userId)}</td><td class="muted">${esc(u.date)}</td><td>${when(u.daysUntil)}</td></tr>`)
        .join('')}</tbody></table></div>`
    : '<p class="muted" style="margin:0;">Nobody has saved a birthday yet. Members add theirs with <code>/birthday set</code>.</p>';

  const ct = d.counting.settings;
  const stat = (value, label) => `<div class="mini-stat"><div class="value">${value}</div><div class="label">${label}</div></div>`;
  document.getElementById('ctStats').innerHTML = [
    stat(fmt(ct.current + 1), 'Next number'),
    stat(fmt(ct.record), 'Best run'),
    stat(fmt(ct.resets), 'Resets'),
    stat(esc(ct.lastUserName || (ct.lastUserId ? 'someone' : '—')), 'Last counted by')
  ].join('');

  const top = d.starboard.top;
  document.getElementById('sbTop').innerHTML = top.length
    ? top
        .map(
          (p) => `<div class="list-row" style="display:flex; justify-content:space-between; gap:0.5rem; padding:0.4rem 0; border-top:1px solid var(--border-card);">
            <span><strong>${fmt(p.stars)}</strong> ${esc(d.starboard.settings.emoji)} · ${esc(p.authorName || 'someone')} <span class="muted">in #${esc((channels.find((c) => c.id === p.channelId) || {}).name || 'channel')}</span></span>
            <a href="${esc(p.url)}" target="_blank" rel="noopener">Jump ↗</a></div>`
        )
        .join('')
    : '<p class="muted" style="margin:0;">Nothing has reached the starboard yet.</p>';
}

async function loadEngagement() {
  let d;
  try {
    d = await manageApi('GET', 'engagement');
  } catch (err) {
    showToast(`⚠️ ${err.message}`);
    return;
  }
  enState.data = d;
  if (!enState.loaded) fillEngagementForms(d);
  enState.loaded = true;
  renderEngagementStatus(d);
}

function readEngagement(section) {
  const v = (id) => document.getElementById(id).value;
  const c = (id) => document.getElementById(id).checked;
  if (section === 'birthdays') {
    return { enabled: c('bdEnabled'), channelId: v('bdChannel') || null, announceHour: v('bdHour'), roleId: v('bdRole') || null, xpGift: v('bdXp') || 0, message: v('bdMessage') };
  }
  if (section === 'counting') return { enabled: c('ctEnabled'), channelId: v('ctChannel') || null, allowSameUser: !c('ctTurns'), mathAllowed: c('ctMath') };
  return {
    enabled: c('sbEnabled'),
    channelId: v('sbChannel') || null,
    threshold: v('sbThreshold'),
    emoji: v('sbEmoji').trim() || '⭐',
    selfStar: c('sbSelf'),
    ignoredChannelIds: [...document.querySelectorAll('.sb-ignore:checked')].map((el) => el.value)
  };
}

const EN_LABELS = { birthdays: '🎂 Birthday settings saved.', counting: '🔢 Counting settings saved.', starboard: '⭐ Starboard settings saved.' };
const EN_BUTTONS = { birthdays: 'bdSave', counting: 'ctSave', starboard: 'sbSave' };

async function saveEngagement(section) {
  const body = readEngagement(section);
  if (body.enabled && !body.channelId) return showToast('❌ Pick a channel first.');
  const data = await withButton(document.getElementById(EN_BUTTONS[section]), () => manageApi('POST', `engagement/${section}`, body), EN_LABELS[section]);
  if (data) loadEngagement();
}

async function setCount() {
  const input = document.getElementById('ctSetTo');
  if (input.value === '' || Number(input.value) < 0) return showToast('❌ Enter the last number counted (0 or more).');
  const data = await withButton(document.getElementById('ctSetBtn'), () => manageApi('POST', 'engagement/counting', { current: input.value }), (d) => `✅ Count set — next is ${fmt(d.settings.current + 1)}.`);
  if (data) {
    input.value = '';
    loadEngagement();
  }
}

function renderBirthdayPreview() {
  const text = document.getElementById('bdMessage').value.trim() || '🎂 Happy birthday {users}! Have an amazing day! 🎉';
  const who = `<span class="mention-pill">@${esc(viewer.username)}</span>`;
  const extras = [];
  const xp = Number(document.getElementById('bdXp').value) || 0;
  if (xp > 0) extras.push(`🎁 <strong>+${fmt(xp)} XP</strong> birthday gift`);
  const roleId = document.getElementById('bdRole').value;
  const role = roles.find((r) => r.id === roleId);
  if (role) extras.push(`<span class="mention-pill">@${esc(role.name)}</span> for the day`);
  document.getElementById('bdpText').innerHTML =
    esc(text).replaceAll('{users}', who).replaceAll('{user}', who).replaceAll('{count}', '1').replaceAll('{server}', esc(guildName)).replace(/\n/g, '<br>') +
    (extras.length ? `<div class="muted" style="font-size:0.78rem; margin-top:0.35rem;">${extras.join(' · ')}</div>` : '');
  const h = Number(document.getElementById('bdHour').value) || 0;
  document.getElementById('bdpTime').textContent = `Today at ${String(h).padStart(2, '0')}:00 UTC`;
  const local = new Date(Date.UTC(2000, 0, 1, h));
  document.getElementById('bdLocalTime').textContent = `That's ${local.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} your time.`;
}

(function initEngagementUi() {
  const panel = document.getElementById('tab-engagement');
  if (!panel) return;
  ['bdMessage', 'bdXp', 'bdRole', 'bdHour'].forEach((id) => {
    document.getElementById(id).addEventListener('input', renderBirthdayPreview);
    document.getElementById(id).addEventListener('change', renderBirthdayPreview);
  });
  panel.querySelectorAll('[data-sb-emoji]').forEach((b) =>
    b.addEventListener('click', () => {
      document.getElementById('sbEmoji').value = b.dataset.sbEmoji;
      if (typeof setUnsaved === 'function') setUnsaved(true);
    })
  );
  document.getElementById('sbIgnoreSearch').addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    panel.querySelectorAll('#sbIgnored .check-pill').forEach((p) => (p.style.display = !q || p.dataset.name.includes(q) ? '' : 'none'));
  });
})();
