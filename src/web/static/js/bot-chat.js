// Bot Chat: a small live feed of a channel plus a composer that talks through the bot. The feed is
// just the channel's recent messages fetched on a timer — nothing is stored on the page.
(function () {
  const guildId = (window.BC_CONFIG || {}).guildId;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let channelId = '';
  let replyTo = null; // { id, name }
  let timer = null;
  let lastKey = ''; // skip re-rendering when the feed hasn't changed (keeps the view steady)

  function toast(msg) {
    const t = $('toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 2600);
  }

  async function api(method, path, body) {
    const res = await fetch(`/dashboard/${guildId}/botchat${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined
    });
    const data = await res.json().catch(() => ({ ok: false, error: 'Unexpected reply from the server.' }));
    if (!res.ok || !data.ok) throw new Error(data.error || `Request failed (${res.status}).`);
    return data;
  }

  const timeStr = (ts) => {
    try {
      return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    } catch (e) {
      return '';
    }
  };

  function messageHtml(m) {
    const reply = m.replyTo
      ? `<div class="bc-msg-reply">↩ ${m.replyTo.name ? esc(m.replyTo.name) : 'a message'}${m.replyTo.text ? ': ' + esc(m.replyTo.text) : ''}</div>`
      : '';
    const extras = (m.extras || []).map((e) => `<span class="bc-extra">${esc(e)}</span>`).join(' ');
    const body = m.content ? esc(m.content).replace(/\n/g, '<br>') : '<span class="muted">(no text)</span>';
    const tag = m.self ? '<span class="bc-badge">BOT · you</span>' : m.bot ? '<span class="bc-badge">BOT</span>' : '';
    return `<div class="bc-msg${m.self ? ' bc-msg-self' : ''}">
      <img class="bc-avatar" src="${esc(m.avatar)}" alt="" onerror="this.style.visibility='hidden'">
      <div class="bc-msg-body">
        ${reply}
        <div class="bc-msg-head"><span class="bc-name">${esc(m.name)}</span>${tag}<span class="bc-time">${timeStr(m.at)}</span></div>
        <div class="bc-text">${body} ${extras}</div>
      </div>
      <button class="bc-reply-btn" title="Reply" onclick="bcStartReply('${m.id}', this.getAttribute('data-name'))" data-name="${esc(m.name)}">↩</button>
    </div>`;
  }

  function render(messages) {
    const key = messages.map((m) => m.id + ':' + (m.content.length)).join(',');
    if (key === lastKey) return;
    lastKey = key;
    const feed = $('bcFeed');
    const atBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 60;
    feed.innerHTML = messages.length
      ? messages.map(messageHtml).join('')
      : '<p class="muted" style="margin:0; text-align:center; padding:1.5rem 0;">No messages here yet.</p>';
    if (atBottom) feed.scrollTop = feed.scrollHeight;
  }

  async function refresh(showErrors) {
    if (!channelId) return;
    try {
      const d = await api('GET', `/feed?channelId=${encodeURIComponent(channelId)}`);
      if (d.channelId === channelId) render(d.messages);
    } catch (err) {
      if (showErrors) $('bcFeed').innerHTML = `<p class="muted" style="margin:0; text-align:center; padding:1.5rem 0;">⚠️ ${esc(err.message)}</p>`;
    }
  }
  window.bcRefresh = () => refresh(true);

  function startPolling() {
    stopPolling();
    timer = setInterval(() => {
      if (!document.hidden) refresh(false);
    }, 5000);
  }
  function stopPolling() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  window.bcStartReply = (id, name) => {
    replyTo = { id, name };
    $('bcReplyText').textContent = `Replying to ${name}`;
    $('bcReplyBar').style.display = '';
    $('bcInput').focus();
  };
  window.bcClearReply = () => {
    replyTo = null;
    $('bcReplyBar').style.display = 'none';
  };

  window.bcSend = async () => {
    const input = $('bcInput');
    const content = input.value.trim();
    if (!channelId) return toast('Pick a channel first.');
    if (!content) return;
    $('bcSend').disabled = true;
    try {
      await api('POST', '/send', { channelId, content, replyTo: replyTo ? replyTo.id : undefined });
      input.value = '';
      $('bcCount').textContent = '0';
      window.bcClearReply();
      lastKey = ''; // force a re-render so the new message shows at once
      await refresh(false);
    } catch (err) {
      toast(`❌ ${err.message}`);
    } finally {
      $('bcSend').disabled = false;
      input.focus();
    }
  };

  function onChannel() {
    channelId = $('bcChannel').value;
    window.bcClearReply();
    lastKey = '';
    const on = !!channelId;
    $('bcInput').disabled = !on;
    $('bcSend').disabled = !on;
    if (on) {
      $('bcFeed').innerHTML = '<p class="muted" style="margin:0; text-align:center; padding:1.5rem 0;">Loading…</p>';
      refresh(true);
      startPolling();
    } else {
      stopPolling();
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (!$('bcChannel')) return;
    $('bcChannel').addEventListener('change', onChannel);
    const input = $('bcInput');
    input.addEventListener('input', () => ($('bcCount').textContent = String(input.value.length)));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        window.bcSend();
      }
    });
    window.addEventListener('beforeunload', stopPolling);
  });
})();
