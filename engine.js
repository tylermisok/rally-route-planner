/* Rally Route Planner engine: file parsing, data merge and route optimisation.
   Pure functions, no DOM, so it runs on the page, in a Web Worker, and in Node for tests. */
(function (root) {
  'use strict';

  const DAY = 1440;

  // ---------------------------------------------------------------- helpers
  function num(s) { const v = parseFloat(String(s).replace(/[, ]/g, '')); return isFinite(v) ? v : null; }
  function isCode(s) { return /^[A-Z0-9]{2,8}$/.test(s) && /[A-Z]/.test(s); }
  function hav(a, b) {
    const R = 3958.8, r = Math.PI / 180;
    const dl = (b.lat - a.lat) * r, dn = (b.lon - a.lon) * r;
    const x = Math.sin(dl / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dn / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  }
  function fmtTime(m) {
    m = Math.round(m); const d = Math.floor(m / DAY); m -= d * DAY;
    const h = Math.floor(m / 60), mm = m % 60;
    return `${((h + 11) % 12) + 1}:${String(mm).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}${d > 0 ? ` +${d}d` : ''}`;
  }

  // ---------------------------------------------------------------- coordinates
  // One coordinate: "N31° 28.880'", "W83 31.563", "31.4813", "-83.52", "N31 28 52.8"
  function parseCoord(s) {
    if (s == null) return null;
    s = String(s).trim();
    const hemi = (s.match(/[NSEW]/i) || [''])[0].toUpperCase();
    const parts = s.replace(/[NSEW]/gi, ' ').match(/-?\d+(?:\.\d+)?/g);
    if (!parts) return null;
    let v;
    if (parts.length === 1) v = parseFloat(parts[0]);
    else if (parts.length === 2) v = Math.abs(parseFloat(parts[0])) + parseFloat(parts[1]) / 60;
    else v = Math.abs(parseFloat(parts[0])) + parseFloat(parts[1]) / 60 + parseFloat(parts[2]) / 3600;
    if (parts[0].startsWith('-')) v = -Math.abs(v);
    if (hemi === 'S' || hemi === 'W') v = -Math.abs(v);
    return isFinite(v) ? v : null;
  }
  // A lat/lon pair inside free text
  function findCoordPair(text) {
    let m = text.match(/([NS])\s*(\d{1,3})[^\d\n]{0,3}\s*(\d{1,2}(?:\.\d+)?)['′’]?\s*,?\s*([EW])\s*(\d{1,3})[^\d\n]{0,3}\s*(\d{1,2}(?:\.\d+)?)/i);
    if (m) {
      let lat = +m[2] + +m[3] / 60, lon = +m[5] + +m[6] / 60;
      if (m[1].toUpperCase() === 'S') lat = -lat;
      if (m[4].toUpperCase() === 'W') lon = -lon;
      return { lat, lon };
    }
    m = text.match(/(-?\d{1,2}\.\d{3,})\s*,\s*(-?\d{1,3}\.\d{3,})/);
    if (m) return { lat: +m[1], lon: +m[2] };
    return null;
  }

  // ---------------------------------------------------------------- times and windows
  function parseClock(s) {
    const m = String(s).trim().match(/^(\d{1,2})(?::?(\d{2}))?\s*(a\.?m\.?|p\.?m\.?|noon|midnight)?$/i);
    if (!m) return null;
    let h = +m[1], mm = m[2] ? +m[2] : 0;
    const ap = (m[3] || '').toLowerCase();
    if (ap.startsWith('noon')) return 720;
    if (ap.startsWith('midnight')) return 0;
    if (h > 23 || mm > 59) return null;
    if (ap.startsWith('a')) h = h % 12;
    else if (ap.startsWith('p')) h = (h % 12) + 12;
    return { min: h * 60 + mm, explicit: !!ap, h, mm };
  }
  function to24(c, ref, after) {
    // c without AM/PM: choose the reading that lands inside the rally day (or after `after`)
    if (c.explicit) return c.min;
    const opts = [(c.h % 12) * 60 + c.mm, ((c.h % 12) + 12) * 60 + c.mm];
    if (after != null) return opts.find(o => o > after) ?? opts[1];
    const inside = opts.filter(o => o >= ref.start - 60 && o <= ref.end);
    return inside.length ? inside[0] : (c.h >= 7 && c.h <= 11 ? opts[0] : opts[1]);
  }
  // Returns {type:'open'} | {type:'win',open,close} | {type:'daylight'} | {type:'unknown',raw}
  function parseWindow(raw, rally) {
    if (raw == null) return { type: 'open' };
    const s = String(raw).trim();
    if (!s || /24\s*h|all\s*day|any\s*time|anytime|always|^n\/?a$|^-$/i.test(s)) return { type: 'open' };
    if (/daylight|sunrise|sunset|dawn|dusk/i.test(s)) return { type: 'daylight', raw: s };
    const m = s.replace(/[–—]/g, '-').match(/(\d{1,2}(?::\d{2})?\s*(?:[ap]\.?m\.?|noon)?)\s*(?:-|to|until)\s*(\d{1,2}(?::\d{2})?\s*(?:[ap]\.?m\.?|noon|midnight)?)/i);
    if (!m) return { type: 'unknown', raw: s };
    const a = parseClock(m[1]), b = parseClock(m[2]);
    if (!a || !b) return { type: 'unknown', raw: s };
    // "11:00 - 1:00 PM": the PM applies to the end; start inherits only if that keeps start < end
    if (!a.explicit && b.explicit) {
      const same = { ...a, explicit: true, min: (a.h % 12) * 60 + a.mm + (b.min >= 720 ? 720 : 0) };
      if (same.min < b.min) a.min = same.min, a.explicit = true;
    }
    const open = to24(a, rally);
    const close = b.explicit ? b.min : to24(b, rally, open);
    return { type: 'win', open, close, assumed: !(a.explicit && b.explicit), raw: s };
  }
  function windowText(w) {
    if (!w || w.type === 'open') return '24 h';
    if (w.type === 'win') return `${fmtTime(w.open)} - ${fmtTime(w.close)}`;
    if (w.type === 'daylight') return 'Daylight';
    return w.raw || '?';
  }

  // ---------------------------------------------------------------- CSV
  function splitCSVLine(line, sep) {
    const out = []; let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
      else if (ch === '"') q = true;
      else if (ch === sep) { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur); return out.map(s => s.trim());
  }
  function parseCSV(text) {
    const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim());
    if (!lines.length) return { rows: [], warnings: ['CSV is empty'] };
    const sep = (lines[0].match(/\t/g) || []).length > (lines[0].match(/,/g) || []).length ? '\t' : (lines[0].includes(';') && !lines[0].includes(',') ? ';' : ',');
    const head = splitCSVLine(lines[0], sep).map(h => h.toLowerCase());
    const col = (...names) => head.findIndex(h => names.some(n => h === n || h.startsWith(n)));
    let iCode = col('code', 'bonus', 'id', 'abbr'), iLat = col('lat'), iLon = col('lon', 'long', 'lng'),
      iPts = col('point', 'pts', 'value', 'score'), iAv = col('avail', 'hour', 'window', 'time', 'open'),
      iName = col('name', 'title', 'description');
    let start = 1;
    if (iLat < 0 || iLon < 0) { // no header row: guess CODE,LAT,LON,POINTS,AVAIL
      iCode = 0; iLat = 1; iLon = 2; iPts = 3; iAv = 4; start = 0;
    }
    const rows = [], warnings = [];
    for (let k = start; k < lines.length; k++) {
      const f = splitCSVLine(lines[k], sep);
      const code = (f[iCode] || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (!code) continue;
      const lat = parseCoord(f[iLat]), lon = parseCoord(f[iLon]);
      rows.push({ code, lat, lon, points: iPts >= 0 ? num(f[iPts]) : null, avail: iAv >= 0 ? (f[iAv] || '') : '', name: iName >= 0 && iName !== iCode ? f[iName] : '' });
      if (lat == null || lon == null) warnings.push(`CSV row ${k + 1} (${code}): could not read coordinates`);
    }
    return { rows, warnings };
  }

  // ---------------------------------------------------------------- GPX
  function xmlText(s) { return s == null ? '' : s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").trim(); }
  function parseGPX(text) {
    const wpts = [];
    const re = /<wpt\b([^>]*)>([\s\S]*?)<\/wpt>/g; let m;
    while ((m = re.exec(text))) {
      const attrs = m[1], body = m[2];
      const lat = num((attrs.match(/lat\s*=\s*["']([^"']+)/) || [])[1]);
      const lon = num((attrs.match(/lon\s*=\s*["']([^"']+)/) || [])[1]);
      const tag = t => xmlText((body.match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`)) || [])[1]);
      wpts.push({ name: tag('name'), cmt: tag('cmt'), desc: tag('desc'), lat, lon });
    }
    return { wpts };
  }

  // ---------------------------------------------------------------- rally book (text lines from the PDF)
  function parseBook(lines, knownCodes) {
    knownCodes = knownCodes || new Set();
    const L = lines.map(l => l.replace(/\s+$/, ''));
    const sepLine = l => /^\s*[*_=~\-]{8,}\s*$/.test(l);
    const pageLine = l => /^\s*page\s+\d+\s+of\s+\d+\s*$/i.test(l);
    // header lines: "CODE   Name" where CODE is known, or followed by a Points line within 4 lines
    const heads = [];
    for (let i = 0; i < L.length; i++) {
      const m = L[i].trim().match(/^([A-Z0-9]{2,8})(?:\s{2,}|\t|\s+[-–:]\s+|\s+)(\S.*)$/);
      if (!m || !isCode(m[1])) continue;
      const known = knownCodes.has(m[1]);
      const loose = /\s{2,}|\t/.test(L[i].trim().slice(m[1].length, m[1].length + 3));
      const near = L.slice(i, i + 5).some(x => /points?\s*[:=]/i.test(x));
      const close = L.slice(i + 1, i + 3).some(x => /^\s*(?:[^:]*\s)?points?\s*[:=]\s*\d/i.test(x)); // unknown codes (e.g. combos) need Points right below
      if ((known && near) || (loose && near) || close || (known && /^\s*[A-Z0-9]{2,8}\s{2,}/.test(L[i]))) heads.push({ i, code: m[1], rest: m[2].trim() });
    }
    const bonuses = {}, combos = [];
    for (let h = 0; h < heads.length; h++) {
      const from = heads[h].i, to = h + 1 < heads.length ? heads[h + 1].i : L.length;
      let block = L.slice(from, to);
      const cut = block.findIndex((l, k) => k > 0 && sepLine(l));
      if (cut > 0) block = block.slice(0, cut);
      block = block.filter(l => !pageLine(l));
      const text = block.join('\n');
      const ptsM = text.match(/points?\s*[:=]\s*([\d,]+)/i);
      const points = ptsM ? num(ptsM[1]) : null;
      const avM = text.match(/(?:available|availability|hours|open)\s*[:=]\s*([^\n]+)/i);
      const coord = findCoordPair(text);
      // second line usually "City, ST    Points: 510"
      const city = (block[1] || '').split(/\s{2,}|points?\s*:/i)[0].trim();
      const instr = [];
      let inTake = false;
      for (const l of block.slice(1)) {
        const t = l.trim();
        if (/^(note|caution|warning)\b/i.test(t)) { inTake = false; continue; }
        if (/^(take|photograph|photo of|submit|answer|record|bring)\b/i.test(t)) inTake = true;
        if (inTake) instr.push(t);
      }
      const notes = [];
      for (let k = 0; k < block.length; k++) {
        if (/^\s*(note|caution|warning)\b/i.test(block[k])) {
          let n = block[k].trim();
          while (k + 1 < block.length && block[k + 1].trim() && !/^\s*(note|caution|warning|take)\b/i.test(block[k + 1])) n += ' ' + block[++k].trim();
          notes.push(n);
        }
      }
      // combination bonus: lists several other bonus codes
      const memberText = (text.match(/(?:claim|bonuses|members?|consists? of|requires?|visit)[^:\n]*:?([\s\S]*)$/i) || [, ''])[1];
      const members = [...new Set((memberText.match(/\b[A-Z0-9]{2,8}\b/g) || []).filter(c => c !== heads[h].code && (knownCodes.has(c) || heads.some(x => x.code === c && !/combo/i.test(x.rest)))))];
      const looksCombo = /combo|combination/i.test(heads[h].rest + ' ' + text.slice(0, 300)) || (!coord && members.length >= 2);
      if (looksCombo && members.length >= 2) {
        combos.push({ code: heads[h].code, name: heads[h].rest.replace(/\s{2,}.*/, ''), points: points || 0, members });
        continue;
      }
      // parking / safety coordinates given in a NOTE override the routing target
      let park = null;
      for (const n of notes) if (/park|coordinates? (?:are|is) to|access/i.test(n)) { const c = findCoordPair(n); if (c) park = c; }
      bonuses[heads[h].code] = {
        code: heads[h].code, name: heads[h].rest.replace(/\s{2,}.*/, '').trim(), city,
        points, lat: coord ? coord.lat : null, lon: coord ? coord.lon : null,
        avail: avM ? avM[1].trim() : null, proof: instr.join(' '), notes, park
      };
    }
    // rally clock and penalties
    const all = L.join('\n');
    const rally = {};
    const se = all.match(/start\w*\s+(?:at\s+)?(\d{1,2}:\d{2}\s*[ap]\.?m\.?)[\s\S]{0,80}?end\w*\s+(?:at\s+)?(\d{1,2}:\d{2}\s*[ap]\.?m\.?)/i);
    if (se) { rally.start = parseClock(se[1]).min; rally.end = parseClock(se[2]).min; }
    const pen = all.match(/[^\n]*penalt[^\n]*(?:\n[^\n]+){0,5}/i) || all.match(/[^\n]*\blate (?:finish|arrival)[^\n]*(?:\n[^\n]+){0,4}/i);
    if (pen) rally.penaltyText = pen[0].replace(/\s+/g, ' ').trim();
    const tz = all.match(/\b(Eastern|Central|Mountain|Pacific)\s+(?:Standard\s+|Daylight\s+)?Time\b/i);
    if (tz) rally.timezone = tz[0];
    return { bonuses, combos, rally };
  }

  // ---------------------------------------------------------------- merge
  function gpxCode(name) { const t = (name || '').trim().split(/[\s\-_:,]+/)[0].toUpperCase(); return isCode(t) && t.length >= 3 ? t : null; }

  function merge({ book, csv, gpx }) {
    const issues = [];
    const B = (book && book.bonuses) || {}, C = {}, G = {};
    (csv ? csv.rows : []).forEach(r => { C[r.code] = r; });
    const others = [];
    (gpx ? gpx.wpts : []).forEach(w => {
      const c = gpxCode(w.name);
      if (c && (B[c] || C[c] || !Object.keys(B).length && !Object.keys(C).length)) G[c] = w;
      else others.push(w);
    });
    // GPX names that are codes but unknown to book/CSV still count when no other source has them
    if (Object.keys(B).length || Object.keys(C).length) {
      others.slice().forEach(w => {
        const c = gpxCode(w.name), p = num(((w.cmt || '') + ' ' + (w.desc || '')).match(/([\d,]+)\s*(?:pts|points)/i)?.[1]);
        if (c && p > 0) { G[c] = w; others.splice(others.indexOf(w), 1); }
      });
    }
    const codes = [...new Set([...Object.keys(B), ...Object.keys(C), ...Object.keys(G)])].sort();
    const rallyRef = { start: (book && book.rally.start) ?? 420, end: (book && book.rally.end) ?? 1020 };
    const bonuses = [];
    for (const code of codes) {
      const b = B[code] || {}, c = C[code] || {}, g = G[code] || {};
      const gp = num(((g.cmt || '') + ' ' + (g.desc || '')).match(/([\d,]+)\s*(?:pts|points)/i)?.[1]);
      const pts = [b.points, c.points, gp].filter(v => v != null);
      const points = b.points ?? c.points ?? gp;
      if (new Set(pts).size > 1) issues.push({ level: 'warn', code, text: `${code}: point values disagree (${[b.points != null ? `book ${b.points}` : '', c.points != null ? `CSV ${c.points}` : '', gp != null ? `GPX ${gp}` : ''].filter(Boolean).join(', ')}). Using ${points}.` });
      const coordSrc = [['CSV', c], ['book', b], ['GPX', g]].filter(([, s]) => s.lat != null && s.lon != null);
      const [srcName, src] = coordSrc[0] || [null, null];
      if (!src) { issues.push({ level: 'error', code, text: `${code}: no coordinates in any file, so it cannot be routed.` }); }
      for (const [n2, s2] of coordSrc.slice(1)) {
        const d = hav(src, s2) * 1609.34;
        if (d > 150) issues.push({ level: 'warn', code, text: `${code}: ${srcName} and ${n2} coordinates are ${Math.round(d)} m apart. Using ${srcName}.` });
      }
      const availRaw = b.avail ?? (c.avail || null);
      const win = parseWindow(availRaw, rallyRef);
      if (win.type === 'unknown') issues.push({ level: 'warn', code, text: `${code}: could not read availability "${availRaw}". Treated as always open.` });
      if (win.type === 'win' && win.assumed) issues.push({ level: 'info', code, text: `${code}: window "${availRaw}" has no AM/PM. Read as ${windowText(win)}.` });
      if (b.avail && c.avail && win.type === 'win') {
        const w2 = parseWindow(c.avail, rallyRef);
        if (w2.type === 'win' && (w2.open !== win.open || w2.close !== win.close)) issues.push({ level: 'warn', code, text: `${code}: book window ${windowText(win)} vs CSV ${windowText(w2)}. Using the book.` });
      }
      if (points == null) issues.push({ level: 'warn', code, text: `${code}: no point value found. Scored as 0.` });
      const notes = b.notes || [];
      const blob = (notes.join(' ') + ' ' + (b.proof || '')).toLowerCase();
      let extra = 0;
      if (/walk|yards|hike|trail/.test(blob)) extra += 5;
      if (/gravel|dirt|unpaved|sand/.test(blob)) extra += 3;
      if (/security|license|gate|guard|check.?in/.test(blob)) extra += 5;
      if (/fee|\$\d/.test(blob)) extra += 3;
      bonuses.push({
        code, name: b.name || c.name || g.desc || g.cmt || code, city: b.city || '',
        points: points || 0, lat: src ? src.lat : null, lon: src ? src.lon : null,
        rlat: b.park ? b.park.lat : (src ? src.lat : null), rlon: b.park ? b.park.lon : (src ? src.lon : null),
        win, availRaw, proof: b.proof || '', notes, extraStop: extra,
        bike: /motorcycle|your bike/i.test(b.proof || ''),
        sources: [B[code] && 'book', C[code] && 'CSV', G[code] && 'GPX'].filter(Boolean)
      });
    }
    const combos = ((book && book.combos) || []).map(cb => ({ ...cb, members: cb.members.filter(m => codes.includes(m)) })).filter(cb => cb.members.length >= 2);
    const places = others.filter(w => w.lat != null).map(w => ({ name: w.name, lat: w.lat, lon: w.lon }));
    const startGuess = places.find(p => /hq|start|finish|headquart|hotel|check.?point|base/i.test(p.name)) || places[0] || null;
    if (!startGuess) issues.push({ level: 'info', text: 'No start/finish waypoint found. Click "Set on map" to choose one.' });
    if (!book) issues.push({ level: 'info', text: 'No rally book PDF loaded. Proof instructions, combos and rally hours come from the PDF.' });
    return { bonuses, combos, places, start: startGuess, rally: (book && book.rally) || {}, issues };
  }

  // ---------------------------------------------------------------- model
  // matrix: { n, sec: number[n*n], m: number[n*n] } over points [start, finish, ...bonuses]
  function buildModel(data, matrix, s) {
    const bon = data.bonuses.filter(b => b.rlat != null && !s.excluded.includes(b.code));
    // matrix rows are [start, finish, ...routable bonuses in data order]
    const idxOf = new Map(data.bonuses.filter(b => b.rlat != null).map((b, i) => [b.code, i]));
    const n = bon.length + 2, S = 0, F = n - 1;
    const mapM = k => k === S ? 0 : k === F ? 1 : 2 + idxOf.get(bon[k - 1].code);
    const N0 = matrix.n;
    const D = new Float64Array(n * n), T = new Float64Array(n * n);
    const speed = s.calib / (s.pace / 100);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      const a = mapM(i), b = mapM(j);
      const sec = matrix.sec[a * N0 + b], met = matrix.m[a * N0 + b];
      D[i * n + j] = met == null || !isFinite(met) ? 1e6 : met / 1609.344;
      T[i * n + j] = sec == null || !isFinite(sec) ? 1e6 : (sec / 60) * speed;
    }
    const P = new Float64Array(n), STOP = new Float64Array(n), WIN = new Array(n).fill(null);
    bon.forEach((b, k) => {
      const u = k + 1;
      P[u] = b.points; STOP[u] = s.stopMin + (s.autoExtra ? b.extraStop : 0) + (s.extraStop[b.code] || 0);
      if (b.win.type === 'win') WIN[u] = [b.win.open, b.win.close];
      else if (b.win.type === 'daylight') WIN[u] = [s.sunrise, s.sunset];
    });
    const codeIdx = new Map(bon.map((b, k) => [b.code, k + 1]));
    const combos = data.combos.map(c => ({ code: c.code, name: c.name, points: c.points, members: c.members.map(m => codeIdx.get(m)).filter(Boolean), total: c.members.length }))
      .filter(c => c.members.length === c.total);
    const comboOf = Array.from({ length: n }, () => []);
    combos.forEach((c, ci) => c.members.forEach(u => comboOf[u].push(ci)));
    const end = s.end > s.start ? s.end : s.end + DAY;
    const geo = [{ lat: s.startLat ?? 0, lon: s.startLon ?? 0 }, ...bon.map(b => ({ lat: b.rlat, lon: b.rlon })), null];
    return {
      n, S, F, D, T, P, STOP, WIN, combos, comboOf, bon, codeIdx, geo: s.startLat != null ? geo : null,
      start: s.start, deadline: end - s.buffer, end,
      usable: s.range * (1 - s.reserve / 100), fuelMin: s.fuelMin, margin: s.winMargin,
      required: s.required.map(c => codeIdx.get(c)).filter(Boolean)
    };
  }

  // earliest time >= t that is inside a (daily repeating) window [o, c - margin]
  function nextOpen(t, w, margin) {
    let [o, c] = w; if (c <= o) c += DAY; c -= margin;
    const d0 = Math.floor(t / DAY) - 1;
    for (let d = d0; d < d0 + 4; d++) {
      const a = d * DAY + o, b = d * DAY + c;
      if (t <= b) return Math.max(t, a);
    }
    return t + DAY;
  }

  function simulate(M, route, detail) {
    let t = M.start, miles = 0, since = 0, viol = 0, prev = M.S, wait = 0, fuels = 0;
    const legs = detail ? [] : null;
    const L = route.length;
    for (let k = 0; k <= L; k++) {
      const u = k < L ? route[k] : M.F;
      const d = M.D[prev * M.n + u], rt = M.T[prev * M.n + u];
      let fuel = false;
      if (since + d > M.usable && since > 0) { t += M.fuelMin; since = 0; fuel = true; fuels++; }
      if (d > M.usable) viol += 999;
      t += rt; miles += d; since += d;
      const arr = t; let w = 0;
      if (M.WIN[u]) {
        const nt = nextOpen(t, M.WIN[u], M.margin);
        if (nt - t > 600) viol += nt - t; // window missed: would need to wait for the next day
        w = nt - t; wait += w; t = nt;
      }
      t += M.STOP[u];
      if (detail) legs.push({ to: u, mi: d, ride: rt, arr, wait: w, photo: arr + w, depart: t, fuel, odo: miles });
      prev = u;
    }
    if (t > M.deadline) viol += t - M.deadline;
    return { viol, finish: t, miles, legs, wait, fuels };
  }

  function score(M, route) {
    let p = 0; const inr = new Uint8Array(M.n);
    for (const u of route) { p += M.P[u]; inr[u] = 1; }
    const got = [];
    for (const c of M.combos) if (c.members.every(u => inr[u])) { p += c.points; got.push(c.code); }
    return { points: p, combos: got };
  }

  // ---------------------------------------------------------------- search
  function rng(seed) { let x = seed >>> 0 || 1; return () => ((x = (x * 1664525 + 1013904223) >>> 0) / 4294967296); }

  function Searcher(M, lam) {
    const n = M.n;
    const feasible = r => simulate(M, r).viol === 0;
    const obj = r => { const s = score(M, r).points; return lam ? s - lam * simulate(M, r).miles : s; };
    const req = new Set(M.required);

    function valOf(u, inr) {
      let v = M.P[u];
      for (const ci of M.comboOf[u]) {
        const c = M.combos[ci]; let missing = 0;
        for (const x of c.members) if (!inr[x] && x !== u) missing++;
        if (missing === 0) v += c.points; else if (missing <= 2) v += c.points * 0.25;
      }
      return v;
    }

    function greedy(route, rnd, alpha, forbid) {
      for (;;) {
        const inr = new Uint8Array(n); route.forEach(u => inr[u] = 1);
        const seq = [M.S, ...route, M.F], cands = [];
        for (let u = 1; u < n - 1; u++) {
          if (inr[u] || (forbid && forbid.has(u))) continue;
          let bd = 1e18, bp = 0;
          for (let p = 0; p < seq.length - 1; p++) {
            const a = seq[p], b = seq[p + 1];
            const dt = M.T[a * n + u] + M.STOP[u] + M.T[u * n + b] - M.T[a * n + b];
            if (dt < bd) { bd = dt; bp = p; }
          }
          const a = seq[bp], b = seq[bp + 1];
          const dm = M.D[a * n + u] + M.D[u * n + b] - M.D[a * n + b];
          const v = valOf(u, inr) - lam * dm;
          if (v <= 0 || bd > 1e5) continue;
          cands.push([Math.pow(v, alpha) / (Math.max(bd, 0) + 2) * (1 + 0.15 * rnd()), u, bp]);
        }
        cands.sort((x, y) => y[0] - x[0]);
        let added = false;
        const base = lam ? obj(route) : 0;
        for (let c = 0; c < Math.min(40, cands.length) && !added; c++) {
          const [, u, p] = cands[c];
          const qs = []; for (let q = 0; q <= route.length; q++) qs.push(q);
          qs.sort((x, y) => Math.abs(x - p) - Math.abs(y - p));
          for (const q of qs.slice(0, 5)) {
            const r = route.slice(0, q).concat([u], route.slice(q));
            if (feasible(r) && (!lam || obj(r) > base)) { route = r; added = true; break; }
          }
        }
        if (!added) return route;
      }
    }

    // re-sequence to minimise (violation, finish time)
    function tighten(route, allowInfeasible) {
      const cost = r => { const s = simulate(M, r); return s.viol * 1e4 + s.finish; };
      let best = cost(route), imp = true;
      while (imp) {
        imp = false; const L = route.length;
        for (let i = 0; i < L - 1; i++) for (let j = i + 1; j < Math.min(L, i + 14); j++) {
          const r = route.slice(0, i).concat(route.slice(i, j + 1).reverse(), route.slice(j + 1));
          const c = cost(r); if (c < best - 0.05) { route = r; best = c; imp = true; }
        }
        for (let i = 0; i < route.length; i++) for (let j = 0; j < route.length; j++) {
          if (i === j) continue;
          const r = route.slice(0, i).concat(route.slice(i + 1)); r.splice(j, 0, route[i]);
          const c = cost(r); if (c < best - 0.05) { route = r; best = c; imp = true; }
        }
      }
      return route;
    }

    function dropBad(route) {
      if (!lam) return route;
      for (;;) {
        const b = obj(route); let best = null;
        for (let i = 0; i < route.length; i++) {
          if (req.has(route[i])) continue;
          const r = route.slice(0, i).concat(route.slice(i + 1));
          const e = obj(r); if (e > b && (!best || e > best[0])) best = [e, r];
        }
        if (!best) return route; route = best[1];
      }
    }

    function seed(nodes) {
      let r = [];
      for (const u of nodes) {
        let best = null;
        for (let q = 0; q <= r.length; q++) {
          const x = r.slice(0, q).concat([u], r.slice(q)); const s = simulate(M, x);
          const c = s.viol * 1e4 + s.finish; if (!best || c < best[0]) best = [c, x];
        }
        r = best[1];
      }
      return tighten(r, true);
    }

    // 1-for-1 swaps: trade a route bonus for a nearby unvisited one when that scores more
    function exchange(route, rnd, alpha, untilMs) {
      let improved = true;
      while (improved && Date.now() < untilMs) {
        improved = false;
        const inr = new Uint8Array(n); route.forEach(u => inr[u] = 1);
        const cur = obj(route);
        for (let i = 0; i < route.length && !improved; i++) {
          const u = route[i]; if (req.has(u)) continue;
          for (let v = 1; v < n - 1 && !improved; v++) {
            if (inr[v] || M.D[u * n + v] > 60) continue;
            if (valOf(v, inr) + 1e-9 < M.P[u] && !lam) continue;
            let r = route.slice(); r[i] = v;
            if (!feasible(r)) { r = tighten(r); if (!feasible(r)) continue; }
            if (obj(r) > cur + 1e-9) { route = greedy(r, rnd, alpha); improved = true; }
          }
        }
      }
      return route;
    }

    function local(r, rnd, alpha, untilMs) {
      r = greedy(r, rnd, alpha); r = tighten(r); r = greedy(r, rnd, alpha);
      if (untilMs) r = exchange(r, rnd, alpha, untilMs);
      return dropBad(r);
    }

    function better(a, b) {
      const oa = obj(a), ob = obj(b);
      return oa > ob + 1e-9 || (Math.abs(oa - ob) < 1e-9 && simulate(M, a).finish < simulate(M, b).finish - 0.5);
    }

    function ils(start, rnd, deadlineMs, alpha, polish) {
      let cur = local(start, rnd, alpha, polish ? deadlineMs : 0), best = cur.slice();
      while (Date.now() < deadlineMs) {
        if (!cur.length) break;
        let r;
        const c = cur[Math.floor(rnd() * cur.length)];
        const rad = [15, 30, 50, 80][Math.floor(rnd() * 4)];
        if (rnd() < 0.7) r = cur.filter(u => req.has(u) || M.D[c * n + u] > rad);
        else r = cur.filter(u => req.has(u) || rnd() > 0.3);
        r = tighten(r);
        const forbid = rnd() < 0.5 ? new Set([c]) : null;
        r = greedy(r, rnd, alpha, forbid); r = local(r, rnd, alpha);
        if (!feasible(r)) continue;
        if (polish && obj(r) > obj(best) - 400) r = exchange(r, rnd, alpha, deadlineMs);
        if (better(r, cur) || rnd() < 0.05) cur = r;
        if (better(r, best)) best = r.slice();
      }
      return best;
    }
    return { greedy, tighten, seed, ils, local, obj, feasible, better };
  }

  // budgetMs: wall-clock for this scenario. onProgress(fraction, bestRoute)
  function optimize(M, opts) {
    const { budgetMs = 8000, lam = 0, seed = 7, onProgress } = opts || {};
    const S = Searcher(M, lam), rnd = rng(seed), t0 = Date.now();
    const notes = [];
    let base = [];
    if (M.required.length) {
      base = S.seed(M.required);
      if (!S.feasible(base)) { notes.push('The "must visit" bonuses cannot all be reached in time; they were treated as optional.'); M = { ...M, required: [] }; base = []; }
    }
    // anchors: empty, each top bonus, each combo set
    const order = [];
    for (let u = 1; u < M.n - 1; u++) order.push(u);
    order.sort((a, b) => M.P[b] - M.P[a]);
    // anchors span the value ranking, every time-windowed bonus, and each compass sector around the start
    const pick = new Set(order.slice(0, 10));
    for (let u = 1; u < M.n - 1; u++) if (M.WIN[u]) pick.add(u);
    const sector = new Map();
    for (const u of order) {
      if (!M.geo || M.D[M.S * M.n + u] < 30) continue;
      const g = M.geo[u], s0 = M.geo[M.S];
      const k = Math.floor(((Math.atan2(g.lat - s0.lat, (g.lon - s0.lon) * Math.cos(s0.lat * Math.PI / 180)) + Math.PI) / (2 * Math.PI)) * 8) % 8;
      if (!sector.has(k)) sector.set(k, u);
    }
    sector.forEach(u => pick.add(u));
    const anchors = [[], ...[...pick].map(u => [u])];
    M.combos.forEach(c => anchors.push(c.members.slice()));
    for (let i = anchors.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [anchors[i], anchors[j]] = [anchors[j], anchors[i]]; }
    const pool = [];
    const ph1 = budgetMs * 0.25, per = ph1 / anchors.length;
    for (let a = 0; a < anchors.length; a++) {
      let r = S.seed([...new Set([...base, ...anchors[a]])]);
      if (!S.feasible(r)) continue;
      const out = S.ils(r, rnd, Math.min(Date.now() + per, t0 + ph1), [1, 1.3, 1.6][a % 3]);
      pool.push(out);
      onProgress && onProgress(Math.min(0.25, (Date.now() - t0) / budgetMs), best(pool));
    }
    if (!pool.length) pool.push(base.length ? base : []);
    // later rounds: more time for fewer starts, chosen from different regions (low overlap of bonus sets)
    const diverse = k => {
      const sorted = pool.slice().sort((x, y) => S.obj(y) - S.obj(x)), tops = [];
      for (const r of sorted) {
        const set = new Set(r);
        if (tops.every(t => t.filter(u => set.has(u)).length < 0.5 * Math.min(t.length, r.length))) tops.push(r);
        if (tops.length >= k) break;
      }
      return tops;
    };
    const round = (tops, until, polish, f0, f1) => {
      const t1 = Date.now();
      for (let i = 0; i < tops.length; i++) {
        const out = S.ils(tops[i], rnd, t1 + (until - t1) * (i + 1) / tops.length, [1, 1.3, 1.6][i % 3], polish);
        pool.push(out);
        onProgress && onProgress(f0 + (f1 - f0) * (i + 1) / tops.length, best(pool));
      }
    };
    round(diverse(6), t0 + budgetMs * 0.6, false, 0.25, 0.6);
    round(diverse(2), t0 + budgetMs, true, 0.6, 0.99);
    return { route: best(pool), notes };
    function best(p) { let b = null; for (const r of p) if (!b || S.better(r, b)) b = r; return b || []; }
  }

  function describe(M, route) {
    const sim = simulate(M, route, true), sc = score(M, route);
    let run = 0;
    const legs = sim.legs.map((l, k) => {
      const isF = l.to === M.F, b = isF ? null : M.bon[l.to - 1];
      if (b) run += b.points;
      return { ...l, code: b ? b.code : 'FINISH', points: b ? b.points : 0, running: run, stop: isF ? 0 : M.STOP[l.to], win: b ? b.win : null };
    });
    const ride = sim.legs.reduce((a, l) => a + l.ride, 0);
    return { route: route.map(u => M.bon[u - 1].code), points: sc.points, combos: sc.combos, miles: sim.miles, finish: sim.finish, deadline: M.deadline, end: M.end, ride, wait: sim.wait, fuels: sim.fuels, viol: sim.viol, legs };
  }

  const api = { parseCoord, findCoordPair, parseClock, parseWindow, windowText, fmtTime, parseCSV, parseGPX, parseBook, merge, buildModel, simulate, score, optimize, describe, hav };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.RallyEngine = api;
})(typeof self !== 'undefined' ? self : this);
