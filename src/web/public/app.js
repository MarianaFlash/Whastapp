/* Dashboard "Pendientes": JS sin dependencias. */
(() => {
  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => Array.from(el.querySelectorAll(sel));

  const state = {
    view: 'pending',
    q: '',
    chats: [],
    status: null,
    settings: null,
    currentJid: null,
    knownCritical: null,
    timer: null,
  };

  const LEVEL_LABEL = { ok: 'Al día', yellow: 'Atención', red: 'Urgente', critical: 'Crítico' };
  const CONN_LABEL = {
    starting: 'Iniciando…',
    qr: 'Escanea el QR',
    connecting: 'Conectando…',
    connected: 'Conectado',
    disconnected: 'Sin conexión',
    logged_out: 'Sesión cerrada',
    stopped: 'Detenido',
  };

  // ---------- utilidades ----------

  async function api(path, options = {}) {
    const res = await fetch(path, {
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });
    if (res.status === 401) {
      location.href = '/login.html';
      throw new Error('No autorizado');
    }
    if (!res.ok) {
      let message = `Error ${res.status}`;
      try {
        message = (await res.json()).error || message;
      } catch {
        /* sin cuerpo */
      }
      throw new Error(message);
    }
    if (res.status === 204) return null;
    return res.json();
  }

  const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body ?? {}) });

  function escapeHtml(text) {
    return String(text ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function fmtDuration(seconds) {
    const s = Math.max(0, Math.floor(seconds));
    if (s < 60) return 'menos de 1 min';
    const minutes = Math.floor(s / 60);
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.floor(minutes / 60);
    const restMin = minutes % 60;
    if (hours < 24) return restMin ? `${hours} h ${restMin} min` : `${hours} h`;
    const days = Math.floor(hours / 24);
    const restHours = hours % 24;
    return restHours ? `${days} d ${restHours} h` : `${days} d`;
  }

  function fmtWhen(ts) {
    if (!ts) return '';
    const d = new Date(ts * 1000);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    const time = d.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
    if (sameDay) return `hoy ${time}`;
    if (d.toDateString() === yesterday.toDateString()) return `ayer ${time}`;
    return d.toLocaleDateString('es', { day: 'numeric', month: 'short' }) + ` ${time}`;
  }

  let toastTimer = null;
  function toast(message) {
    const el = $('#toast');
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
  }

  function initial(name) {
    const clean = (name || '').replace(/[^\p{L}\p{N}]/gu, ' ').trim();
    return clean ? clean[0].toUpperCase() : '?';
  }

  // ---------- carga ----------

  async function refresh() {
    try {
      const [status, chats] = await Promise.all([
        api('/api/status'),
        api(`/api/chats?view=${encodeURIComponent(state.view)}&q=${encodeURIComponent(state.q)}`),
      ]);
      state.status = status;
      state.chats = chats;
      renderStatus();
      renderList();
      notifyNewCritical();
    } catch (err) {
      $('#conn').textContent = 'Sin conexión con el servidor';
      $('#conn').className = 'conn disconnected';
      console.error(err);
    }
  }

  function schedule() {
    clearInterval(state.timer);
    state.timer = setInterval(refresh, state.status?.connection?.status === 'qr' ? 4000 : 20000);
  }

  // ---------- render ----------

  function renderStatus() {
    const st = state.status;
    const conn = st.connection;
    const connEl = $('#conn');
    connEl.className = `conn ${conn.status}`;
    connEl.textContent = conn.status === 'connected' && conn.me?.name ? `Conectado · ${conn.me.name}` : CONN_LABEL[conn.status] || conn.status;

    const qrPanel = $('#qr-panel');
    const connPanel = $('#conn-panel');
    if (st.qrDataUrl) {
      qrPanel.hidden = false;
      connPanel.hidden = true;
      $('#qr-img').src = st.qrDataUrl;
    } else {
      qrPanel.hidden = true;
      if (conn.status !== 'connected') {
        connPanel.hidden = false;
        $('#conn-title').textContent =
          conn.status === 'logged_out'
            ? 'La sesión se cerró desde el teléfono'
            : conn.status === 'disconnected'
              ? 'Sin conexión con WhatsApp, reintentando…'
              : 'Conectando con WhatsApp…';
        $('#conn-detail').textContent = conn.lastError ? `Último error: ${conn.lastError}` : 'Si tarda más de un minuto, recarga la página.';
      } else if (!conn.historyDone && conn.historyMessages === 0) {
        connPanel.hidden = false;
        $('#conn-title').textContent = 'Sincronizando historial reciente…';
        $('#conn-detail').textContent = 'En uno o dos minutos aparecerán los chats que esperan respuesta.';
      } else {
        connPanel.hidden = true;
      }
    }

    const c = st.counts;
    const s = st.stats;
    const avg = s.today.avgWaitSeconds;
    $('#stats').innerHTML = `
      <div class="tile"><div class="label">Pendientes</div><div class="value">${c.pending}</div><div class="sub">${c.snoozed ? `${c.snoozed} ${c.snoozed === 1 ? 'pospuesto' : 'pospuestos'}` : 'esperan tu respuesta'}</div></div>
      <div class="tile critical"><div class="label">Críticos</div><div class="value">${c.critical}</div><div class="sub">${c.red} urgentes · ${c.yellow} en atención</div></div>
      <div class="tile vip"><div class="label">⭐ VIP esperando</div><div class="value">${c.vip}</div><div class="sub">van primero en la lista</div></div>
      <div class="tile"><div class="label">Respondidos hoy</div><div class="value">${s.today.answered}</div><div class="sub">${s.week.answered} en 7 días</div></div>
      <div class="tile"><div class="label">Tu tiempo de respuesta</div><div class="value" style="font-size:20px">${avg === null ? '—' : fmtDuration(avg)}</div><div class="sub">${s.week.avgWaitSeconds === null ? 'promedio de hoy' : `7 días: ${fmtDuration(s.week.avgWaitSeconds)}`}</div></div>
    `;
    $('#pill-pending').textContent = c.pending;
    $('#pill-snoozed').textContent = c.snoozed;
    const v = st.version && st.version !== 'dev' ? st.version.slice(0, 7) : st.version || '?';
    $('#version-line').textContent =
      `Versión ${v}${st.builtAt ? ` · construida ${st.builtAt}` : ''}` +
      `${st.trackingSinceDate ? ` · contando desde ${st.trackingSinceDate}` : ''}`;
    document.title = c.pending ? `(${c.pending}) Pendientes` : 'Pendientes';
  }

  function rowActions(chat) {
    const view = state.view;
    const actions = [];
    const open = chat.waLink
      ? `<a class="btn small primary" href="${chat.waLink}" target="_blank" rel="noopener">Abrir en WhatsApp</a>`
      : `<button class="btn small primary" data-action="noLink">Abrir en WhatsApp</button>`;
    actions.push(open);
    if (chat.pending) actions.push(`<button class="btn small" data-action="resolve" title="Quitar de la lista sin contar como respuesta">✓ Listo</button>`);
    if (chat.pending && !chat.snoozed) actions.push(`<button class="btn small" data-action="snooze">⏰ Posponer</button>`);
    if (chat.snoozed) actions.push(`<button class="btn small" data-action="unsnooze">Quitar posposición</button>`);
    actions.push(`<button class="btn small" data-action="vip">${chat.vipGroup ? '⭐ Cambiar' : '☆ Marcar VIP'}</button>`);
    if (view === 'ignored') actions.push(`<button class="btn small" data-action="unignore">Volver a mostrar</button>`);
    else actions.push(`<button class="btn small" data-action="ignore" title="No volver a mostrar este chat">Ignorar</button>`);
    return actions.join('');
  }

  function renderList() {
    const list = $('#list');
    const empty = $('#empty');
    const chats = state.chats;
    if (!chats.length) {
      list.innerHTML = '';
      empty.hidden = false;
      const messages = {
        pending: ['🎉', 'Nadie espera tu respuesta. ¡Todo al día!'],
        snoozed: ['⏰', 'No tienes chats pospuestos.'],
        vip: ['⭐', 'Aún no has marcado contactos VIP. Usa "Marcar VIP" en cualquier chat.'],
        all: ['💬', 'Todavía no hay chats. Aparecerán cuando lleguen mensajes.'],
        ignored: ['🙈', 'No has ignorado ningún chat.'],
      };
      const [icon, text] = messages[state.view] || ['💬', 'Nada por aquí.'];
      empty.innerHTML = `<div class="big">${icon}</div>${escapeHtml(text)}`;
      return;
    }
    empty.hidden = true;
    list.innerHTML = chats
      .map((chat) => {
        const classes = ['chat', `level-${chat.level}`];
        if (chat.pending) classes.push('pending');
        if (chat.snoozed) classes.push('snoozed');
        if (chat.vipGroup) classes.push('vip');
        const tags = [];
        if (chat.vipGroup) tags.push(`<span class="tag vip">⭐ ${escapeHtml(chat.vipGroup)}</span>`);
        if (chat.isGroup) tags.push(`<span class="tag">Grupo</span>`);
        if (chat.pending && chat.unansweredCount > 1) tags.push(`<span class="tag">${chat.unansweredCount} mensajes</span>`);
        let side;
        if (chat.snoozed) {
          side = `<span class="badge muted">Pospuesto</span><div class="wait">hasta ${escapeHtml(fmtWhen(chat.snoozedUntil))}<small>esperando ${fmtDuration(chat.waitSeconds)}</small></div>`;
        } else if (chat.pending) {
          side = `<span class="badge ${chat.level}">${LEVEL_LABEL[chat.level]}</span><div class="wait">esperando ${fmtDuration(chat.waitSeconds)}<small>desde ${escapeHtml(fmtWhen(chat.waitingSince))}</small></div>`;
        } else {
          const last = Math.max(chat.lastIncomingAt || 0, chat.lastOutgoingAt || 0);
          side = `<span class="badge muted">${chat.ignored ? 'Ignorado' : 'Al día'}</span><div class="wait"><small>${last ? `último ${escapeHtml(fmtWhen(last))}` : ''}</small></div>`;
        }
        const preview = chat.pending && chat.preview ? `<div class="preview">«${escapeHtml(chat.preview)}»</div>` : '';
        return `
          <li class="${classes.join(' ')}" data-jid="${escapeHtml(chat.jid)}">
            <div class="avatar">${escapeHtml(initial(chat.name))}</div>
            <div class="body">
              <div class="line1"><span class="name">${escapeHtml(chat.name)}</span>${tags.join('')}</div>
              ${preview}
            </div>
            <div class="side">${side}</div>
            <div class="actions">${rowActions(chat)}</div>
          </li>`;
      })
      .join('');
  }

  // ---------- acciones ----------

  function chatByJid(jid) {
    return state.chats.find((c) => c.jid === jid);
  }

  async function act(jid, action) {
    const chat = chatByJid(jid);
    try {
      switch (action) {
        case 'resolve':
          await post(`/api/chats/${encodeURIComponent(jid)}/resolve`);
          toast(`${chat?.name ?? 'Chat'} marcado como listo`);
          break;
        case 'snooze':
          state.currentJid = jid;
          $('#dlg-snooze').showModal();
          return;
        case 'unsnooze':
          await post(`/api/chats/${encodeURIComponent(jid)}/snooze`, { clear: true });
          toast('Posposición quitada');
          break;
        case 'vip':
          openVipDialog(jid);
          return;
        case 'ignore':
          await post(`/api/chats/${encodeURIComponent(jid)}/ignore`, { ignored: true });
          toast(`${chat?.name ?? 'Chat'} ignorado. Lo encuentras en la pestaña Ignorados.`);
          break;
        case 'unignore':
          await post(`/api/chats/${encodeURIComponent(jid)}/ignore`, { ignored: false });
          toast('Chat visible de nuevo');
          break;
        case 'noLink':
          toast('Este chat no muestra número. Búscalo en WhatsApp por su nombre.');
          return;
        default:
          return;
      }
      await refresh();
    } catch (err) {
      toast(err.message);
    }
  }

  $('#list').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const li = e.target.closest('li[data-jid]');
    if (!li) return;
    act(li.dataset.jid, btn.dataset.action);
  });

  // Posponer
  $('#dlg-snooze').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-minutes], button[data-tomorrow]');
    if (!btn || !state.currentJid) return;
    let body;
    if (btn.dataset.tomorrow) {
      const d = new Date();
      d.setDate(d.getDate() + 1);
      d.setHours(Number(btn.dataset.tomorrow), 0, 0, 0);
      body = { until: Math.floor(d.getTime() / 1000) };
    } else {
      body = { minutes: Number(btn.dataset.minutes) };
    }
    try {
      await post(`/api/chats/${encodeURIComponent(state.currentJid)}/snooze`, body);
      $('#dlg-snooze').close();
      toast('Pospuesto');
      await refresh();
    } catch (err) {
      toast(err.message);
    }
  });

  // VIP
  async function openVipDialog(jid) {
    state.currentJid = jid;
    const chat = chatByJid(jid);
    if (!state.settings) state.settings = await api('/api/settings');
    $('#vip-title').textContent = `⭐ ${chat?.name ?? 'Contacto'}`;
    $('#vip-custom').value = '';
    $('#vip-remove').hidden = !chat?.vipGroup;
    $('#vip-choices').innerHTML = state.settings.vipGroups
      .map(
        (g) =>
          `<button class="btn ${chat?.vipGroup === g ? 'primary' : ''}" data-group="${escapeHtml(g)}">${escapeHtml(g)}</button>`,
      )
      .join('');
    $('#dlg-vip').showModal();
  }

  async function setVip(group) {
    try {
      await post(`/api/chats/${encodeURIComponent(state.currentJid)}/vip`, { group });
      $('#dlg-vip').close();
      toast(group ? `Marcado como ⭐ ${group}` : 'Estrella quitada');
      state.settings = null;
      await refresh();
    } catch (err) {
      toast(err.message);
    }
  }
  $('#vip-choices').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-group]');
    if (btn) setVip(btn.dataset.group);
  });
  $('#vip-save-custom').addEventListener('click', () => {
    const custom = $('#vip-custom').value.trim();
    if (!custom) return toast('Escribe un nombre de grupo o elige uno de la lista');
    setVip(custom);
  });
  $('#vip-remove').addEventListener('click', () => setVip(null));

  // ---------- ajustes ----------

  const form = $('#form-settings');

  function fillSettings(s) {
    const f = form.elements;
    f['vip.yellow'].value = s.thresholds.vip.yellow;
    f['vip.red'].value = s.thresholds.vip.red;
    f['vip.critical'].value = s.thresholds.vip.critical;
    f['normal.yellow'].value = s.thresholds.normal.yellow;
    f['normal.red'].value = s.thresholds.normal.red;
    f['normal.critical'].value = s.thresholds.normal.critical;
    f.notifyViaWhatsApp.checked = s.notifyViaWhatsApp;
    f.notifyCriticalImmediately.checked = s.notifyCriticalImmediately;
    f.digestTimes.value = s.digestTimes.join(', ');
    f.assistantName.value = s.assistantName;
    f['quietHours.enabled'].checked = s.quietHours.enabled;
    f['quietHours.start'].value = s.quietHours.start;
    f['quietHours.end'].value = s.quietHours.end;
    f.groupsMode.value = s.groupsMode;
    f.trackingSinceDate.value = s.trackingSinceDate || '';
    f.reactionCountsAsReply.checked = s.reactionCountsAsReply;
    f.storePreview.checked = s.storePreview;
    f.vipGroups.value = s.vipGroups.join(', ');
  }

  function readSettings() {
    const f = form.elements;
    const list = (value) => value.split(',').map((x) => x.trim()).filter(Boolean);
    return {
      thresholds: {
        vip: { yellow: Number(f['vip.yellow'].value), red: Number(f['vip.red'].value), critical: Number(f['vip.critical'].value) },
        normal: { yellow: Number(f['normal.yellow'].value), red: Number(f['normal.red'].value), critical: Number(f['normal.critical'].value) },
      },
      notifyViaWhatsApp: f.notifyViaWhatsApp.checked,
      notifyCriticalImmediately: f.notifyCriticalImmediately.checked,
      digestTimes: list(f.digestTimes.value),
      assistantName: f.assistantName.value,
      quietHours: { enabled: f['quietHours.enabled'].checked, start: f['quietHours.start'].value, end: f['quietHours.end'].value },
      groupsMode: f.groupsMode.value,
      trackingSinceDate: f.trackingSinceDate.value || null,
      reactionCountsAsReply: f.reactionCountsAsReply.checked,
      storePreview: f.storePreview.checked,
      vipGroups: list(f.vipGroups.value),
    };
  }

  $('#btn-settings').addEventListener('click', async () => {
    try {
      state.settings = await api('/api/settings');
      fillSettings(state.settings);
      $('#dlg-settings').showModal();
    } catch (err) {
      toast(err.message);
    }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      state.settings = await api('/api/settings', { method: 'PUT', body: JSON.stringify(readSettings()) });
      $('#dlg-settings').close();
      toast('Ajustes guardados');
      await refresh();
    } catch (err) {
      toast(err.message);
    }
  });

  $('#btn-test').addEventListener('click', async () => {
    try {
      await post('/api/notify/test');
      toast('Mensaje de prueba enviado a tu chat "Tú" en WhatsApp');
    } catch (err) {
      toast(err.message);
    }
  });
  $('#btn-digest').addEventListener('click', async () => {
    try {
      await post('/api/notify/digest');
      toast('Resumen enviado a tu WhatsApp');
    } catch (err) {
      toast(err.message);
    }
  });
  $('#btn-unlink').addEventListener('click', async () => {
    if (!confirm('¿Desvincular este dispositivo de tu WhatsApp? Tendrás que escanear el QR de nuevo.')) return;
    try {
      await post('/api/whatsapp/logout');
      $('#dlg-settings').close();
      toast('Desvinculado. En unos segundos aparece un QR nuevo.');
      await refresh();
    } catch (err) {
      toast(err.message);
    }
  });
  $('#btn-browser-notif').addEventListener('click', async () => {
    if (!('Notification' in window)) return toast('Este navegador no soporta notificaciones');
    const result = await Notification.requestPermission();
    toast(result === 'granted' ? 'Avisos del navegador activados' : 'Permiso denegado');
  });

  $$('[data-close]').forEach((btn) => btn.addEventListener('click', () => btn.closest('dialog').close()));

  $('#btn-logout').addEventListener('click', async () => {
    await post('/api/logout').catch(() => {});
    location.href = '/login.html';
  });

  // ---------- pestañas y búsqueda ----------

  $('#tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-view]');
    if (!btn) return;
    state.view = btn.dataset.view;
    $$('#tabs button').forEach((b) => b.classList.toggle('active', b === btn));
    refresh();
  });

  let searchTimer = null;
  $('#search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.q = e.target.value.trim();
      refresh();
    }, 250);
  });

  // ---------- avisos del navegador ----------

  function notifyNewCritical() {
    if (state.view !== 'pending') return;
    const critical = state.chats.filter((c) => c.level === 'critical' && !c.snoozed);
    const current = new Set(critical.map((c) => c.jid));
    if (state.knownCritical && 'Notification' in window && Notification.permission === 'granted') {
      for (const chat of critical) {
        if (state.knownCritical.has(chat.jid)) continue;
        const n = new Notification(`🚨 ${chat.name} lleva ${fmtDuration(chat.waitSeconds)} esperando`, {
          body: chat.preview || 'Toca para abrir el chat',
          tag: chat.jid,
        });
        n.onclick = () => {
          window.focus();
          if (chat.waLink) window.open(chat.waLink, '_blank', 'noopener');
        };
      }
    }
    state.knownCritical = current;
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refresh();
  });

  refresh().then(schedule);
  setInterval(() => {
    if (state.status?.connection?.status === 'qr') schedule();
  }, 10000);
})();
