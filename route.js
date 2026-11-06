/* Ambulance Planner – Route deployment module (admin) */
'use strict';
const { esc, fmt, fmtInt, hm2min, min2hm, dayTag, dur, istISO, istHM, todayIST, addDays, niceDate, ago, haversine, distToLine, progressInfo, delayText } = AP;
const CFG = AP.CFG;
const $ = id => document.getElementById(id);
const num = v => { if (v === '' || v == null) return null; const n = +v; return isFinite(n) ? n : null; };
const clone = o => JSON.parse(JSON.stringify(o));
const stCls = s => String(s || '').replace(/\s+/g, '');
const COLORS = ['#e11d48', '#2563eb', '#16a34a', '#d97706', '#7c3aed', '#0891b2', '#db2777', '#4d7c0f', '#b91c1c', '#0f766e'];
const STATUSES = ['Planned', 'Assigned', 'In progress', 'Completed', 'Cancelled'];

/* ---------------- state ---------------- */
const S = { amb: [], staff: [], routes: [], deps: [], depRange: null, grid: null, gridIdx: null, route: null, dirty: false, tab: 'routes', day: todayIST(), rosterView: 'week', liveDate: todayIST(), liveSel: null, live: [], bulkKind: 'staff', bulk: null };
const LEG = new Map();          // engine|a>b -> {km, min, geom} or {err}
let localKeys = {}; try { localKeys = JSON.parse(localStorage.getItem('ap-keys') || '{}') || {}; } catch (e) {}
const keyOf = k => (localKeys[k] || CFG[k] || '').trim();

/* ---------------- ui helpers ---------------- */
let toastT = 0;
function toast(msg, bad) { const t = $('toast'); t.textContent = msg; t.className = 'toast show' + (bad ? ' bad' : ''); clearTimeout(toastT); toastT = setTimeout(() => { t.className = 'toast' + (bad ? ' bad' : ''); }, bad ? 6500 : 3200); }
function busy(on, msg) { $('busy').classList.toggle('show', !!on); if (msg) $('busyMsg').textContent = msg; }
async function guard(fn, msg) { busy(true, msg || 'Saving…'); try { return await fn(); } catch (e) { console.error(e); toast(e.message || String(e), true); return undefined; } finally { busy(false); } }
function openModal(html, wide) { $('mbody').innerHTML = html; $('mbox').className = 'mbox' + (wide ? ' wide' : ''); $('modal').classList.add('show'); }
function closeModal() { $('modal').classList.remove('show'); $('mbody').innerHTML = ''; }
$('modal').addEventListener('click', e => { if (e.target === $('modal') || e.target.closest('[data-close]')) closeModal(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') { if ($('modal').classList.contains('show')) closeModal(); else if (addMode) setAddMode(false); } });
const opt = (v, label, sel) => `<option value="${esc(v)}"${sel ? ' selected' : ''}>${esc(label)}</option>`;
const ambById = id => S.amb.find(a => a.id === id), staffById = id => S.staff.find(s => s.id === id), routeById = id => S.routes.find(r => r.id === id);
const staffName = id => { const s = staffById(id); return s ? s.name : ''; };
function download(name, data, type) { const b = data instanceof Blob ? data : new Blob([data], { type }); const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500); }
function parseLatLng(str) {
  let s = String(str || '').trim(); try { s = decodeURIComponent(s); } catch (e) {}
  const pats = [[/@(-?\d+\.\d+),\s*(-?\d+\.\d+)/, 0], [/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/, 0], [/!2d(-?\d+\.\d+)!3d(-?\d+\.\d+)/, 1], [/[?&](?:q|query|ll|center|destination)=(-?\d+\.\d+),\s*(-?\d+\.\d+)/, 0], [/^\s*(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)\s*$/, 0]];
  for (const [re, sw] of pats) { const m = s.match(re); if (!m) continue; let a = +m[1], b = +m[2]; if (sw) [a, b] = [b, a]; if (Math.abs(a) <= 90 && Math.abs(b) <= 180) return { lat: a, lng: b }; }
  return null;
}

/* ---------------- theme ---------------- */
function setTheme(t) { document.documentElement.dataset.theme = t; try { localStorage.setItem('ap-route-theme', t); } catch (e) {} $('themeBtn').innerHTML = `<svg class="i"><use href="#i-${t === 'dark' ? 'sun' : 'moon'}"/></svg>`; }
let th = null; try { th = localStorage.getItem('ap-route-theme'); } catch (e) {}
setTheme(th || (window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
$('themeBtn').addEventListener('click', () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));

/* ---------------- tabs ---------------- */
function showTab(t) {
  S.tab = t; try { localStorage.setItem('ap-route-tab', t); } catch (e) {}
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
  document.querySelectorAll('.pane').forEach(p => p.classList.toggle('on', p.dataset.pane === t));
  if (t === 'routes') { rmap.invalidateSize(); }
  if (t === 'roster') renderRoster();
  if (t === 'live') { lmap.invalidateSize(); loadLive(); }
  if (t === 'dash') loadDash();
  if (t === 'masters') renderMasters();
  if (t === 'settings') renderSettings();
}
$('tabs').addEventListener('click', e => { const b = e.target.closest('[data-tab]'); if (b) showTab(b.dataset.tab); });

/* =========================================================
   Routing engines (real road network only)
   ========================================================= */
const ENGINES = {
  ors: { name: 'openrouteservice', short: 'ORS', key: () => keyOf('ORS_API_KEY'), note: 'Road distance and normal (no live traffic) drive time from OpenStreetMap roads.' },
  ola: { name: 'Ola Maps', short: 'Ola', key: () => keyOf('OLA_MAPS_API_KEY'), note: 'Road distance and drive time with current traffic, from Ola Maps.' }
};
const engReady = e => !!(ENGINES[e] && ENGINES[e].key());
const firstEngine = () => ['ors', 'ola'].find(engReady) || null;
const r5 = v => (+v).toFixed(5);
const legKey = (eng, a, b) => `${eng}|${r5(a.lat)},${r5(a.lng)}>${r5(b.lat)},${r5(b.lng)}`;
function thin(pts, max = 160) { if (pts.length <= max) return pts.map(p => [+p[0].toFixed(5), +p[1].toFixed(5)]); const out = [], st = (pts.length - 1) / (max - 1); for (let i = 0; i < max; i++) { const p = pts[Math.round(i * st)]; out.push([+p[0].toFixed(5), +p[1].toFixed(5)]); } return out; }
async function httpJSON(url, init, who) {
  let r;
  try { r = await fetch(url, init); }
  catch (e) { throw new Error(`${who}: no response (check internet, or the service blocked this site)`); }
  let j = null, txt = ''; try { txt = await r.text(); j = txt ? JSON.parse(txt) : null; } catch (e) {}
  if (!r.ok) {
    const m = j && ((j.error && (j.error.message || j.error)) || j.message || j.reason) || txt.slice(0, 140) || r.statusText;
    if (r.status === 401 || r.status === 403) throw new Error(`${who} refused the key (${r.status}): ${m}. Check the key in config.js.`);
    if (r.status === 429) throw new Error(`${who}: daily or per-minute limit reached. Wait a minute and retry.`);
    throw new Error(`${who} error ${r.status}: ${typeof m === 'string' ? m : JSON.stringify(m)}`);
  }
  return j;
}
/* ORS: whole chain in one call (≤ 50 points per call), split into legs */
async function orsLegs(pts) {
  const out = [];
  for (let s = 0; s < pts.length - 1; s += 49) {
    const chunk = pts.slice(s, s + 50);
    const j = await httpJSON('https://api.openrouteservice.org/v2/directions/driving-car/geojson', {
      method: 'POST', headers: { 'Authorization': ENGINES.ors.key(), 'Content-Type': 'application/json', 'Accept': 'application/json, application/geo+json' },
      body: JSON.stringify({ coordinates: chunk.map(p => [+p.lng, +p.lat]), radiuses: chunk.map(() => -1), instructions: false })
    }, 'openrouteservice');
    const f = j && j.features && j.features[0]; if (!f) throw new Error('openrouteservice returned no route');
    const segs = f.properties.segments || [], wp = f.properties.way_points || [], coords = f.geometry.coordinates || [];
    for (let k = 0; k < chunk.length - 1; k++) {
      const sg = segs[k] || { distance: 0, duration: 0 }, a = wp[k] != null ? wp[k] : 0, b = wp[k + 1] != null ? wp[k + 1] : coords.length - 1;
      out.push({ km: (sg.distance || 0) / 1000, min: (sg.duration || 0) / 60, geom: thin(coords.slice(a, b + 1).map(c => [c[1], c[0]])) });
    }
  }
  return out;
}
const valNum = v => v == null ? NaN : typeof v === 'number' ? v : typeof v === 'object' ? +(v.value ?? NaN) : parseFloat(v);
function decodePoly(str, prec) { const f = Math.pow(10, prec), out = []; let i = 0, lat = 0, lng = 0; while (i < str.length) { let b, sh = 0, r = 0; do { b = str.charCodeAt(i++) - 63; r |= (b & 0x1f) << sh; sh += 5; } while (b >= 0x20 && i < str.length); lat += (r & 1) ? ~(r >> 1) : (r >> 1); sh = 0; r = 0; do { b = str.charCodeAt(i++) - 63; r |= (b & 0x1f) << sh; sh += 5; } while (b >= 0x20 && i < str.length); lng += (r & 1) ? ~(r >> 1) : (r >> 1); out.push([lat / f, lng / f]); } return out; }
async function olaLeg(a, b) {
  const u = `https://api.olamaps.io/routing/v1/directions?origin=${(+a.lat).toFixed(6)},${(+a.lng).toFixed(6)}&destination=${(+b.lat).toFixed(6)},${(+b.lng).toFixed(6)}&mode=driving&overview=full&api_key=${encodeURIComponent(ENGINES.ola.key())}`;
  const j = await httpJSON(u, { method: 'POST', headers: { 'X-Request-Id': DB.uuid() } }, 'Ola Maps');
  const r = j && (j.routes || (j.data && j.data.routes) || [])[0]; if (!r) throw new Error('Ola Maps returned no route');
  const legs = r.legs || [];
  let sec = legs.reduce((t, l) => t + (valNum(l.duration_in_traffic ?? l.duration) || 0), 0), m = legs.reduce((t, l) => t + (valNum(l.distance) || 0), 0);
  if (!sec) sec = valNum(r.duration); if (!m) m = valNum(r.distance);
  if (!isFinite(m) || m <= 0) throw new Error('Ola Maps returned no distance');
  const enc = typeof r.overview_polyline === 'string' ? r.overview_polyline : r.overview_polyline && r.overview_polyline.points;
  let geom = null;
  if (enc) for (const pr of [5, 6]) { const p = decodePoly(enc, pr); if (p.length > 1 && Math.abs(p[0][0] - a.lat) < 0.05 && Math.abs(p[0][1] - a.lng) < 0.05) { geom = thin(p); break; } }
  return { km: m / 1000, min: isFinite(sec) ? sec / 60 : NaN, geom: geom || null };
}

/* =========================================================
   Routes: schedule engine
   ========================================================= */
const newRoute = () => ({ id: DB.uuid(), name: '', data: { start_time: '08:00', speed: 30, halt: 30, radius: 2, engine: firstEngine() || 'ors', time_src: 'speed', stops: [], legs: {} }, _new: true });
function normRoute(r) {
  const d = r.data = r.data || {};
  d.start_time = hm2min(d.start_time) != null ? d.start_time : '08:00'; d.speed = num(d.speed) || 30; d.halt = num(d.halt) ?? 30; d.radius = num(d.radius) || 2;
  d.engine = ENGINES[d.engine] ? d.engine : (firstEngine() || 'ors'); d.time_src = d.time_src === 'engine' ? 'engine' : 'speed';
  d.stops = Array.isArray(d.stops) ? d.stops.filter(s => s && isFinite(+s.lat) && isFinite(+s.lng)).map(s => ({ id: s.id || DB.uuid(), ...s, lat: +s.lat, lng: +s.lng })) : [];
  d.legs = d.legs && typeof d.legs === 'object' ? d.legs : {};
  return r;
}
function legOf(r, a, b) { const k = legKey(r.data.engine, a, b); return LEG.get(k) || r.data.legs[k] || null; }
const fixDay = (hm, ref) => { if (ref == null) return hm; return hm + 1440 * Math.round((ref - hm) / 1440); };
function popOf(s, R) { if (s.pop_src === 'Grid') return S.grid ? gridSum([[s.lat, s.lng, num(s.radius) || R]], null) : null; return num(s.pop); }
function schedule(r, startMin, noOverride) {
  const d = r.data, rows = []; let prev = null, incomplete = false, pending = false;
  if (startMin == null) startMin = hm2min(d.start_time) ?? 480;
  d.stops.forEach((s, i) => {
    let leg = null, travel = 0, speed = null;
    if (i) {
      leg = legOf(r, d.stops[i - 1], s);
      if (leg && !leg.err && isFinite(leg.km)) {
        if (d.time_src === 'engine' && leg.min > 0) { travel = leg.min; speed = leg.km / (leg.min / 60); }
        else { speed = num(s.speed) || d.speed; travel = leg.km / speed * 60; }
      } else { travel = null; incomplete = true; if (!leg || !leg.err) pending = true; }
    }
    const arrC = i === 0 ? startMin : (prev != null && travel != null ? prev + travel : null);
    let arr = arrC; const ao = noOverride ? null : hm2min(s.arr_ov);
    if (ao != null) arr = fixDay(ao, arrC ?? prev ?? startMin);
    const halt = num(s.halt) ?? d.halt;
    let dep = arr != null ? arr + halt : null; const doo = noOverride ? null : hm2min(s.dep_ov);
    if (doo != null && arr != null) { dep = fixDay(doo, arr + halt); if (dep < arr) dep += 1440; }
    rows.push({ i, s, leg, speed, travel, arrC, arr, dep, halt: arr != null && dep != null ? dep - arr : halt, arrOv: ao != null, depOv: doo != null, pop: popOf(s, d.radius) });
    prev = dep;
  });
  const base = noOverride ? null : schedule(r, startMin, true).rows;
  if (base) rows.forEach((x, i) => { const b = base[i]; x.shift = x.arr != null && b.arr != null ? x.arr - b.arr : 0; });
  const legs = rows.slice(1);
  const tot = {
    stops: rows.length, km: legs.reduce((t, x) => t + (x.leg && isFinite(x.leg.km) ? x.leg.km : 0), 0), drive: legs.reduce((t, x) => t + (x.travel || 0), 0),
    halt: rows.reduce((t, x) => t + (x.halt || 0), 0), start: rows.length ? rows[0].arr : null, end: rows.length ? rows[rows.length - 1].dep : null, incomplete, pending
  };
  tot.dur = tot.start != null && tot.end != null ? tot.end - tot.start : null;
  const pc = popCoverage(r, rows); Object.assign(tot, pc);
  return { rows, tot };
}
/* population: sum, overlaps, unique (only with a grid), area */
function popCoverage(r, rows) {
  const d = r.data, circ = d.stops.map(s => [s.lat, s.lng, num(s.radius) || d.radius]);
  const sum = rows.reduce((t, x) => t + (x.pop || 0), 0), withPop = rows.filter(x => x.pop != null).length;
  const overlaps = [];
  for (let i = 0; i < circ.length; i++) for (let j = i + 1; j < circ.length; j++) if (haversine(circ[i], circ[j]) < circ[i][2] + circ[j][2] - 0.01) overlaps.push([i, j]);
  let unique = null, uniqueBy = null;
  if (S.grid && circ.length) { uniqueBy = []; unique = gridSum(circ, uniqueBy); }
  let area = 0;
  if (circ.length) {
    const la = circ.map(c => c[0]), lo = circ.map(c => c[1]), R = Math.max(...circ.map(c => c[2]));
    const kx = 111.32 * Math.cos(la[0] * Math.PI / 180), ky = 110.57;
    const x0 = Math.min(...lo) - R / kx, x1 = Math.max(...lo) + R / kx, y0 = Math.min(...la) - R / ky, y1 = Math.max(...la) + R / ky;
    const n = 140, dx = (x1 - x0) / n, dy = (y1 - y0) / n; let hit = 0;
    for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) { const p = [y0 + (a + .5) * dy, x0 + (b + .5) * dx]; if (circ.some(c => Math.hypot((p[0] - c[0]) * ky, (p[1] - c[1]) * kx) <= c[2])) hit++; }
    area = hit * dx * kx * dy * ky;
  }
  const best = unique != null ? unique : (withPop ? sum : null);
  return { pop_sum: withPop ? sum : null, pop_n: withPop, overlaps, pop_unique: unique, pop_unique_by: uniqueBy, pop_best: best, area };
}
/* population grid: points bucketed by 0.01° */
function buildGridIdx() { const idx = new Map(); (S.grid || []).forEach(p => { const k = `${Math.floor(p[0] * 100)}|${Math.floor(p[1] * 100)}`; if (!idx.has(k)) idx.set(k, []); idx.get(k).push(p); }); S.gridIdx = idx; }
function gridSum(circles, perCircle) {
  if (!S.gridIdx) return null;
  const seen = new Set(); let tot = 0;
  circles.forEach((c, ci) => {
    let mine = 0; const r = c[2] || 0, dLa = r / 110.57, dLo = r / (111.32 * Math.cos(c[0] * Math.PI / 180));
    for (let a = Math.floor((c[0] - dLa) * 100); a <= Math.floor((c[0] + dLa) * 100); a++) for (let b = Math.floor((c[1] - dLo) * 100); b <= Math.floor((c[1] + dLo) * 100); b++) {
      const cell = S.gridIdx.get(`${a}|${b}`); if (!cell) continue;
      cell.forEach(p => { if (haversine(c, p) <= r) { if (!seen.has(p)) { seen.add(p); mine += p[2]; tot += p[2]; } } });
    }
    if (perCircle) perCircle[ci] = mine;
  });
  return tot;
}

/* =========================================================
   Routes: map
   ========================================================= */
const osm = () => L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: 'Tiles © Esri — Esri, HERE, Garmin, © OpenStreetMap contributors' });
const HOME = [28.479814, 77.074042];
const rmap = L.map('rmap', { zoomControl: true, preferCanvas: false }).setView(HOME, 12); osm().addTo(rmap);
const lmap = L.map('lmap', { zoomControl: true }).setView(HOME, 11); osm().addTo(lmap);
const rG = { line: L.layerGroup().addTo(rmap), circ: L.layerGroup().addTo(rmap), pins: L.layerGroup().addTo(rmap) };
let addMode = false, showCirc = true;
function setAddMode(on) { addMode = on; $('addMode').classList.toggle('on', on); rmap.getContainer().style.cursor = on ? 'crosshair' : ''; setStat(on ? 'Click the map to add stops · Esc to stop' : ''); }
$('addMode').addEventListener('click', () => setAddMode(!addMode));
$('circBtn').addEventListener('click', () => { showCirc = !showCirc; $('circBtn').classList.toggle('on', showCirc); drawRoute(); });
$('fitBtn').addEventListener('click', () => fitRoute());
function setStat(t) { $('rStatus').innerHTML = t || ''; }
const pinIcon = (n, cls) => L.divIcon({ className: 'mk', iconSize: [28, 28], iconAnchor: [14, 30], html: `<div class="pinnum ${cls || ''}"><span>${n}</span></div>` });
function fitRoute() { const st = S.route && S.route.data.stops; if (st && st.length) rmap.fitBounds(L.latLngBounds(st.map(s => [s.lat, s.lng])).pad(0.2), { maxZoom: 15 }); }
rmap.on('click', e => { if (!addMode || !S.route) return; addStop(e.latlng.lat, e.latlng.lng, null); });
function drawRoute() {
  rG.line.clearLayers(); rG.circ.clearLayers(); rG.pins.clearLayers();
  const r = S.route; if (!r) return;
  const d = r.data, sc = schedule(r);
  d.stops.forEach((s, i) => {
    if (i) {
      const lg = legOf(r, d.stops[i - 1], s);
      if (lg && lg.geom && lg.geom.length > 1) L.polyline(lg.geom, { color: '#2563eb', weight: 5, opacity: .85 }).addTo(rG.line);
      else L.polyline([[d.stops[i - 1].lat, d.stops[i - 1].lng], [s.lat, s.lng]], { color: lg && lg.err ? '#dc2626' : '#94a3b8', weight: 2, dashArray: '4 8', opacity: .9 }).bindTooltip(lg && lg.err ? 'No road route: ' + esc(lg.err) : 'Waiting for road route').addTo(rG.line);
    }
    if (showCirc) { const rad = (num(s.radius) || d.radius) * 1000, ov = sc.tot.overlaps.some(p => p.includes(i)); L.circle([s.lat, s.lng], { radius: rad, color: ov ? '#d97706' : '#e11d48', weight: 1.2, fillOpacity: .06, interactive: false }).addTo(rG.circ); }
    const row = sc.rows[i];
    const m = L.marker([s.lat, s.lng], { draggable: true, icon: pinIcon(i + 1, i === 0 ? 'first' : ''), zIndexOffset: 500 }).addTo(rG.pins);
    m.bindTooltip(`<b>${i + 1}. ${esc(s.name || 'Stop')}</b><br>${row.arr != null ? `Arrive ${min2hm(row.arr)} · leave ${min2hm(row.dep)}` : 'Times pending road route'}${row.pop != null ? `<br>Population ${fmtInt(row.pop)}` : ''}`, { direction: 'top', offset: [0, -28] });
    m.on('dragend', () => { const p = m.getLatLng(); s.lat = +p.lat.toFixed(6); s.lng = +p.lng.toFixed(6); markDirty(); renderRoute(); });
  });
}

