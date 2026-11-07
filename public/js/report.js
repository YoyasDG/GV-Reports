'use strict';
(() => {
  const { api, el, icon, relative, absolute, etaPhrase, duration, badge, toast, compressImage } = GV;
  const $ = (id) => document.getElementById(id);

  const QUICK = [
    ['internet', 'Sin internet', 'No tengo internet'],
    ['correo', 'Correo', 'No me abre el correo'],
    ['impresora', 'Impresora', 'No imprime la impresora'],
    ['programa', 'Un programa no abre', 'No abre el programa '],
    ['clave', 'Contraseña', 'Olvidé mi contraseña / estoy bloqueado'],
    ['lenta', 'PC lenta', 'La computadora está muy lenta']
  ];

  const state = { me: null, topic: '', photos: [], blocked: false, sending: false, poll: null };

  // El acceso directo abre /?equipo=NOMBRE-PC. Lo recordamos en este navegador.
  const params = new URLSearchParams(location.search);
  let hostname = (params.get('equipo') || '').trim();
  try {
    if (hostname) localStorage.setItem('gv_equipo', hostname);
    else hostname = localStorage.getItem('gv_equipo') || '';
  } catch { /* almacenamiento no disponible */ }

  // ---------- Vistas ----------
  const VIEWS = ['setup', 'report', 'sent', 'mine', 'detail'];
  function show(name) {
    for (const v of VIEWS) $('view-' + v).hidden = v !== name;
    clearInterval(state.poll);
    if (name === 'mine') state.poll = setInterval(loadMine, 30000);
    window.scrollTo(0, 0);
  }

  function renderWho() {
    if (!state.me) { $('who').hidden = true; return; }
    $('who').hidden = false;
    const host = state.me.hostname || hostname;
    $('who-text').replaceChildren(state.me.name, host ? ' · ' : '', host ? el('span', { class: 'mono' }, host) : '');
  }

  async function route() {
    if (!state.me) return show('setup');
    const h = location.hash;
    const m = /^#r\/(\d+)$/.exec(h);
    if (m) { show('detail'); return loadDetail(Number(m[1])); }
    if (h === '#mis-reportes') { show('mine'); return loadMine(); }
    show('report');
    setTimeout(() => $('desc').focus(), 0);
  }

  // ---------- Identidad ----------
  $('setup-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('setup-error').hidden = true;
    try {
      const host = $('setup-host').value.trim() || hostname;
      const { reporter } = await api('/api/me', { method: 'POST', body: { name: $('setup-name').value, area: $('setup-area').value, hostname: host } });
      state.me = reporter;
      if (host) { hostname = host; try { localStorage.setItem('gv_equipo', host); } catch {} }
      renderWho();
      route();
    } catch (err) {
      $('setup-error').textContent = err.message; $('setup-error').hidden = false;
    }
  });

  $('who-change').addEventListener('click', () => {
    $('setup-name').value = state.me?.name || '';
    $('setup-area').value = state.me?.area || '';
    $('setup-host').value = state.me?.hostname || hostname;
    show('setup');
  });

  // ---------- Reporte rápido ----------
  function renderQuick() {
    $('quick').replaceChildren(...QUICK.map(([id, label, fill]) => el('button', {
      type: 'button', class: 'chip', 'aria-pressed': String(state.topic === id),
      onclick: () => {
        const on = state.topic === id;
        state.topic = on ? '' : id;
        const d = $('desc');
        if (!on && !d.value.trim()) { d.value = fill; d.focus(); d.setSelectionRange(d.value.length, d.value.length); }
        renderQuick();
      }
    }, label)));
  }

  function renderThumbs() {
    const box = $('thumbs');
    box.hidden = state.photos.length === 0;
    box.replaceChildren(...state.photos.map((src, i) => {
      const t = el('div', { class: 'thumb' },
        el('button', { type: 'button', 'aria-label': 'Quitar foto ' + (i + 1), onclick: () => { state.photos.splice(i, 1); renderThumbs(); } }, icon('x', 12, 2)));
      t.style.backgroundImage = `url("${src}")`;
      return t;
    }));
  }

  async function addFiles(files) {
    for (const f of files) {
      if (state.photos.length >= 5) { toast('Máximo 5 fotos por reporte.'); break; }
      try { state.photos.push(await compressImage(f)); }
      catch (err) { toast(err.message); }
    }
    renderThumbs();
  }

  $('photo-input').addEventListener('change', (e) => { addFiles([...e.target.files]); e.target.value = ''; });
  document.addEventListener('paste', (e) => {
    if ($('view-report').hidden) return;
    const files = [...(e.clipboardData?.items || [])].filter((i) => i.type.startsWith('image/')).map((i) => i.getAsFile()).filter(Boolean);
    if (files.length) { e.preventDefault(); addFiles(files); toast('Captura agregada.'); }
  });
  // Arrastrar y soltar imágenes en la ventana.
  document.addEventListener('dragover', (e) => { if (!$('view-report').hidden) e.preventDefault(); });
  document.addEventListener('drop', (e) => {
    if ($('view-report').hidden) return;
    e.preventDefault();
    addFiles([...(e.dataTransfer?.files || [])].filter((f) => f.type.startsWith('image/')));
  });

  $('blocked').addEventListener('click', () => {
    state.blocked = !state.blocked;
    $('blocked').setAttribute('aria-pressed', String(state.blocked));
  });

  async function send() {
    if (state.sending) return;
    const description = $('desc').value.trim();
    $('report-error').hidden = true;
    if (!description && !state.photos.length) {
      $('report-error').textContent = 'Escribe algo o agrega una foto para enviarlo.';
      $('report-error').hidden = false; $('desc').focus(); return;
    }
    state.sending = true;
    $('send').disabled = true; $('send').textContent = 'Enviando…';
    try {
      const topicLabel = (QUICK.find((q) => q[0] === state.topic) || [])[1] || '';
      const { ticket } = await api('/api/tickets', {
        method: 'POST',
        body: { description, topic: topicLabel, blocked: state.blocked, hostname, photos: state.photos }
      });
      $('sent-folio').textContent = ticket.folio;
      $('sent-queue').textContent = ticket.queue
        ? (ticket.queue.position === 1 ? '#1 · al frente' : `#${ticket.queue.position} de ${ticket.queue.total}`)
        : '—';
      resetForm();
      show('sent');
    } catch (err) {
      $('report-error').textContent = err.status === 401 ? 'Tu sesión se perdió. Dinos de nuevo quién eres.' : err.message;
      $('report-error').hidden = false;
      if (err.status === 401) { state.me = null; renderWho(); show('setup'); }
    } finally {
      state.sending = false;
      $('send').disabled = false; $('send').textContent = 'Enviar a Sistemas';
    }
  }

  function resetForm() {
    $('desc').value = ''; state.topic = ''; state.photos = []; state.blocked = false;
    $('blocked').setAttribute('aria-pressed', 'false');
    renderQuick(); renderThumbs();
  }

  $('send').addEventListener('click', send);
  $('desc').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send(); });
  $('again').addEventListener('click', () => { location.hash = ''; route(); });
  $('new-report').addEventListener('click', (e) => { e.preventDefault(); history.replaceState(null, '', location.pathname + location.search); route(); });

  // ---------- Mis reportes ----------
  function etaBlock(t) {
    if (t.status === 'resuelto') {
      return el('div', { class: 'row-between muted-sm' },
        el('span', {}, '¡Listo! Atendido en ' + duration(t.created_at, t.resolved_at || t.updated_at) + '.'),
        el('a', { href: '#r/' + t.id }, '¿Volvió a fallar?'));
    }
    const box = el('div', { class: 'eta-box' });
    if (t.eta_at) {
      box.append(el('div', { class: 'eta-line' }, icon('clock', 18), 'Te atendemos: ' + etaPhrase(t.eta_at)));
      const total = new Date(t.eta_at) - new Date(t.created_at);
      const pct = Math.max(4, Math.min(100, Math.round(((Date.now() - new Date(t.created_at)) / total) * 100)));
      const bar = el('div', { class: 'progress' + (pct >= 100 ? ' late' : ''), role: 'progressbar', 'aria-label': 'Avance del tiempo estimado', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct) }, el('div'));
      bar.firstChild.style.width = pct + '%';
      box.append(bar);
    } else if (t.status === 'en_espera') {
      box.append(el('div', { class: 'eta-line muted' }, icon('clock', 18), 'En espera'));
    } else {
      box.append(el('div', { class: 'eta-line muted' }, icon('clock', 18), 'Sistemas te asignará un horario en breve.'));
    }
    if (t.last_message) box.append(el('div', { class: 'muted-sm' }, (t.last_message.author_name || 'Sistemas') + ': “' + t.last_message.body + '”'));
    return box;
  }

  function statusBadge(t) {
    if (t.status === 'nuevo' && t.queue) return badge('nuevo', 'En fila · #' + t.queue.position);
    return badge(t.status, t.status_label);
  }

  function ticketCard(t) {
    return el('article', { class: 'card stack-sm', style: 'gap:12px' },
      el('div', { class: 'row-between' },
        el('div', { class: 'row' },
          el('span', { class: 'mono muted' }, t.folio),
          el('span', { class: 'muted-sm' }, relative(t.created_at) + (t.photo_count ? ` · ${t.photo_count} foto${t.photo_count > 1 ? 's' : ''}` : ''))),
        el('div', { class: 'row' }, t.blocked && t.status !== 'resuelto' ? badge('urgente', 'No puedo trabajar') : null, statusBadge(t))),
      el('h2', { class: 'heading' }, el('a', { href: '#r/' + t.id, style: 'color:inherit;text-decoration:none' }, summary(t))),
      etaBlock(t));
  }

  function summary(t) {
    const s = t.description || t.topic || 'Reporte con foto';
    return s.length > 90 ? s.slice(0, 88) + '…' : s;
  }

  async function loadMine() {
    try {
      const { tickets } = await api('/api/my/tickets');
      const list = $('mine-list');
      if (!tickets.length) {
        list.replaceChildren(el('div', { class: 'card empty' }, 'Todavía no has enviado reportes. Todo en orden por aquí.'));
        return;
      }
      list.replaceChildren(...tickets.map(ticketCard));
    } catch (err) { toast(err.message); }
  }

  // ---------- Detalle ----------
  async function loadDetail(id) {
    const body = $('detail-body');
    body.replaceChildren(el('p', { class: 'muted' }, 'Cargando…'));
    try {
      const { ticket: t, photos, events } = await api('/api/my/tickets/' + id);
      const reply = el('textarea', { class: 'textarea', id: 'reply', rows: '3', maxlength: '2000', placeholder: t.status === 'resuelto' ? 'Cuéntanos qué volvió a pasar…' : 'Agrega un dato o responde a Sistemas…' });
      const btn = el('button', { type: 'button', class: 'btn btn-primary' }, t.status === 'resuelto' ? 'Reabrir reporte' : 'Enviar');
      btn.addEventListener('click', async () => {
        if (!reply.value.trim()) return reply.focus();
        btn.disabled = true;
        try {
          await api(`/api/my/tickets/${id}/messages`, { method: 'POST', body: { body: reply.value, reopen: t.status === 'resuelto' } });
          toast(t.status === 'resuelto' ? 'Reabrimos tu reporte.' : 'Mensaje enviado.');
          loadDetail(id);
        } catch (err) { toast(err.message); btn.disabled = false; }
      });

      body.replaceChildren(
        el('div', { class: 'stack-sm' },
          el('div', { class: 'row' }, el('span', { class: 'mono muted' }, t.folio), statusBadge(t), t.blocked && t.status !== 'resuelto' ? badge('urgente', 'No puedo trabajar') : null),
          el('h1', { class: 'title', id: 'detail-title' }, summary(t)),
          el('span', { class: 'muted-sm' }, absolute(t.created_at) + (t.assignee_name ? ' · Atiende: ' + t.assignee_name : ''))),
        etaBlock(t),
        t.description ? el('p', { class: 'msg', style: 'margin:0' }, t.description) : null,
        photos.length ? el('div', { class: 'photo-grid' }, photos.map((p, i) => el('a', { href: p.url, target: '_blank', rel: 'noopener' }, el('img', { src: p.url, alt: 'Foto ' + (i + 1) + ' del reporte' })))) : null,
        el('section', { class: 'panel' },
          el('h2', { class: 'heading' }, 'Conversación'),
          el('ol', { class: 'timeline' }, events.filter((e) => e.kind === 'message' || e.kind === 'created' || e.kind === 'reopened').map((e) =>
            el('li', {},
              el('div', { class: 'avatar' + (e.author_kind === 'admin' ? ' av-adm' : '') , 'aria-hidden': 'true' }, GV.initials(e.author_name)),
              el('div', { class: 'stack-sm', style: 'gap:2px' },
                el('div', {}, el('b', {}, e.author_name || 'Sistemas'), ' ', e.kind === 'created' ? 'envió el reporte' : e.kind === 'reopened' ? 'reabrió el reporte' : ''),
                e.kind === 'message' ? el('div', { class: 'msg' }, e.body) : null,
                el('div', { class: 'muted-sm' }, relative(e.created_at)))))),
          el('div', { class: 'field' }, el('label', { class: 'label', for: 'reply' }, t.status === 'resuelto' ? '¿Volvió a fallar?' : 'Responder'), reply),
          el('div', { class: 'row', style: 'justify-content:flex-end' }, btn)));
    } catch (err) {
      body.replaceChildren(el('div', { class: 'notice notice-error' }, err.message));
    }
  }

  // ---------- Inicio ----------
  $('cam-icon').replaceWith(icon('camera'));
  $('plus-icon').replaceWith(icon('plus', 18, 1.75));
  $('sent-icon').append(icon('check', 32, 1.75));
  renderQuick();
  window.addEventListener('hashchange', route);

  (async () => {
    try {
      const { reporter } = await api('/api/me' + (hostname ? '?equipo=' + encodeURIComponent(hostname) : ''));
      state.me = reporter;
      if (!reporter) $('setup-host').value = hostname;
    } catch (err) { toast(err.message); }
    renderWho();
    route();
  })();
})();
