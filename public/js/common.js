'use strict';
// Utilidades compartidas (empleado y administrador).

const GV = (() => {
  async function api(path, { method = 'GET', body } = {}) {
    const res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined
    });
    let data = {};
    try { data = await res.json(); } catch { /* sin cuerpo */ }
    if (!res.ok) {
      const err = new Error(data.error || 'No pudimos conectar con el servidor.');
      err.status = res.status;
      throw err;
    }
    return data;
  }

  // Crea elementos sin innerHTML: el('div', {class:'x', onclick}, 'texto', otroNodo)
  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else if (k === 'dataset') Object.assign(node.dataset, v);
      else node.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) {
      if (c === null || c === undefined || c === false) continue;
      node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return node;
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const ICONS = {
    clock: ['circle:10,10,7', 'path:M10 6v4l3 2'],
    camera: ['path:M3 7.5A1.5 1.5 0 0 1 4.5 6h1.8l1.2-2h5l1.2 2h1.8A1.5 1.5 0 0 1 17 7.5v7a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 14.5z', 'circle:10,10.5,2.75'],
    x: ['path:M5 5l10 10M15 5L5 15'],
    plus: ['path:M10 4v12M4 10h12'],
    check: ['path:M4.5 10.5l3.5 3.5 7.5-8'],
    back: ['path:M12 5l-5 5 5 5']
  };
  function icon(name, size = 20, strokeWidth = 1.5) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('width', size); svg.setAttribute('height', size);
    svg.setAttribute('viewBox', '0 0 20 20'); svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', strokeWidth);
    svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    for (const spec of ICONS[name] || []) {
      const [shape, val] = spec.split(':');
      const n = document.createElementNS(SVG_NS, shape);
      if (shape === 'path') n.setAttribute('d', val);
      else { const [cx, cy, r] = val.split(','); n.setAttribute('cx', cx); n.setAttribute('cy', cy); n.setAttribute('r', r); }
      svg.append(n);
    }
    return svg;
  }

  const LOCALE = 'es-MX';
  const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const time = (d) => d.toLocaleTimeString(LOCALE, { hour: 'numeric', minute: '2-digit' });

  function relative(iso) {
    const d = new Date(iso);
    const diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 60) return 'hace un momento';
    if (diff < 3600) return `hace ${Math.round(diff / 60)} min`;
    if (diff < 86400 && sameDay(d, new Date())) return `hace ${Math.round(diff / 3600)} h`;
    const y = new Date(); y.setDate(y.getDate() - 1);
    if (sameDay(d, y)) return 'ayer, ' + time(d);
    return d.toLocaleDateString(LOCALE, { day: 'numeric', month: 'short' });
  }

  function absolute(iso) {
    const d = new Date(iso);
    return d.toLocaleDateString(LOCALE, { day: 'numeric', month: 'short', year: 'numeric' }) + ', ' + time(d);
  }

  // "Hoy antes de las 13:00", "Mañana antes de las 10:00", "lun 9 nov, antes de las 12:00"
  function etaPhrase(iso) {
    const d = new Date(iso);
    const today = new Date();
    const tomorrow = new Date(); tomorrow.setDate(today.getDate() + 1);
    if (sameDay(d, today)) return 'Hoy antes de las ' + time(d);
    if (sameDay(d, tomorrow)) return 'Mañana antes de las ' + time(d);
    return d.toLocaleDateString(LOCALE, { weekday: 'short', day: 'numeric', month: 'short' }) + ', antes de las ' + time(d);
  }

  function duration(fromIso, toIso) {
    const mins = Math.max(1, Math.round((new Date(toIso) - new Date(fromIso)) / 60000));
    if (mins < 60) return mins + ' min';
    const h = Math.floor(mins / 60), m = mins % 60;
    if (h < 24) return h + ' h' + (m ? ' ' + m + ' min' : '');
    const d = Math.floor(h / 24);
    return d + (d === 1 ? ' día' : ' días') + (h % 24 ? ' ' + (h % 24) + ' h' : '');
  }

  function badge(status, label) {
    return el('span', { class: 'badge b-' + status }, label);
  }

  function initials(name) {
    return String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
  }

  let toastTimer;
  function toast(msg) {
    let t = document.querySelector('.toast');
    if (!t) { t = el('div', { class: 'toast', role: 'status' }); document.body.append(t); }
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
  }

  // Reduce fotos a JPEG ≤1600 px para que suban rápido desde cualquier red.
  function compressImage(file, maxSide = 1600, quality = 0.82) {
    return new Promise((resolve, reject) => {
      if (!file.type.startsWith('image/')) return reject(new Error('Solo se aceptan imágenes.'));
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('No pudimos leer esa imagen. Prueba con JPG o PNG.')); };
      img.src = url;
    });
  }

  return { api, el, icon, relative, absolute, etaPhrase, duration, badge, initials, toast, compressImage };
})();