/* =========================================================
   Routes: road legs
   ========================================================= */
let legTimer = 0, legGen = 0;
function needLegs(r) { const d = r.data, out = []; for (let i = 1; i < d.stops.length; i++) { const k = legKey(d.engine, d.stops[i - 1], d.stops[i]); if (!LEG.has(k) && !d.legs[k]) out.push(i); } return out; }
function queueLegs() { clearTimeout(legTimer); legTimer = setTimeout(fetchLegs, 600); }
async function fetchLegs(force) {
  const r = S.route; if (!r) return;
  const d = r.data, need = force ? d.stops.slice(1).map((_, i) => i + 1) : needLegs(r);
  if (!need.length) { setStat(addMode ? 'Click the map to add stops · Esc to stop' : ''); return; }
  if (!engReady(d.engine)) { setStat(`<span class="err">No road routing key for ${esc(ENGINES[d.engine].name)}.</span> Add it in config.js (see the setup guide). Times stay blank until roads are measured.`); renderRoute(true); return; }
  const gen = ++legGen, eng = d.engine;
  setStat(`Getting road route from ${esc(ENGINES[eng].name)}… (${need.length} leg${need.length > 1 ? 's' : ''})`);
  try {
    if (eng === 'ors') {
      const pts = d.stops.map(s => ({ lat: s.lat, lng: s.lng })), legs = await orsLegs(pts);
      if (gen !== legGen) return;
      legs.forEach((lg, k) => { LEG.set(legKey(eng, pts[k], pts[k + 1]), lg); });
    } else {
      for (let n = 0; n < need.length; n++) {
        const i = need[n], a = d.stops[i - 1], b = d.stops[i], k = legKey(eng, a, b);
        setStat(`Getting road route from Ola Maps… ${n + 1}/${need.length}`);
        try { LEG.set(k, await olaLeg(a, b)); } catch (e) { if (/refused the key|limit/i.test(e.message)) throw e; LEG.set(k, { err: e.message }); }
        if (gen !== legGen) return;
      }
    }
    setStat('');
  } catch (e) {
    if (gen !== legGen) return;
    need.forEach(i => { const k = legKey(eng, d.stops[i - 1], d.stops[i]); if (!LEG.has(k)) LEG.set(k, { err: e.message }); });
    setStat(`<span class="err">${esc(e.message)}</span> <button class="btn sm" id="legRetry">Retry</button>`);
    const b = $('legRetry'); if (b) b.onclick = () => { need.forEach(i => LEG.delete(legKey(eng, d.stops[i - 1], d.stops[i]))); fetchLegs(); };
  }
  if (gen === legGen && S.route === r) renderRoute(true);
}

/* =========================================================
   Routes: panel
   ========================================================= */
function markDirty() { S.dirty = true; $('routeSave').classList.add('dirty'); $('routeSaved').textContent = 'unsaved changes'; }
function clearDirty() { S.dirty = false; $('routeSave').classList.remove('dirty'); $('routeSaved').textContent = S.route && !S.route._new ? `saved ${S.route.updated_at ? ago(S.route.updated_at) : ''}` : ''; }
window.addEventListener('beforeunload', e => { if (S.dirty) { e.preventDefault(); e.returnValue = ''; } });
function renderRouteSel() {
  const cur = S.route && S.route.id;
  $('routeSel').innerHTML = (S.route && S.route._new ? opt(S.route.id, (S.route.name || 'New route') + ' (not saved)', true) : '') + S.routes.map(r => opt(r.id, `${r.name} · ${(r.data.stops || []).length} stops`, r.id === cur)).join('') || '<option>No routes yet</option>';
}
function renderEngineSel() {
  const d = S.route.data;
  $('rEngine').innerHTML = Object.entries(ENGINES).map(([k, e]) => opt(k, `${e.name}${engReady(k) ? '' : ' (no key)'}`, d.engine === k)).join('');
  $('engineNote').innerHTML = `${esc(ENGINES[d.engine].note)}${engReady(d.engine) ? '' : ' <span class="err">No key set: add it in config.js.</span>'}${d.time_src === 'engine' ? ' Travel time uses the engine’s estimate; the speed column then shows the resulting average speed.' : ' Travel time = road distance ÷ planned speed (per-stop speed overrides the default).'}`;
}
function loadRouteToForm() {
  const r = S.route, d = r.data;
  $('rName').value = r.name || ''; $('rStart').value = d.start_time; $('rSpeed').value = d.speed; $('rHalt').value = d.halt; $('rRadius').value = d.radius; $('rTimeSrc').value = d.time_src;
  renderEngineSel(); renderRouteSel(); clearDirty(); if (S.route._new) markDirty();
}
function setRoute(r) { S.route = normRoute(clone(r)); if (r._new) S.route._new = true; Object.entries(S.route.data.legs).forEach(([k, v]) => { if (!LEG.has(k)) LEG.set(k, v); }); loadRouteToForm(); renderRoute(); fitRoute(); queueLegs(); }
[['rName', v => { S.route.name = v.trim().slice(0, 80); }], ['rStart', v => { if (hm2min(v) != null) S.route.data.start_time = v; }], ['rSpeed', v => { const n = num(v); if (n && n >= 5 && n <= 150) S.route.data.speed = n; }],
 ['rHalt', v => { const n = num(v); if (n != null && n >= 0) S.route.data.halt = n; }], ['rRadius', v => { const n = num(v); if (n && n > 0 && n <= 50) S.route.data.radius = n; }],
 ['rTimeSrc', v => { S.route.data.time_src = v; }], ['rEngine', v => { S.route.data.engine = v; queueLegs(); }]].forEach(([id, f]) => $(id).addEventListener('change', e => { f(e.target.value); markDirty(); renderEngineSel(); renderRoute(); }));
