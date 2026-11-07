'use strict';
(() => {
  const { api, el, icon, relative, absolute, etaPhrase, badge, initials, toast } = GV;
  const $ = (id) => document.getElementById(id);

  const VIEWS = [
    ['abiertos', 'Abiertos', 'abiertos'],
    ['sin_tiempo', 'Sin tiempo estimado', 'sin_tiempo'],
    ['nuevo', 'Nuevos', 'nuevo'],
    ['en_progreso', 'En progreso', 'en_progreso'],
    ['en_espera', 'En espera', 'en_espera'],
    ['resuelto', 'Resueltos', 'resuelto']
  ];
  const STATUSES = [['nuevo', 'Nuevo'], ['en_progreso', 'En progreso'], ['en_espera', 'En espera'], ['resuelto', 'Resuelto']];
  const ETAS = [[30, '30 min'], [60, '1 h'], [120, '2 h'], [240, '4 h'], [1440, '1 día'], [4320, '3 días']];

  const state = { me: null, view: 'abiertos', q: '', stats: null, lastId: null, admins: [], poll: null };

  // ---------- Avisos de nuevos reportes ----------
  function beep() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      [660, 880].forEach((f, i) => {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.frequency.value = f; o.connect(g); g.connect(ctx.destination);
        const t = ctx.currentTime + i * 0.18;
        g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.2, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
        o.start(t); o.stop(t + 0.17);
      });
    } catch { /* sin audio */ }
  }

  function notifyNew(n) {
    beep();
    toast(n === 1 ? 'Llegó un reporte nuevo.' : `Llegaron ${n} reportes nuevos.`);
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification('Reports · Grupo Volcanes', { body: n === 1 ? 'Llegó un reporte nuevo.' : `Llegaron ${n} reportes nuevos.`, icon: '/favicon.svg' });
    }
  }

  function setupNotifyButton() {
    const b = $('notify-btn');
    b.hidden = !('Notification' in window) || Notification.permission !== 'default';
    b.onclick = async () => { await Notification.requestPermission(); setupNotifyButton(); };
  }

  async function pollStats() {
    try {
      const { stats } = await api('/api/admin/stats');
      if (state.lastId !== null && stats.ultimo_id > state.lastId) notifyNew(stats.ultimo_id - state.lastId);
      const changed = !state.stats || JSON.stringify(stats) !== JSON.stringify(state.stats);
      state.lastId = stats.ultimo_id;
      state.stats = stats;
      document.title = (stats.nuevo ? `(${stats.nuevo}) ` : '') + 'Reports · Administración';
      renderNav();
      if (changed && !$('view-list').hidden) loadList(false);
    } catch (err) {
      if (err.status === 401) showLogin();
    }
  }

  // ---------- Login ----------
  function showLogin(needsSetup) {
    clearInterval(state.poll);
    $('view-app').hidden = true;
    $('view-login').hidden = false;
    $('login-setup').hidden = !needsSetup;
    $('login-user').focus();
  }

  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('login-error').hidden = true;
    try {
      const { admin } = await api('/api/admin/login', { method: 'POST', body: { username: $('login-user').value, password: $('login-pass').value } });
      $('login-pass').value = '';
      start(admin);
    } catch (err) {
      $('login-error').textContent = err.message; $('login-error').hidden = false;
    }
  });

  $('logout').addEventListener('click', async () => {
    await api('/api/admin/logout', { method: 'POST' }).catch(() => {});
    state.me = null; state.lastId = null; showLogin();
  });

  async function start(admin) {
    state.me = admin;
    $('view-login').hidden = true;
    $('view-app').hidden = false;
    $('me-name').textContent = admin.name;
    $('me-avatar').textContent = initials(admin.name);
    setupNotifyButton();
    try { state.admins = (await api('/api/admin/admins')).admins; } catch { state.admins = [admin]; }
    await pollStats();
    clearInterval(state.poll);
    state.poll = setInterval(pollStats, 15000);
    route();
  }

  // ---------- Navegación ----------
  function renderNav() {
    const s = state.stats || {};
    $('nav').replaceChildren(...VIEWS.map(([id, label, key]) => el('button', {
      type: 'button', class: 'adm-nav', 'aria-current': state.view === id && !location.hash.startsWith('#t/') ? 'page' : null,
      onclick: () => { state.view = id; if (location.hash) location.hash = ''; else route(); }
    }, el('span', {}, label), el('span', { class: 'mono' }, String(s[key] ?? '')))));
  }

  function route() {
    const m = /^#t\/(\d+)$/.exec(location.hash);
    renderNav();
    if (m) { $('view-list').hidden = true; $('view-detail').hidden = false; loadDetail(Number(m[1])); }
    else { $('view-detail').hidden = true; $('view-list').hidden = false; loadList(true); }
  }
  window.addEventListener('hashchange', route);

  // ---------- Bandeja ----------
  function kpi(cls, label, value) {
    return el('div', { class: 'kpi ' + cls }, el('span', { class: 'label' }, label), el('b', {}, String(value)));
  }

  function etaCell(t) {
    if (t.status === 'resuelto') return el('span', { class: 'muted-sm' }, 'Resuelto ' + relative(t.resolved_at || t.updated_at));
    if (!t.eta_at) {
      return el('a', { class: 'btn btn-sm', href: '#t/' + t.id, onclick: (e) => e.stopPropagation() }, 'Asignar tiempo');
    }
    const late = new Date(t.eta_at) < new Date();
    return el('span', { class: late ? 'late' : '' }, (late ? 'Vencido · ' : '') + etaPhrase(t.eta_at));
  }

  function summary(t) {
    const s = t.description || 'Reporte con foto';
    return s.length > 80 ? s.slice(0, 78) + '…' : s;
  }

  async function loadList(scroll) {
    try {
      const { tickets, stats } = await api(`/api/admin/tickets?view=${encodeURIComponent(state.view)}&q=${encodeURIComponent(state.q)}`);
      state.stats = stats;
      const label = VIEWS.find((v) => v[0] === state.view)[1];
      $('list-title').textContent = label;
      $('list-sub').textContent = stats.sin_tiempo
        ? `${stats.sin_tiempo} reporte${stats.sin_tiempo > 1 ? 's esperan' : ' espera'} tiempo estimado.`
        : 'Todos los reportes abiertos tienen tiempo estimado.';
      $('kpis').replaceChildren(
        kpi('kpi-plain', 'Abiertos', stats.abiertos),
        kpi('kpi-straw', 'Sin tiempo estimado', stats.sin_tiempo),
        kpi('kpi-coral', 'Vencen hoy', stats.vencen_hoy),
        kpi('kpi-teal', 'Resueltos esta semana', stats.resueltos_semana));
      $('rows-empty').hidden = tickets.length > 0;
      $('rows').replaceChildren(...tickets.map((t) => el('tr', { onclick: () => { location.hash = 't/' + t.id; } },
        el('td', { class: 'mono' }, t.folio),
        el('td', {},
          el('a', { class: 'subject', href: '#t/' + t.id, onclick: (e) => e.stopPropagation() }, summary(t)),
          el('div', { class: 'muted-sm' }, [t.topic, t.photo_count ? `${t.photo_count} foto${t.photo_count > 1 ? 's' : ''}` : ''].filter(Boolean).join(' · '))),
        el('td', {}, el('div', {}, t.reporter_name), el('div', { class: 'muted-sm' }, [t.reporter_area, t.hostname].filter(Boolean).join(' · '))),
        el('td', {}, el('div', { class: 'row', style: 'gap:4px' }, badge(t.status, t.status_label), t.blocked && t.status !== 'resuelto' ? badge('urgente', 'No puede trabajar') : null)),
        el('td', {}, etaCell(t)),
        el('td', { class: 'muted-sm', title: absolute(t.created_at) }, relative(t.created_at)))));
      renderNav();
      if (scroll) window.scrollTo(0, 0);
    } catch (err) {
      if (err.status === 401) return showLogin();
      toast(err.message);
    }
  }

  let searchTimer;
  $('search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.q = e.target.value.trim(); loadList(false); }, 250);
  });

  // ---------- Detalle ----------
  async function loadDetail(id) {
    const root = $('view-detail');
    root.replaceChildren(el('p', { class: 'muted' }, 'Cargando…'));
    let data;
    try { data = await api('/api/admin/tickets/' + id); }
    catch (err) {
      if (err.status === 401) return showLogin();
      root.replaceChildren(el('a', { href: '#', class: 'muted-sm' }, '← Bandeja'), el('div', { class: 'notice notice-error' }, err.message));
      return;
    }
    const { ticket: t, photos, events } = data;
    const draft = { status: t.status, assignee_id: t.assignee_id, eta_minutes: null, eta_at: undefined };

    // Estado
    const statusSeg = el('div', { class: 'seg' });
    const renderStatus = () => statusSeg.replaceChildren(...STATUSES.map(([id, label]) => el('button', {
      type: 'button', class: 's-' + id, 'aria-pressed': String(draft.status === id),
      onclick: () => { draft.status = id; renderStatus(); }
    }, label)));
    renderStatus();

    // Responsable
    const assignee = el('select', { class: 'select', id: 'assignee' },
      el('option', { value: '' }, 'Sin asignar'),
      state.admins.map((a) => el('option', { value: String(a.id), selected: a.id === t.assignee_id }, a.name + (a.id === state.me.id ? ' (yo)' : ''))));

    // Tiempo estimado
    const etaSeg = el('div', { class: 'seg seg-3' });
    const custom = el('input', { class: 'input', type: 'datetime-local', id: 'eta-custom' });
    const preview = el('div', { class: 'heading', style: 'font-size:15px;line-height:22px' });
    const renderEta = () => {
      etaSeg.replaceChildren(...ETAS.map(([mins, label]) => el('button', {
        type: 'button', 'aria-pressed': String(draft.eta_minutes === mins),
        onclick: () => { draft.eta_minutes = draft.eta_minutes === mins ? null : mins; draft.eta_at = undefined; custom.value = ''; renderEta(); }
      }, label)));
      let iso = null;
      if (draft.eta_minutes) iso = new Date(Date.now() + draft.eta_minutes * 60e3).toISOString();
      else if (draft.eta_at) iso = draft.eta_at;
      else if (draft.eta_at === undefined) iso = t.eta_at;
      preview.textContent = iso ? 'Te atendemos: ' + etaPhrase(iso) : 'Por asignar';
    };
    custom.addEventListener('change', () => {
      draft.eta_minutes = null;
      draft.eta_at = custom.value ? new Date(custom.value).toISOString() : undefined;
      renderEta();
    });
    renderEta();

    const saveBtn = el('button', { type: 'button', class: 'btn btn-primary' }, 'Guardar y avisar');
    const saveMsg = el('div', { class: 'notice notice-ok', role: 'status', hidden: true });
    saveBtn.addEventListener('click', async () => {
      const body = {};
      if (draft.status !== t.status) body.status = draft.status;
      const aId = assignee.value ? Number(assignee.value) : null;
      if (aId !== t.assignee_id) body.assignee_id = aId;
      if (draft.eta_minutes) body.eta_minutes = draft.eta_minutes;
      else if (draft.eta_at) body.eta_at = draft.eta_at;
      if (body.status && body.status !== 'nuevo') body.keep_status = true;
      if (!Object.keys(body).length) { toast('No hay cambios que guardar.'); return; }
      saveBtn.disabled = true;
      try {
        await api('/api/admin/tickets/' + t.id, { method: 'PATCH', body });
        toast('Listo. ' + t.reporter_name + ' ya ve los cambios.');
        pollStats();
        loadDetail(t.id);
      } catch (err) { toast(err.message); saveBtn.disabled = false; }
    });

    // Mensajes
    const reply = el('textarea', { class: 'textarea', id: 'reply', rows: '3', maxlength: '2000', placeholder: 'Ej. Ya voy para allá; mientras, conéctate al wifi de invitados.' });
    const internal = el('input', { type: 'checkbox' });
    const sendBtn = el('button', { type: 'button', class: 'btn' }, 'Enviar respuesta');
    sendBtn.addEventListener('click', async () => {
      if (!reply.value.trim()) return reply.focus();
      sendBtn.disabled = true;
      try {
        await api(`/api/admin/tickets/${t.id}/messages`, { method: 'POST', body: { body: reply.value, internal: internal.checked } });
        loadDetail(t.id);
      } catch (err) { toast(err.message); sendBtn.disabled = false; }
    });

    const eventLine = (e) => {
      let text;
      if (e.kind === 'created') text = 'envió el reporte' + (photos.length ? ` con ${photos.length} foto${photos.length > 1 ? 's' : ''}` : '');
      else if (e.kind === 'reopened') text = 'reabrió el reporte';
      else if (e.kind === 'update') text = e.body;
      return el('li', {},
        el('div', { class: 'avatar' + (e.author_kind === 'admin' ? ' av-adm' : ''), 'aria-hidden': 'true' }, initials(e.author_name)),
        el('div', { class: 'stack-sm', style: 'gap:2px' },
          el('div', {}, el('b', {}, e.author_name || 'Sistema'), ' ', text || '', e.internal ? el('span', { class: 'badge b-en_espera internal-tag' }, 'Nota interna') : null),
          e.kind === 'message' ? el('div', { class: 'msg' }, e.body) : null,
          el('div', { class: 'muted-sm', title: absolute(e.created_at) }, relative(e.created_at))));
    };

    root.replaceChildren(
      el('div', { class: 'stack-sm' },
        el('a', { href: '#', class: 'muted-sm' }, '← Bandeja'),
        el('div', { class: 'row' }, el('span', { class: 'mono muted' }, t.folio), badge(t.status, t.status_label), t.blocked && t.status !== 'resuelto' ? badge('urgente', 'No puede trabajar') : null),
        el('h1', { class: 'title' }, summary(t)),
        el('div', { class: 'muted-sm' }, [t.reporter_name, t.reporter_area, absolute(t.created_at), t.topic].filter(Boolean).join(' · '),
          t.hostname ? [' · ', el('span', { class: 'mono' }, t.hostname)] : '')),
      el('div', { class: 'detail-grid' },
        el('div', { class: 'left' },
          el('section', { class: 'panel' },
            el('h2', { class: 'heading' }, 'Reporte'),
            t.description ? el('p', { class: 'msg', style: 'margin:0' }, t.description) : el('p', { class: 'muted', style: 'margin:0' }, 'Sin texto, solo foto.'),
            photos.length ? el('div', { class: 'photo-grid' }, photos.map((p, i) =>
              el('a', { href: p.url, target: '_blank', rel: 'noopener', 'aria-label': 'Abrir foto ' + (i + 1) }, el('img', { src: p.url, alt: 'Foto ' + (i + 1) })))) : null),
          el('section', { class: 'panel' },
            el('h2', { class: 'heading' }, 'Actividad'),
            el('ol', { class: 'timeline' }, events.map(eventLine)),
            el('div', { class: 'field', style: 'padding-top:16px;border-top:1px solid var(--line)' },
              el('label', { class: 'label', for: 'reply' }, 'Responder a ' + t.reporter_name.split(' ')[0]), reply,
              el('div', { class: 'row-between' },
                el('label', { class: 'checkline' }, internal, 'Nota interna (el empleado no la ve)'),
                sendBtn)))),
        el('div', { class: 'right' },
          el('section', { class: 'panel', 'aria-labelledby': 'atencion' },
            el('h2', { class: 'heading', id: 'atencion' }, 'Atención'),
            el('div', { class: 'field' }, el('span', { class: 'label' }, 'Estado'), statusSeg),
            el('div', { class: 'field' }, el('label', { class: 'label', for: 'assignee' }, 'Asignado a'), assignee),
            el('div', { class: 'field' },
              el('span', { class: 'label' }, 'Tiempo estimado de atención'),
              etaSeg,
              el('label', { class: 'muted-sm', for: 'eta-custom' }, 'u otra fecha y hora:'), custom,
              el('div', { class: 'preview' }, el('span', { class: 'label' }, t.reporter_name.split(' ')[0] + ' verá'), preview)),
            saveBtn, saveMsg))));
    window.scrollTo(0, 0);
  }

  // ---------- Inicio ----------
  (async () => {
    try {
      const { admin, needsSetup } = await api('/api/admin/me');
      if (admin) start(admin); else showLogin(needsSetup);
    } catch (err) { showLogin(); toast(err.message); }
  })();
})();
