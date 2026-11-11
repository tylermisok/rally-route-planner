(() => {
  'use strict';
  const E = window.RallyEngine;
  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k, d) { try { const v = localStorage.getItem('rrp:' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('rrp:' + k, JSON.stringify(v)); } catch { /* storage full or blocked */ } }
  };
  const toMin = hhmm => { const [h, m] = String(hhmm || '0:0').split(':').map(Number); return h * 60 + (m || 0); };
  const toHHMM = m => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(Math.round(m % 60)).padStart(2, '0')}`;
  const fmtH = m => `${Math.floor(m / 60)}h ${String(Math.round(m % 60)).padStart(2, '0')}m`;
  const fmtN = n => Math.round(n).toLocaleString();

  const DEFAULTS = { range: 250, mpg: 40, reserve: 15, mph: 50, stopMin: 10, fuelMin: 10, start: '07:00', end: '17:00', buffer: 30,
    depth: 'standard', winMargin: 5, sunrise: '07:00', sunset: '17:30', fuelPrice: 3.25, calib: 0.8, autoExtra: 'true' };
  const S = { ...DEFAULTS, ...store.get('settings', {}) };
  const BUDGET = { quick: 8000, standard: 20000, deep: 60000 };
  const PALETTE = ['#f5d18a', '#f2a65a', '#e4572e', '#b5325b', '#6b2160'];

  const st = {
    files: [], book: null, csv: null, gpx: null, data: null,
    places: [], startIdx: 0, finishIdx: -1, custom: { start: null, finish: null },
    required: new Set(store.get('required', [])), excluded: new Set(store.get('excluded', [])),
    matrix: null, results: {}, active: 'max', running: false, pick: null, bins: []
  };

  // ------------------------------------------------------------ toast
  let toastT;
  function toast(msg, ms = 2600) { const t = $('#toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), ms); }

  // ------------------------------------------------------------ theme + map
  const map = L.map('map', { zoomControl: false, attributionControl: true }).setView([37.5, -92], 4);
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  map.createPane('labels').style.zIndex = 350; // town names above the base map, below routes and markers
  map.getPane('labels').style.pointerEvents = 'none';
  let tiles = [];
  function isDark() {
    const t = document.documentElement.dataset.theme;
    return t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  }
  function setTiles() {
    tiles.forEach(t => map.removeLayer(t));
    const tone = isDark() ? 'Dark' : 'Light';
    const esri = s => `https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_${tone}_Gray_${s}/MapServer/tile/{z}/{y}/{x}`;
    tiles = [
      L.tileLayer(esri('Base'), { maxZoom: 16, attribution: 'Tiles © <a href="https://www.esri.com">Esri</a>, HERE, Garmin, © OpenStreetMap contributors' }),
      L.tileLayer(esri('Reference'), { maxZoom: 16, pane: 'labels' })
    ];
    tiles.forEach(t => t.addTo(map));
  }
  const savedTheme = store.get('theme', null);
  if (savedTheme) document.documentElement.dataset.theme = savedTheme;
  setTiles();
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (!document.documentElement.dataset.theme) setTiles(); });
  $('#theme').onclick = () => {
    const next = isDark() ? 'light' : 'dark';
    document.documentElement.dataset.theme = next; store.set('theme', next); setTiles(); drawRoute();
  };
  const layers = { bonus: L.layerGroup().addTo(map), route: L.layerGroup().addTo(map), pins: L.layerGroup().addTo(map), ends: L.layerGroup().addTo(map) };
  const markerOf = new Map();

  // ------------------------------------------------------------ settings form
  function bindForm() {
    document.querySelectorAll('[data-key]').forEach(el => {
      const k = el.dataset.key;
      el.value = S[k];
      el.addEventListener('input', () => {
        S[k] = el.type === 'number' || el.type === 'range' ? +el.value : el.value;
        // the mph box and slider share one setting: mirror the edit into the other control
        document.querySelectorAll(`[data-key="${k}"]`).forEach(o => { if (o !== el) o.value = S[k]; });
        store.set('settings', S); refreshPace();
      });
    });
    document.querySelectorAll('#depth button').forEach(b => {
      b.classList.toggle('on', b.dataset.v === S.depth);
      b.onclick = () => { S.depth = b.dataset.v; store.set('settings', S); document.querySelectorAll('#depth button').forEach(x => x.classList.toggle('on', x === b)); };
    });
    refreshPace();
  }
  // Average posted-limit speed over this rally's typical legs (10-150 mi), from the road matrix.
  // Entering X mph scales every leg by X / this, so interstates stay faster than towns.
  function refMph() {
    const mx = st.matrix; if (!mx) return null;
    let mi = 0, h = 0;
    for (let k = 0; k < mx.n * mx.n; k++) {
      const m = mx.m[k], sec = mx.sec[k];
      if (!m || !sec) continue;
      const x = m / 1609.344; if (x < 10 || x > 150) continue;
      mi += x; h += sec * (+S.calib) / 3600;
    }
    return h ? mi / h : null;
  }
  function pacePct() { const r = refMph() || 56; return 100 * (+S.mph) / r; }
  function refreshPace() {
    const v = +S.mph || 0, el = $('#mphRange');
    el.style.setProperty('--p', Math.max(0, Math.min(100, (v - 30) / 70 * 100)) + '%');
    const r = refMph();
    if (!r) { $('#paceHint').innerHTML = 'Your speed is applied road by road (faster on interstates, slower in towns) once road distances are measured.'; return; }
    const p = Math.round(100 * v / r);
    $('#paceHint').innerHTML = `Riding at the posted limits averages <b>${r.toFixed(0)} mph</b> on this rally's roads, so ${v} mph is <b>${p}%</b> of the limits` +
      (p > 100 ? `. <span class="over">This assumes riding above posted limits.</span>` : `: about ${Math.round(70 * p / 100)} mph where the limit is 70 and ${Math.round(55 * p / 100)} mph where it is 55.`);
  }
  function tryCachedMatrix() {
    if (!st.data || !startPoint()) return;
    const pts = matrixPoints();
    const key = hash(pts.map(p => p.lat.toFixed(5) + ',' + p.lon.toFixed(5)).join(';'));
    const cached = store.get('matrix', null);
    if (cached && cached.key === key) { st.matrix = cached; refreshPace(); }
  }

  // ------------------------------------------------------------ files
  const drop = $('#drop');
  ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', e => addFiles([...e.dataTransfer.files]));
  document.addEventListener('dragover', e => e.preventDefault());
  document.addEventListener('drop', e => { e.preventDefault(); if (e.dataTransfer.files.length) addFiles([...e.dataTransfer.files]); });
  $('#fileIn').addEventListener('change', e => { addFiles([...e.target.files]); e.target.value = ''; });

  function kindOf(f) {
    const x = f.name.toLowerCase().split('.').pop();
    return x === 'pdf' ? 'PDF' : x === 'gpx' ? 'GPX' : (x === 'csv' || x === 'tsv') ? 'CSV' : x === 'txt' ? 'TXT' : null;
  }
  async function addFiles(list) {
    for (const f of list) {
      const k = kindOf(f);
      if (!k) { toast(`Skipped ${f.name}: use PDF, CSV or GPX`); continue; }
      st.files = st.files.filter(x => x.name !== f.name);
      st.files.push({ name: f.name, kind: k, file: f, status: 'reading' });
    }
    renderChips();
    await parseAll();
  }
  function renderChips() {
    $('#fileChips').innerHTML = st.files.map((f, i) =>
      `<span class="chip" title="${esc(f.name)}"><b>${f.kind}</b><i>${esc(f.name)}</i>${f.status === 'reading' ? '…' : f.status === 'error' ? '⚠' : ''}<button class="x" data-i="${i}" title="Remove">✕</button></span>`).join('');
    $('#fileChips').querySelectorAll('.x').forEach(b => b.onclick = e => { e.preventDefault(); st.files.splice(+b.dataset.i, 1); renderChips(); parseAll(); });
  }

  let pdfReady = null;
  function initPdf() {
    if (pdfReady) return pdfReady;
    const url = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    // the worker is fetched, checked against a pinned SHA-384 hash, then started from a same-origin blob
    const pinned = 'SnzOobpRMLXZ52iJvZm/C0fYw0OQemTXzTjIsdsfMcrCtCEe9qgzxTd3RSklO5x2';
    pdfReady = fetch(url).then(r => r.arrayBuffer()).then(async buf => {
      const h = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-384', buf))));
      if (h !== pinned) throw new Error('PDF reader failed its integrity check');
      pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([buf], { type: 'text/javascript' }));
    });
    pdfReady.catch(err => { pdfReady = null; toast(err.message || 'Could not load the PDF reader'); });
    return pdfReady;
  }
  async function pdfLines(buf) {
    await initPdf();
    const pdf = await pdfjsLib.getDocument({ data: buf, isEvalSupported: false }).promise;
    const out = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      const tc = await (await pdf.getPage(p)).getTextContent();
      const rows = [];
      for (const it of tc.items) {
        if (!it.str) continue;
        const x = it.transform[4], y = it.transform[5], h = Math.abs(it.transform[3]) || 10;
        let r = rows.find(r => Math.abs(r.y - y) < h * 0.45);
        if (!r) { r = { y, h, items: [] }; rows.push(r); }
        r.items.push({ x, w: it.width, s: it.str });
      }
      rows.sort((a, b) => b.y - a.y);
      for (const r of rows) {
        r.items.sort((a, b) => a.x - b.x);
        let s = '', end = null;
        for (const it of r.items) {
          if (end != null) {
            const gap = it.x - end;
            if (gap > r.h * 1.5) s = s.replace(/\s+$/, '') + '    ';
            else if (gap > r.h * 0.12 && !/\s$/.test(s) && !/^\s/.test(it.s)) s += ' ';
          }
          s += it.s; end = it.x + it.w;
        }
        if (s.trim()) out.push(s);
      }
      out.push('*'.repeat(20));
    }
    return out;
  }

  async function parseAll() {
    st.csv = st.gpx = st.book = null;
    const csvs = [], gpxs = [], books = [];
    for (const f of st.files) {
      try {
        if (f.kind === 'CSV') {
          const buf = await f.file.arrayBuffer();
          let text = new TextDecoder('utf-8').decode(buf);
          if (text.includes('�')) text = new TextDecoder('windows-1252').decode(buf);
          csvs.push(E.parseCSV(text));
        } else if (f.kind === 'GPX') gpxs.push(E.parseGPX(await f.file.text()));
        else if (f.kind === 'PDF') books.push(await pdfLines(await f.file.arrayBuffer()));
        else if (f.kind === 'TXT') books.push((await f.file.text()).split(/\r?\n/));
        f.status = 'ok';
      } catch (err) { console.error(err); f.status = 'error'; toast(`Could not read ${f.name}`); }
    }
    renderChips();
    if (csvs.length) st.csv = { rows: csvs.flatMap(c => c.rows), warnings: csvs.flatMap(c => c.warnings) };
    if (gpxs.length) st.gpx = { wpts: gpxs.flatMap(g => g.wpts) };
    const known = new Set([...(st.csv ? st.csv.rows.map(r => r.code) : [])]);
    if (st.gpx) st.gpx.wpts.forEach(w => { const c = (w.name || '').trim().split(/[\s\-_:,]+/)[0]; if (/^[A-Z0-9]{3,8}$/.test(c) && /[A-Z]/.test(c)) known.add(c); });
    if (books.length) st.book = E.parseBook(books.flat(), known);
    if (!st.files.length) { st.data = null; renderAll(); return; }
    st.data = E.merge({ book: st.book, csv: st.csv, gpx: st.gpx });
    if (st.csv) st.csv.warnings.forEach(w => st.data.issues.push({ level: 'warn', text: w }));
    if (st.book && st.book.rally.start != null) {
      S.start = toHHMM(st.book.rally.start); S.end = toHHMM(st.book.rally.end);
      $('#start').value = S.start; $('#end').value = S.end; store.set('settings', S);
      toast(`Rally hours read from the book: ${E.fmtTime(st.book.rally.start)} to ${E.fmtTime(st.book.rally.end)}`);
    }
    st.places = st.data.places.slice();
    st.startIdx = st.data.start ? st.places.findIndex(p => p.name === st.data.start.name) : -1;
    st.finishIdx = -1;
    st.matrix = null; st.results = {};
    tryCachedMatrix();
    renderAll();
  }

  // ------------------------------------------------------------ start / finish
  function startPoint() { return st.custom.start || st.places[st.startIdx] || null; }
  function finishPoint() { return st.finishIdx === -2 ? st.custom.finish : st.finishIdx >= 0 ? st.places[st.finishIdx] : startPoint(); }
  function renderEnds() {
    const opts = st.places.map((p, i) => `<option value="${i}">${esc(p.name)}</option>`).join('');
    $('#startPt').innerHTML = (st.custom.start ? `<option value="-2">Map point (${st.custom.start.lat.toFixed(4)}, ${st.custom.start.lon.toFixed(4)})</option>` : '') + opts + (!st.places.length && !st.custom.start ? '<option value="-1">Set the start on the map</option>' : '');
    $('#startPt').value = st.custom.start ? -2 : st.startIdx;
    $('#finishPt').innerHTML = '<option value="-1">Same as start</option>' + (st.custom.finish ? `<option value="-2">Map point (${st.custom.finish.lat.toFixed(4)}, ${st.custom.finish.lon.toFixed(4)})</option>` : '') + opts;
    $('#finishPt').value = st.finishIdx;
    layers.ends.clearLayers();
    const s = startPoint(), f = finishPoint();
    if (s) L.marker([s.lat, s.lon], { icon: L.divIcon({ className: '', html: '<div class="pin hq">★</div>', iconSize: [30, 30], iconAnchor: [15, 15] }), zIndexOffset: 1000 }).bindTooltip(`Start: ${esc(s.name)}`).addTo(layers.ends);
    if (f && s && (f.lat !== s.lat || f.lon !== s.lon)) L.marker([f.lat, f.lon], { icon: L.divIcon({ className: '', html: '<div class="pin hq">⚑</div>', iconSize: [30, 30], iconAnchor: [15, 15] }), zIndexOffset: 1000 }).bindTooltip(`Finish: ${esc(f.name)}`).addTo(layers.ends);
  }
  $('#startPt').onchange = e => { const v = +e.target.value; if (v !== -2) { st.custom.start = null; st.startIdx = v; } st.matrix = null; tryCachedMatrix(); refreshPace(); renderEnds(); updateGo(); };
  $('#finishPt').onchange = e => { const v = +e.target.value; if (v !== -2) st.custom.finish = null; st.finishIdx = v; st.matrix = null; tryCachedMatrix(); refreshPace(); renderEnds(); };
  document.querySelectorAll('[data-pick]').forEach(b => b.onclick = e => { e.preventDefault(); st.pick = b.dataset.pick; $('#maptip').classList.add('on'); map.getContainer().style.cursor = 'crosshair'; });
  function endPick() { st.pick = null; $('#maptip').classList.remove('on'); map.getContainer().style.cursor = ''; }
  document.addEventListener('keydown', e => { if (e.key === 'Escape') endPick(); });
  map.on('click', e => {
    if (!st.pick) return;
    const pt = { name: `Map point`, lat: e.latlng.lat, lon: e.latlng.lng };
    if (st.pick === 'start') st.custom.start = pt; else { st.custom.finish = pt; st.finishIdx = -2; }
    endPick(); st.matrix = null; tryCachedMatrix(); refreshPace(); renderEnds(); updateGo();
  });

  // ------------------------------------------------------------ rendering
  function binOf(p) { let k = 0; while (k < st.bins.length && p > st.bins[k]) k++; return k; }
  function renderAll() {
    const d = st.data;
    $('#welcome').style.display = d ? 'none' : '';
    $('#bonusCard').hidden = !d; $('#issueCard').hidden = !d; $('#legend').hidden = !d;
    if (!d) { $('#stats').hidden = true; layers.bonus.clearLayers(); layers.route.clearLayers(); layers.pins.clearLayers(); layers.ends.clearLayers(); $('#resCard').hidden = true; updateGo(); return; }
    const pts = d.bonuses.map(b => b.points).sort((a, b) => a - b);
    const q = f => pts[Math.min(pts.length - 1, Math.floor(f * pts.length))] || 0;
    st.bins = [q(0.2), q(0.4), q(0.6), q(0.8)];
    const routable = d.bonuses.filter(b => b.rlat != null);
    const hrs = st.book && st.book.rally.start != null ? `${E.fmtTime(st.book.rally.start).replace(':00 ', '')}–${E.fmtTime(st.book.rally.end).replace(':00 ', '')}` : '—';
    $('#stats').hidden = false;
    $('#stats').innerHTML = [
      [routable.length, 'bonuses'], [d.combos.length, 'combos'], [fmtN(d.bonuses.reduce((a, b) => a + b.points, 0)), 'total pts'], [hrs, 'rally hours']
    ].map(([v, k]) => `<div class="stat"><div class="v">${v}</div><div class="k">${k}</div></div>`).join('');
    renderLegend(); renderMarkers(); renderEnds(); renderList(); renderIssues(); updateGo();
    const ll = routable.map(b => [b.lat, b.lon]);
    if (startPoint()) ll.push([startPoint().lat, startPoint().lon]);
    if (ll.length && !Object.keys(st.results).length) map.fitBounds(ll, { padding: [40, 40] });
  }
  function renderLegend() {
    const b = st.bins, labels = [`≤ ${b[0]}`, `${b[0] + 1}–${b[1]}`, `${b[1] + 1}–${b[2]}`, `${b[2] + 1}–${b[3]}`, `> ${b[3]}`];
    $('#legend').innerHTML = '<b>Points</b>' + labels.map((l, i) => `<div class="row"><span class="sw" style="background:${PALETTE[i]}"></span>${l}</div>`).join('') +
      `<div class="row"><span class="sw" style="background:transparent;border:2px solid var(--ink)"></span>has time window</div>`;
  }
  function popupHtml(b) {
    const must = st.required.has(b.code), skip = st.excluded.has(b.code);
    return `<div class="pop"><h4><code>${esc(b.code)}</code>${esc(b.name)}</h4>
      <div class="m">${esc(b.city)}${b.city ? ' · ' : ''}<b>${b.points}</b> pts · ${esc(E.windowText(b.win))}</div>
      ${b.proof ? `<div class="pr">${esc(b.proof)}</div>` : ''}
      ${b.notes.map(n => `<div class="nt">${esc(n)}</div>`).join('')}
      <div class="b"><button class="btn" data-act="must" data-code="${esc(b.code)}">${must ? '✓ Must visit' : 'Must visit'}</button><button class="btn" data-act="skip" data-code="${esc(b.code)}">${skip ? '✕ Skipped' : 'Skip'}</button></div></div>`;
  }
  function renderMarkers() {
    layers.bonus.clearLayers(); markerOf.clear();
    const inRoute = new Set((st.results[st.active] || {}).route || []);
    for (const b of st.data.bonuses) {
      if (b.lat == null) continue;
      const k = binOf(b.points), skip = st.excluded.has(b.code);
      const m = L.circleMarker([b.lat, b.lon], {
        radius: 4 + k * 1.6, color: b.win.type === 'open' ? 'rgba(0,0,0,.35)' : (isDark() ? '#fff' : '#1c1915'),
        weight: b.win.type === 'open' ? 1 : 2.2, fillColor: PALETTE[k], fillOpacity: skip ? 0.15 : inRoute.size && !inRoute.has(b.code) ? 0.45 : 0.95, opacity: skip ? 0.3 : 1
      }).bindTooltip(esc(`${b.code} · ${b.points}${b.win.type !== 'open' ? ' · ' + E.windowText(b.win) : ''}`), { direction: 'top', offset: [0, -4] })
        .bindPopup(() => popupHtml(b), { maxWidth: 300 });
      m.addTo(layers.bonus); markerOf.set(b.code, m);
    }
  }
  map.on('popupopen', e => {
    e.popup.getElement().querySelectorAll('[data-act]').forEach(btn => btn.onclick = () => {
      toggle(btn.dataset.code, btn.dataset.act); e.popup.setContent(popupHtml(st.data.bonuses.find(b => b.code === btn.dataset.code)));
      map.fire('popupopen', { popup: e.popup });
    });
  });
  function toggle(code, act) {
    const a = act === 'must' ? st.required : st.excluded, o = act === 'must' ? st.excluded : st.required;
    if (a.has(code)) a.delete(code); else { a.add(code); o.delete(code); }
    store.set('required', [...st.required]); store.set('excluded', [...st.excluded]);
    renderList(); renderMarkers();
  }
  function renderList() {
    const q = ($('#q').value || '').trim().toLowerCase();
    const inRoute = new Set((st.results[st.active] || {}).route || []);
    const rows = st.data.bonuses.filter(b => !q || (b.code + ' ' + b.name + ' ' + b.city).toLowerCase().includes(q)).sort((a, b) => b.points - a.points);
    $('#bonusCount').textContent = `${rows.length} shown`;
    $('#blist').innerHTML = rows.map(b => `<div class="brow${inRoute.has(b.code) ? ' inr' : ''}" data-code="${esc(b.code)}">
      <span class="sw" style="background:${PALETTE[binOf(b.points)]}"></span><code>${esc(b.code)}</code>
      <span class="nm" title="${esc(b.name)}">${esc(b.name)}${b.win.type !== 'open' ? ` <span class="tag win">${esc(E.windowText(b.win))}</span>` : ''}</span>
      <span class="pt">${b.points}</span>
      <span class="tg"><button class="must${st.required.has(b.code) ? ' on' : ''}" data-act="must" title="Must visit">MUST</button><button class="skip${st.excluded.has(b.code) ? ' on' : ''}" data-act="skip" title="Never visit">SKIP</button></span></div>`).join('') || '<div class="empty">No matches</div>';
    $('#blist').querySelectorAll('.brow').forEach(r => r.onclick = e => {
      const act = e.target.dataset.act;
      if (act) { toggle(r.dataset.code, act); return; }
      const m = markerOf.get(r.dataset.code); if (m) { map.setView(m.getLatLng(), Math.max(map.getZoom(), 11)); m.openPopup(); }
    });
  }
  $('#q').addEventListener('input', () => renderList());
  function renderIssues() {
    const list = [...st.data.issues, ...((st.results[st.active] || {}).notes || []).map(t => ({ level: 'warn', text: t }))];
    list.push({ level: 'info', text: 'Bonus windows are read as local time at the bonus. Photos are planned at least the "window margin" before a window closes.' });
    list.push({ level: 'info', text: '"Finish" means arriving at the finish point. The plan targets the deadline minus your safety buffer.' });
    if (st.book && st.book.rally.penaltyText) list.push({ level: 'info', text: 'From the book: ' + st.book.rally.penaltyText.slice(0, 400) });
    $('#issues').innerHTML = list.map(i => `<li><span class="ic ${i.level}"></span><span>${esc(i.text)}</span></li>`).join('');
  }
  function updateGo() {
    const ok = st.data && startPoint() && !st.running;
    $('#go').disabled = !ok;
    $('#goLbl').textContent = st.running ? 'Searching…' : !st.data ? 'Load rally files to begin' : !startPoint() ? 'Set a start point' : Object.keys(st.results).length ? 'Search again' : 'Find best route';
  }

  // ------------------------------------------------------------ routing matrix
  const OSRM = 'https://router.project-osrm.org';
  function matrixPoints() {
    const s = startPoint(), f = finishPoint();
    return [s, f, ...st.data.bonuses.filter(b => b.rlat != null).map(b => ({ lat: b.rlat, lon: b.rlon }))];
  }
  function hash(str) { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); }
  async function fetchJSON(url, tries = 5) {
    for (let a = 0; a < tries; a++) {
      try { const r = await fetch(url); if (r.ok) { const j = await r.json(); if (j.code === 'Ok') return j; } } catch { /* retry */ }
      await new Promise(r => setTimeout(r, 1100 * (a + 1)));
    }
    throw new Error('Routing service did not respond');
  }
  async function getMatrix(onProg) {
    const pts = matrixPoints();
    const key = hash(pts.map(p => p.lat.toFixed(5) + ',' + p.lon.toFixed(5)).join(';'));
    const cached = store.get('matrix', null);
    if (cached && cached.key === key) return cached;
    const n = pts.length, B = 40, sec = new Array(n * n).fill(null), m = new Array(n * n).fill(null);
    const blocks = []; for (let i = 0; i < n; i += B) for (let j = 0; j < n; j += B) blocks.push([i, j]);
    let done = 0;
    for (const [i0, j0] of blocks) {
      const I = [], J = []; for (let i = i0; i < Math.min(n, i0 + B); i++) I.push(i); for (let j = j0; j < Math.min(n, j0 + B); j++) J.push(j);
      const idx = [...new Set([...I, ...J])].sort((a, b) => a - b), pos = new Map(idx.map((k, p) => [k, p]));
      const coords = idx.map(k => `${pts[k].lon.toFixed(6)},${pts[k].lat.toFixed(6)}`).join(';');
      const j = await fetchJSON(`${OSRM}/table/v1/driving/${coords}?sources=${I.map(k => pos.get(k)).join(';')}&destinations=${J.map(k => pos.get(k)).join(';')}&annotations=duration,distance`);
      I.forEach((a, ai) => J.forEach((b, bi) => { sec[a * n + b] = j.durations[ai][bi]; m[a * n + b] = j.distances[ai][bi]; }));
      onProg(++done / blocks.length);
      await new Promise(r => setTimeout(r, 1100)); // the public OSRM server allows 1 request per second
    }
    const out = { key, n, sec: sec.map(v => v == null ? null : Math.round(v)), m: m.map(v => v == null ? null : Math.round(v)) };
    store.set('matrix', out);
    return out;
  }

  // ------------------------------------------------------------ optimisation (parallel workers)
  let workerURL = null;
  function makeWorker() {
    if (!workerURL) {
      const src = $('#engine-src').textContent + `
        self.onmessage = e => {
          const { data, matrix, settings, opts } = e.data;
          const M = RallyEngine.buildModel(data, matrix, settings);
          let last = 0;
          const res = RallyEngine.optimize(M, { ...opts, onProgress: (f, r) => { const now = Date.now(); if (now - last > 250) { last = now; postMessage({ type: 'progress', f, points: RallyEngine.score(M, r).points }); } } });
          postMessage({ type: 'done', route: res.route.map(u => M.bon[u - 1].code), notes: res.notes });
        };`;
      workerURL = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    }
    return new Worker(workerURL);
  }
  function modelSettings(extra) {
    return {
      calib: +S.calib, pace: pacePct(), stopMin: +S.stopMin, autoExtra: String(S.autoExtra) === 'true', extraStop: {},
      excluded: [...st.excluded], required: [...st.required], start: toMin(S.start), end: toMin(S.end), buffer: +S.buffer,
      range: +S.range, reserve: +S.reserve, fuelMin: +S.fuelMin, winMargin: +S.winMargin, sunrise: toMin(S.sunrise), sunset: toMin(S.sunset),
      startLat: startPoint().lat, startLon: startPoint().lon, ...extra
    };
  }
  async function solve(settings, opts, budget, onProg) {
    const nW = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1));
    const prog = new Array(nW).fill(0), best = new Array(nW).fill(0);
    const payload = { data: st.data, matrix: st.matrix, settings };
    let outs;
    try {
      outs = await Promise.all([...Array(nW)].map((_, i) => new Promise((res, rej) => {
        const w = makeWorker();
        w.onmessage = e => {
          if (e.data.type === 'progress') { prog[i] = e.data.f; best[i] = e.data.points; onProg(Math.min(...prog), Math.max(...best)); }
          else { w.terminate(); res(e.data); }
        };
        w.onerror = err => { w.terminate(); rej(err); };
        w.postMessage({ ...payload, opts: { ...opts, budgetMs: budget, seed: 17 + i * 7919 } });
      })));
    } catch (err) {
      console.warn('Workers unavailable, solving on the page', err);
      const M = E.buildModel(st.data, st.matrix, settings);
      const r = E.optimize(M, { ...opts, budgetMs: Math.min(budget, 8000) });
      outs = [{ route: r.route.map(u => M.bon[u - 1].code), notes: r.notes }];
    }
    const M = E.buildModel(st.data, st.matrix, settings);
    let bestD = null;
    for (const o of outs) {
      const d = E.describe(M, o.route.map(c => M.codeIdx.get(c)));
      d.notes = o.notes; d.pace = settings.pace;
      if (!bestD || d.points > bestD.points || (d.points === bestD.points && d.miles < bestD.miles)) bestD = d;
    }
    return bestD;
  }

  function setProg(f, txt, pts) {
    $('#prog').classList.add('on');
    $('#prog .bar i').style.width = Math.round(f * 100) + '%';
    $('#progTxt').textContent = txt;
    $('#progPts').textContent = pts ? `${fmtN(pts)} pts` : '';
  }

  $('#go').onclick = async () => {
    if (st.running) return;
    st.running = true; updateGo();
    try {
      if (!st.matrix) {
        setProg(0, 'Measuring road distances…');
        st.matrix = await getMatrix(f => setProg(f * 0.15, `Measuring road distances… ${Math.round(f * 100)}%`));
        refreshPace();
      }
      const budget = BUDGET[S.depth] || 20000;
      st.results = {};
      const base = 0.15, span = 0.85;
      // 1. maximum points
      const max = await solve(modelSettings(), { lam: 0 }, budget, (f, p) => setProg(base + span * 0.6 * f, 'Finding the highest-scoring route…', p));
      st.results.max = { ...max, label: 'Max points' }; st.active = 'max'; renderResults(); drawRoute();
      // 2. more buffer
      const safer = await solve(modelSettings({ buffer: +S.buffer + 30 }), { lam: 0 }, budget * 0.35, (f, p) => setProg(base + span * (0.6 + 0.2 * f), 'Finding a safer route (+30 min buffer)…', p));
      st.results.safer = { ...safer, label: '+30 min buffer' }; renderResults();
      // 3. efficient (points per mile)
      const lam = max.miles > 0 ? 0.35 * max.points / max.miles : 0;
      const eff = await solve(modelSettings(), { lam }, budget * 0.35, (f, p) => setProg(base + span * (0.8 + 0.2 * f), 'Finding the most efficient route…', p));
      st.results.eff = { ...eff, label: 'Fewest miles' };
      // the other scenarios meet the max-points constraints too, so keep whichever scored highest
      const top = [eff, safer].filter(x => x.points > st.results.max.points).sort((a, b) => b.points - a.points)[0];
      if (top) { st.results.max = { ...top, label: 'Max points' }; if (st.active === 'max') drawRoute(); }
      renderResults();
      setProg(1, 'Done', max.points);
      setTimeout(() => $('#prog').classList.remove('on'), 1200);
    } catch (err) {
      console.error(err); toast(err.message || 'Something went wrong'); $('#prog').classList.remove('on');
    } finally { st.running = false; updateGo(); }
  };

  // ------------------------------------------------------------ results
  function renderResults() {
    const r = st.results[st.active]; if (!r) return;
    $('#resCard').hidden = false;
    $('#tabs').innerHTML = ['max', 'safer', 'eff'].map(k => {
      const x = st.results[k];
      return `<button class="tab${k === st.active ? ' on' : ''}" data-k="${k}" ${x ? '' : 'disabled'}><div class="t">${x ? x.label : k === 'safer' ? '+30 min buffer' : 'Fewest miles'}</div><div class="p">${x ? fmtN(x.points) : '…'}</div></button>`;
    }).join('');
    $('#tabs').querySelectorAll('.tab').forEach(t => t.onclick = () => { if (!st.results[t.dataset.k]) return; st.active = t.dataset.k; renderResults(); drawRoute(); });
    const spare = r.end - r.finish;
    const gal = r.miles / (+S.mpg || 1), cost = gal * (+S.fuelPrice || 0);
    const stopT = r.legs.reduce((a, l) => a + l.stop, 0) + r.fuels * (+S.fuelMin);
    const comboNames = r.combos.map(c => (st.data.combos.find(x => x.code === c) || {}));
    let html = `<div class="hero"><div><div class="big">${fmtN(r.points)}</div><div class="cap">estimated points · ${r.route.length} bonuses</div></div>
      <div class="fin"><div class="v">${E.fmtTime(r.finish)}</div><div class="cap"><span class="pill ${spare >= +S.buffer - 0.5 ? 'ok' : 'warn'}">${Math.round(spare)} min before deadline</span>${r.pace > 100.5 ? '<br><span class="pill err" style="margin-top:4px">assumes speeding</span>' : ''}</div></div></div>
      <div class="kpis">
        <div class="kpi"><div class="v">${fmtN(r.miles)} mi</div><div class="k">${(r.points / Math.max(r.miles, 1)).toFixed(1)} pts / mile</div></div>
        <div class="kpi"><div class="v">${fmtH(r.ride)}</div><div class="k">riding · avg ${(r.miles / Math.max(r.ride / 60, 0.01)).toFixed(0)} mph</div></div>
        <div class="kpi"><div class="v">${fmtH(stopT + r.wait)}</div><div class="k">stops${r.wait > 0.5 ? ` + ${Math.round(r.wait)} min waiting` : ''}</div></div>
        <div class="kpi"><div class="v">${r.fuels}</div><div class="k">fuel stop${r.fuels === 1 ? '' : 's'}</div></div>
        <div class="kpi"><div class="v">${gal.toFixed(1)} gal</div><div class="k">at ${S.mpg} mpg</div></div>
        <div class="kpi"><div class="v">$${cost.toFixed(0)}</div><div class="k">fuel cost</div></div>
      </div>`;
    if (comboNames.length) html += `<div class="combos">${comboNames.map(c => `<span class="combo">✓ ${esc(c.code)} ${esc(c.name || '')} +${fmtN(c.points || 0)}</span>`).join('')}</div>`;
    html += `<div class="actions"><button class="btn" id="gpxBtn"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>GPX for GPS</button><button class="btn" id="csvBtn"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>Itinerary CSV</button><button class="btn" id="printBtn"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M7 9V3h10v6M7 17H4v-7h16v7h-3M7 14h10v7H7z"/></svg>Print</button></div>`;
    // timeline
    const s = startPoint(), f = finishPoint();
    html += `<div class="tl"><div class="stop hq"><div class="dot">★</div><div><div class="nm">Start · ${esc(s.name)}</div><div class="meta">Full tank</div></div><div class="r"><div class="tm">${E.fmtTime(toMin(S.start))}</div></div></div>`;
    r.legs.forEach((l, k) => {
      const b = l.code === 'FINISH' ? null : st.data.bonuses.find(x => x.code === l.code);
      html += `<div class="leg"><div class="rail"><i></i></div><span>${l.fuel ? '<span class="fuel">⛽ fuel first · </span>' : ''}${l.mi.toFixed(1)} mi · ${Math.round(l.ride)} min</span></div>`;
      if (!b) {
        html += `<div class="stop hq"><div class="dot">⚑</div><div><div class="nm">Finish · ${esc(f.name)}</div><div class="meta">Deadline ${E.fmtTime(r.end)} · target ${E.fmtTime(r.deadline)}</div></div><div class="r"><div class="tm">${E.fmtTime(l.arr)}</div><div class="pt">${fmtN(r.points)}</div></div></div>`;
        return;
      }
      const win = b.win.type !== 'open' ? `<span class="tag win">${esc(E.windowText(b.win))}</span>` : '';
      const wait = l.wait > 0.5 ? `<span class="tag wait">wait ${Math.round(l.wait)} min</span>` : '';
      const bike = b.bike ? '<span class="tag bike">bike in photo</span>' : '';
      html += `<div class="stop" data-code="${esc(b.code)}"><div class="dot">${k + 1}</div><div><div class="nm"><code>${esc(b.code)}</code>${esc(b.name)}</div>
        <div class="meta">${esc(b.city)}${b.city ? ' · ' : ''}${Math.round(l.stop)} min stop${win}${wait}${bike}</div>
        ${b.proof ? `<div class="proof">${esc(b.proof)}</div>` : ''}${b.notes.length ? `<div class="proof" style="color:var(--warn)">${esc(b.notes.join(' '))}</div>` : ''}</div>
        <div class="r"><div class="tm">${E.fmtTime(l.photo)}</div><div class="pt">+${b.points}</div></div></div>`;
    });
    html += '</div>';
    $('#resBody').innerHTML = html;
    $('#resBody').querySelectorAll('.stop[data-code]').forEach(el => el.onclick = () => {
      const m = markerOf.get(el.dataset.code); if (m) { map.setView(m.getLatLng(), Math.max(map.getZoom(), 12)); m.openPopup(); }
    });
    $('#gpxBtn').onclick = exportGPX; $('#csvBtn').onclick = exportCSV; $('#printBtn').onclick = () => window.print();
    renderList(); renderMarkers(); renderIssues();
  }

  const geomCache = new Map();
  async function drawRoute() {
    layers.route.clearLayers(); layers.pins.clearLayers();
    const r = st.results[st.active]; if (!r) return;
    const s = startPoint(), f = finishPoint();
    const stops = r.route.map(c => st.data.bonuses.find(b => b.code === c));
    const pts = [s, ...stops.map(b => ({ lat: b.rlat, lon: b.rlon })), f];
    stops.forEach((b, k) => L.marker([b.lat, b.lon], { icon: L.divIcon({ className: '', html: `<div class="pin">${k + 1}</div>`, iconSize: [24, 24], iconAnchor: [12, 12] }), zIndexOffset: 500 })
      .bindTooltip(esc(`${k + 1}. ${b.code} · ${b.points}`), { direction: 'top', offset: [0, -10] }).on('click', () => { const m = markerOf.get(b.code); if (m) m.openPopup(); }).addTo(layers.pins));
    const key = pts.map(p => p.lat.toFixed(5) + ',' + p.lon.toFixed(5)).join(';');
    let line = geomCache.get(key), dashed = false;
    if (!line) {
      try {
        const j = await fetchJSON(`${OSRM}/route/v1/driving/${pts.map(p => `${p.lon.toFixed(6)},${p.lat.toFixed(6)}`).join(';')}?overview=full&geometries=geojson`, 3);
        line = j.routes[0].geometry.coordinates.map(([lo, la]) => [la, lo]); geomCache.set(key, line);
      } catch { line = pts.map(p => [p.lat, p.lon]); dashed = true; }
    }
    if (st.results[st.active] !== r) return; // a different tab was picked meanwhile
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
    L.polyline(line, { color: isDark() ? '#000' : '#fff', weight: 8, opacity: 0.85 }).addTo(layers.route);
    L.polyline(line, { color: accent, weight: 4.5, opacity: 1, dashArray: dashed ? '6 8' : null }).addTo(layers.route);
    map.fitBounds(L.latLngBounds(line), { padding: [40, 40] });
  }

  // ------------------------------------------------------------ exports
  function download(name, text, type) {
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name;
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  const xml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  function exportGPX() {
    const r = st.results[st.active], s = startPoint(), f = finishPoint();
    const stops = r.route.map(c => st.data.bonuses.find(b => b.code === c));
    const pt = (tag, lat, lon, name, desc) => `  <${tag} lat="${lat.toFixed(6)}" lon="${lon.toFixed(6)}"><name>${xml(name)}</name>${desc ? `<desc>${xml(desc)}</desc>` : ''}</${tag}>`;
    const gpx = ['<?xml version="1.0" encoding="UTF-8"?>', '<gpx version="1.1" creator="Rally Route Planner" xmlns="http://www.topografix.com/GPX/1/1">',
      ...stops.map((b, k) => pt('wpt', b.lat, b.lon, b.code, `${k + 1}. ${b.name} (${b.points} pts) ${b.proof}`)),
      `  <rte><name>Rally route ${fmtN(r.points)} pts</name>`,
      pt('rtept', s.lat, s.lon, 'START'), ...stops.map(b => pt('rtept', b.rlat, b.rlon, b.code)), pt('rtept', f.lat, f.lon, 'FINISH'),
      '  </rte>', '</gpx>'].join('\n');
    download(`rally-route-${r.points}.gpx`, gpx, 'application/gpx+xml');
  }
  function exportCSV() {
    const r = st.results[st.active];
    // text starting with = + - @ would run as a formula in Excel, so it gets a leading apostrophe
    const q = v => { let s = String(v ?? ''); if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = "'" + s; return `"${s.replace(/"/g, '""')}"`; };
    const rows = [['#', 'Code', 'Name', 'Town', 'Leg miles', 'Ride min', 'Fuel before leg', 'Arrive', 'Photo', 'Window', 'Points', 'Running', 'Proof'].map(q).join(',')];
    r.legs.forEach((l, k) => {
      const b = st.data.bonuses.find(x => x.code === l.code);
      rows.push([k + 1, l.code, b ? b.name : 'Finish', b ? b.city : '', l.mi.toFixed(1), Math.round(l.ride), l.fuel ? 'Y' : 'N', E.fmtTime(l.arr), b ? E.fmtTime(l.photo) : '', b ? E.windowText(b.win) : '', l.points, l.running, b ? b.proof : ''].map(q).join(','));
    });
    download(`rally-itinerary-${r.points}.csv`, rows.join('\n'), 'text/csv');
  }

  bindForm(); renderAll(); initPdf();
})();