$('routeSel').addEventListener('change', e => {
  const r = routeById(e.target.value); if (!r || (S.route && r.id === S.route.id)) return;
  if (S.dirty && !confirm('Discard unsaved changes to this route?')) { renderRouteSel(); return; }
  setRoute(r);
});
$('routeNew').addEventListener('click', () => { if (S.dirty && !confirm('Discard unsaved changes to this route?')) return; setRoute(newRoute()); $('rName').focus(); });
$('routeDup').addEventListener('click', () => { if (!S.route) return; const c = clone(S.route); c.id = DB.uuid(); c.name = (S.route.name || 'Route') + ' (copy)'; c._new = true; c.data.stops.forEach(s => { s.id = DB.uuid(); }); setRoute(c); toast('Copy made. Rename it and save.'); });
$('routeDel').addEventListener('click', async () => {
  const r = S.route; if (!r) return;
  if (r._new) { setRoute(S.routes[0] || newRoute()); return; }
  const used = S.deps.filter(x => x.route_id === r.id).length;
  if (!confirm(`Delete route “${r.name}”?${used ? ` ${used} loaded deployment(s) use it; they keep their schedule but lose the link to this route.` : ''}`)) return;
  await guard(async () => { await DB.remove('routes', r.id); S.routes = S.routes.filter(x => x.id !== r.id); S.dirty = false; setRoute(S.routes[0] || newRoute()); toast('Route deleted'); }, 'Deleting…');
});
function addStop(lat, lng, name, idx) {
  const d = S.route.data, s = { id: DB.uuid(), name: name || `Stop ${d.stops.length + 1}`, lat: +(+lat).toFixed(6), lng: +(+lng).toFixed(6), pop: null, pop_src: 'Manual', pop_date: null, radius: null, halt: null, speed: null, arr_ov: null, dep_ov: null, remarks: '' };
  if (idx == null) d.stops.push(s); else d.stops.splice(idx, 0, s);
  markDirty(); renderRoute(); queueLegs();
  if (!name) reverseName(s);
  return s;
}
async function reverseName(s) {
  try {
    const j = await httpJSON(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${s.lat}&lon=${s.lng}&zoom=16&accept-language=en`, {}, 'Place names');
    const a = j && j.address || {}, nm = j && (j.name || a.neighbourhood || a.suburb || a.village || a.road || a.town || a.city);
    if (nm && /^Stop \d+$/.test(s.name)) { s.name = String(nm).slice(0, 80); renderStops(schedule(S.route)); drawRoute(); }
  } catch (e) { /* keep the default name */ }
}
function renderRoute(noFetch) {
  if (!S.route) return;
  const sc = schedule(S.route);
  renderStops(sc); renderSummary(sc); drawRoute();
  if (!noFetch) queueLegs();
}
function renderSummary(sc) {
  const t = sc.tot, inc = t.incomplete;
  const st = (l, v, s) => `<div class="stat"><div class="l">${l}</div><div class="v">${v}</div>${s ? `<div class="s">${s}</div>` : ''}</div>`;
  $('sumAside').innerHTML = inc ? `<span class="${t.pending ? 'warn' : 'err'}">${t.pending ? 'measuring roads…' : 'some legs have no road route'}</span>` : t.stops > 1 ? `<span class="good">road distances ✓</span>` : '';
  const ph = t.pop_best != null && t.dur > 0 ? t.pop_best / (t.dur / 60) : null;
  $('sumStats').innerHTML = st('Total road distance', `${fmt(t.km)} km`, inc ? 'incomplete' : '') + st('Driving time', dur(t.drive)) + st('Halt time', dur(t.halt)) +
    st('Deployment duration', dur(t.dur), t.start != null ? `${min2hm(t.start)} → ${min2hm(t.end)}${dayTag(t.end)}` : '') + st('Locations', t.stops, `${fmt(t.area, 0)} km² within radius`) +
    st('Population covered', t.pop_best != null ? fmtInt(t.pop_best) : '–', t.pop_unique != null ? 'unique (grid)' : t.pop_n ? `sum of ${t.pop_n} stop${t.pop_n > 1 ? 's' : ''}` : 'enter per stop') +
    st('Completion', t.end != null ? `${min2hm(t.end)}${dayTag(t.end)}` : '–', 'estimated') + st('Population / hour', ph != null ? fmtInt(ph) : '–', 'covered ÷ duration') + st('Avg speed', t.drive ? `${fmt(t.km / (t.drive / 60), 0)} km/h` : '–', 'over driving time');
  const ov = t.overlaps;
  $('popNote').innerHTML = (ov.length ? `<span class="warn">${ov.length} overlapping coverage pair${ov.length > 1 ? 's' : ''}: ${ov.slice(0, 6).map(([a, b]) => `${a + 1}–${b + 1}`).join(', ')}${ov.length > 6 ? '…' : ''}.</span> ` : '') +
    (t.pop_unique != null ? `Unique population counts each grid point once, even where circles overlap (sum of stops ${fmtInt(t.pop_sum)}).` : ov.length ? 'The total is a plain sum, so overlapping areas may be counted twice. Load a population grid in Settings for a unique count.' : 'Overlaps are checked using each stop’s coverage radius.');
}
function renderStops(sc) {
  const r = S.route, d = r.data, box = $('stops');
  if (!d.stops.length) { box.innerHTML = '<div class="empty">No stops yet.<br>Search a place above the map, or press <b>Add stops</b> and click the map.</div>'; return; }
  const hasGrid = !!S.grid;
  box.innerHTML = sc.rows.map((x, i) => {
    const s = x.s, lg = x.leg;
    const legLine = i ? `<div class="leg${lg && lg.err ? ' err' : ''}">${lg && lg.err ? `No road route: ${esc(lg.err)}` : lg && isFinite(lg.km) ? `↓ <b>${fmt(lg.km)} km</b> · ${dur(x.travel)} at ${fmt(x.speed, 0)} km/h${d.time_src === 'speed' && lg.min > 0 ? ` <span class="hint">(${ENGINES[d.engine].short} estimate ${dur(lg.min)})</span>` : ''}` : '↓ measuring road distance…'}</div>` : '';
    const shift = x.shift && Math.abs(x.shift) >= 1 && !x.arrOv ? ` <span class="ovr" title="Changed by a manual time earlier in the route">${x.shift > 0 ? '+' : ''}${Math.round(x.shift)} min</span>` : '';
    return `${legLine}<div class="stop" data-i="${i}" data-id="${esc(s.id)}">
      <div class="grip" title="Drag to reorder"><button data-mv="-1" title="Move up">▲</button>⋮⋮<button data-mv="1" title="Move down">▼</button></div>
      <div class="num${i === 0 ? ' first' : ''}">${i + 1}</div>
      <div class="body">
        <input class="name" data-f="name" value="${esc(s.name)}" maxlength="80" aria-label="Location name">
        <div class="times">${i === 0 ? 'Start · ' : ''}Arrive <b>${min2hm(x.arr)}${x.arr != null ? dayTag(x.arr) : ''}</b>${x.arrOv ? ' <span class="ovr">manual</span>' : ''}${shift} · Leave <b>${min2hm(x.dep)}</b>${x.depOv ? ' <span class="ovr">manual</span>' : ''}${i < d.stops.length - 1 ? ` → ${esc(d.stops[i + 1].name)}` : ' · last stop'}</div>
        <div class="mini">
          <label>Halt (min)<input type="number" data-f="halt" min="0" step="5" value="${s.halt ?? ''}" placeholder="${d.halt}"></label>
          <label>${i ? 'Speed to here' : 'Speed'} (km/h)<input type="number" data-f="speed" min="5" max="150" value="${s.speed ?? ''}" placeholder="${d.speed}"${i && d.time_src === 'speed' ? '' : ' disabled'}></label>
          <label>Population<input type="number" data-f="pop" min="0" step="1" value="${s.pop_src === 'Grid' ? '' : (s.pop ?? '')}" placeholder="${s.pop_src === 'Grid' ? (x.pop != null ? fmtInt(x.pop) + ' (grid)' : 'grid') : '–'}"${s.pop_src === 'Grid' ? ' disabled' : ''}></label>
        </div>
        <details${s.arr_ov || s.dep_ov || s.remarks ? ' open' : ''}><summary>More: remarks, exact times, population source, location</summary>
          <div class="grid2">
            <label class="f" style="grid-column:1/-1">Remarks / instructions<input type="text" data-f="remarks" value="${esc(s.remarks || '')}" maxlength="300"></label>
            <label class="f">Fixed arrival (optional)<input type="time" data-f="arr_ov" value="${esc(s.arr_ov || '')}"></label>
            <label class="f">Fixed departure (optional)<input type="time" data-f="dep_ov" value="${esc(s.dep_ov || '')}"></label>
            <label class="f">Population source<select data-f="pop_src">${['Manual', 'External', 'Grid'].map(v => opt(v, v === 'Grid' ? `Population grid${hasGrid ? '' : ' (not loaded)'}` : v === 'External' ? 'External data' : 'Manual', (s.pop_src || 'Manual') === v)).join('')}</select></label>
            <label class="f">Population updated<input type="date" data-f="pop_date" value="${esc(s.pop_date || '')}"></label>
            <label class="f">Coverage radius (km)<input type="number" data-f="radius" min="0.2" max="50" step="0.1" value="${s.radius ?? ''}" placeholder="${d.radius}"></label>
            <label class="f">Lat, lng<input type="text" data-f="ll" value="${s.lat.toFixed(6)}, ${s.lng.toFixed(6)}"></label>
          </div>
        </details>
      </div>
      <button class="ico" data-del title="Remove stop">✕</button>
    </div>`;
  }).join('');
}
const stopsEl = $('stops');
stopsEl.addEventListener('change', e => {
  const card = e.target.closest('.stop'), f = e.target.dataset.f; if (!card || !f) return;
  const s = S.route.data.stops[+card.dataset.i], v = e.target.value; let reroute = false;
  if (f === 'name') s.name = v.trim().slice(0, 80) || s.name;
  else if (['halt', 'speed', 'pop', 'radius'].includes(f)) { const n = num(v); s[f] = n != null && n >= 0 ? n : null; }
  else if (f === 'arr_ov' || f === 'dep_ov') s[f] = hm2min(v) != null ? v : null;
  else if (f === 'pop_src') { if (v === 'Grid' && !S.grid) { toast('Load a population grid first: Settings → Population grid.', true); e.target.value = s.pop_src || 'Manual'; return; } s.pop_src = v; }
  else if (f === 'll') { const p = parseLatLng(v); if (!p) { toast('Use “lat, lng” or a Google Maps link.', true); e.target.value = `${s.lat}, ${s.lng}`; return; } s.lat = +p.lat.toFixed(6); s.lng = +p.lng.toFixed(6); reroute = true; }
  else s[f] = v;
  markDirty(); renderRoute(!reroute);
});
stopsEl.addEventListener('click', e => {
  const card = e.target.closest('.stop'); if (!card) return;
  const d = S.route.data, i = +card.dataset.i;
  if (e.target.closest('[data-del]')) { d.stops.splice(i, 1); markDirty(); renderRoute(); return; }
  const mv = e.target.closest('[data-mv]');
  if (mv) { const j = i + +mv.dataset.mv; if (j < 0 || j >= d.stops.length) return; [d.stops[i], d.stops[j]] = [d.stops[j], d.stops[i]]; markDirty(); renderRoute(); return; }
  if (e.target.closest('.num')) { const s = d.stops[i]; rmap.setView([s.lat, s.lng], Math.max(rmap.getZoom(), 15)); }
});
let dragI = null;
stopsEl.addEventListener('pointerdown', e => { const g = e.target.closest('.grip'); if (g && !e.target.closest('button')) g.parentElement.draggable = true; });
stopsEl.addEventListener('dragstart', e => { const c = e.target.closest('.stop'); if (!c) return; dragI = +c.dataset.i; c.classList.add('drag'); e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', String(dragI)); } catch (er) {} });
stopsEl.addEventListener('dragover', e => { const c = e.target.closest('.stop'); if (dragI == null || !c) return; e.preventDefault(); stopsEl.querySelectorAll('.over').forEach(x => x.classList.remove('over')); c.classList.add('over'); });
stopsEl.addEventListener('drop', e => {
  const c = e.target.closest('.stop'); if (dragI == null || !c) return; e.preventDefault();
  const to = +c.dataset.i, d = S.route.data; if (to !== dragI) { const [s] = d.stops.splice(dragI, 1); d.stops.splice(to, 0, s); markDirty(); }
  dragI = null; renderRoute();
});
stopsEl.addEventListener('dragend', () => { dragI = null; stopsEl.querySelectorAll('.stop').forEach(c => { c.draggable = false; c.classList.remove('drag', 'over'); }); });

$('routeSave').addEventListener('click', () => saveRoute());
async function saveRoute() {
  const r = S.route; if (!r) return false;
  if (!r.name) { toast('Give the route a name first.', true); $('rName').focus(); return false; }
  if (r.data.stops.length < 2) { toast('Add at least two stops.', true); return false; }
  const sc = schedule(r);
  if (sc.tot.incomplete && !confirm(`${sc.tot.pending ? 'Road distances are still being measured' : 'Some legs have no road route'}, so times are incomplete. Save anyway? Deployments can’t be shared with the team until every leg has a road route.`)) return false;
  // keep only legs for the current sequence
  const legs = {}; for (let i = 1; i < r.data.stops.length; i++) { const k = legKey(r.data.engine, r.data.stops[i - 1], r.data.stops[i]), v = LEG.get(k) || r.data.legs[k]; if (v && !v.err) legs[k] = v; }
  r.data.legs = legs;
  return await guard(async () => {
    const [row] = await DB.upsert('routes', [{ id: r.id, name: r.name, data: r.data }]);
    const i = S.routes.findIndex(x => x.id === row.id); if (i >= 0) S.routes[i] = normRoute(row); else S.routes.push(normRoute(row));
    S.routes.sort((a, b) => a.name.localeCompare(b.name));
    delete r._new; r.updated_at = row.updated_at; clearDirty(); renderRouteSel();
    const n = await refreshPlansForRoute(row.id);
    toast(`Route saved${n ? ` · ${n} upcoming deployment${n > 1 ? 's' : ''} updated` : ''}`);
    return true;
  });
}
/* deployments that haven't started follow route edits automatically */
async function refreshPlansForRoute(routeId) {
  const r = routeById(routeId); if (!r) return 0;
  const today = todayIST(), all = await DB.list('deployments', { from: addDays(today, -1), eq: { route_id: routeId } });
  const upd = all.filter(d => !started(d) && ['Planned', 'Assigned'].includes(d.status)).map(d => ({ ...adminRow(d), plan: buildPlan(r, d) }));
  if (upd.length) { const rows = await DB.upsert('deployments', upd); mergeDeps(rows); }
  return upd.length;
}
$('schedBtn').addEventListener('click', () => openScheduleTable());
function openScheduleTable() {
  const r = S.route, sc = schedule(r), d = r.data;
  openModal(`<h2>${esc(r.name || 'Route')} · full schedule</h2>
  <div class="tw"><table class="t"><thead><tr><th>#</th><th>Location</th><th>Latitude</th><th>Longitude</th><th>Population</th><th>Source</th><th>Arrival</th><th>Departure</th><th>Halt</th><th>Next destination</th><th>Road km from prev.</th><th>Travel</th><th>Speed</th><th>Remarks</th></tr></thead><tbody>
  ${sc.rows.map((x, i) => `<tr><td>${i + 1}</td><td>${esc(x.s.name)}</td><td class="n">${x.s.lat.toFixed(6)}</td><td class="n">${x.s.lng.toFixed(6)}</td><td class="n">${x.pop != null ? fmtInt(x.pop) : ''}</td><td>${esc(x.s.pop_src || 'Manual')}${x.s.pop_date ? ` (${esc(x.s.pop_date)})` : ''}</td><td>${min2hm(x.arr)}${x.arrOv ? ' *' : ''}</td><td>${min2hm(x.dep)}${x.depOv ? ' *' : ''}</td><td class="n">${dur(x.halt)}</td><td>${i < d.stops.length - 1 ? esc(d.stops[i + 1].name) : '–'}</td><td class="n">${i ? (x.leg && isFinite(x.leg.km) ? fmt(x.leg.km) : '–') : 'Start'}</td><td class="n">${i ? dur(x.travel) : ''}</td><td class="n">${i && x.speed ? fmt(x.speed, 0) : ''}</td><td>${esc(x.s.remarks || '')}</td></tr>`).join('')}
  <tr><td></td><td><b>Total</b></td><td></td><td></td><td class="n"><b>${sc.tot.pop_best != null ? fmtInt(sc.tot.pop_best) : ''}</b></td><td></td><td>${min2hm(sc.tot.start)}</td><td>${min2hm(sc.tot.end)}</td><td class="n">${dur(sc.tot.halt)}</td><td></td><td class="n"><b>${fmt(sc.tot.km)}</b></td><td class="n">${dur(sc.tot.drive)}</td><td></td><td></td></tr></tbody></table></div>
  <p class="note">* fixed time entered by hand. Times shown for the route’s start time ${esc(d.start_time)}; each deployment recalculates from its own start time.</p>
  <div class="mfoot"><button class="btn" id="stCsv"><svg class="i"><use href="#i-csv"/></svg>Download CSV</button><button class="btn" data-close>Close</button></div>`, true);
  $('stCsv').onclick = () => {
    const rows = [['Point', 'Location', 'Latitude', 'Longitude', 'Population', 'Population source', 'Population updated', 'Planned arrival', 'Planned departure', 'Halt (min)', 'Next destination', 'Road distance from previous (km)', 'Expected travel time (min)', 'Expected speed (km/h)', 'Remarks']];
    sc.rows.forEach((x, i) => rows.push([i + 1, x.s.name, x.s.lat, x.s.lng, x.pop ?? '', x.s.pop_src || 'Manual', x.s.pop_date || '', min2hm(x.arr), min2hm(x.dep), Math.round(x.halt), i < d.stops.length - 1 ? d.stops[i + 1].name : '', i && x.leg ? +x.leg.km.toFixed(2) : '', i ? Math.round(x.travel || 0) : '', i && x.speed ? Math.round(x.speed) : '', x.s.remarks || '']));
    download(slug(r.name) + '-schedule.csv', '﻿' + toCSV(rows), 'text/csv');
  };
}
$('fromBase').addEventListener('click', () => {
  const list = S.amb.filter(a => a.base_lat != null && a.base_lng != null);
  if (!list.length) { toast('No ambulance has a base location yet. Add bases in Ambulances & staff.', true); return; }
  openModal(`<h2>Start the route at a base</h2><div class="tw"><table class="t"><tbody>${list.map(a => `<tr class="click" data-a="${esc(a.id)}"><td><b>${esc(a.reg_no)}</b> <span class="hint">${esc(a.type)}</span></td><td>${esc(a.base_name || '')}</td><td class="hint">${a.base_lat.toFixed(5)}, ${a.base_lng.toFixed(5)}</td></tr>`).join('')}</tbody></table></div><p class="note">Adds the base as stop 1 with no halt.</p>`);
  $('mbody').querySelector('tbody').onclick = e => { const tr = e.target.closest('[data-a]'); if (!tr) return; const a = ambById(tr.dataset.a); closeModal(); const s = addStop(a.base_lat, a.base_lng, `Base – ${a.base_name || a.reg_no}`, 0); s.halt = 0; renderRoute(); fitRoute(); };
});

/* ---------------- search ---------------- */
let sTimer = 0, sGen = 0, lastRes = [];
const resEl = $('results');
$('q').addEventListener('input', e => { clearTimeout(sTimer); const q = e.target.value.trim(); if (q.length < 3) { resEl.classList.remove('show'); return; } sTimer = setTimeout(() => search(q), 380); });
$('q').addEventListener('keydown', e => { if (e.key === 'Enter') { clearTimeout(sTimer); search(e.target.value.trim()); } });
document.addEventListener('click', e => { if (!e.target.closest('.msearch')) resEl.classList.remove('show'); });
async function search(q) {
  if (!q) return; const gen = ++sGen;
  const p = parseLatLng(q); if (p) return showRes([{ name: 'Coordinates', sub: `${p.lat.toFixed(6)}, ${p.lng.toFixed(6)}`, lat: p.lat, lng: p.lng }]);
  resEl.innerHTML = '<div class="msg">Searching…</div>'; resEl.classList.add('show');
  const c = rmap.getCenter(); let items = [], src = '';
  try {
    if (keyOf('ORS_API_KEY')) { src = 'openrouteservice'; const j = await httpJSON(`https://api.openrouteservice.org/geocode/autocomplete?api_key=${encodeURIComponent(keyOf('ORS_API_KEY'))}&text=${encodeURIComponent(q)}&boundary.country=IN&focus.point.lat=${c.lat}&focus.point.lon=${c.lng}&size=8`, {}, 'Search'); items = (j.features || []).map(f => ({ name: f.properties.name, sub: f.properties.label, lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0] })); }
    else if (keyOf('OLA_MAPS_API_KEY')) { src = 'Ola Maps'; const j = await httpJSON(`https://api.olamaps.io/places/v1/autocomplete?input=${encodeURIComponent(q)}&location=${c.lat},${c.lng}&api_key=${encodeURIComponent(keyOf('OLA_MAPS_API_KEY'))}`, { headers: { 'X-Request-Id': DB.uuid() } }, 'Search'); items = (j.predictions || []).filter(x => x.geometry && x.geometry.location).map(x => ({ name: (x.structured_formatting && x.structured_formatting.main_text) || x.description, sub: x.description, lat: x.geometry.location.lat, lng: x.geometry.location.lng })); }
  } catch (e) { items = []; }
  if (!items.length) { try { src = 'OpenStreetMap'; const j = await httpJSON(`https://nominatim.openstreetmap.org/search?format=jsonv2&q=${encodeURIComponent(q)}&countrycodes=in&limit=8&viewbox=${c.lng - 0.6},${c.lat + 0.6},${c.lng + 0.6},${c.lat - 0.6}&accept-language=en`, {}, 'Search'); items = (j || []).map(x => ({ name: x.name || x.display_name.split(',')[0], sub: x.display_name, lat: +x.lat, lng: +x.lon })); } catch (e) { if (gen === sGen) { resEl.innerHTML = `<div class="msg err">${esc(e.message)}</div>`; } return; } }
  if (gen !== sGen) return;
  showRes(items, src);
}
function showRes(items, src) {
  lastRes = items;
  resEl.innerHTML = items.length ? `<div class="msg">Click a result to add it as stop ${S.route ? S.route.data.stops.length + 1 : ''}</div>` + items.map((r, i) => `<button data-i="${i}">${esc(r.name)}<small>${esc(r.sub || '')}</small></button>`).join('') + (src ? `<div class="msg" style="text-align:right">Results: ${esc(src)}</div>` : '') : '<div class="msg">Nothing found. Try another spelling, or paste coordinates.</div>';
  resEl.classList.add('show');
}
resEl.addEventListener('click', e => { const b = e.target.closest('[data-i]'); if (!b) return; const r = lastRes[+b.dataset.i]; resEl.classList.remove('show'); $('q').value = ''; addStop(r.lat, r.lng, String(r.name || 'Stop').slice(0, 80)); rmap.setView([r.lat, r.lng], Math.max(rmap.getZoom(), 14)); });

/* =========================================================
   Deployments: plan snapshot, conflicts
   ========================================================= */
const started = d => !!(d.progress && ((d.progress.stops && Object.values(d.progress.stops).some(e => e && Object.keys(e).length)) || d.progress.done));
const ADMIN_KEYS = ['id', 'dep_date', 'ambulance_id', 'pilot_id', 'emt_id', 'route_id', 'start_time', 'end_time', 'status', 'notes', 'plan'];
const adminRow = d => { const o = {}; ADMIN_KEYS.forEach(k => { o[k] = d[k] === undefined ? null : d[k]; }); if (!o.plan) o.plan = {}; return o; };
function buildPlan(r, dep) {
  const sc = schedule(normRoute(clone(r)), hm2min(dep.start_time)), d = r.data;
  const geom = []; for (let i = 1; i < d.stops.length; i++) { const lg = legOf(r, d.stops[i - 1], d.stops[i]); geom.push(lg && lg.geom ? lg.geom : []); }
  return {
    route_id: r.id, route_name: r.name, date: dep.dep_date, start_time: dep.start_time, engine: d.engine, time_src: d.time_src, built_at: new Date().toISOString(), incomplete: sc.tot.incomplete,
    stops: sc.rows.map((x, i) => ({ name: x.s.name, lat: x.s.lat, lng: x.s.lng, remarks: x.s.remarks || '', pop: x.pop, pop_src: x.s.pop_src || 'Manual', pop_date: x.s.pop_date || null, radius: num(x.s.radius) || d.radius,
      overlaps: sc.tot.overlaps.filter(p => p.includes(i)).map(p => p[0] === i ? p[1] : p[0]), unique: sc.tot.pop_unique_by ? sc.tot.pop_unique_by[i] : null,
      halt: Math.round(x.halt || 0), km: i && x.leg && isFinite(x.leg.km) ? +x.leg.km.toFixed(3) : null, travel: i && x.travel != null ? +x.travel.toFixed(1) : null, speed: i && x.speed ? +x.speed.toFixed(1) : null,
      arr: x.arr != null ? istISO(dep.dep_date, x.arr) : null, dep: x.dep != null ? istISO(dep.dep_date, x.dep) : null, manual: !!(x.arrOv || x.depOv) })),
    geom,
    totals: { km: +sc.tot.km.toFixed(2), drive: Math.round(sc.tot.drive), halt: Math.round(sc.tot.halt), dur: sc.tot.dur != null ? Math.round(sc.tot.dur) : null, stops: sc.tot.stops,
      pop_sum: sc.tot.pop_sum, pop_unique: sc.tot.pop_unique, pop_best: sc.tot.pop_best, area: +sc.tot.area.toFixed(1), end: sc.tot.end != null ? istISO(dep.dep_date, sc.tot.end) : null }
  };
}
function depSpan(d) { const s = hm2min(d.start_time) ?? 0; let e = hm2min(d.end_time) ?? s; if (e <= s) e += 1440; return [new Date(istISO(d.dep_date, s)).getTime(), new Date(istISO(d.dep_date, e)).getTime()]; }
function conflictsFor(d, pool) {
  if (d.status === 'Cancelled') return [];
  const [a0, a1] = depSpan(d), out = [], ppl = [d.pilot_id, d.emt_id].filter(Boolean);
  pool.forEach(o => {
    if (o.id === d.id || o.status === 'Cancelled') return;
    const [b0, b1] = depSpan(o); if (!(a0 < b1 && b0 < a1)) return;
    const when = `${niceDate(o.dep_date)} ${o.start_time}–${o.end_time}`;
    if (o.ambulance_id === d.ambulance_id) out.push(`${(ambById(d.ambulance_id) || {}).reg_no || 'Ambulance'} is already deployed ${when}`);
    ppl.forEach(p => { if (p === o.pilot_id || p === o.emt_id) out.push(`${staffName(p)} is already on ${(ambById(o.ambulance_id) || {}).reg_no || 'another ambulance'} ${when}`); });
  });
  return out;
}
function mergeDeps(rows) { rows.forEach(r => { const i = S.deps.findIndex(x => x.id === r.id); if (i >= 0) S.deps[i] = r; else S.deps.push(r); }); }
async function loadDeps(from, to, force) {
  if (!force && S.depRange && S.depRange[0] <= from && S.depRange[1] >= to) return;
  const rows = await DB.list('deployments', { from, to });
  S.deps = S.deps.filter(d => d.dep_date < from || d.dep_date > to).concat(rows);
  S.depRange = S.depRange && !force ? [S.depRange[0] < from ? S.depRange[0] : from, S.depRange[1] > to ? S.depRange[1] : to] : [from, to];
}

/* =========================================================
   Roster
   ========================================================= */
const weekStart = ds => { const [y, m, d] = ds.split('-').map(Number), wd = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7; return addDays(ds, -wd); };
const weekDays = ds => { const s = weekStart(ds); return Array.from({ length: 7 }, (_, i) => addDays(s, i)); };
$('wkDate').value = S.day;
$('wkDate').addEventListener('change', e => { if (e.target.value) { S.day = e.target.value; renderRoster(); } });
$('wkPrev').addEventListener('click', () => { S.day = addDays(S.day, S.rosterView === 'week' ? -7 : -1); renderRoster(); });
$('wkNext').addEventListener('click', () => { S.day = addDays(S.day, S.rosterView === 'week' ? 7 : 1); renderRoster(); });
$('wkToday').addEventListener('click', () => { S.day = todayIST(); renderRoster(); });
$('rosterView').addEventListener('click', e => { const b = e.target.closest('[data-v]'); if (!b) return; S.rosterView = b.dataset.v; document.querySelectorAll('#rosterView button').forEach(x => x.classList.toggle('on', x === b)); renderRoster(); });
async function renderRoster() {
  $('wkDate').value = S.day;
  const days = weekDays(S.day);
  try { await loadDeps(addDays(days[0], -7), days[6]); } catch (e) { $('rosterBox').innerHTML = `<p class="err" style="padding:12px">${esc(e.message)}</p>`; return; }
  const pool = S.deps, conf = {}; pool.forEach(d => { const c = conflictsFor(d, pool); if (c.length) conf[d.id] = c; });
  const visible = new Set(S.rosterView === 'week' ? days : [S.day]);
  const confList = Object.entries(conf).filter(([id]) => { const d = pool.find(x => x.id === id); return d && visible.has(d.dep_date); });
  $('confBar').innerHTML = confList.length ? `<div class="conflicts" style="margin-bottom:10px">${confList.length} deployment${confList.length > 1 ? 's have' : ' has'} a clash: ${confList.slice(0, 4).map(([, m]) => esc(m[0])).join(' · ')}${confList.length > 4 ? ' …' : ''}</div>` : '';
  const today = todayIST(), chip = d => {
    const r = d.plan && d.plan.route_name ? d.plan.route_name : (routeById(d.route_id) || {}).name || 'No route';
    return `<span class="dchip ${stCls(d.status)}${conf[d.id] ? ' conf' : ''}" data-dep="${esc(d.id)}" title="${esc((conf[d.id] || []).join('\n'))}"><b>${esc(d.start_time)}–${esc(d.end_time)}</b> ${esc(r)}<small>${esc([staffName(d.pilot_id), staffName(d.emt_id)].filter(Boolean).join(' · ') || 'no crew')} · ${esc(d.status)}</small></span>`;
  };
  if (S.rosterView === 'week') {
    $('wkTitle').textContent = `Week of ${niceDate(days[0])}`;
    const ambs = S.amb.filter(a => a.active || pool.some(d => d.ambulance_id === a.id && visible.has(d.dep_date)));
    $('rosterBox').innerHTML = ambs.length ? `<table class="roster"><thead><tr><th>Ambulance</th>${days.map(ds => `<th class="${ds === today ? 'today' : ''}">${niceDate(ds).replace(/ \d{4}$/, '')}</th>`).join('')}</tr></thead><tbody>${ambs.map(a => `<tr><td class="amb"><b>${esc(a.reg_no)}</b><span class="hint">${esc(a.type)} · ${esc([staffName(a.default_pilot), staffName(a.default_emt)].filter(Boolean).join(' · ') || 'no default crew')}</span></td>${days.map(ds => { const list = pool.filter(d => d.ambulance_id === a.id && d.dep_date === ds).sort((x, y) => x.start_time.localeCompare(y.start_time)); return `<td class="cell" data-amb="${esc(a.id)}" data-date="${ds}">${list.map(chip).join('')}<span class="add">+ deploy</span></td>`; }).join('')}</tr>`).join('')}</tbody></table>` : '<p class="note" style="padding:14px">No ambulances yet. Add them in <b>Ambulances &amp; staff</b> (paste from Excel).</p>';
  } else {
    $('wkTitle').textContent = niceDate(S.day);
    const list = pool.filter(d => d.dep_date === S.day).sort((x, y) => x.start_time.localeCompare(y.start_time) || ((ambById(x.ambulance_id) || {}).reg_no || '').localeCompare((ambById(y.ambulance_id) || {}).reg_no || ''));
    $('rosterBox').innerHTML = list.length ? `<table class="t"><thead><tr><th>Date</th><th>Ambulance</th><th>Type</th><th>Pilot</th><th>Paramedic / EMT</th><th>Route</th><th>Start</th><th>End</th><th>Stops</th><th>Road km</th><th>Status</th><th></th></tr></thead><tbody>${list.map(d => { const a = ambById(d.ambulance_id) || {}, t = (d.plan && d.plan.totals) || {}; return `<tr class="click" data-dep="${esc(d.id)}"${conf[d.id] ? ` style="box-shadow:inset 3px 0 var(--bad)" title="${esc(conf[d.id].join('\n'))}"` : ''}><td>${esc(niceDate(d.dep_date))}</td><td><b>${esc(a.reg_no || '?')}</b></td><td>${esc(a.type || '')}</td><td>${esc(staffName(d.pilot_id))}</td><td>${esc(staffName(d.emt_id))}</td><td>${esc((d.plan && d.plan.route_name) || (routeById(d.route_id) || {}).name || '')}</td><td>${esc(d.start_time)}</td><td>${esc(d.end_time)}</td><td class="n">${t.stops || ''}</td><td class="n">${t.km != null ? fmt(t.km) : ''}</td><td><span class="st st-${stCls(d.status)}">${esc(d.status)}</span></td><td><button class="btn sm" data-qr="${esc(d.id)}">QR</button></td></tr>`; }).join('')}</tbody></table>` : `<p class="note" style="padding:14px">No deployments on ${esc(niceDate(S.day))}. Use <b>New deployment</b>, or switch to Week and click a cell.</p>`;
  }
  updateLiveCount();
}
$('rosterBox').addEventListener('click', e => {
  const q = e.target.closest('[data-qr]'); if (q) { e.stopPropagation(); const d = S.deps.find(x => x.id === q.dataset.qr); if (d) openQR(d); return; }
  const c = e.target.closest('[data-dep]'); if (c) { const d = S.deps.find(x => x.id === c.dataset.dep); if (d) openDep(d); return; }
  const cell = e.target.closest('td.cell'); if (cell) openDep(null, { ambulance_id: cell.dataset.amb, dep_date: cell.dataset.date });
});
$('newDep').addEventListener('click', () => openDep(null, { dep_date: S.day }));
function depDefaults(p) {
  const a = ambById(p.ambulance_id) || S.amb.find(x => x.active) || {}, rId = p.route_id || a.default_route || null, r = routeById(rId);
  const start = p.start_time || (r ? r.data.start_time : '08:00');
  let end = p.end_time; if (!end) { const sc = r ? schedule(normRoute(clone(r)), hm2min(start)) : null; end = sc && sc.tot.end != null ? min2hm(Math.ceil(sc.tot.end / 15) * 15) : min2hm(hm2min(start) + 480); }
  return { id: DB.uuid(), dep_date: p.dep_date || S.day, ambulance_id: a.id || null, pilot_id: p.pilot_id !== undefined ? p.pilot_id : a.default_pilot || null, emt_id: p.emt_id !== undefined ? p.emt_id : a.default_emt || null, route_id: rId, start_time: start, end_time: end, status: 'Planned', notes: '', plan: {}, progress: {}, _new: true };
}
function cloneDep(d, date) { return { ...depDefaults({ ambulance_id: d.ambulance_id, route_id: d.route_id, pilot_id: d.pilot_id, emt_id: d.emt_id, start_time: d.start_time, end_time: d.end_time, dep_date: date }), notes: d.notes || '' }; }
async function saveDeps(list, label) {
  const rows = list.map(d => { const r = routeById(d.route_id); return { ...adminRow(d), plan: r ? buildPlan(r, d) : {} }; });
  const saved = await DB.upsert('deployments', rows); mergeDeps(saved); return saved;
}
$('copyPrevDay').addEventListener('click', async () => {
  const day = S.day, prev = addDays(day, -1); await loadDeps(prev, day);
  const src = S.deps.filter(d => d.dep_date === prev && d.status !== 'Cancelled'), have = S.deps.filter(d => d.dep_date === day);
  const todo = src.filter(d => !have.some(h => h.ambulance_id === d.ambulance_id && h.start_time === d.start_time));
  if (!todo.length) { toast(src.length ? `Everything from ${niceDate(prev)} is already on ${niceDate(day)}.` : `Nothing deployed on ${niceDate(prev)}.`); return; }
  if (!confirm(`Copy ${todo.length} deployment(s) from ${niceDate(prev)} to ${niceDate(day)}? Same ambulance, crew, route and times; status Planned.`)) return;
  await guard(async () => { await saveDeps(todo.map(d => cloneDep(d, day))); renderRoster(); toast(`${todo.length} deployment(s) copied`); }, 'Copying…');
});
$('copyPrevWeek').addEventListener('click', async () => {
  const days = weekDays(S.day); await loadDeps(addDays(days[0], -7), days[6]);
  const todo = [];
  days.forEach(ds => { const p = addDays(ds, -7); S.deps.filter(d => d.dep_date === p && d.status !== 'Cancelled').forEach(d => { if (!S.deps.some(h => h.dep_date === ds && h.ambulance_id === d.ambulance_id && h.start_time === d.start_time)) todo.push(cloneDep(d, ds)); }); });
  if (!todo.length) { toast('Nothing new to copy from last week.'); return; }
  if (!confirm(`Copy ${todo.length} deployment(s) from last week into the week of ${niceDate(days[0])}?`)) return;
  await guard(async () => { await saveDeps(todo); renderRoster(); toast(`${todo.length} deployment(s) copied`); }, 'Copying…');
});
$('autoFill').addEventListener('click', async () => {
  const days = weekDays(S.day); await loadDeps(days[0], days[6]);
  const ready = S.amb.filter(a => a.active && a.default_route && routeById(a.default_route)), todo = [];
  ready.forEach(a => days.forEach(ds => { if (!S.deps.some(d => d.ambulance_id === a.id && d.dep_date === ds && d.status !== 'Cancelled')) todo.push(depDefaults({ ambulance_id: a.id, dep_date: ds })); }));
  const skipped = S.amb.filter(a => a.active && !(a.default_route && routeById(a.default_route))).length;
  if (!todo.length) { toast(ready.length ? 'Every ambulance with a default route already has a deployment each day this week.' : 'Set a default route (and crew) for ambulances in Ambulances & staff first.', !ready.length); return; }
  if (!confirm(`Create ${todo.length} deployment(s) for the week of ${niceDate(days[0])} using each ambulance’s default route and crew?${skipped ? ` ${skipped} active ambulance(s) have no default route and are skipped.` : ''}`)) return;
  await guard(async () => { await saveDeps(todo); renderRoster(); toast(`${todo.length} deployment(s) created`); }, 'Creating…');
});

/* ---------------- deployment editor ---------------- */
function openDep(d, preset) {
  const isNew = !d; d = d ? clone(d) : depDefaults(preset || {});
  const pilots = S.staff.filter(s => s.active || s.id === d.pilot_id), emts = S.staff.filter(s => s.active || s.id === d.emt_id);
  const stOpts = (list, sel, role) => opt('', '— none —', !sel) + list.filter(s => s.role === role).map(s => opt(s.id, s.name + (s.phone ? ` · ${s.phone}` : ''), s.id === sel)).join('') + list.filter(s => s.role !== role).map(s => opt(s.id, `${s.name} (${s.role})`, s.id === sel)).join('');
  const hasStart = started(d);
  openModal(`<h2>${isNew ? 'New deployment' : 'Deployment'} <span class="st st-${stCls(d.status)}">${esc(d.status)}</span></h2>
  <div class="grid3">
    <label class="f">Date<input type="date" id="dDate" value="${esc(d.dep_date)}"></label>
    <label class="f">Ambulance<select id="dAmbS">${S.amb.filter(a => a.active || a.id === d.ambulance_id).map(a => opt(a.id, `${a.reg_no} · ${a.type}`, a.id === d.ambulance_id)).join('')}</select></label>
    <label class="f">Route<select id="dRouteS">${opt('', '— choose —', !d.route_id)}${S.routes.map(r => opt(r.id, `${r.name} (${(r.data.stops || []).length} stops)`, r.id === d.route_id)).join('')}</select></label>
    <label class="f">Pilot / driver<select id="dPilotS">${stOpts(pilots, d.pilot_id, 'Pilot')}</select></label>
    <label class="f">Paramedic / EMT<select id="dEmtS">${stOpts(emts, d.emt_id, 'EMT')}</select></label>
    <label class="f">Status<select id="dStatusS">${STATUSES.map(s => opt(s, s, s === d.status)).join('')}</select></label>
    <label class="f">Shift start (route starts)<input type="time" id="dStart" value="${esc(d.start_time)}"></label>
    <label class="f">Shift end<input type="time" id="dEnd" value="${esc(d.end_time)}"></label>
    <label class="f">Notes<input type="text" id="dNotes" value="${esc(d.notes || '')}" maxlength="300"></label>
  </div>
  <div id="dPrev" class="note"></div>
  <div id="dConf"></div>
  ${hasStart ? '<p class="note warn">The team has already started this deployment. Saving keeps their recorded times; route changes are applied only if you tick below.</p><label class="hint"><input type="checkbox" id="dReplan"> Rebuild the team’s schedule from the route</label>' : ''}
  <div class="mfoot">${isNew ? '' : '<button class="btn danger l" id="dDel">Delete</button>'}<button class="btn" data-close>Close</button>${isNew ? '' : '<button class="btn" id="dExp">Excel</button><button class="btn" id="dPrint">Print / PDF</button>'}<button class="btn" id="dSave">Save</button><button class="btn primary" id="dSaveQR">Save &amp; share QR</button></div>`);
  let endTouched = !isNew;
  const read = () => ({ ...d, dep_date: $('dDate').value, ambulance_id: $('dAmbS').value || null, route_id: $('dRouteS').value || null, pilot_id: $('dPilotS').value || null, emt_id: $('dEmtS').value || null, status: $('dStatusS').value, start_time: $('dStart').value, end_time: $('dEnd').value, notes: $('dNotes').value.trim() });
  async function refreshPrev() {
    const x = read(), r = routeById(x.route_id);
    if (r && !endTouched) { const sc = schedule(normRoute(clone(r)), hm2min(x.start_time)); if (sc.tot.end != null) $('dEnd').value = min2hm(Math.ceil(sc.tot.end / 15) * 15); }
    const y = read();
    if (r) { const p = buildPlan(r, y), t = p.totals; $('dPrev').innerHTML = `${t.stops} stops · ${fmt(t.km)} km by road · drive ${dur(t.drive)} · halts ${dur(t.halt)} · route ends ${t.end ? istHM(t.end) : '–'}${t.pop_best != null ? ` · population ${fmtInt(t.pop_best)}` : ''}${p.incomplete ? ' · <span class="err">some legs have no road route: open the route and fix before sharing</span>' : ''}`; }
    else $('dPrev').textContent = 'Pick a route to build the schedule.';
    if (y.dep_date) { try { await loadDeps(addDays(y.dep_date, -1), addDays(y.dep_date, 1)); } catch (e) {} }
    const c = conflictsFor(y, S.deps);
    $('dConf').innerHTML = c.length ? `<div class="conflicts">Clash: ${c.map(esc).join('<br>')}</div>` : y.ambulance_id ? '<div class="conflicts ok">No clash with other deployments.</div>' : '';
  }
  ['dDate', 'dAmbS', 'dRouteS', 'dPilotS', 'dEmtS', 'dStart'].forEach(id => $(id).addEventListener('change', () => {
    if (id === 'dAmbS' && isNew) { const a = ambById($('dAmbS').value); if (a) { if (a.default_pilot) $('dPilotS').value = a.default_pilot; if (a.default_emt) $('dEmtS').value = a.default_emt; if (a.default_route && !$('dRouteS').value) $('dRouteS').value = a.default_route; } }
    if (id === 'dRouteS' && !endTouched) { const r = routeById($('dRouteS').value); if (r && isNew) $('dStart').value = r.data.start_time; }
    refreshPrev();
  }));
  $('dEnd').addEventListener('change', () => { endTouched = true; refreshPrev(); });
  refreshPrev();
  async function save(qr) {
    const x = read();
    if (!x.ambulance_id) { toast('Choose an ambulance.', true); return null; }
    if (!x.dep_date || hm2min(x.start_time) == null || hm2min(x.end_time) == null) { toast('Fill date, start and end time.', true); return null; }
    if (qr && !x.route_id) { toast('Choose a route before sharing with the team.', true); return null; }
    const c = conflictsFor(x, S.deps);
    if (c.length && !confirm(`This deployment clashes:\n\n${c.join('\n')}\n\nSave anyway?`)) return null;
    const r = routeById(x.route_id), replan = !hasStart || ($('dReplan') && $('dReplan').checked);
    const plan = replan ? (r ? buildPlan(r, x) : {}) : d.plan;
    if (qr && plan.incomplete) { toast('Some legs of this route have no road route yet. Open the route, let it measure the roads, save it, then share.', true); return null; }
    if (qr && x.status === 'Planned') x.status = 'Assigned';
    return await guard(async () => { const [row] = await DB.upsert('deployments', [{ ...adminRow(x), plan }]); mergeDeps([row]); renderRoster(); return row; });
  }
  $('dSave').onclick = async () => { const row = await save(false); if (row) { closeModal(); toast('Deployment saved'); } };
  $('dSaveQR').onclick = async () => { const row = await save(true); if (row) openQR(row); };
  if (!isNew) {
    $('dDel').onclick = async () => { if (!confirm('Delete this deployment? Its QR link stops working. (To keep history, set status Cancelled instead.)')) return; await guard(async () => { await DB.remove('deployments', d.id); S.deps = S.deps.filter(x => x.id !== d.id); closeModal(); renderRoster(); toast('Deployment deleted'); }, 'Deleting…'); };
    $('dExp').onclick = () => exportXlsx([S.deps.find(x => x.id === d.id) || d], `deployment-${(ambById(d.ambulance_id) || {}).reg_no || ''}-${d.dep_date}`);
    $('dPrint').onclick = () => printDeps([S.deps.find(x => x.id === d.id) || d]);
  }
}

/* ---------------- QR + sharing ---------------- */
const teamUrl = d => new URL(`team.html#t=${d.token}`, location.href).href;
function qrCanvas(text, caption, scale = 8) {
  const q = qrcode(0, 'M'); q.addData(text); q.make();
  const n = q.getModuleCount(), m = 4, cap = caption ? caption.length * 22 + 14 : 0, c = document.createElement('canvas');
  c.width = (n + m * 2) * scale; c.height = (n + m * 2) * scale + cap;
  const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.fillStyle = '#000';
  for (let r = 0; r < n; r++) for (let k = 0; k < n; k++) if (q.isDark(r, k)) g.fillRect((k + m) * scale, (r + m) * scale, scale, scale);
  if (caption) { g.fillStyle = '#0b1220'; g.textAlign = 'center'; caption.forEach((t, i) => { g.font = `${i ? 500 : 700} ${i ? 17 : 20}px "Exo 2", Arial, sans-serif`; g.fillText(t, c.width / 2, (n + m * 2) * scale + 6 + 22 * (i + 1) - 4); }); }
  return c;
}
async function openQR(d0) {
  let d = d0;
  if (!d.token) { const [row] = await DB.list('deployments', { ids: [d.id] }); if (row) d = row; }
  if (!d.token) { toast('Save the deployment first.', true); return; }
  if (!d.route_id || !d.plan || !(d.plan.stops || []).length) { toast('This deployment has no route yet. Open it and choose a route.', true); return; }
  if (d.status === 'Planned') { const r = await guard(() => DB.upsert('deployments', [{ ...adminRow(d), status: 'Assigned' }]), 'Updating…'); if (r) { mergeDeps(r); d = { ...d, ...r[0] }; renderRoster(); } }
  const a = ambById(d.ambulance_id) || {}, url = teamUrl(d), pilot = staffById(d.pilot_id), emt = staffById(d.emt_id);
  const cap = [`${a.reg_no || ''} · ${niceDate(d.dep_date)}`, `${(d.plan && d.plan.route_name) || ''} · ${d.start_time}–${d.end_time}`];
  const cv = qrCanvas(url, cap);
  const msg = `${CFG.ORG_NAME || 'Ambulance'} deployment\n${a.reg_no || ''} · ${niceDate(d.dep_date)}\nRoute: ${(d.plan && d.plan.route_name) || ''} (${(d.plan.stops || []).length} stops)\nStart ${d.start_time} at ${(d.plan.stops[0] || {}).name || ''}\nOpen your route: ${url}`;
  const ph = p => p && p.phone ? String(p.phone).replace(/\D/g, '').replace(/^0+/, '').replace(/^(\d{10})$/, '91$1') : '';
  openModal(`<h2>QR for the team</h2><div class="qrwrap"><div id="qrBox"></div><div>
    <p style="margin-top:0"><b>${esc(a.reg_no || '')}</b> · ${esc(niceDate(d.dep_date))} · ${esc(d.start_time)}–${esc(d.end_time)}<br>${esc((d.plan && d.plan.route_name) || '')} · ${(d.plan.stops || []).length} stops<br>Pilot: ${esc(pilot ? pilot.name : '–')} · EMT: ${esc(emt ? emt.name : '–')}</p>
    <p class="note">The team scans this (or opens the link) on a phone. No login needed. The page shows only this deployment: next stop, times, a Navigate button that opens Google Maps, and Reached / Depart buttons that record the actual times.</p>
    <input type="text" readonly value="${esc(url)}" id="qrUrl" style="margin:6px 0">
    <div class="row">
      <button class="btn primary" id="qrPng">Download QR</button>
      ${ph(pilot) ? `<a class="btn" target="_blank" rel="noopener" href="https://wa.me/${ph(pilot)}?text=${encodeURIComponent(msg)}"><svg class="i"><use href="#i-wa"/></svg>Pilot on WhatsApp</a>` : ''}
      ${ph(emt) ? `<a class="btn" target="_blank" rel="noopener" href="https://wa.me/${ph(emt)}?text=${encodeURIComponent(msg)}"><svg class="i"><use href="#i-wa"/></svg>EMT on WhatsApp</a>` : ''}
      <a class="btn" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(msg)}"><svg class="i"><use href="#i-wa"/></svg>WhatsApp…</a>
      <button class="btn" id="qrCopy"><svg class="i"><use href="#i-link"/></svg>Copy link</button>
      ${navigator.share ? '<button class="btn" id="qrShare">Share…</button>' : ''}
      <button class="btn" id="qrPrint">Print card</button>
      <a class="btn" href="${esc(url)}" target="_blank" rel="noopener">Open team page</a>
    </div>
    <p class="note">Lost phone or wrong person got it? <button class="btn sm danger" id="qrReset">Make a new link</button> The old QR stops working at once.</p>
  </div></div>`);
  $('qrBox').appendChild(cv);
  const fname = `QR-${a.reg_no || 'deployment'}-${d.dep_date}.png`;
  $('qrPng').onclick = () => cv.toBlob(b => download(fname, b));
  $('qrCopy').onclick = async () => { try { await navigator.clipboard.writeText(url); toast('Link copied'); } catch (e) { $('qrUrl').select(); document.execCommand('copy'); toast('Link copied'); } };
  if ($('qrShare')) $('qrShare').onclick = () => cv.toBlob(async b => { try { const f = new File([b], fname, { type: 'image/png' }); await navigator.share(navigator.canShare && navigator.canShare({ files: [f] }) ? { files: [f], text: msg } : { text: msg }); } catch (e) {} });
  $('qrPrint').onclick = () => { $('printArea').innerHTML = `<div style="text-align:center;padding-top:20mm"><h1>${esc(CFG.ORG_NAME || '')} · Ambulance deployment</h1><img src="${cv.toDataURL()}" style="width:110mm"><p style="font-size:14px">Scan with the phone camera to open your route.<br>${esc(url)}</p></div>`; window.print(); };
  $('qrReset').onclick = async () => { if (!confirm('Make a new link? The current QR and link will stop working.')) return; const r = await guard(() => DB.update('deployments', d.id, { token: DB.token() }), 'Updating…'); if (r) { mergeDeps([r]); openQR(r); toast('New link made. Share the new QR.'); } };
}

/* =========================================================
   Live view
   ========================================================= */
$('liveDate').value = S.liveDate;
$('liveDate').addEventListener('change', e => { S.liveDate = e.target.value || todayIST(); loadLive(); });
$('liveRefresh').addEventListener('click', () => loadLive());
const lG = { routes: L.layerGroup().addTo(lmap), stops: L.layerGroup().addTo(lmap), amb: L.layerGroup().addTo(lmap), trail: L.layerGroup().addTo(lmap) };
let liveFitted = '';
setInterval(() => { if (S.tab === 'live' && $('liveAuto').checked && !document.hidden) loadLive(true); }, 30000);
async function loadLive(quiet) {
  try { S.live = (await DB.list('deployments', { from: S.liveDate, to: S.liveDate })).filter(d => d.status !== 'Cancelled'); mergeDeps(S.live); }
  catch (e) { if (!quiet) toast(e.message, true); return; }
  renderLive(); updateLiveCount();
}
function liveInfo(d) {
  const pi = progressInfo(d.plan, d.progress), flat = (d.plan.geom || []).flat();
  let off = null; if (d.last_lat != null && flat.length && (d.last_acc == null || d.last_acc < 300) && d.status === 'In progress') { const k = distToLine([d.last_lat, d.last_lng], flat); if (k > 1) off = k; }
  return { pi, off, stale: d.last_seen ? Date.now() - new Date(d.last_seen) > 10 * 60000 : true };
}
function renderLive() {
  const list = S.live.slice().sort((a, b) => a.start_time.localeCompare(b.start_time));
  $('liveAside').textContent = `${list.length} deployment${list.length === 1 ? '' : 's'} · updated ${new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' })}`;
  lG.routes.clearLayers(); lG.stops.clearLayers(); lG.amb.clearLayers(); lG.trail.clearLayers();
  if (!list.length) { $('liveList').innerHTML = `<p class="note">No deployments on ${esc(niceDate(S.liveDate))}.</p>`; $('liveDetail').style.display = 'none'; return; }
  const b = L.latLngBounds([]);
  $('liveList').innerHTML = list.map((d, k) => {
    const a = ambById(d.ambulance_id) || {}, { pi, off, stale } = liveInfo(d), col = COLORS[k % COLORS.length], nx = pi.rows[pi.cur];
    (d.plan.geom || []).forEach(g => { if (g.length > 1) { L.polyline(g, { color: col, weight: d.id === S.liveSel ? 5 : 3, opacity: d.id === S.liveSel || !S.liveSel ? .85 : .35 }).addTo(lG.routes); g.forEach(p => b.extend(p)); } });
    if (d.last_lat != null) { L.marker([d.last_lat, d.last_lng], { icon: L.divIcon({ className: 'mk', iconSize: [0, 0], html: `<span class="ambmk${stale ? ' stale' : ''}" style="${stale ? '' : `background:${col}`}">${esc(a.reg_no || '')}</span>` }), zIndexOffset: 1000 }).bindTooltip(`${esc(a.reg_no || '')} · last seen ${ago(d.last_seen)}${d.last_acc ? ` (±${Math.round(d.last_acc)} m)` : ''}`).on('click', () => selLive(d.id)).addTo(lG.amb); b.extend([d.last_lat, d.last_lng]); }
    const late = pi.delay >= 10 && !pi.done && pi.started;
    return `<div class="lv${d.id === S.liveSel ? ' sel' : ''}" data-id="${esc(d.id)}" style="border-left:4px solid ${col}">
      <div class="row"><b>${esc(a.reg_no || '?')}</b><span class="st st-${stCls(d.status)}">${esc(d.status)}</span>${late ? `<span class="chip bad">${Math.round(pi.delay)} min late</span>` : ''}${off ? `<span class="chip warn">${fmt(off)} km off route</span>` : ''}<span class="hint" style="margin-left:auto">${esc(d.start_time)}–${esc(d.end_time)}</span></div>
      <div class="hint">${esc(d.plan.route_name || '')} · ${esc([staffName(d.pilot_id), staffName(d.emt_id)].filter(Boolean).join(' · '))}</div>
      <div class="bar"><i style="width:${pi.n ? pi.nDone / pi.n * 100 : 0}%"></i></div>
      <div style="font-size:12.5px">${pi.done ? `Completed ${istHM(d.progress.done)}` : nx ? `${nx.st === 'at' ? 'At' : 'Next'}: <b>${esc(nx.stop.name)}</b> · planned ${istHM(nx.st === 'at' ? nx.stop.dep : nx.stop.arr)} · ETA ${istHM(nx.st === 'at' ? nx.etaDep : nx.etaArr)} ${pi.started ? `(${delayText(pi.delay)})` : ''}` : pi.allDeparted ? 'All stops done · waiting for “Complete”' : ''} · ${pi.nDone}/${pi.n} done</div>
      <div class="hint">Location ${d.last_seen ? ago(d.last_seen) : 'not shared'}</div></div>`;
  }).join('');
  const sig = S.liveDate + list.length;
  if (b.isValid() && liveFitted !== sig) { lmap.fitBounds(b.pad(0.15), { maxZoom: 14 }); liveFitted = sig; }
  renderLiveDetail();
}
$('liveList').addEventListener('click', e => { const c = e.target.closest('[data-id]'); if (c) selLive(c.dataset.id); });
function selLive(id) { S.liveSel = S.liveSel === id ? null : id; renderLive(); }
async function renderLiveDetail() {
  const box = $('liveDetail'), d = S.live.find(x => x.id === S.liveSel);
  if (!d) { box.style.display = 'none'; return; }
  const a = ambById(d.ambulance_id) || {}, { pi, off } = liveInfo(d);
  pi.rows.forEach(r => { L.marker([r.stop.lat, r.stop.lng], { icon: pinIcon(r.i + 1, r.st === 'done' ? 'done' : r.st === 'at' ? 'at' : r.i === 0 ? 'first' : '') }).bindTooltip(`${r.i + 1}. ${esc(r.stop.name)}`).addTo(lG.stops); });
  box.style.display = '';
  box.innerHTML = `<h3>${esc(a.reg_no || '')} · ${esc(d.plan.route_name || '')}<span class="aside"><a href="${esc(teamUrl(d))}" target="_blank" rel="noopener">team page</a></span></h3>
    ${off ? `<p class="warn">Last location is ${fmt(off)} km from the planned route.</p>` : ''}
    <div class="tw"><table class="t"><thead><tr><th>#</th><th>Stop</th><th>Planned</th><th>Actual</th><th>Delay</th><th>ETA</th></tr></thead><tbody>${pi.rows.map(r => `<tr${r.st === 'at' || r.st === 'next' ? ' style="background:var(--warnbg)"' : ''}><td>${r.i + 1}</td><td>${esc(r.stop.name)}</td><td>${istHM(r.stop.arr)}–${istHM(r.stop.dep)}</td><td>${r.actArr ? istHM(r.actArr) : '–'}${r.actDep ? '–' + istHM(r.actDep) : ''}</td><td class="${r.arrDelay > 10 ? 'err' : ''}">${r.arrDelay != null ? delayText(r.arrDelay) : ''}</td><td>${r.st === 'done' ? '✓' : istHM(r.etaArr)}</td></tr>`).join('')}</tbody></table></div>`;
  {
    try { const pings = (await DB.list('pings', { eq: { deployment_id: d.id }, limit: 2000 })).slice(-2000); if (pings.length > 1 && S.liveSel === d.id) L.polyline(pings.map(p => [p.lat, p.lng]), { color: '#0b1730', weight: 2, dashArray: '3 5' }).bindTooltip('Actual path (from the team phone)').addTo(lG.trail); } catch (e) {}
  }
}
async function updateLiveCount() {
  const n = S.deps.filter(d => d.dep_date === todayIST() && d.status === 'In progress').length;
  $('liveCnt').style.display = n ? '' : 'none'; $('liveCnt').textContent = n;
}

/* =========================================================
   Dashboard
   ========================================================= */
const today0 = todayIST(); $('dFrom').value = weekStart(today0); $('dTo').value = addDays(weekStart(today0), 6);
['dFrom', 'dTo'].forEach(id => $(id).addEventListener('change', () => loadDash()));
['dAmb', 'dType', 'dPilot', 'dRoute', 'dStatus', 'dLate'].forEach(id => $(id).addEventListener('change', () => renderDash()));
let dashRows = [];
function fillDashFilters() {
  const keep = id => $(id).value;
  const a = keep('dAmb'), p = keep('dPilot'), r = keep('dRoute');
  $('dAmb').innerHTML = opt('', 'All') + S.amb.map(x => opt(x.id, x.reg_no, x.id === a)).join('');
  $('dPilot').innerHTML = opt('', 'All') + S.staff.filter(x => x.role === 'Pilot').map(x => opt(x.id, x.name, x.id === p)).join('');
  $('dRoute').innerHTML = opt('', 'All') + S.routes.map(x => opt(x.id, x.name, x.id === r)).join('');
}
async function loadDash() {
  fillDashFilters();
  const f = $('dFrom').value, t = $('dTo').value; if (!f || !t || f > t) { $('dKpis').innerHTML = '<p class="err">Pick a valid date range.</p>'; return; }
  try { dashRows = await DB.list('deployments', { from: f, to: t }); } catch (e) { $('dKpis').innerHTML = `<p class="err">${esc(e.message)}</p>`; return; }
  renderDash();
}
function lateOf(d, thr) { const pi = progressInfo(d.plan, d.progress); const arr = pi.rows.filter(r => r.arrDelay != null); return { pi, arr, late: arr.some(r => r.arrDelay > thr) || (!pi.done && pi.started && pi.delay > thr) }; }
function renderDash() {
  const thr = num($('dLate').value) || 10, fa = $('dAmb').value, ft = $('dType').value, fp = $('dPilot').value, fr = $('dRoute').value, fs = $('dStatus').value;
  const rows = dashRows.filter(d => (!fa || d.ambulance_id === fa) && (!ft || (ambById(d.ambulance_id) || {}).type === ft) && (!fp || d.pilot_id === fp) && (!fr || d.route_id === fr) && (!fs || d.status === fs));
  const live = rows.filter(d => d.status !== 'Cancelled'), T = d => (d.plan && d.plan.totals) || {};
  const sum = k => live.reduce((t, d) => t + (+T(d)[k] || 0), 0);
  const L2 = live.map(d => lateOf(d, thr)), arrs = L2.flatMap(x => x.arr), onTime = arrs.filter(r => Math.abs(r.arrDelay) <= thr).length;
  const done = live.filter(d => d.status === 'Completed').length, pend = live.filter(d => ['Planned', 'Assigned', 'In progress'].includes(d.status)).length;
  const k = (l, v, s) => `<div class="stat"><div class="l">${l}</div><div class="v">${v}</div>${s ? `<div class="s">${s}</div>` : ''}</div>`;
  $('dKpis').innerHTML = k('Ambulances deployed', new Set(live.map(d => d.ambulance_id)).size, `${live.length} deployments`) + k('Routes planned', new Set(live.map(d => d.route_id).filter(Boolean)).size) +
    k('Locations covered', fmtInt(sum('stops'))) + k('Planned road km', fmt(sum('km'), 0)) + k('Deployment hours', fmt(sum('dur') / 60, 1)) + k('Population covered', fmtInt(sum('pop_best')), 'sum over deployments') +
    k('Completed vs pending', `${done} / ${pend}`, `${rows.length - live.length} cancelled`) + k('Delayed deployments', L2.filter(x => x.late).length, `late by more than ${thr} min`) +
    k('On-time arrivals', arrs.length ? `${Math.round(onTime / arrs.length * 100)}%` : '–', arrs.length ? `${arrs.length} arrivals · avg ${fmt(arrs.reduce((t, r) => t + r.arrDelay, 0) / arrs.length, 0)} min` : 'no arrivals recorded yet');
  $('dAside').textContent = `${rows.length} shown`;
  $('dTable').innerHTML = rows.length ? `<table class="t"><thead><tr><th>Date</th><th>Ambulance</th><th>Type</th><th>Pilot</th><th>EMT</th><th>Route</th><th>Shift</th><th>Stops</th><th>Road km</th><th>Hours</th><th>Population</th><th>Done</th><th>Delay</th><th>Status</th></tr></thead><tbody>${rows.map(d => { const a = ambById(d.ambulance_id) || {}, t = T(d), x = lateOf(d, thr); return `<tr class="click" data-dep="${esc(d.id)}"><td>${esc(d.dep_date)}</td><td><b>${esc(a.reg_no || '')}</b></td><td>${esc(a.type || '')}</td><td>${esc(staffName(d.pilot_id))}</td><td>${esc(staffName(d.emt_id))}</td><td>${esc((d.plan && d.plan.route_name) || '')}</td><td>${esc(d.start_time)}–${esc(d.end_time)}</td><td class="n">${t.stops || ''}</td><td class="n">${t.km != null ? fmt(t.km) : ''}</td><td class="n">${t.dur != null ? fmt(t.dur / 60) : ''}</td><td class="n">${t.pop_best != null ? fmtInt(t.pop_best) : ''}</td><td class="n">${x.pi.nDone}/${x.pi.n}</td><td class="${x.late ? 'err' : ''}">${x.pi.started ? delayText(x.pi.delay) : ''}</td><td><span class="st st-${stCls(d.status)}">${esc(d.status)}</span></td></tr>`; }).join('')}</tbody></table>` : '<p class="note" style="padding:12px">No deployments match.</p>';
}
$('dTable').addEventListener('click', e => { const tr = e.target.closest('[data-dep]'); if (!tr) return; const d = dashRows.find(x => x.id === tr.dataset.dep); if (d) { mergeDeps([d]); openDep(d); } });

/* =========================================================
   Masters: ambulances and staff (with bulk paste / upload)
   ========================================================= */
function cacheMaster() { try { localStorage.setItem('ap-master', JSON.stringify({ at: new Date().toISOString(), ambulances: S.amb.map(a => ({ reg_no: a.reg_no, type: a.type, base_name: a.base_name, base_lat: a.base_lat, base_lng: a.base_lng, active: a.active })) })); } catch (e) {} }
const AMB_KEYS = ['id', 'reg_no', 'type', 'base_name', 'base_lat', 'base_lng', 'default_pilot', 'default_emt', 'default_route', 'active', 'notes'];
const STAFF_KEYS = ['id', 'name', 'role', 'phone', 'emp_code', 'active'];
const pick = (o, keys) => { const r = {}; keys.forEach(k => { r[k] = o[k] === undefined ? null : o[k]; }); return r; };
function renderMasters() {
  const fa = ($('ambFind').value || '').toLowerCase(), fs = ($('staffFind').value || '').toLowerCase();
  const sOpts = (sel, role) => opt('', '—', !sel) + S.staff.filter(s => (s.active && s.role === role) || s.id === sel).map(s => opt(s.id, s.name, s.id === sel)).join('');
  const amb = S.amb.filter(a => !fa || JSON.stringify([a.reg_no, a.base_name, a.type]).toLowerCase().includes(fa));
  $('ambAside').textContent = `${S.amb.filter(a => a.active).length} active of ${S.amb.length}`;
  $('ambTable').innerHTML = amb.length ? `<table class="t"><thead><tr><th>Reg. no</th><th>Type</th><th>Base name</th><th>Base lat, lng</th><th>Default pilot</th><th>Default EMT</th><th>Default route</th><th>Active</th><th></th></tr></thead><tbody>${amb.map(a => `<tr data-id="${esc(a.id)}"><td><input type="text" data-f="reg_no" value="${esc(a.reg_no)}" style="min-width:120px"></td><td><select data-f="type">${['BLS', 'ALS', 'PTV', 'FRV'].map(t => opt(t, t, a.type === t)).join('')}</select></td><td><input type="text" data-f="base_name" value="${esc(a.base_name || '')}" style="min-width:120px"></td><td><input type="text" data-f="base_ll" value="${a.base_lat != null ? `${a.base_lat}, ${a.base_lng}` : ''}" placeholder="lat, lng or Maps link" style="min-width:150px"></td><td><select data-f="default_pilot">${sOpts(a.default_pilot, 'Pilot')}</select></td><td><select data-f="default_emt">${sOpts(a.default_emt, 'EMT')}</select></td><td><select data-f="default_route">${opt('', '—', !a.default_route)}${S.routes.map(r => opt(r.id, r.name, r.id === a.default_route)).join('')}</select></td><td><input type="checkbox" data-f="active"${a.active ? ' checked' : ''}></td><td><button class="ico" data-del title="Delete">✕</button></td></tr>`).join('')}</tbody></table>` : '<p class="note" style="padding:12px">No ambulances yet. Paste them above or press Add one.</p>';
  const st = S.staff.filter(s => !fs || JSON.stringify([s.name, s.phone, s.emp_code, s.role]).toLowerCase().includes(fs));
  $('staffAside').textContent = `${S.staff.filter(s => s.active && s.role === 'Pilot').length} pilots · ${S.staff.filter(s => s.active && s.role === 'EMT').length} EMTs`;
  $('staffTable').innerHTML = st.length ? `<table class="t"><thead><tr><th>Name</th><th>Role</th><th>Phone</th><th>Emp. code</th><th>Default crew on</th><th>Active</th><th></th></tr></thead><tbody>${st.map(s => `<tr data-id="${esc(s.id)}"><td><input type="text" data-f="name" value="${esc(s.name)}" style="min-width:140px"></td><td><select data-f="role">${opt('Pilot', 'Pilot / driver', s.role === 'Pilot')}${opt('EMT', 'EMT / paramedic', s.role === 'EMT')}</select></td><td><input type="tel" data-f="phone" value="${esc(s.phone || '')}" style="min-width:110px"></td><td><input type="text" data-f="emp_code" value="${esc(s.emp_code || '')}" style="min-width:90px"></td><td class="hint">${esc(S.amb.filter(a => a.default_pilot === s.id || a.default_emt === s.id).map(a => a.reg_no).join(', '))}</td><td><input type="checkbox" data-f="active"${s.active ? ' checked' : ''}></td><td><button class="ico" data-del title="Delete">✕</button></td></tr>`).join('')}</tbody></table>` : '<p class="note" style="padding:12px">No staff yet.</p>';
}
$('ambFind').addEventListener('input', renderMasters); $('staffFind').addEventListener('input', renderMasters);
async function saveOne(table, row, keys) {
  const [r] = await DB.upsert(table, [pick(row, keys)]);
  const arr = table === 'ambulances' ? S.amb : S.staff, i = arr.findIndex(x => x.id === r.id); if (i >= 0) arr[i] = r; else arr.push(r);
  if (table === 'ambulances') { S.amb.sort((a, b) => a.reg_no.localeCompare(b.reg_no, 'en', { numeric: true })); cacheMaster(); } else S.staff.sort((a, b) => a.name.localeCompare(b.name));
  return r;
}
$('ambTable').addEventListener('change', async e => {
  const tr = e.target.closest('[data-id]'), a = tr && ambById(tr.dataset.id), f = e.target.dataset.f; if (!a || !f) return;
  const x = { ...a }, v = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
  if (f === 'base_ll') { if (!String(v).trim()) { x.base_lat = null; x.base_lng = null; } else { const p = parseLatLng(v); if (!p) { toast('Use “lat, lng” or a Google Maps link.', true); renderMasters(); return; } x.base_lat = +p.lat.toFixed(6); x.base_lng = +p.lng.toFixed(6); } }
  else if (f === 'reg_no') { x.reg_no = normReg(v); if (!x.reg_no) { renderMasters(); return; } }
  else x[f] = v === '' ? null : v;
  const r = await guard(() => saveOne('ambulances', x, AMB_KEYS)); renderMasters(); if (r) toast(`${r.reg_no} saved`);
});
$('staffTable').addEventListener('change', async e => {
  const tr = e.target.closest('[data-id]'), s = tr && staffById(tr.dataset.id), f = e.target.dataset.f; if (!s || !f) return;
  const x = { ...s }, v = e.target.type === 'checkbox' ? e.target.checked : e.target.value.trim();
  if (f === 'name' && !v) { renderMasters(); return; }
  x[f] = v === '' ? null : v;
  const r = await guard(() => saveOne('staff', x, STAFF_KEYS)); renderMasters(); if (r) toast(`${r.name} saved`);
});
$('ambTable').addEventListener('click', async e => { const b = e.target.closest('[data-del]'); if (!b) return; const a = ambById(b.closest('[data-id]').dataset.id); if (!confirm(`Delete ${a.reg_no}? If it has deployments, untick Active instead.`)) return; await guard(async () => { await DB.remove('ambulances', a.id); S.amb = S.amb.filter(x => x.id !== a.id); cacheMaster(); renderMasters(); toast('Deleted'); }, 'Deleting…'); });
$('staffTable').addEventListener('click', async e => { const b = e.target.closest('[data-del]'); if (!b) return; const s = staffById(b.closest('[data-id]').dataset.id); if (!confirm(`Delete ${s.name}? They are removed from default crews and deployments. To keep history, untick Active instead.`)) return; await guard(async () => { await DB.remove('staff', s.id); S.staff = S.staff.filter(x => x.id !== s.id); S.amb.forEach(a => { if (a.default_pilot === s.id) a.default_pilot = null; if (a.default_emt === s.id) a.default_emt = null; }); renderMasters(); toast('Deleted'); }, 'Deleting…'); });
$('ambAdd').addEventListener('click', async () => { const reg = normReg(prompt('Registration number (e.g. HR26AB1234)') || ''); if (!reg) return; if (S.amb.some(a => a.reg_no === reg)) { toast(`${reg} already exists.`, true); return; } const r = await guard(() => saveOne('ambulances', { id: DB.uuid(), reg_no: reg, type: 'BLS', active: true }, AMB_KEYS)); if (r) { renderMasters(); toast(`${reg} added. Set its type, base and default crew in the table.`); } });
$('staffAdd').addEventListener('click', async () => { const name = (prompt('Name') || '').trim(); if (!name) return; const r = await guard(() => saveOne('staff', { id: DB.uuid(), name, role: 'Pilot', active: true }, STAFF_KEYS)); if (r) { renderMasters(); toast(`${name} added as Pilot. Change role, phone and code in the table.`); } });
const normReg = v => String(v || '').toUpperCase().replace(/[\s\-.]/g, '').slice(0, 20);
const digits = v => String(v || '').replace(/\D/g, '').slice(-10);

/* ---- bulk import ---- */
$('bulkKind').addEventListener('click', e => { const b = e.target.closest('[data-v]'); if (!b) return; S.bulkKind = b.dataset.v; document.querySelectorAll('#bulkKind button').forEach(x => x.classList.toggle('on', x === b)); $('bulkText').placeholder = b.dataset.v === 'staff' ? 'Paste here, e.g.\nName\tRole\tPhone\tEmp code\nRavi Kumar\tPilot\t9876543210\tP101' : 'Paste here, e.g.\nReg no\tType\tBase name\tBase location\tDefault pilot\tDefault EMT\tDefault route\nHR26AB1234\tBLS\tIFFCO Chowk\t28.4798, 77.0740\tRavi Kumar\tSita Devi\tSohna loop'; S.bulk = null; $('bulkPrev').innerHTML = ''; $('bulkGo').disabled = true; });
function splitRows(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n').filter(l => l.trim());
  if (!lines.length) return [];
  const tab = lines[0].includes('\t');
  if (tab) return lines.map(l => l.split('\t').map(c => c.trim()));
  return lines.map(l => { const out = []; let cur = '', q = false; for (let i = 0; i < l.length; i++) { const ch = l[i]; if (q) { if (ch === '"' && l[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; } else if (ch === '"') q = true; else if (ch === ',') { out.push(cur.trim()); cur = ''; } else cur += ch; } out.push(cur.trim()); return out; });
}
const HDR = {
  staff: { name: /^(name|staff name|full name|employee name)$/, role: /^(role|designation|type|position)$/, phone: /^(phone|mobile|mobile no|phone no|contact|contact no|mobile number|phone number)$/, emp_code: /^(emp ?code|employee ?code|code|emp ?id|employee ?id|staff ?id)$/, active: /^(active|status)$/ },
  ambulances: { reg_no: /^(reg ?no|registration|registration no|registration number|vehicle ?no|vehicle number|ambulance|ambulance no|reg number)$/, type: /^(type|ambulance type|category)$/, base_name: /^(base|base name|station|base location name|location)$/, lat: /^(lat|latitude|base lat)$/, lng: /^(lng|lon|long|longitude|base lng)$/, ll: /^(base lat, ?lng|lat, ?lng|coordinates|base location|base coordinates|maps link|google maps link)$/, pilot: /^(default pilot|pilot|driver|default driver)$/, emt: /^(default emt|emt|paramedic|default paramedic)$/, route: /^(default route|route)$/, active: /^(active|status)$/ }
};
function findStaff(v, pool) { const s = String(v || '').trim(); if (!s) return null; const lc = s.toLowerCase(), dg = digits(s); return pool.find(x => x.emp_code && x.emp_code.toLowerCase() === lc) || (dg.length === 10 && pool.find(x => digits(x.phone) === dg)) || pool.find(x => x.name.toLowerCase() === lc) || null; }
const isActive = v => v == null || v === '' ? true : !/^(no|n|false|0|inactive|off)$/i.test(String(v).trim());
function bulkCheck() {
  const rows = splitRows($('bulkText').value); if (rows.length < 2) { $('bulkInfo').textContent = 'Paste a header row and at least one data row.'; return; }
  const kind = S.bulkKind, head = rows[0].map(h => h.toLowerCase().replace(/[^a-z0-9, ]/g, ' ').replace(/\s+/g, ' ').trim()), col = {};
  Object.entries(HDR[kind]).forEach(([k, re]) => { const i = head.findIndex(h => re.test(h)); if (i >= 0) col[k] = i; });
  const need = kind === 'staff' ? ['name', 'role'] : ['reg_no'];
  const miss = need.filter(k => col[k] == null);
  if (miss.length) { $('bulkInfo').innerHTML = `<span class="err">Header row needs a column for ${miss.map(m => m.replace('_', ' ')).join(' and ')}.</span> Found: ${esc(rows[0].join(' | '))}`; $('bulkGo').disabled = true; return; }
  const g = (r, k) => col[k] != null ? String(r[col[k]] ?? '').trim() : undefined, out = [], seen = new Set();
  const staffPool = S.staff.slice();
  rows.slice(1).forEach((r, n) => {
    const msgs = []; let rec, ex, act;
    if (kind === 'staff') {
      const name = g(r, 'name'), roleV = g(r, 'role') || '', code = g(r, 'emp_code'), phone = g(r, 'phone');
      if (!name) { out.push({ n: n + 2, act: 'Skip', msgs: ['Name missing'], show: r }); return; }
      const role = /emt|para|nurse|tech|medic/i.test(roleV) ? 'EMT' : /pilot|driver/i.test(roleV) ? 'Pilot' : null;
      ex = (code && S.staff.find(x => x.emp_code && x.emp_code.toLowerCase() === code.toLowerCase())) || (digits(phone).length === 10 && S.staff.find(x => digits(x.phone) === digits(phone))) || (!code && S.staff.find(x => x.name.toLowerCase() === name.toLowerCase()));
      if (!role && !ex) { out.push({ n: n + 2, act: 'Skip', msgs: [`Role “${roleV}” not understood: use Pilot or EMT`], show: r }); return; }
      const key = (code || digits(phone) || name).toLowerCase(); if (seen.has(key)) { out.push({ n: n + 2, act: 'Skip', msgs: ['Repeated in this paste'], show: r }); return; } seen.add(key);
      rec = { ...(ex || { id: DB.uuid(), active: true }), name, ...(role ? { role } : {}), ...(phone ? { phone } : {}), ...(code ? { emp_code: code } : {}), ...(col.active != null ? { active: isActive(g(r, 'active')) } : {}) };
      act = ex ? 'Update' : 'New'; if (!ex) staffPool.push(rec);
      out.push({ n: n + 2, act, msgs, rec, show: [rec.name, rec.role, rec.phone || '', rec.emp_code || ''] });
    } else {
      const reg = normReg(g(r, 'reg_no')); if (!reg) { out.push({ n: n + 2, act: 'Skip', msgs: ['Registration missing'], show: r }); return; }
      if (seen.has(reg)) { out.push({ n: n + 2, act: 'Skip', msgs: ['Repeated in this paste'], show: r }); return; } seen.add(reg);
      ex = S.amb.find(a => a.reg_no === reg);
      const tv = g(r, 'type'); let type = ex ? ex.type : null;
      if (tv) { const t = tv.toUpperCase(); type = /ALS|TYPE ?D\b/.test(t) ? 'ALS' : /BLS|TYPE ?C\b/.test(t) ? 'BLS' : /PTV|PATIENT|TYPE ?B\b/.test(t) ? 'PTV' : /FRV|FIRST|BIKE|TYPE ?A\b/.test(t) ? 'FRV' : null; if (!type) { msgs.push(`Type “${tv}” not understood`); type = ex ? ex.type : 'BLS'; } }
      if (!type) { type = 'BLS'; msgs.push('No type given: set to BLS, change if needed'); }
      rec = { ...(ex || { id: DB.uuid(), active: true }), reg_no: reg, type };
      if (g(r, 'base_name')) rec.base_name = g(r, 'base_name');
      let ll = null; if (col.ll != null && g(r, 'll')) ll = parseLatLng(g(r, 'll')); else if (col.lat != null && col.lng != null && g(r, 'lat')) ll = parseLatLng(`${g(r, 'lat')}, ${g(r, 'lng')}`);
      if (ll) { rec.base_lat = +ll.lat.toFixed(6); rec.base_lng = +ll.lng.toFixed(6); } else if ((col.ll != null && g(r, 'll')) || (col.lat != null && g(r, 'lat'))) msgs.push('Base location not understood');
      [['pilot', 'default_pilot'], ['emt', 'default_emt']].forEach(([k, f]) => { const v = g(r, k); if (v === undefined) return; if (!v) { rec[f] = null; return; } const s = findStaff(v, staffPool); if (s) rec[f] = s.id; else msgs.push(`${k === 'pilot' ? 'Pilot' : 'EMT'} “${v}” not in staff list: import staff first`); });
      const rv = g(r, 'route'); if (rv !== undefined) { if (!rv) rec.default_route = null; else { const rt = S.routes.find(x => x.name.toLowerCase() === rv.toLowerCase()); if (rt) rec.default_route = rt.id; else msgs.push(`Route “${rv}” not found`); } }
      if (col.active != null) rec.active = isActive(g(r, 'active'));
      act = ex ? 'Update' : 'New';
      out.push({ n: n + 2, act, msgs, rec, show: [reg, type, rec.base_name || '', rec.base_lat != null ? `${rec.base_lat}, ${rec.base_lng}` : '', staffName(rec.default_pilot) || (staffPool.find(s => s.id === rec.default_pilot) || {}).name || '', staffName(rec.default_emt) || (staffPool.find(s => s.id === rec.default_emt) || {}).name || ''] });
    }
  });
  S.bulk = { kind, rows: out };
  const ok = out.filter(x => x.rec), nNew = ok.filter(x => x.act === 'New').length, nUp = ok.filter(x => x.act === 'Update').length, nSkip = out.length - ok.length;
  $('bulkInfo').innerHTML = `${nNew} new · ${nUp} update · ${nSkip ? `<span class="err">${nSkip} skipped</span>` : '0 skipped'}`;
  $('bulkGo').disabled = !ok.length;
  const hd = kind === 'staff' ? ['Name', 'Role', 'Phone', 'Emp code'] : ['Reg no', 'Type', 'Base', 'Lat, lng', 'Pilot', 'EMT'];
  $('bulkPrev').innerHTML = `<table class="t"><thead><tr><th>Row</th><th>Action</th>${hd.map(h => `<th>${h}</th>`).join('')}<th>Notes</th></tr></thead><tbody>${out.map(x => `<tr><td>${x.n}</td><td class="${x.act === 'Skip' ? 'err' : x.act === 'New' ? 'good' : ''}">${x.act}</td>${hd.map((_, i) => `<td>${esc((x.show || [])[i] ?? '')}</td>`).join('')}<td class="${x.msgs.length ? 'warn' : ''}">${esc(x.msgs.join('; '))}</td></tr>`).join('')}</tbody></table>`;
}
$('bulkCheck').addEventListener('click', bulkCheck);
$('bulkText').addEventListener('input', () => { $('bulkGo').disabled = true; });
$('bulkGo').addEventListener('click', async () => {
  const b = S.bulk; if (!b) return; const recs = b.rows.filter(x => x.rec).map(x => pick(x.rec, b.kind === 'staff' ? STAFF_KEYS : AMB_KEYS));
  await guard(async () => {
    const saved = await DB.upsert(b.kind, recs);
    const arr = b.kind === 'staff' ? S.staff : S.amb; saved.forEach(r => { const i = arr.findIndex(x => x.id === r.id); if (i >= 0) arr[i] = r; else arr.push(r); });
    if (b.kind === 'staff') S.staff.sort((x, y) => x.name.localeCompare(y.name)); else { S.amb.sort((x, y) => x.reg_no.localeCompare(y.reg_no, 'en', { numeric: true })); cacheMaster(); }
    $('bulkText').value = ''; $('bulkPrev').innerHTML = ''; $('bulkGo').disabled = true; S.bulk = null; $('bulkInfo').textContent = `${saved.length} saved.`;
    renderMasters(); toast(`${saved.length} ${b.kind === 'staff' ? 'staff' : 'ambulances'} saved`);
  }, 'Importing…');
});
$('bulkFile').addEventListener('change', async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  try {
    if (/\.xlsx?$/i.test(f.name)) {
      const wb = XLSX.read(await f.arrayBuffer(), { type: 'array' });
      const want = S.bulkKind === 'staff' ? /staff|crew|pilot|emt/i : /amb|vehicle|fleet/i, sn = wb.SheetNames.find(n => want.test(n)) || wb.SheetNames[0];
      const aoa = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, raw: false, defval: '' }).filter(r => r.some(c => String(c).trim()));
      $('bulkText').value = aoa.map(r => r.map(c => String(c).replace(/[\t\n]/g, ' ')).join('\t')).join('\n');
      $('bulkInfo').textContent = `Read sheet “${sn}” (${aoa.length - 1} rows).`;
    } else $('bulkText').value = await f.text();
    bulkCheck();
  } catch (err) { toast(`Couldn’t read ${f.name}: ${err.message}`, true); }
});
$('tplBtn').addEventListener('click', () => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Name', 'Role', 'Phone', 'Emp code', 'Active']]), 'Staff');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Reg no', 'Type', 'Base name', 'Base location', 'Default pilot', 'Default EMT', 'Default route', 'Active']]), 'Ambulances');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['How to fill'], ['Staff: Role is Pilot or EMT. Emp code is optional but best for matching.'], ['Ambulances: Type is BLS, ALS, PTV or FRV. Base location can be "28.4798, 77.0740" or a Google Maps link.'], ['Default pilot / EMT: the person\'s name, phone or emp code (add staff first).'], ['Default route: the exact route name from the app (optional).'], ['Active: Yes or No (blank = Yes).'], ['Upload this file in Ambulances & staff → Upload CSV / Excel. Do Staff first, then Ambulances.']]), 'Read me');
  XLSX.writeFile(wb, 'ambulance-planner-template.xlsx');
});

/* =========================================================
   Exports: Excel (4 sheets), CSV, printable PDF
   ========================================================= */
const slug = s => String(s || 'export').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'export';
const toCSV = rows => rows.map(r => r.map(v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }).join(',')).join('\n');
const shortId = id => String(id || '').slice(0, 8).toUpperCase();
function exportRows(deps) {
  deps = deps.slice().sort((a, b) => a.dep_date.localeCompare(b.dep_date) || a.start_time.localeCompare(b.start_time));
  const sum = [['Deployment ID', 'Date', 'Ambulance', 'Type', 'Driver / pilot', 'Pilot phone', 'Paramedic / EMT', 'EMT phone', 'Route', 'Starting location', 'Shift start', 'Shift end', 'Total distance (km)', 'Total driving time (min)', 'Total halt time (min)', 'Total deployment duration (min)', 'Total locations', 'Total population covered', 'Population basis', 'Status']];
  const det = [['Deployment ID', 'Date', 'Ambulance', 'Point', 'Location', 'Latitude', 'Longitude', 'Population', 'Road distance from previous (km)', 'Planned speed (km/h)', 'Expected travel time (min)', 'Planned arrival', 'Planned departure', 'Halt (min)', 'Actual arrival', 'Actual departure', 'Delay at arrival (min)', 'Status', 'Next destination', 'Remarks']];
  const ros = [['Deployment date', 'Ambulance', 'Ambulance type', 'Driver / pilot', 'Paramedic / EMT', 'Assigned route', 'Shift start', 'Shift end', 'Status', 'Team link']];
  const pop = [['Deployment ID', 'Date', 'Route', 'Point', 'Location', 'Population', 'Population source', 'Population updated', 'Coverage radius (km)', 'Overlaps with points', 'Unique population estimate']];
  deps.forEach(d => {
    const a = ambById(d.ambulance_id) || {}, p = staffById(d.pilot_id) || {}, e = staffById(d.emt_id) || {}, pl = d.plan || {}, t = pl.totals || {}, st = pl.stops || [], id = shortId(d.id);
    sum.push([id, d.dep_date, a.reg_no || '', a.type || '', p.name || '', p.phone || '', e.name || '', e.phone || '', pl.route_name || '', (st[0] || {}).name || '', d.start_time, d.end_time, t.km ?? '', t.drive ?? '', t.halt ?? '', t.dur ?? '', t.stops ?? '', t.pop_best ?? '', t.pop_unique != null ? 'Unique (population grid)' : t.pop_sum != null ? 'Sum of stops' : '', d.status]);
    ros.push([d.dep_date, a.reg_no || '', a.type || '', p.name || '', e.name || '', pl.route_name || '', d.start_time, d.end_time, d.status, d.token ? teamUrl(d) : '']);
    const pi = progressInfo(pl, d.progress);
    st.forEach((s, i) => {
      const r = pi.rows[i];
      det.push([id, d.dep_date, a.reg_no || '', i + 1, s.name, s.lat, s.lng, s.pop ?? '', s.km ?? (i ? '' : 'Start'), s.speed ?? '', s.travel != null ? Math.round(s.travel) : '', s.arr ? istHM(s.arr) : '', s.dep ? istHM(s.dep) : '', s.halt ?? '', r.actArr ? istHM(r.actArr) : '', r.actDep ? istHM(r.actDep) : '', r.arrDelay != null ? Math.round(r.arrDelay) : '', r.st === 'done' ? 'Done' : r.st === 'at' ? 'At location' : 'Pending', st[i + 1] ? st[i + 1].name : '', s.remarks || '']);
      pop.push([id, d.dep_date, pl.route_name || '', i + 1, s.name, s.pop ?? '', s.pop_src || '', s.pop_date || '', s.radius ?? '', (s.overlaps || []).map(k => k + 1).join(', ') || 'None', s.unique != null ? Math.round(s.unique) : '']);
    });
  });
  return { sum, det, ros, pop };
}
function exportXlsx(deps, name) {
  if (!deps.length) { toast('Nothing to export for that choice.', true); return; }
  const R = exportRows(deps), wb = XLSX.utils.book_new(), add = (rows, n) => { const ws = XLSX.utils.aoa_to_sheet(rows); ws['!cols'] = rows[0].map((h, i) => ({ wch: Math.min(40, Math.max(String(h).length, ...rows.slice(1, 200).map(r => String(r[i] ?? '').length)) + 2) })); XLSX.utils.book_append_sheet(wb, ws, n); };
  add(R.sum, 'Deployment Summary'); add(R.det, 'Route Details'); add(R.ros, 'Ambulance Roster'); add(R.pop, 'Population Coverage');
  XLSX.writeFile(wb, slug(name) + '.xlsx');
}
function printDeps(deps) {
  if (!deps.length) { toast('Nothing to print for that choice.', true); return; }
  deps = deps.slice().sort((a, b) => a.dep_date.localeCompare(b.dep_date) || a.start_time.localeCompare(b.start_time));
  const R = exportRows(deps);
  const roster = deps.length > 1 ? `<h1>${esc(CFG.ORG_NAME || '')} · Ambulance roster</h1><table><tr>${R.ros[0].slice(0, 9).map(h => `<th>${esc(h)}</th>`).join('')}</tr>${R.ros.slice(1).map(r => `<tr>${r.slice(0, 9).map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</table><div class="pb"></div>` : '';
  $('printArea').innerHTML = roster + deps.map(d => {
    const a = ambById(d.ambulance_id) || {}, pl = d.plan || {}, t = pl.totals || {}, qr = d.token ? qrCanvas(teamUrl(d), null, 4).toDataURL() : '', pi = progressInfo(pl, d.progress);
    return `<div class="pb"><table style="border:0"><tr><td style="border:0;vertical-align:top"><h1>${esc(a.reg_no || '')} · ${esc(niceDate(d.dep_date))}</h1>
      <div>${esc(CFG.ORG_NAME || '')} · Route: <b>${esc(pl.route_name || '')}</b> · Shift ${esc(d.start_time)}–${esc(d.end_time)} · Status ${esc(d.status)}</div>
      <div>Pilot: ${esc(staffName(d.pilot_id))} · EMT: ${esc(staffName(d.emt_id))}</div>
      <div>${t.stops || 0} stops · ${fmt(t.km)} km by road · driving ${dur(t.drive)} · halts ${dur(t.halt)} · duration ${dur(t.dur)}${t.pop_best != null ? ` · population ${fmtInt(t.pop_best)}` : ''}</div></td>
      ${qr ? `<td style="border:0;width:34mm;text-align:center"><img src="${qr}" style="width:32mm"><div style="font-size:9px">Team page</div></td>` : ''}</tr></table>
      <h2>Schedule</h2><table><tr><th>#</th><th>Location</th><th>Arrive</th><th>Leave</th><th>Halt</th><th>Road km</th><th>Travel</th><th>Population</th><th>Actual</th><th>Remarks</th></tr>
      ${(pl.stops || []).map((s, i) => `<tr><td>${i + 1}</td><td>${esc(s.name)}<br><span style="color:#555">${(+s.lat).toFixed(5)}, ${(+s.lng).toFixed(5)}</span></td><td>${istHM(s.arr)}</td><td>${istHM(s.dep)}</td><td>${s.halt ?? ''} min</td><td>${s.km != null ? fmt(s.km) : 'Start'}</td><td>${s.travel != null ? Math.round(s.travel) + ' min' : ''}</td><td>${s.pop != null ? fmtInt(s.pop) : ''}</td><td>${pi.rows[i].actArr ? istHM(pi.rows[i].actArr) : ''}${pi.rows[i].actDep ? '–' + istHM(pi.rows[i].actDep) : ''}</td><td>${esc(s.remarks || '')}</td></tr>`).join('')}</table></div>`;
  }).join('');
  setTimeout(() => window.print(), 150);
}
$('exportBtn').addEventListener('click', () => {
  const days = weekDays(S.day);
  openModal(`<h2>Export</h2>
    <div class="grid2">
      <label class="f">What<select id="exScope"><option value="date">All deployments on a date</option><option value="range" selected>Date range</option><option value="all">Complete roster (all dates)</option><option value="one">A single deployment</option></select></label>
      <label class="f">Format<select id="exFmt"><option value="xlsx">Excel (.xlsx, 4 sheets)</option><option value="csv">CSV (route details)</option><option value="pdf">Printable PDF</option></select></label>
      <label class="f" id="exDateL">Date<input type="date" id="exDate" value="${S.day}"></label>
      <label class="f" id="exFromL">From<input type="date" id="exFrom" value="${days[0]}"></label>
      <label class="f" id="exToL">To<input type="date" id="exTo" value="${days[6]}"></label>
      <label class="f" id="exOneL" style="grid-column:1/-1">Deployment<select id="exOne">${S.deps.slice().sort((a, b) => b.dep_date.localeCompare(a.dep_date)).map(d => opt(d.id, `${d.dep_date} · ${(ambById(d.ambulance_id) || {}).reg_no || ''} · ${(d.plan && d.plan.route_name) || ''} · ${d.start_time}`)).join('')}</select></label>
    </div>
    <p class="note">Excel sheets: Deployment Summary, Route Details (planned and actual times), Ambulance Roster, Population Coverage. PDF opens the print dialog: choose “Save as PDF”.</p>
    <div class="mfoot"><button class="btn" data-close>Cancel</button><button class="btn primary" id="exGo">Export</button></div>`);
  const sync = () => { const v = $('exScope').value; $('exDateL').style.display = v === 'date' ? '' : 'none'; ['exFromL', 'exToL'].forEach(id => { $(id).style.display = v === 'range' ? '' : 'none'; }); $('exOneL').style.display = v === 'one' ? '' : 'none'; };
  $('exScope').onchange = sync; sync();
  $('exGo').onclick = async () => {
    const v = $('exScope').value, f = $('exFmt').value;
    const deps = await guard(async () => {
      if (v === 'one') { const id = $('exOne').value; return id ? await DB.list('deployments', { ids: [id] }) : []; }
      if (v === 'date') return await DB.list('deployments', { from: $('exDate').value, to: $('exDate').value });
      if (v === 'range') { if ($('exFrom').value > $('exTo').value) throw new Error('“From” is after “To”.'); return await DB.list('deployments', { from: $('exFrom').value, to: $('exTo').value }); }
      return await DB.list('deployments');
    }, 'Collecting data…');
    if (!deps) return;
    const name = v === 'one' ? `deployment-${(deps[0] || {}).dep_date || ''}` : v === 'date' ? `deployments-${$('exDate').value}` : v === 'range' ? `deployments-${$('exFrom').value}-to-${$('exTo').value}` : 'complete-roster';
    if (!deps.length) { toast('No deployments for that choice.', true); return; }
    closeModal();
    if (f === 'xlsx') exportXlsx(deps, name);
    else if (f === 'csv') download(slug(name) + '-route-details.csv', '﻿' + toCSV(exportRows(deps).det), 'text/csv');
    else printDeps(deps);
  };
});

/* =========================================================
   Settings
   ========================================================= */
$('orsKey').value = localKeys.ORS_API_KEY || ''; $('olaKey').value = localKeys.OLA_MAPS_API_KEY || '';
[['orsKey', 'ORS_API_KEY'], ['olaKey', 'OLA_MAPS_API_KEY']].forEach(([id, k]) => $(id).addEventListener('change', e => { const v = e.target.value.trim(); if (v) localKeys[k] = v; else delete localKeys[k]; try { localStorage.setItem('ap-keys', JSON.stringify(localKeys)); } catch (er) {} if (S.route) { if (!engReady(S.route.data.engine) && firstEngine()) S.route.data.engine = firstEngine(); renderEngineSel(); queueLegs(); } renderSettings(); toast('Saved in this browser'); }));
function renderSettings(results) {
  const R = results || {}, line = (name, ok, txt) => `<div style="padding:6px 0;border-bottom:1px solid var(--line)"><span class="chip ${ok === true ? 'ok' : ok === false ? 'bad' : ''}">${ok === true ? '✓' : ok === false ? '✗' : '–'}</span> <b>${name}</b> <span class="muted">${esc(txt)}</span></div>`;
  $('connOut').innerHTML =
    line('Database', DB.cloud ? (R.db ?? true) : null, DB.cloud ? (R.dbTxt || `Supabase · ${CFG.SUPABASE_URL}`) : 'Not connected: demo mode (this browser only). Add SUPABASE_URL and SUPABASE_ANON_KEY in config.js.') +
    line('openrouteservice (roads)', keyOf('ORS_API_KEY') ? (R.ors ?? true) : null, keyOf('ORS_API_KEY') ? (R.orsTxt || `key set${localKeys.ORS_API_KEY ? ' in this browser' : ' in config.js'}`) : 'No key. Get a free one at openrouteservice.org and put it in config.js.') +
    line('Ola Maps (roads, optional)', keyOf('OLA_MAPS_API_KEY') ? (R.ola ?? true) : null, keyOf('OLA_MAPS_API_KEY') ? (R.olaTxt || `key set${localKeys.OLA_MAPS_API_KEY ? ' in this browser' : ' in config.js'}`) : 'Not set (optional).');
  renderAdmins();
  $('popInfo').textContent = S.grid ? `${S.grid.length.toLocaleString('en-IN')} points loaded · ${fmtInt(S.grid.reduce((t, p) => t + p[2], 0))} people` : 'No grid loaded.';
}
$('connTest').addEventListener('click', async () => {
  const R = {}; $('connOut').innerHTML = '<p class="note">Testing…</p>';
  if (DB.cloud) { try { await DB.list('app_settings'); R.db = true; R.dbTxt = 'connected, tables found'; } catch (e) { R.db = false; R.dbTxt = e.message; } }
  const a = { lat: 28.479814, lng: 77.074042 }, b = { lat: 28.4595, lng: 77.0266 };
  if (keyOf('ORS_API_KEY')) { try { const l = await orsLegs([a, b]); R.ors = true; R.orsTxt = `working · test drive ${fmt(l[0].km)} km, ${fmt(l[0].min, 0)} min`; } catch (e) { R.ors = false; R.orsTxt = e.message; } }
  if (keyOf('OLA_MAPS_API_KEY')) { try { const l = await olaLeg(a, b); R.ola = true; R.olaTxt = `working · test drive ${fmt(l.km)} km, ${fmt(l.min, 0)} min`; } catch (e) { R.ola = false; R.olaTxt = e.message; } }
  renderSettings(R);
});
$('signOut').addEventListener('click', async () => { if (!DB.cloud) { toast('Demo mode has no login.'); return; } await DB.auth.signOut(); location.reload(); });
$('popFile').addEventListener('change', async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  const rows = splitRows(await f.text()); if (rows.length < 2) { toast('Empty file.', true); return; }
  const h = rows[0].map(x => x.toLowerCase().trim()), li = h.findIndex(x => /^(lat|latitude|y)$/.test(x)), gi = h.findIndex(x => /^(lng|lon|long|longitude|x)$/.test(x)), pi = h.findIndex(x => /^(pop|population|people|weight|count|value)$/.test(x));
  if (li < 0 || gi < 0 || pi < 0) { toast('The CSV needs columns lat, lng and pop (or population).', true); return; }
  const pts = rows.slice(1).map(r => [+r[li], +r[gi], +r[pi]]).filter(p => isFinite(p[0]) && isFinite(p[1]) && isFinite(p[2]) && p[2] >= 0 && Math.abs(p[0]) <= 90 && Math.abs(p[1]) <= 180);
  if (!pts.length) { toast('No valid rows found.', true); return; }
  if (pts.length > 60000) { toast(`That file has ${pts.length.toLocaleString('en-IN')} points; the limit is 60,000. Crop it to your area first.`, true); return; }
  if (!confirm(`Replace the population grid with ${pts.length.toLocaleString('en-IN')} points (${fmtInt(pts.reduce((t, p) => t + p[2], 0))} people)?`)) return;
  await guard(async () => { await DB.clear('pop_grid'); await DB.insert('pop_grid', pts.map(p => ({ lat: p[0], lng: p[1], pop: p[2] }))); S.grid = pts; buildGridIdx(); renderSettings(); if (S.route) renderRoute(true); toast('Population grid loaded'); }, 'Uploading population grid…');
});
$('popClear').addEventListener('click', async () => { if (!S.grid || !confirm('Remove the population grid? Stops using “Population grid” will show no population until you enter it.')) return; await guard(async () => { await DB.clear('pop_grid'); S.grid = null; S.gridIdx = null; renderSettings(); if (S.route) renderRoute(true); toast('Grid removed'); }); });

/* =========================================================
   Start-up
   ========================================================= */
window.addEventListener('error', e => { if (e.message && !/ResizeObserver/.test(e.message)) toast('Something went wrong: ' + e.message, true); });
window.addEventListener('unhandledrejection', e => { const m = e.reason && (e.reason.message || String(e.reason)); if (m) toast(m, true); });
$('modeChip').textContent = DB.cloud ? 'Live database' : 'Demo mode';
$('demoBanner').classList.toggle('show', !DB.cloud);
if (CFG.ORG_NAME) $('orgName').textContent = `${CFG.ORG_NAME} · Route deployment`;
$('loginForm').addEventListener('submit', async e => {
  e.preventDefault(); $('lErr').textContent = '';
  try { await DB.auth.signIn($('lEmail').value.trim(), $('lPass').value); $('login').classList.remove('show'); boot(); } catch (er) { $('lErr').textContent = er.message; }
});
async function checkAdmin() {
  if (!DB.cloud) return true;
  const sess = await DB.auth.session(); S.me = sess && sess.user && sess.user.email ? sess.user.email.toLowerCase() : null;
  if (!(await DB.rpc('is_admin', {}))) {
    await DB.auth.signOut(); $('login').classList.add('show');
    $('lErr').textContent = `${S.me || 'This account'} is not on the admin list. Ask an existing admin to add your email (Route deployment → Settings → Admins).`;
    return false;
  }
  const admins = await DB.list('app_admins');
  if (!admins.length && S.me) { await DB.upsert('app_admins', [{ email: S.me }]); toast('You are the first admin. Add colleagues in Settings → Admins.'); }
  return true;
}
async function renderAdmins() {
  if (!DB.cloud) { $('adminCard').style.display = 'none'; return; }
  try {
    const list = await DB.list('app_admins');
    $('adminList').innerHTML = list.map(a => `<div class="row" style="padding:5px 0;border-bottom:1px solid var(--line)"><b>${esc(a.email)}</b>${a.email === S.me ? ' <span class="chip">you</span>' : `<button class="btn sm danger" data-rm="${esc(a.email)}" style="margin-left:auto">Remove</button>`}</div>`).join('');
  } catch (e) { $('adminList').innerHTML = `<p class="err">${esc(e.message)}</p>`; }
}
$('adminAdd').addEventListener('click', async () => {
  const em = $('adminNew').value.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) { toast('Enter a valid email.', true); return; }
  if (await guard(() => DB.upsert('app_admins', [{ email: em }]))) { $('adminNew').value = ''; renderAdmins(); toast(`${em} added. Create their login in Supabase → Authentication → Users.`); }
});
$('adminList').addEventListener('click', async e => {
  const b = e.target.closest('[data-rm]'); if (!b) return;
  if (!confirm(`Remove ${b.dataset.rm} from admins? They will no longer see any data.`)) return;
  await guard(() => DB.removeWhere('app_admins', 'email', b.dataset.rm), 'Removing…'); renderAdmins();
});
async function boot() {
  busy(true, 'Loading…');
  try { if (!(await checkAdmin())) { busy(false); return; } } catch (e) { busy(false); toast(e.message, true); }
  try {
    [S.staff, S.amb, S.routes] = await Promise.all([DB.list('staff'), DB.list('ambulances'), DB.list('routes')]);
    S.routes = S.routes.map(normRoute); cacheMaster();
  } catch (e) { busy(false); toast(e.message, true); renderSettings(); showTab('settings'); return; }
  busy(false);
  setRoute(S.routes[0] || newRoute());
  let t = 'routes'; try { t = localStorage.getItem('ap-route-tab') || 'routes'; } catch (e) {}
  showTab(t);
  loadDeps(addDays(weekStart(S.day), -7), addDays(weekStart(S.day), 6)).then(updateLiveCount).catch(() => {});
  DB.list('pop_grid').then(rows => { if (rows.length) { S.grid = rows.map(r => [+r.lat, +r.lng, +r.pop]); buildGridIdx(); if (S.route) renderRoute(true); } }).catch(() => {});
}
(async () => {
  if (!DB.cloud) { boot(); return; }
  try { const s = await DB.auth.session(); if (s) boot(); else $('login').classList.add('show'); }
  catch (e) { $('login').classList.add('show'); $('lErr').textContent = e.message; }
})();
