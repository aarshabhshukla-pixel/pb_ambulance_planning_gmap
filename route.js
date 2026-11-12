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
$('themeBtn').addEventListener('click', () => { setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'); if (typeof MP !== 'undefined' && MP.base === 'auto') setBase(); });

/* ---------------- tabs ---------------- */
function showTab(t) {
  S.tab = t; try { localStorage.setItem('ap-route-tab', t); } catch (e) {}
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
  document.querySelectorAll('.pane').forEach(p => p.classList.toggle('on', p.dataset.pane === t));
  if (t === 'routes') { rmap.invalidateSize(); }
  if (t === 'roster') renderRoster();
  if (t === 'live') { lmap.invalidateSize(); loadLive(); }
  if (t === 'dash') loadDash();
  if (t === 'masters') { renderMasters(); renderPlaces(); }
  if (t === 'settings') renderSettings();
}
$('tabs').addEventListener('click', e => { const b = e.target.closest('[data-tab]'); if (b) showTab(b.dataset.tab); });

/* =========================================================
   Routing engines (real road network only)
   ========================================================= */
const ENGINES = {
  ors: { name: 'openrouteservice', short: 'ORS', key: () => keyOf('ORS_API_KEY'), note: 'Road distance and normal (no live traffic) drive time from OpenStreetMap roads.' },
  tomtom: { name: 'TomTom (with traffic)', short: 'TomTom', key: () => keyOf('TOMTOM_API_KEY'), note: 'Road distance and drive time with TomTom’s usual traffic for the route’s start time on the next weekday (free key, no card). Halts are not part of TomTom’s clock, so later legs use traffic for slightly earlier times.' },
  ola: { name: 'Ola Maps', short: 'Ola', key: () => keyOf('OLA_MAPS_API_KEY'), note: 'Road distance and drive time with current traffic, from Ola Maps (paid beyond its free quota).' }
};
/* cache tag: TomTom times depend on the start time, the others don't */
const engTag = d => d.engine === 'tomtom' ? `tomtom@${d.start_time}` : d.engine;
/* next weekday (Mon–Fri) at hh:mm IST, never in the past */
function nextWeekdayISO(hm) {
  const m = hm2min(hm) ?? 480; let ds = todayIST();
  for (let k = 0; k < 8; k++) { const t = new Date(istISO(ds, m)), wd = AP.istParts(t).wd; if (t > Date.now() + 5 * 60000 && wd >= 1 && wd <= 5) return { iso: `${ds}T${min2hm(m)}:00+05:30`, label: `${AP.WD[wd]} ${min2hm(m)}` }; ds = addDays(ds, 1); }
  return { iso: `${ds}T${min2hm(m)}:00+05:30`, label: min2hm(m) };
}
const engReady = e => !!(ENGINES[e] && ENGINES[e].key());
const firstEngine = () => ['ors', 'tomtom', 'ola'].find(engReady) || null;
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
/* TomTom: whole chain in one call (≤ 150 points per call), traffic for the given departure */
async function tomtomLegs(pts, depIso) {
  const out = [];
  for (let s = 0; s < pts.length - 1; s += 149) {
    const chunk = pts.slice(s, s + 150), path = chunk.map(p => `${(+p.lat).toFixed(6)},${(+p.lng).toFixed(6)}`).join(':');
    const j = await httpJSON(`https://api.tomtom.com/routing/1/calculateRoute/${path}/json?key=${encodeURIComponent(ENGINES.tomtom.key())}&traffic=true&travelMode=car&routeType=fastest&routeRepresentation=polyline&computeTravelTimeFor=all${depIso ? '&departAt=' + encodeURIComponent(depIso) : ''}`, {}, 'TomTom');
    const r = j && j.routes && j.routes[0]; if (!r || !Array.isArray(r.legs)) throw new Error('TomTom returned no route');
    for (let k = 0; k < chunk.length - 1; k++) {
      const lg = r.legs[k]; if (!lg || !lg.summary) { out.push({ err: 'no route for this leg' }); continue; }
      out.push({ km: lg.summary.lengthInMeters / 1000, min: lg.summary.travelTimeInSeconds / 60, geom: thin((lg.points || []).map(p => [p.latitude, p.longitude])) });
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
  d.shape = d.shape === 'hex' ? 'hex' : 'circle';
  return r;
}
function legOf(r, a, b) { const k = legKey(engTag(r.data), a, b); return LEG.get(k) || r.data.legs[k] || null; }
const fixDay = (hm, ref) => { if (ref == null) return hm; return hm + 1440 * Math.round((ref - hm) / 1440); };
function popOf(s, R, shape) { if (s.pop_src === 'Grid') return S.grid ? gridSum([[s.lat, s.lng, num(s.radius) || R, shape]], null) : null; return num(s.pop); }
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
    rows.push({ i, s, leg, speed, travel, arrC, arr, dep, halt: arr != null && dep != null ? dep - arr : halt, arrOv: ao != null, depOv: doo != null, pop: popOf(s, d.radius, d.shape) });
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
  const d = r.data, circ = d.stops.map(s => [s.lat, s.lng, num(s.radius) || d.radius, s._shape || (d.shape === 'hex' ? 'hex' : 'circle')]);
  const sum = rows.reduce((t, x) => t + (x.pop || 0), 0), withPop = rows.filter(x => x.pop != null).length;
  const overlaps = [];
  for (let i = 0; i < circ.length; i++) for (let j = i + 1; j < circ.length; j++) {
    const a = circ[i], b = circ[j], hx = a[3] === 'hex' && b[3] === 'hex';
    if (hx ? inHex((b[1] - a[1]) * kxAt(a[0]), (b[0] - a[0]) * KY, (a[2] + b[2]) * 0.999) : haversine(a, b) < a[2] + b[2] - 0.01) overlaps.push([i, j]);
  }
  let unique = null, uniqueBy = null;
  if (S.grid && circ.length) { uniqueBy = []; unique = gridSum(circ, uniqueBy); }
  let area = 0;
  if (circ.length) {
    const la = circ.map(c => c[0]), lo = circ.map(c => c[1]), R = Math.max(...circ.map(c => c[2]));
    const kx = 111.32 * Math.cos(la[0] * Math.PI / 180), ky = 110.57;
    const x0 = Math.min(...lo) - R / kx, x1 = Math.max(...lo) + R / kx, y0 = Math.min(...la) - R / ky, y1 = Math.max(...la) + R / ky;
    const n = 140, dx = (x1 - x0) / n, dy = (y1 - y0) / n; let hit = 0;
    for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) { const p = [y0 + (a + .5) * dy, x0 + (b + .5) * dx]; if (circ.some(c => inArea(c, p[0], p[1]))) hit++; }
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
      cell.forEach(p => { if (inArea([c[0], c[1], r, c[3]], p[0], p[1])) { if (!seen.has(p)) { seen.add(p); mine += p[2]; tot += p[2]; } } });
    }
    if (perCircle) perCircle[ci] = mine;
  });
  return tot;
}

/* =========================================================
   Routes: map
   ========================================================= */
const HOME = [28.479814, 77.074042];
const rmap = L.map('rmap', { zoomControl: true, preferCanvas: false }).setView(HOME, 12);
const lmap = L.map('lmap', { zoomControl: true }).setView(HOME, 11);
const rG = { line: L.layerGroup().addTo(rmap), circ: L.layerGroup().addTo(rmap), pins: L.layerGroup().addTo(rmap) };
let addMode = false, showCirc = true;
function setAddMode(on) { addMode = on; $('addMode').classList.toggle('on', on); rmap.getContainer().style.cursor = on ? 'crosshair' : ''; setStat(on ? 'Click the map to add stops · Esc to stop' : ''); }
$('addMode').addEventListener('click', () => setAddMode(!addMode));
$('circBtn').addEventListener('click', () => { showCirc = !showCirc; $('circBtn').classList.toggle('on', showCirc); $('shCirc').checked = showCirc; drawRoute(); });
$('fitBtn').addEventListener('click', () => fitRoute());
function setStat(t) { $('rStatus').innerHTML = t || ''; }
const pinIcon = (n, cls) => L.divIcon({ className: 'mk', iconSize: [28, 28], iconAnchor: [14, 30], html: `<div class="pinnum ${cls || ''}"><span>${n}</span></div>` });
function fitRoute() { const st = S.route && S.route.data.stops; if (st && st.length) rmap.fitBounds(L.latLngBounds(st.map(s => [s.lat, s.lng])).pad(0.2), { maxZoom: 15 }); }
rmap.on('click', e => { if (placeMode) { openPlace(null, { lat: e.latlng.lat, lng: e.latlng.lng }); return; } if (!addMode || !S.route) return; addStop(e.latlng.lat, e.latlng.lng, null); });
function drawRoute() {
  rG.line.clearLayers(); rG.circ.clearLayers(); rG.pins.clearLayers();
  if (S.view !== 'one') { drawMany(); drawOverlay(); const lg = $('mLegend'); if (lg.classList.contains('show')) lg.insertAdjacentHTML('beforeend', ovLegend()); return; }
  drawOverlay(); { const lg = $('mLegend'), ol = ovLegend(); lg.innerHTML = ol; lg.classList.toggle('show', !!ol); }
  const r = S.route; if (!r) return;
  const d = r.data, sc = schedule(r);
  d.stops.forEach((s, i) => {
    if (i) {
      const lg = legOf(r, d.stops[i - 1], s);
      if (lg && lg.geom && lg.geom.length > 1) L.polyline(lg.geom, { color: '#2563eb', weight: 5, opacity: .85 }).bindTooltip(() => legTip(r, sc, i), { sticky: true }).addTo(rG.line);
      else L.polyline([[d.stops[i - 1].lat, d.stops[i - 1].lng], [s.lat, s.lng]], { color: lg && lg.err ? '#dc2626' : '#94a3b8', weight: 2, dashArray: '4 8', opacity: .9 }).bindTooltip(lg && lg.err ? 'No road route: ' + esc(lg.err) : 'Waiting for road route').addTo(rG.line);
    }
    if (showCirc) { const ov = sc.tot.overlaps.some(p => p.includes(i)); covLayer(r, s, num(s.radius) || d.radius, { color: ov ? '#d97706' : '#e11d48', weight: 1.2, fillOpacity: .06, interactive: false }).addTo(rG.circ); }
    const row = sc.rows[i];
    const m = L.marker([s.lat, s.lng], { draggable: true, icon: pinIcon(i + 1, i === 0 ? 'first' : ''), zIndexOffset: 500 }).addTo(rG.pins);
    m.bindTooltip(() => stopTip(r, sc, i), { direction: 'top', offset: [0, -28] });
    if ($('shLabels').checked) L.marker([s.lat, s.lng], { interactive: false, keyboard: false, icon: L.divIcon({ className: 'mk', iconSize: [0, 0], html: `<span class="slabel">${esc(row ? `${s.name} · ${min2hm(row.arr)}` : s.name)}</span>` }) }).addTo(rG.pins);
    m.on('dragend', () => { const p = m.getLatLng(); s.lat = +p.lat.toFixed(6); s.lng = +p.lng.toFixed(6); markDirty(); renderRoute(); });
  });
}

/* =========================================================
   Routes: road legs
   ========================================================= */
let legTimer = 0, legGen = 0;
function needLegs(r) { const d = r.data, out = []; for (let i = 1; i < d.stops.length; i++) { const k = legKey(engTag(d), d.stops[i - 1], d.stops[i]); if (!LEG.has(k) && !d.legs[k]) out.push(i); } return out; }
function queueLegs() { clearTimeout(legTimer); legTimer = setTimeout(fetchLegs, 600); }
async function fetchLegs(force) {
  const r = S.route; if (!r) return;
  const d = r.data, need = force ? d.stops.slice(1).map((_, i) => i + 1) : needLegs(r);
  if (!need.length) { setStat(addMode ? 'Click the map to add stops · Esc to stop' : ''); return; }
  if (!engReady(d.engine)) { setStat(`<span class="err">No road routing key for ${esc(ENGINES[d.engine].name)}.</span> Add it in config.js (see the setup guide). Times stay blank until roads are measured.`); renderRoute(true); return; }
  const gen = ++legGen, eng = d.engine, tag = engTag(d);
  setStat(`Getting road route from ${esc(ENGINES[eng].name)}… (${need.length} leg${need.length > 1 ? 's' : ''})`);
  try {
    if (eng === 'ors') {
      const pts = d.stops.map(s => ({ lat: s.lat, lng: s.lng })), legs = await orsLegs(pts);
      if (gen !== legGen) return;
      legs.forEach((lg, k) => { LEG.set(legKey(tag, pts[k], pts[k + 1]), lg); });
    } else if (eng === 'tomtom') {
      const pts = d.stops.map(s => ({ lat: s.lat, lng: s.lng })), legs = await tomtomLegs(pts, nextWeekdayISO(d.start_time).iso);
      if (gen !== legGen) return;
      legs.forEach((lg, k) => { LEG.set(legKey(tag, pts[k], pts[k + 1]), lg); });
    } else {
      for (let n = 0; n < need.length; n++) {
        const i = need[n], a = d.stops[i - 1], b = d.stops[i], k = legKey(tag, a, b);
        setStat(`Getting road route from Ola Maps… ${n + 1}/${need.length}`);
        try { LEG.set(k, await olaLeg(a, b)); } catch (e) { if (/refused the key|limit/i.test(e.message)) throw e; LEG.set(k, { err: e.message }); }
        if (gen !== legGen) return;
      }
    }
    setStat('');
  } catch (e) {
    if (gen !== legGen) return;
    need.forEach(i => { const k = legKey(tag, d.stops[i - 1], d.stops[i]); if (!LEG.has(k)) LEG.set(k, { err: e.message }); });
    setStat(`<span class="err">${esc(e.message)}</span> <button class="btn sm" id="legRetry">Retry</button>`);
    const b = $('legRetry'); if (b) b.onclick = () => { need.forEach(i => LEG.delete(legKey(tag, d.stops[i - 1], d.stops[i]))); fetchLegs(); };
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
  $('rEngine').innerHTML = Object.entries(ENGINES).filter(([k]) => k !== 'ola' || engReady(k) || d.engine === k).map(([k, e]) => opt(k, `${e.name}${engReady(k) ? '' : ' (no key)'}`, d.engine === k)).join('');
  $('engineNote').innerHTML = `${esc(ENGINES[d.engine].note)}${engReady(d.engine) ? '' : ' <span class="err">No key set: add it in config.js.</span>'}${d.time_src === 'engine' ? ' Travel time uses the engine’s estimate; the speed column then shows the resulting average speed.' : ' Travel time = road distance ÷ planned speed (per-stop speed overrides the default).'}`;
}
function loadRouteToForm() {
  const r = S.route, d = r.data;
  $('shapeSel').value = d.shape === 'hex' ? 'hex' : 'circle';
  $('rName').value = r.name || ''; $('rStart').value = d.start_time; $('rSpeed').value = d.speed; $('rHalt').value = d.halt; $('rRadius').value = d.radius; $('rTimeSrc').value = d.time_src;
  renderEngineSel(); renderRouteSel(); clearDirty(); if (S.route._new) markDirty();
}
function setRoute(r) { const on = $('optNote'); if (on) on.innerHTML = ''; S.route = normRoute(clone(r)); if (r._new) S.route._new = true; Object.entries(S.route.data.legs).forEach(([k, v]) => { if (!LEG.has(k)) LEG.set(k, v); }); loadRouteToForm(); renderRoute(); fitRoute(); queueLegs(); }
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
  const legs = {}; for (let i = 1; i < r.data.stops.length; i++) { const k = legKey(engTag(r.data), r.data.stops[i - 1], r.data.stops[i]), v = LEG.get(k) || r.data.legs[k]; if (v && !v.err) legs[k] = v; }
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
  const list = S.amb.filter(a => a.base_lat != null && a.base_lng != null), pl = (S.places || []).filter(p => p.active !== false);
  if (!list.length && !pl.length) { toast('No hospitals, bases or ambulance bases yet. Add them in Ambulances & staff.', true); return; }
  openModal(`<h2>Start the route at a hospital or base</h2><div class="tw"><table class="t"><tbody>${pl.map(p => `<tr class="click" data-p="${esc(p.id)}"><td><b>${esc(p.name)}</b> <span class="hint">${esc(p.kind)}</span></td><td>${esc(p.address || '')}</td><td class="hint">${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}</td></tr>`).join('')}${list.map(a => `<tr class="click" data-a="${esc(a.id)}"><td><b>${esc(a.reg_no)}</b> <span class="hint">ambulance base</span></td><td>${esc(a.base_name || '')}</td><td class="hint">${a.base_lat.toFixed(5)}, ${a.base_lng.toFixed(5)}</td></tr>`).join('')}</tbody></table></div><p class="note">Adds it as stop 1 with no halt.</p>`);
  $('mbody').querySelector('tbody').onclick = e => {
    const tr = e.target.closest('[data-a],[data-p]'); if (!tr) return; closeModal();
    const p = tr.dataset.p && S.places.find(q => q.id === tr.dataset.p), a = tr.dataset.a && ambById(tr.dataset.a);
    const s = p ? addStop(p.lat, p.lng, p.name, 0) : addStop(a.base_lat, a.base_lng, `Base – ${a.base_name || a.reg_no}`, 0); s.halt = 0; renderRoute(); fitRoute();
  };
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
    if (r) { const p = buildPlan(r, y), t = p.totals, over = t.end && new Date(t.end).getTime() > depSpan(y)[1]; $('dPrev').innerHTML = `${t.stops} stops · ${fmt(t.km)} km by road · drive ${dur(t.drive)} · halts ${dur(t.halt)} · route ends ${t.end ? istHM(t.end) : '–'}${t.pop_best != null ? ` · population ${fmtInt(t.pop_best)}` : ''}${over ? ` · <span class="warn">route ends after the shift (${esc(y.end_time)})</span>` : ''}${p.incomplete ? ' · <span class="err">some legs have no road route: open the route and fix before sharing</span>' : ''}`; }
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
  pi.rows.forEach(r => { L.marker([r.stop.lat, r.stop.lng], { icon: pinIcon(r.i + 1, r.st === 'done' ? 'done' : r.st === 'at' ? 'at' : r.i === 0 ? 'first' : '') }).bindTooltip(`<div class="tip"><b>${r.i + 1}. ${esc(r.stop.name)}</b><br>Planned ${istHM(r.stop.arr)}–${istHM(r.stop.dep)} · halt ${r.stop.halt ?? '–'} min${r.stop.km != null ? `<br>From previous: ${fmt(r.stop.km)} km · ${Math.round(r.stop.travel || 0)} min` : ''}<br>${r.actArr ? `Actual ${istHM(r.actArr)}${r.actDep ? '–' + istHM(r.actDep) : ' (at stop)'} · ${esc(delayText(r.arrDelay))}` : r.st === 'done' ? 'Done' : `Expected ${istHM(r.etaArr)}`}${r.stop.remarks ? `<br><i>${esc(r.stop.remarks)}</i>` : ''}</div>`).addTo(lG.stops); });
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
function cacheMaster() { try { localStorage.setItem('ap-master', JSON.stringify({ at: new Date().toISOString(), ambulances: S.amb.map(a => ({ reg_no: a.reg_no, type: a.type, base_name: a.base_name, base_lat: a.base_lat, base_lng: a.base_lng, active: a.active })), places: (S.places || []).map(p => ({ name: p.name, kind: p.kind, lat: p.lat, lng: p.lng, active: p.active, capabilities: p.capabilities })) })); } catch (e) {} }
const AMB_KEYS = ['id', 'reg_no', 'type', 'base_name', 'base_lat', 'base_lng', 'default_pilot', 'default_emt', 'default_route', 'active', 'notes'];
const STAFF_KEYS = ['id', 'name', 'role', 'phone', 'emp_code', 'active'];
const pick = (o, keys) => { const r = {}; keys.forEach(k => { r[k] = o[k] === undefined ? null : o[k]; }); return r; };
function renderMasters() {
  const fa = ($('ambFind').value || '').toLowerCase(), fs = ($('staffFind').value || '').toLowerCase();
  const sOpts = (sel, role) => opt('', '—', !sel) + S.staff.filter(s => (s.active && s.role === role) || s.id === sel).map(s => opt(s.id, s.name, s.id === sel)).join('');
  const amb = S.amb.filter(a => !fa || JSON.stringify([a.reg_no, a.base_name, a.type]).toLowerCase().includes(fa));
  $('ambAside').textContent = `${S.amb.filter(a => a.active).length} active of ${S.amb.length}`;
  $('ambTable').innerHTML = amb.length ? `<table class="t"><thead><tr><th>Reg. no</th><th>Type</th><th>Base (from list)</th><th>Base name</th><th>Base lat, lng</th><th>Default pilot</th><th>Default EMT</th><th>Default route</th><th>Active</th><th></th></tr></thead><tbody>${amb.map(a => `<tr data-id="${esc(a.id)}"><td><input type="text" data-f="reg_no" value="${esc(a.reg_no)}" style="min-width:120px"></td><td><select data-f="type">${['BLS', 'ALS', 'PTV', 'FRV'].map(t => opt(t, t, a.type === t)).join('')}</select></td><td><select data-f="base_place">${opt('', '— pick —', true)}${(S.places || []).filter(p => p.active !== false).map(p => opt(p.id, `${p.name} (${p.kind})`)).join('')}</select></td><td><input type="text" data-f="base_name" value="${esc(a.base_name || '')}" style="min-width:120px"></td><td><input type="text" data-f="base_ll" value="${a.base_lat != null ? `${a.base_lat}, ${a.base_lng}` : ''}" placeholder="lat, lng or Maps link" style="min-width:150px"></td><td><select data-f="default_pilot">${sOpts(a.default_pilot, 'Pilot')}</select></td><td><select data-f="default_emt">${sOpts(a.default_emt, 'EMT')}</select></td><td><select data-f="default_route">${opt('', '—', !a.default_route)}${S.routes.map(r => opt(r.id, r.name, r.id === a.default_route)).join('')}</select></td><td><input type="checkbox" data-f="active"${a.active ? ' checked' : ''}></td><td><button class="ico" data-del title="Delete">✕</button></td></tr>`).join('')}</tbody></table>` : '<p class="note" style="padding:12px">No ambulances yet. Paste them above or press Add one.</p>';
  const st = S.staff.filter(s => !fs || JSON.stringify([s.name, s.phone, s.emp_code, s.role]).toLowerCase().includes(fs));
  $('staffAside').textContent = `${S.staff.filter(s => s.active && s.role === 'Pilot').length} pilots · ${S.staff.filter(s => s.active && s.role === 'EMT').length} EMTs`;
  $('staffTable').innerHTML = st.length ? `<table class="t"><thead><tr><th>Name</th><th>Role</th><th>Phone</th><th>Emp. code</th><th>Default crew on</th><th>Active</th><th></th></tr></thead><tbody>${st.map(s => `<tr data-id="${esc(s.id)}"><td><input type="text" data-f="name" value="${esc(s.name)}" style="min-width:140px"></td><td><select data-f="role">${opt('Pilot', 'Pilot / driver', s.role === 'Pilot')}${opt('EMT', 'EMT / paramedic', s.role === 'EMT')}</select></td><td><input type="tel" data-f="phone" value="${esc(s.phone || '')}" style="min-width:110px"></td><td><input type="text" data-f="emp_code" value="${esc(s.emp_code || '')}" style="min-width:90px"></td><td class="hint">${esc(S.amb.filter(a => a.default_pilot === s.id || a.default_emt === s.id).map(a => a.reg_no).join(', '))}</td><td><input type="checkbox" data-f="active"${s.active ? ' checked' : ''}></td><td><button class="ico" data-del title="Delete">✕</button></td></tr>`).join('')}</tbody></table>` : '<p class="note" style="padding:12px">No staff yet.</p>';
}
$('ambFind').addEventListener('input', renderMasters); $('staffFind').addEventListener('input', renderMasters);
async function saveOne(table, row, keys) {
  const [r] = await DB.upsert(table, [pick(row, keys)]);
  const arr = table === 'ambulances' ? S.amb : table === 'places' ? S.places : S.staff, i = arr.findIndex(x => x.id === r.id); if (i >= 0) arr[i] = r; else arr.push(r);
  if (table === 'ambulances') { S.amb.sort((a, b) => a.reg_no.localeCompare(b.reg_no, 'en', { numeric: true })); cacheMaster(); } else if (table === 'places') { S.places.sort((a, b) => a.name.localeCompare(b.name)); cacheMaster(); drawPlaces(); } else S.staff.sort((a, b) => a.name.localeCompare(b.name));
  return r;
}
$('ambTable').addEventListener('change', async e => {
  const tr = e.target.closest('[data-id]'), a = tr && ambById(tr.dataset.id), f = e.target.dataset.f; if (!a || !f) return;
  const x = { ...a }, v = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
  if (f === 'base_place') { const p = (S.places || []).find(q => q.id === v); if (!p) return; x.base_name = p.name; x.base_lat = p.lat; x.base_lng = p.lng; }
  else if (f === 'base_ll') { if (!String(v).trim()) { x.base_lat = null; x.base_lng = null; } else { const p = parseLatLng(v); if (!p) { toast('Use “lat, lng” or a Google Maps link.', true); renderMasters(); return; } x.base_lat = +p.lat.toFixed(6); x.base_lng = +p.lng.toFixed(6); } }
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
$('bulkKind').addEventListener('click', e => { const b = e.target.closest('[data-v]'); if (!b) return; S.bulkKind = b.dataset.v; document.querySelectorAll('#bulkKind button').forEach(x => x.classList.toggle('on', x === b)); $('bulkText').placeholder = b.dataset.v === 'places' ? 'Paste here, e.g.\nName\tKind\tLocation\tAddress\tPhone\nPB Health Hospital\tHospital\t28.4798, 77.0740\tIFFCO Chowk\t0124…' : b.dataset.v === 'staff' ? 'Paste here, e.g.\nName\tRole\tPhone\tEmp code\nRavi Kumar\tPilot\t9876543210\tP101' : 'Paste here, e.g.\nReg no\tType\tBase name\tBase location\tDefault pilot\tDefault EMT\tDefault route\nHR26AB1234\tBLS\tIFFCO Chowk\t28.4798, 77.0740\tRavi Kumar\tSita Devi\tSohna loop'; S.bulk = null; $('bulkPrev').innerHTML = ''; $('bulkGo').disabled = true; });
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
  if (S.bulkKind === 'places') return bulkCheckPlaces();
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
  const b = S.bulk; if (!b) return; const recs = b.rows.filter(x => x.rec).map(x => pick(x.rec, b.kind === 'staff' ? STAFF_KEYS : b.kind === 'places' ? PLACE_KEYS : AMB_KEYS));
  await guard(async () => {
    const saved = await DB.upsert(b.kind, recs);
    const arr = b.kind === 'staff' ? S.staff : b.kind === 'places' ? S.places : S.amb; saved.forEach(r => { const i = arr.findIndex(x => x.id === r.id); if (i >= 0) arr[i] = r; else arr.push(r); });
    if (b.kind === 'staff') S.staff.sort((x, y) => x.name.localeCompare(y.name)); else if (b.kind === 'places') { S.places.sort((x, y) => x.name.localeCompare(y.name)); cacheMaster(); drawPlaces(); } else { S.amb.sort((x, y) => x.reg_no.localeCompare(y.reg_no, 'en', { numeric: true })); cacheMaster(); }
    $('bulkText').value = ''; $('bulkPrev').innerHTML = ''; $('bulkGo').disabled = true; S.bulk = null; $('bulkInfo').textContent = `${saved.length} saved.`;
    renderMasters(); toast(`${saved.length} ${b.kind === 'staff' ? 'staff' : b.kind === 'places' ? 'hospitals / bases' : 'ambulances'} saved`);
  }, 'Importing…');
});
$('bulkFile').addEventListener('change', async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  try {
    if (/\.xlsx?$/i.test(f.name)) {
      const wb = XLSX.read(await f.arrayBuffer(), { type: 'array' });
      const want = S.bulkKind === 'staff' ? /staff|crew|pilot|emt/i : S.bulkKind === 'places' ? /hosp|base|place/i : /amb|vehicle|fleet/i, sn = wb.SheetNames.find(n => want.test(n)) || wb.SheetNames[0];
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
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Name', 'Kind', 'Location', 'Address', 'Phone', 'Capabilities', 'Active']]), 'Hospitals & bases');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['How to fill'], ['Hospitals & bases: Kind is Hospital, Base, Standby or Other. Location is "28.4798, 77.0740" or a Google Maps link.'], ['Staff: Role is Pilot or EMT. Emp code is optional but best for matching.'], ['Ambulances: Type is BLS, ALS, PTV or FRV. Base location can be "28.4798, 77.0740" or a Google Maps link.'], ['Default pilot / EMT: the person\'s name, phone or emp code (add staff first).'], ['Default route: the exact route name from the app (optional).'], ['Active: Yes or No (blank = Yes).'], ['Upload this file in Ambulances & staff → Upload CSV / Excel. Do Staff first, then Ambulances.']]), 'Read me');
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
$('orsKey').value = localKeys.ORS_API_KEY || ''; $('olaKey').value = localKeys.OLA_MAPS_API_KEY || ''; $('ttKey').value = localKeys.TOMTOM_API_KEY || '';
[['orsKey', 'ORS_API_KEY'], ['olaKey', 'OLA_MAPS_API_KEY'], ['ttKey', 'TOMTOM_API_KEY']].forEach(([id, k]) => $(id).addEventListener('change', e => { const v = e.target.value.trim(); if (v) localKeys[k] = v; else delete localKeys[k]; try { localStorage.setItem('ap-keys', JSON.stringify(localKeys)); } catch (er) {} if (S.route) { if (!engReady(S.route.data.engine) && firstEngine()) S.route.data.engine = firstEngine(); renderEngineSel(); queueLegs(); } renderSettings(); toast('Saved in this browser'); }));
function renderSettings(results) {
  const R = results || {}, line = (name, ok, txt) => `<div style="padding:6px 0;border-bottom:1px solid var(--line)"><span class="chip ${ok === true ? 'ok' : ok === false ? 'bad' : ''}">${ok === true ? '✓' : ok === false ? '✗' : '–'}</span> <b>${name}</b> <span class="muted">${esc(txt)}</span></div>`;
  $('connOut').innerHTML =
    line('Database', DB.cloud ? (R.db ?? true) : null, DB.cloud ? (R.dbTxt || `Supabase · ${CFG.SUPABASE_URL}`) : 'Not connected: demo mode (this browser only). Add SUPABASE_URL and SUPABASE_ANON_KEY in config.js.') +
    line('openrouteservice (roads)', keyOf('ORS_API_KEY') ? (R.ors ?? true) : null, keyOf('ORS_API_KEY') ? (R.orsTxt || `key set${localKeys.ORS_API_KEY ? ' in this browser' : ' in config.js'}`) : 'No key. Get a free one at openrouteservice.org and put it in config.js.') +
    line('TomTom (roads with traffic, free)', keyOf('TOMTOM_API_KEY') ? (R.tt ?? true) : null, keyOf('TOMTOM_API_KEY') ? (R.ttTxt || `key set${localKeys.TOMTOM_API_KEY ? ' in this browser' : ' in config.js'}`) : 'Optional. Free key at developer.tomtom.com (no card) adds drive times with usual traffic.') +
    line('Ola Maps (roads, optional)', keyOf('OLA_MAPS_API_KEY') ? (R.ola ?? true) : null, keyOf('OLA_MAPS_API_KEY') ? (R.olaTxt || `key set${localKeys.OLA_MAPS_API_KEY ? ' in this browser' : ' in config.js'}`) : 'Not set (optional).');
  renderAdmins();
  $('popInfo').textContent = S.grid ? `${S.grid.length.toLocaleString('en-IN')} points loaded · ${fmtInt(S.grid.reduce((t, p) => t + p[2], 0))} people` : 'No grid loaded.';
}
$('connTest').addEventListener('click', async () => {
  const R = {}; $('connOut').innerHTML = '<p class="note">Testing…</p>';
  if (DB.cloud) { try { await DB.list('app_settings'); R.db = true; R.dbTxt = 'connected, tables found'; } catch (e) { R.db = false; R.dbTxt = e.message; } }
  const a = { lat: 28.479814, lng: 77.074042 }, b = { lat: 28.4595, lng: 77.0266 };
  if (keyOf('ORS_API_KEY')) { try { const l = await orsLegs([a, b]); R.ors = true; R.orsTxt = `working · test drive ${fmt(l[0].km)} km, ${fmt(l[0].min, 0)} min`; } catch (e) { R.ors = false; R.orsTxt = e.message; } }
  if (keyOf('TOMTOM_API_KEY')) { try { const l = await tomtomLegs([a, b], nextWeekdayISO('09:00').iso); R.tt = !l[0].err; R.ttTxt = l[0].err ? l[0].err : `working · test drive ${fmt(l[0].km)} km, ${fmt(l[0].min, 0)} min at 09:00 on a weekday`; } catch (e) { R.tt = false; R.ttTxt = e.message; } }
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
/* =========================================================
   Base maps (both maps), layer toggles
   ========================================================= */
/* =========================================================
   Map & scenario: base maps (same list as Radius coverage), overlays, coverage shape
   ========================================================= */
const AS = 'https://server.arcgisonline.com/ArcGIS/rest/services/';
const ESRI_O = { maxZoom: 19, attribution: 'Tiles &copy; Esri &mdash; Esri, HERE, Garmin, USGS, &copy; OpenStreetMap contributors' };
const ESRI_CO = { maxZoom: 19, maxNativeZoom: 16, attribution: 'Tiles &copy; Esri &mdash; Esri, HERE, Garmin, &copy; OpenStreetMap contributors' };
const OSM_O = { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' };
const BASEMAPS = {
  auto:       { label: 'Auto (Esri streets; dark grey in dark mode)' },
  esriStreet: { label: 'Streets – Esri', url: AS + 'World_Street_Map/MapServer/tile/{z}/{y}/{x}', o: ESRI_O },
  esriLight:  { label: 'Light grey – Esri', url: AS + 'Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}', labels: AS + 'Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}', o: ESRI_CO },
  esriDark:   { label: 'Dark grey – Esri', url: AS + 'Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', labels: AS + 'Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}', o: ESRI_CO },
  hybrid:     { label: 'Satellite with labels – Esri', url: AS + 'World_Imagery/MapServer/tile/{z}/{y}/{x}', roads: AS + 'Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}', labels: AS + 'Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', o: { maxZoom: 19, attribution: 'Tiles &copy; Esri &mdash; Esri, Maxar, Earthstar Geographics' } },
  esriTopo:   { label: 'Topographic – Esri', url: AS + 'World_Topo_Map/MapServer/tile/{z}/{y}/{x}', o: ESRI_O },
  osmHot:     { label: 'OSM Humanitarian (community server)', url: 'https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png', o: { ...OSM_O, subdomains: 'abc', attribution: OSM_O.attribution + ', tiles OSM France' } },
  osmDe:      { label: 'OSM Germany style (community server)', url: 'https://tile.openstreetmap.de/{z}/{x}/{y}.png', o: { ...OSM_O, attribution: OSM_O.attribution + ', tiles OSM Germany' } },
  osm:        { label: 'OpenStreetMap standard (website hosting only)', url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', o: OSM_O }
};
const FALLBACK = { esriStreet: 'osmHot', esriLight: 'esriStreet', esriDark: 'esriStreet', hybrid: 'esriStreet', esriTopo: 'esriStreet', osmHot: 'esriStreet', osmDe: 'esriStreet', osm: 'esriStreet' };
const OLD_BASE = { street: 'esriStreet', sat: 'hybrid', grey: 'esriLight' };
const MAPDEF = { base: 'auto', ov: 'off', hexKm: 1, circ: true, places: true, labels: false };
let MP = { ...MAPDEF };
try { const o = JSON.parse(localStorage.getItem('ap-route-map') || 'null'); if (o) MP = { ...MAPDEF, ...o }; else { const b = localStorage.getItem('ap-route-base'); if (b) MP.base = OLD_BASE[b] || b; } } catch (e) { /* defaults */ }
if (!BASEMAPS[MP.base]) MP.base = 'auto';
if (!['off', 'time', 'hex', 'pop'].includes(MP.ov)) MP.ov = 'off';
if (![0.5, 1, 2, 3].includes(+MP.hexKm)) MP.hexKm = 1;
function saveMP() { try { localStorage.setItem('ap-route-map', JSON.stringify(MP)); } catch (e) { /* ignore */ } }
const baseOn = { r: [], l: [] };
let baseKey = null, tileErr = 0, bannerT = 0;
function banner(msg) { const b = $('mBanner'); b.innerHTML = msg; b.classList.add('show'); clearTimeout(bannerT); bannerT = setTimeout(() => b.classList.remove('show'), 7000); }
const resolveBase = () => MP.base !== 'auto' ? MP.base : document.documentElement.dataset.theme === 'dark' ? 'esriDark' : 'esriStreet';
function setBase(k, fromFallback) {
  if (k) MP.base = BASEMAPS[k] ? k : 'auto';
  const key = fromFallback || resolveBase(), b = BASEMAPS[key]; baseKey = key; tileErr = 0;
  [['r', rmap], ['l', lmap]].forEach(([n, m]) => {
    baseOn[n].forEach(t => m.removeLayer(t));
    const ls = [L.tileLayer(b.url, b.o)]; if (b.roads) ls.push(L.tileLayer(b.roads, { maxZoom: 19, opacity: .9 })); if (b.labels) ls.push(L.tileLayer(b.labels, { maxZoom: 19, maxNativeZoom: b.o.maxNativeZoom || 19 }));
    if (n === 'r') ls[0].on('tileerror', () => { if (++tileErr === 6 && baseKey === key && FALLBACK[key]) { const f = FALLBACK[key]; banner(`${esc(BASEMAPS[key].label)} did not load here, switched to ${esc(BASEMAPS[f].label)}.`); setBase(null, f); } });
    baseOn[n] = ls; ls.forEach(t => t.addTo(m).bringToBack());
  });
  $('baseSel').value = MP.base; saveMP();
}
$('baseSel').innerHTML = Object.entries(BASEMAPS).map(([k, b]) => opt(k, b.label)).join('');
$('baseSel').addEventListener('change', e => setBase(e.target.value));
setBase(MP.base);
showCirc = MP.circ; $('shCirc').checked = MP.circ; $('circBtn').classList.toggle('on', showCirc); $('shPlaces').checked = MP.places; $('shLabels').checked = MP.labels;
$('ovSel').value = MP.ov; $('hexKm').value = String(MP.hexKm); $('hexKmF').hidden = MP.ov !== 'hex';
$('shCirc').addEventListener('change', e => { showCirc = MP.circ = e.target.checked; $('circBtn').classList.toggle('on', showCirc); saveMP(); drawRoute(); });
$('circBtn').addEventListener('click', () => { MP.circ = showCirc; saveMP(); });
$('shLabels').addEventListener('change', e => { MP.labels = e.target.checked; saveMP(); drawRoute(); });
$('shPlaces').addEventListener('change', e => { MP.places = e.target.checked; saveMP(); drawPlaces(); });
$('ovSel').addEventListener('change', e => {
  let v = e.target.value;
  if (v === 'pop' && !(S.grid && S.grid.length)) { toast('Load a population grid first (Settings → Population grid).', true); v = 'off'; e.target.value = 'off'; }
  MP.ov = v; $('hexKmF').hidden = v !== 'hex'; saveMP(); drawRoute();
});
$('hexKm').addEventListener('change', e => { MP.hexKm = +e.target.value; saveMP(); drawRoute(); });
$('shapeSel').addEventListener('change', e => {
  if (!S.route) return; S.route.data.shape = e.target.value === 'hex' ? 'hex' : 'circle'; markDirty(); renderRoute(true);
  toast(`Coverage shape: ${S.route.data.shape === 'hex' ? 'hexagon' : 'circle'} for this route. Save the route to keep it.`);
});
$('mapReset').addEventListener('click', () => {
  if (!confirm('Reset the map settings (base map, overlay, toggles, view) to default? Routes and data are not changed.')) return;
  MP = { ...MAPDEF }; saveMP(); setBase('auto'); showCirc = true; $('shCirc').checked = true; $('circBtn').classList.toggle('on', true); $('shPlaces').checked = true; $('shLabels').checked = false;
  $('ovSel').value = 'off'; $('hexKm').value = '1'; $('hexKmF').hidden = true; drawPlaces(); setView('one');
});

/* coverage area of a stop: circle of radius r, or flat-top hexagon with corners r km from the stop */
const R32 = Math.sqrt(3) / 2, ROADF = 1.3, BANDS = [5, 10, 15, 20], TC = [[34, 197, 94], [132, 204, 22], [234, 179, 8], [249, 115, 22], [239, 68, 68]];
const inHex = (dx, dy, r) => { const ax = Math.abs(dx), ay = Math.abs(dy); return ay <= R32 * r && R32 * ax + 0.5 * ay <= R32 * r; };
const KY = 110.57, kxAt = lat => 111.32 * Math.cos(lat * Math.PI / 180);
function inArea(c, lat, lng) { const dx = (lng - c[1]) * kxAt(c[0]), dy = (lat - c[0]) * KY; return c[3] === 'hex' ? inHex(dx, dy, c[2]) : dx * dx + dy * dy <= c[2] * c[2]; }
const shapeOf = r => (r && r.data && r.data.shape === 'hex' ? 'hex' : 'circle');
function hexPts(lat, lng, r) { const kx = kxAt(lat); return [0, 1, 2, 3, 4, 5].map(k => [lat + r * Math.sin(k * Math.PI / 3) / KY, lng + r * Math.cos(k * Math.PI / 3) / kx]); }
function covLayer(r, s, R, o) { return shapeOf(r) === 'hex' ? L.polygon(hexPts(s.lat, s.lng, R), o) : L.circle([s.lat, s.lng], { radius: R * 1000, ...o }); }
const band = t => t <= BANDS[0] ? 0 : t <= BANDS[1] ? 1 : t <= BANDS[2] ? 2 : t <= BANDS[3] ? 3 : 4;

/* overlays: response time from the nearest stop, hexagon grid, population density */
rmap.createPane('ovl'); rmap.getPane('ovl').style.zIndex = 350;
const ovG = L.layerGroup().addTo(rmap), ovR = L.canvas({ pane: 'ovl', padding: .3 });
function ovStops() {
  const list = S.view === 'one' ? (S.route ? [{ r: S.route, start: null }] : []) : manyItems();
  const out = [];
  list.forEach(it => { const r = it.r, d = r.data, sc = it.sc || schedule(r, it.start); d.stops.forEach((s, i) => out.push({ lat: s.lat, lng: s.lng, R: num(s.radius) || d.radius, shape: shapeOf(r), spd: d.speed || 30, r, i, row: sc.rows[i] })); });
  return out;
}
function nearestStop(P, lat, lng) {
  let best = Infinity, bi = -1, bkm = 0, cnt = 0; const kx = kxAt(lat);
  for (let j = 0; j < P.length; j++) {
    const p = P[j], dx = (lng - p.lng) * kx, dy = (lat - p.lat) * KY, km = Math.hypot(dx, dy), t = km * ROADF / p.spd * 60;
    if (t < best) { best = t; bi = j; bkm = km; }
    if (p.shape === 'hex' ? inHex(dx, dy, p.R) : km <= p.R) cnt++;
  }
  return { t: best, j: bi, km: bkm, cnt };
}
function ovBox(P) {
  const m = Math.max(...P.map(p => p.R)) + 3, la = P.map(p => p.lat), lo = P.map(p => p.lng), lat0 = (Math.min(...la) + Math.max(...la)) / 2, kx = kxAt(lat0);
  return { s: Math.min(...la) - m / KY, n: Math.max(...la) + m / KY, w: Math.min(...lo) - m / kx, e: Math.max(...lo) + m / kx, lat0, kx };
}
let ovSum = null;
function drawOverlay() {
  ovG.clearLayers(); ovSum = null;
  if (MP.ov === 'off') return;
  const P = ovStops(); if (!P.length) return;
  const B = ovBox(P);
  if (MP.ov === 'time' || MP.ov === 'pop') {
    const nx = 200, ny = Math.max(40, Math.round(nx * ((B.n - B.s) * KY) / ((B.e - B.w) * B.kx))), cv = document.createElement('canvas'); cv.width = nx; cv.height = ny;
    const g = cv.getContext('2d'), img = g.createImageData(nx, ny);
    if (MP.ov === 'time') {
      const cnt = [0, 0, 0, 0, 0];
      for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
        const lat = B.n - (y + .5) * (B.n - B.s) / ny, lng = B.w + (x + .5) * (B.e - B.w) / nx, q = nearestStop(P, lat, lng), b = band(q.t), c = TC[b], k = (y * nx + x) * 4;
        cnt[b]++; img.data[k] = c[0]; img.data[k + 1] = c[1]; img.data[k + 2] = c[2]; img.data[k + 3] = q.cnt ? 130 : 80;
      }
      ovSum = { kind: 'time', cnt };
    } else {
      const acc = new Float64Array(nx * ny); let mx = 0;
      S.grid.forEach(p => { if (p[0] < B.s || p[0] > B.n || p[1] < B.w || p[1] > B.e) return; const x = Math.floor((p[1] - B.w) / (B.e - B.w) * nx), y = Math.floor((B.n - p[0]) / (B.n - B.s) * ny), k = y * nx + x; acc[k] += p[2]; if (acc[k] > mx) mx = acc[k]; });
      for (let k = 0; k < acc.length; k++) { if (!acc[k]) continue; const f = Math.log1p(acc[k]) / Math.log1p(mx); img.data[k * 4] = 109; img.data[k * 4 + 1] = 40; img.data[k * 4 + 2] = 217; img.data[k * 4 + 3] = Math.round(40 + 170 * f); }
      ovSum = { kind: 'pop', max: mx };
    }
    g.putImageData(img, 0, 0);
    L.imageOverlay(cv.toDataURL(), [[B.s, B.w], [B.n, B.e]], { pane: 'ovl', opacity: .75, interactive: false, className: 'pix' }).addTo(ovG);
    return;
  }
  /* hexagon grid in local km around the box centre */
  const S3 = Math.sqrt(3), lng0 = (B.w + B.e) / 2, W = (B.e - B.w) * B.kx, Hh = (B.n - B.s) * KY;
  let w = MP.hexKm, a = w / S3; while ((W * Hh) / (1.5 * S3 * a * a) > 5000) { w *= 2; a = w / S3; }
  const toLL = (x, y) => [B.lat0 + y / KY, lng0 + x / B.kx];
  const key = (x, y) => { const q = (2 / 3 * x) / a, r = (-x / 3 + S3 / 3 * y) / a, cz = -q - r; let rq = Math.round(q), rr = Math.round(r); const rz = Math.round(cz), dq = Math.abs(rq - q), dr = Math.abs(rr - r), dz = Math.abs(rz - cz); if (dq > dr && dq > dz) rq = -rr - rz; else if (dr > dz) rr = -rq - rz; return rq + ',' + rr; };
  const pop = new Map(); if (S.grid) S.grid.forEach(p => { if (p[0] < B.s || p[0] > B.n || p[1] < B.w || p[1] > B.e) return; const k = key((p[1] - lng0) * B.kx, (p[0] - B.lat0) * KY); pop.set(k, (pop.get(k) || 0) + p[2]); });
  const sum = { kind: 'hex', w, cnt: [0, 0, 0, 0, 0], pop: [0, 0, 0, 0, 0], unc: 0, uncPop: 0, grid: !!S.grid };
  for (let q = Math.floor(-W / 2 / (1.5 * a)) - 1; q <= Math.ceil(W / 2 / (1.5 * a)) + 1; q++) {
    for (let r = Math.floor(-Hh / 2 / (S3 * a) - q / 2) - 1; r <= Math.ceil(Hh / 2 / (S3 * a) - q / 2) + 1; r++) {
      const cx = a * 1.5 * q, cy = a * S3 * (r + q / 2), [lat, lng] = toLL(cx, cy);
      if (lat < B.s || lat > B.n || lng < B.w || lng > B.e) continue;
      const nq = nearestStop(P, lat, lng), b = band(nq.t), c = TC[b], pp = pop.get(q + ',' + r) || 0, st = P[nq.j];
      sum.cnt[b]++; sum.pop[b] += pp; if (!nq.cnt) { sum.unc++; sum.uncPop += pp; }
      L.polygon([0, 1, 2, 3, 4, 5].map(k => toLL(cx + a * Math.cos(k * Math.PI / 3), cy + a * Math.sin(k * Math.PI / 3))), { renderer: ovR, color: '#ffffff', weight: .7, opacity: .8, fillColor: `rgb(${c})`, fillOpacity: nq.cnt ? .5 : .25 })
        .bindTooltip(() => `<div class="tip"><b>${fmt(nq.t)} min</b> from the nearest stop (estimate)<br><span class="tl">Nearest:</span> ${esc(st.r.name || 'Route')} · stop ${st.i + 1} ${esc(st.r.data.stops[st.i].name || '')}<br><span class="tl">Ambulance there:</span> ${min2hm(st.row.arr)}–${min2hm(st.row.dep)} (halt ${st.row.halt != null ? Math.round(st.row.halt) : '–'} min)<br>${fmt(nq.km)} km straight line · ${nq.cnt ? `inside ${nq.cnt} coverage area${nq.cnt > 1 ? 's' : ''}` : 'outside every coverage area'}${S.grid ? `<br>Population ${fmtInt(pp)}` : ''}</div>`, { sticky: true })
        .addTo(ovG);
    }
  }
  ovSum = sum;
}
function ovLegend() {
  if (!ovSum) return '';
  const lab = [`≤ ${BANDS[0]} min`, `${BANDS[0]}–${BANDS[1]} min`, `${BANDS[1]}–${BANDS[2]} min`, `${BANDS[2]}–${BANDS[3]} min`, `> ${BANDS[3]} min`], hexSw = ';clip-path:polygon(25% 0,75% 0,100% 50%,75% 100%,25% 100%,0 50%)';
  if (ovSum.kind === 'pop') return `<div class="ovlegend"><b>Population density</b><div class="lg"><span class="sw" style="background:linear-gradient(90deg,rgba(109,40,217,.2),rgba(109,40,217,.85))"></span>low → high (darkest ≈ ${fmtInt(ovSum.max)} people per cell)</div></div>`;
  if (ovSum.kind === 'time') { const n = ovSum.cnt.reduce((a, b) => a + b, 0) || 1; return `<div class="ovlegend"><b>Drive time from the nearest stop</b>${TC.map((c, i) => `<div class="lg"><span class="sw" style="background:rgba(${c},.7)"></span>${lab[i]} · ${fmt(ovSum.cnt[i] / n * 100, 0)}% of the area</div>`).join('')}<div class="note" style="margin:3px 0 0">Straight line × ${ROADF} at each route’s planned speed. Paler = outside every coverage area.</div></div>`; }
  return `<div class="ovlegend"><b>Hexagons ${ovSum.w} km wide · drive time from the nearest stop</b>${TC.map((c, i) => `<div class="lg"><span class="sw" style="background:rgba(${c},.7)${hexSw}"></span>${lab[i]} · ${ovSum.cnt[i]}${ovSum.grid ? ` (${fmtInt(ovSum.pop[i])} people)` : ''}</div>`).join('')}<div class="lg">Outside every coverage area: ${ovSum.unc}${ovSum.grid ? ` (${fmtInt(ovSum.uncPop)} people)` : ''} · faded</div><div class="note" style="margin:3px 0 0">Hover a hexagon for the nearest stop and when the ambulance is there.</div></div>`;
}

/* =========================================================
   Hover details
   ========================================================= */
function stopTip(r, sc, i) {
  const d = r.data, x = sc.rows[i], s = x.s, nx = d.stops[i + 1], pv = i ? sc.rows[i - 1] : null, R = num(s.radius) || d.radius, nh = nearestPlace(s, 'Hospital');
  const lg = x.leg && isFinite(x.leg.km) ? x.leg : null;
  return `<div class="tip"><span class="tl">${esc(r.name || 'Route')} · stop ${i + 1} of ${d.stops.length}</span><br><b>${esc(s.name || 'Stop')}</b>
    <br>Arrive <b>${min2hm(x.arr)}${x.arr != null ? dayTag(x.arr) : ''}</b>${x.arrOv ? ' (fixed)' : ''} · Halt <b>${x.halt != null ? Math.round(x.halt) : '–'} min</b> · Depart <b>${min2hm(x.dep)}</b>${x.depOv ? ' (fixed)' : ''}
    ${i ? `<br><span class="tl">From ${esc(pv.s.name)}:</span> ${lg ? `${fmt(lg.km)} km · ${dur(x.travel)} at ${fmt(x.speed, 0)} km/h` : 'road route pending'}` : '<br><span class="tl">Start of route</span>'}
    <br><span class="tl">Next:</span> ${nx ? esc(nx.name) : 'last stop'}
    <br><span class="tl">Coverage:</span> ${fmt(R)} km ${shapeOf(r) === 'hex' ? 'hexagon' : 'radius'}${x.pop != null ? ` · population ${fmtInt(x.pop)}` : ''}
    ${nh ? `<br><span class="tl">Nearest hospital:</span> ${esc(nh.p.name)} · ${fmt(nh.km)} km (straight line)` : ''}
    ${s.remarks ? `<br><i>${esc(s.remarks)}</i>` : ''}</div>`;
}
function legTip(r, sc, i) {
  const x = sc.rows[i], pv = sc.rows[i - 1], lg = x.leg;
  return `<div class="tip"><span class="tl">${esc(r.name || 'Route')} · leg ${i} of ${sc.rows.length - 1}</span><br><b>${esc(pv.s.name)} → ${esc(x.s.name)}</b>
    <br>${lg && isFinite(lg.km) ? `${fmt(lg.km)} km by road · ${dur(x.travel)} at ${fmt(x.speed, 0)} km/h` : 'Road route pending'}
    <br>Depart ${min2hm(pv.dep)} → arrive ${min2hm(x.arr)}</div>`;
}

/* =========================================================
   All routes / one ambulance on the map
   ========================================================= */
S.view = 'one'; S.viewAmb = null;
function setView(v) {
  if (v === 'amb' && !S.amb.length) { toast('Add ambulances first (Ambulances & staff).', true); v = 'one'; }
  S.view = v; $('viewSel').value = v;
  document.querySelectorAll('#viewSeg button').forEach(b => b.classList.toggle('on', b.dataset.v === v));
  $('viewAmb').style.display = v === 'amb' ? 'block' : 'none';
  if (v === 'amb' && !S.viewAmb) { const a = S.amb.find(x => x.active) || S.amb[0]; S.viewAmb = a && a.id; $('viewAmb').value = S.viewAmb || ''; }
  if (v !== 'one') { setAddMode(false); }
  drawRoute(); fitMany();
}
function fillViewAmb() { $('viewAmb').innerHTML = S.amb.map(a => opt(a.id, `${a.reg_no}${a.active ? '' : ' (inactive)'}`, a.id === S.viewAmb)).join(''); }
$('viewSel').addEventListener('change', e => setView(e.target.value));
$('viewSeg').addEventListener('click', e => { const b = e.target.closest('[data-v]'); if (b) setView(b.dataset.v); });
$('viewAmb').addEventListener('change', e => { S.viewAmb = e.target.value; drawRoute(); fitMany(); });
const curOf = r => (S.route && S.route.id === r.id ? S.route : r);
function manyItems() {
  const items = [];
  if (S.view === 'all') {
    const list = S.routes.map(curOf); if (S.route && S.route._new && S.route.data.stops.length) list.push(S.route);
    list.filter(r => r.data.stops.length).forEach(r => items.push({ r, start: null, label: '' }));
  } else {
    const a = ambById(S.viewAmb); if (!a) return items;
    const byRoute = new Map();
    S.deps.filter(x => x.ambulance_id === a.id && x.route_id && x.status !== 'Cancelled').sort((x, y) => x.dep_date.localeCompare(y.dep_date)).forEach(x => { if (!byRoute.has(x.route_id)) byRoute.set(x.route_id, []); byRoute.get(x.route_id).push(x); });
    if (a.default_route && !byRoute.has(a.default_route)) byRoute.set(a.default_route, []);
    byRoute.forEach((deps, id) => { const r = routeById(id); if (!r || !r.data.stops.length) return; const rr = curOf(r); items.push({ r: rr, start: deps.length ? hm2min(deps[0].start_time) : null, label: deps.length ? deps.map(x => niceDate(x.dep_date)).slice(0, 4).join(', ') + (deps.length > 4 ? ` +${deps.length - 4}` : '') : 'default route' }); });
  }
  return items;
}
function drawMany() {
  const items = manyItems(), lg = $('mLegend'), all = [];
  items.forEach((it, n) => {
    const r = it.r, d = r.data, sc = schedule(r, it.start), col = COLORS[n % COLORS.length]; it.sc = sc; it.col = col;
    d.stops.forEach((s, i) => {
      if (i) {
        const l = legOf(r, d.stops[i - 1], s);
        if (l && l.geom && l.geom.length > 1) L.polyline(l.geom, { color: col, weight: 4, opacity: .85 }).bindTooltip(() => legTip(r, sc, i), { sticky: true }).addTo(rG.line);
        else L.polyline([[d.stops[i - 1].lat, d.stops[i - 1].lng], [s.lat, s.lng]], { color: col, weight: 2, dashArray: '4 8', opacity: .8 }).bindTooltip(() => legTip(r, sc, i), { sticky: true }).addTo(rG.line);
      }
      const R = num(s.radius) || d.radius;
      if (showCirc) covLayer(r, s, R, { color: col, weight: 1, fillColor: col, fillOpacity: .07, interactive: false }).addTo(rG.circ);
      L.marker([s.lat, s.lng], { icon: L.divIcon({ className: 'mk', iconSize: [20, 20], iconAnchor: [10, 10], html: `<div class="sdot" style="background:${col}">${i + 1}</div>` }) }).bindTooltip(() => stopTip(r, sc, i), { direction: 'top', offset: [0, -10] }).on('click', () => openRouteFromMap(r)).addTo(rG.pins);
      if ($('shLabels').checked) L.marker([s.lat, s.lng], { interactive: false, keyboard: false, icon: L.divIcon({ className: 'mk', iconSize: [0, 0], html: `<span class="slabel">${esc(`${s.name} · ${min2hm(sc.rows[i].arr)}`)}</span>` }) }).addTo(rG.pins);
      all.push({ lat: s.lat, lng: s.lng, radius: R, pop: sc.rows[i].pop, pop_src: 'Manual', rt: n, _shape: shapeOf(r) });
    });
  });
  let amb = null;
  if (S.view === 'amb') { amb = ambById(S.viewAmb); if (amb && amb.base_lat != null) L.marker([amb.base_lat, amb.base_lng], { icon: L.divIcon({ className: 'mk', iconSize: [24, 24], iconAnchor: [12, 12], html: '<div class="plk Base">B</div>' }) }).bindTooltip(`<b>${esc(amb.reg_no)} base</b><br>${esc(amb.base_name || '')}`).addTo(rG.pins); }
  if (!items.length) { lg.innerHTML = `<b>${S.view === 'amb' ? (amb ? esc(amb.reg_no) : 'No ambulance') : 'All routes'}</b><p class="note" style="margin:4px 0 0">${S.view === 'amb' ? 'No default route and no deployments loaded for this ambulance. Set a default route in Ambulances & staff, or open the roster week that has its deployments.' : 'No saved routes yet.'}</p>`; lg.classList.add('show'); return; }
  // union coverage, unique population, overlaps between different routes
  const cov = popCoverage({ data: { stops: all, radius: 0 } }, all.map(s => ({ pop: s.pop })));
  const cross = cov.overlaps.filter(([a, b]) => all[a].rt !== all[b].rt).length;
  const T = items.reduce((t, it) => { const x = it.sc.tot; t.km += x.km; t.stops += x.stops; t.drive += x.drive; t.halt += x.halt; return t; }, { km: 0, stops: 0, drive: 0, halt: 0 });
  lg.innerHTML = `<b>${S.view === 'amb' ? `${esc(amb.reg_no)} · ${esc(amb.type || '')}${amb.base_name ? ` · base ${esc(amb.base_name)}` : ''}` : `All routes (${items.length})`}</b>
    <table><thead><tr><th></th><th>Route</th><th class="n">Stops</th><th class="n">Km</th><th>Time</th><th class="n">Population</th></tr></thead><tbody>
    ${items.map((it, n) => { const t = it.sc.tot; return `<tr class="rt" data-r="${esc(it.r.id)}" title="Open this route"><td><span class="sw" style="background:${it.col}"></span></td><td class="nm">${esc(it.r.name || 'New route')}${it.label ? `<br><span class="hint">${esc(it.label)}</span>` : ''}</td><td class="n">${t.stops}</td><td class="n">${fmt(t.km)}${t.incomplete ? '*' : ''}</td><td>${min2hm(t.start)}–${min2hm(t.end)}</td><td class="n">${t.pop_best != null ? fmtInt(t.pop_best) : '–'}</td></tr>`; }).join('')}
    </tbody></table>
    <div class="note" style="margin:6px 0 0">${T.stops} stops · ${fmt(T.km)} km by road · driving ${dur(T.drive)} · halts ${dur(T.halt)}<br>Area covered ${fmt(cov.area, 0)} km² · population ${cov.pop_unique != null ? `${fmtInt(cov.pop_unique)} unique (grid)` : cov.pop_sum != null ? `${fmtInt(cov.pop_sum)} (sum of stops)` : '–'}${cross ? `<br><span class="warn">${cross} stop pair${cross > 1 ? 's' : ''} from different routes overlap</span>` : ''}${items.some(it => it.sc.tot.incomplete) ? '<br>* some legs not measured yet: open that route to measure roads' : ''}<br>Hover a stop or road for times; click a route to edit it.</div>`;
  lg.classList.add('show');
}
function fitMany() {
  if (S.view === 'one') { fitRoute(); return; }
  const pts = manyItems().flatMap(it => it.r.data.stops.map(s => [s.lat, s.lng]));
  if (pts.length) rmap.fitBounds(L.latLngBounds(pts).pad(0.15), { maxZoom: 14 });
}
function openRouteFromMap(r) {
  const saved = routeById(r.id);
  if (S.route && S.route.id !== r.id) { if (S.dirty && !confirm('Discard unsaved changes to this route?')) return; if (saved) setRoute(saved); }
  setView('one');
}
$('mLegend').addEventListener('click', e => { const tr = e.target.closest('[data-r]'); if (!tr) return; const r = routeById(tr.dataset.r) || (S.route && S.route.id === tr.dataset.r ? S.route : null); if (r) openRouteFromMap(r); });

/* =========================================================
   Hospitals & bases
   ========================================================= */
const PLACE_KEYS = ['id', 'name', 'kind', 'lat', 'lng', 'address', 'phone', 'capabilities', 'notes', 'active'];
const KINDS = ['Hospital', 'Base', 'Standby', 'Other'], KIND_TXT = { Hospital: 'Hospital', Base: 'Ambulance base / station', Standby: 'Standby point', Other: 'Other' };
S.places = S.places || [];
const pG = { r: L.layerGroup().addTo(rmap), l: L.layerGroup().addTo(lmap) };
const placeIcon = k => L.divIcon({ className: 'mk', iconSize: [24, 24], iconAnchor: [12, 12], html: `<div class="plk ${esc(k)}">${({ Hospital: 'H', Base: 'B', Standby: 'S' })[k] || '•'}</div>` });
const placeTip = p => `<div class="tip"><b>${esc(p.name)}</b><br><span class="tl">${esc(KIND_TXT[p.kind] || p.kind)}</span>${p.address ? `<br>${esc(p.address)}` : ''}${p.phone ? `<br>☎ ${esc(p.phone)}` : ''}${p.capabilities ? `<br>${esc(p.capabilities)}` : ''}</div>`;
let placeMode = false;
function setPlaceMode(on) {
  if (on && S.placesErr) { toast('Run setup.sql again in Supabase → SQL Editor to enable hospitals & bases.', true); return; }
  placeMode = on; $('placeMode').classList.toggle('on', on); if (on) setAddMode(false);
  rmap.getContainer().style.cursor = on || addMode ? 'crosshair' : ''; setStat(on ? 'Click the map where the hospital or base is · Esc to cancel' : addMode ? 'Click the map to add stops · Esc to stop' : '');
}
$('placeMode').addEventListener('click', () => setPlaceMode(!placeMode));
$('addMode').addEventListener('click', () => { if (addMode && placeMode) setPlaceMode(false); if (addMode && S.view !== 'one') setView('one'); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && placeMode && !$('modal').classList.contains('show')) setPlaceMode(false); });
function nearestPlace(pt, kind) {
  let best = null;
  (S.places || []).forEach(p => { if (p.active === false || (kind && p.kind !== kind)) return; const km = haversine([pt.lat, pt.lng], [p.lat, p.lng]); if (!best || km < best.km) best = { p, km }; });
  return best;
}
function drawPlaces() {
  pG.r.clearLayers(); pG.l.clearLayers();
  if (!$('shPlaces').checked) return;
  (S.places || []).filter(p => p.active !== false && isFinite(p.lat) && isFinite(p.lng)).forEach(p => {
    const m = L.marker([p.lat, p.lng], { icon: placeIcon(p.kind), zIndexOffset: 300 }).bindTooltip(placeTip(p), { direction: 'top', offset: [0, -12] })
      .bindPopup(`<b>${esc(p.name)}</b><div class="row" style="margin-top:6px;gap:6px"><button class="btn sm" data-pa="add">Add as stop</button><button class="btn sm" data-pa="first">Set as stop 1</button><button class="btn sm" data-pa="edit">Edit</button></div>`);
    m.on('popupopen', ev => {
      ev.popup.getElement().querySelectorAll('[data-pa]').forEach(b => { b.onclick = () => {
        rmap.closePopup(); const a = b.dataset.pa;
        if (a === 'edit') { openPlace(p); return; }
        if (S.view !== 'one') setView('one');
        if (!S.route) return;
        const s = addStop(p.lat, p.lng, p.name, a === 'first' ? 0 : null); if (a === 'first') { s.halt = 0; renderRoute(); }
        toast(`${p.name} added as stop ${a === 'first' ? 1 : S.route.data.stops.length}`);
      }; });
    });
    m.addTo(pG.r);
    L.marker([p.lat, p.lng], { icon: placeIcon(p.kind), zIndexOffset: 100 }).bindTooltip(placeTip(p), { direction: 'top', offset: [0, -12] }).addTo(pG.l);
  });
}
function openPlace(p, at) {
  if (S.placesErr) { toast('Run setup.sql again in Supabase → SQL Editor to enable hospitals & bases.', true); return; }
  const x = p ? { ...p } : { id: DB.uuid(), name: '', kind: 'Hospital', lat: at ? +at.lat.toFixed(6) : null, lng: at ? +at.lng.toFixed(6) : null, address: '', phone: '', capabilities: '', notes: '', active: true };
  openModal(`<h2>${p ? 'Edit' : 'Add'} hospital / base</h2>
    <div class="grid2">
      <label class="f">Name<input type="text" id="plName" value="${esc(x.name || '')}" maxlength="100" placeholder="e.g. PB Health Hospital"></label>
      <label class="f">Kind<select id="plKind">${KINDS.map(k => opt(k, KIND_TXT[k], x.kind === k)).join('')}</select></label>
      <label class="f" style="grid-column:1/-1">Location (lat, lng or Google Maps link)<input type="text" id="plLL" value="${x.lat != null ? `${x.lat}, ${x.lng}` : ''}" placeholder="28.479814, 77.074042"></label>
      <label class="f" style="grid-column:1/-1">Address<input type="text" id="plAddr" value="${esc(x.address || '')}" maxlength="200"></label>
      <label class="f">Phone<input type="tel" id="plPhone" value="${esc(x.phone || '')}" maxlength="40"></label>
      <label class="f">Capabilities<input type="text" id="plCap" value="${esc(x.capabilities || '')}" maxlength="200" placeholder="e.g. Cath lab, Stroke, Trauma, NICU"></label>
      <label class="f" style="grid-column:1/-1">Notes<input type="text" id="plNotes" value="${esc(x.notes || '')}" maxlength="300"></label>
    </div>
    <label class="hint"><input type="checkbox" id="plActive"${x.active !== false ? ' checked' : ''}> Active (shown on maps and lists)</label>
    <p class="note">Capabilities with the words Cath, Stroke, Trauma or NICU are also picked up by the Radius coverage module.</p>
    <div class="row" style="margin-top:10px"><button class="btn primary" id="plSave">Save</button>${p ? '<button class="btn" id="plDel">Delete</button>' : ''}<button class="btn" id="plCancel">Cancel</button></div>`);
  $('plCancel').onclick = closeModal;
  if (!p && at) {
    httpJSON(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${x.lat}&lon=${x.lng}&zoom=17&accept-language=en`, {}, 'Place names').then(j => {
      if (!j || !$('plAddr')) return; if (!$('plAddr').value) $('plAddr').value = String(j.display_name || '').split(', ').slice(0, 4).join(', ');
      if (!$('plName').value && j.name) $('plName').value = String(j.name).slice(0, 100);
    }).catch(() => {});
  }
  $('plSave').onclick = async () => {
    const name = $('plName').value.trim(), ll = parseLatLng($('plLL').value);
    if (!name) { toast('Enter a name.', true); return; }
    if (!ll) { toast('Location must be “lat, lng” or a Google Maps link.', true); return; }
    Object.assign(x, { name, kind: $('plKind').value, lat: +ll.lat.toFixed(6), lng: +ll.lng.toFixed(6), address: $('plAddr').value.trim() || null, phone: $('plPhone').value.trim() || null, capabilities: $('plCap').value.trim() || null, notes: $('plNotes').value.trim() || null, active: $('plActive').checked });
    const r = await guard(() => saveOne('places', x, PLACE_KEYS));
    if (r) { closeModal(); setPlaceMode(false); renderPlaces(); renderMasters(); toast(`${r.name} saved`); }
  };
  if (p) $('plDel').onclick = () => delPlace(p);
}
async function delPlace(p) {
  if (!confirm(`Delete ${p.name}? Ambulances keep their base name and location.`)) return;
  await guard(async () => { await DB.remove('places', p.id); S.places = S.places.filter(q => q.id !== p.id); cacheMaster(); drawPlaces(); closeModal(); renderPlaces(); renderMasters(); toast('Deleted'); }, 'Deleting…');
}
function renderPlaces() {
  const f = ($('placeFind').value || '').toLowerCase(), list = (S.places || []).filter(p => !f || JSON.stringify([p.name, p.kind, p.address, p.capabilities]).toLowerCase().includes(f));
  $('placeAside').textContent = S.placesErr ? 'needs database update' : KINDS.map(k => [k, S.places.filter(p => p.kind === k && p.active !== false).length]).filter(x => x[1]).map(([k, n]) => `${n} ${k === 'Base' ? 'base' : k.toLowerCase()}${n > 1 ? 's' : ''}`).join(' · ') || 'none yet';
  if (S.placesErr) { $('placeTable').innerHTML = `<p class="note" style="padding:12px"><span class="err">The database has no “places” table yet.</span> Open Supabase → SQL Editor, paste the new setup.sql and press Run. It is safe to run again; nothing is deleted.</p>`; return; }
  $('placeTable').innerHTML = list.length ? `<table class="t"><thead><tr><th>Name</th><th>Kind</th><th>Lat, lng</th><th>Address</th><th>Phone</th><th>Capabilities</th><th>Active</th><th></th></tr></thead><tbody>${list.map(p => `<tr data-id="${esc(p.id)}"><td><input type="text" data-f="name" value="${esc(p.name)}" style="min-width:150px"></td><td><select data-f="kind">${KINDS.map(k => opt(k, k, p.kind === k)).join('')}</select></td><td><input type="text" data-f="ll" value="${p.lat}, ${p.lng}" style="min-width:150px"></td><td><input type="text" data-f="address" value="${esc(p.address || '')}" style="min-width:150px"></td><td><input type="tel" data-f="phone" value="${esc(p.phone || '')}" style="min-width:100px"></td><td><input type="text" data-f="capabilities" value="${esc(p.capabilities || '')}" style="min-width:140px"></td><td><input type="checkbox" data-f="active"${p.active !== false ? ' checked' : ''}></td><td style="white-space:nowrap"><button class="ico" data-show title="Show on map">◎</button><button class="ico" data-del title="Delete">✕</button></td></tr>`).join('')}</tbody></table>` : '<p class="note" style="padding:12px">No hospitals or bases yet. Press Add one, Add on map, or paste a list in Bulk import (choose “Hospitals &amp; bases”).</p>';
}
$('placeFind').addEventListener('input', renderPlaces);
$('placeAdd').addEventListener('click', () => openPlace(null, null));
$('placeMapAdd').addEventListener('click', () => { showTab('routes'); setPlaceMode(true); setTimeout(() => rmap.invalidateSize(), 50); });
$('placeTable').addEventListener('change', async e => {
  const tr = e.target.closest('[data-id]'), p = tr && S.places.find(q => q.id === tr.dataset.id), f = e.target.dataset.f; if (!p || !f) return;
  const x = { ...p }, v = e.target.type === 'checkbox' ? e.target.checked : e.target.value.trim();
  if (f === 'll') { const ll = parseLatLng(v); if (!ll) { toast('Use “lat, lng” or a Google Maps link.', true); renderPlaces(); return; } x.lat = +ll.lat.toFixed(6); x.lng = +ll.lng.toFixed(6); }
  else if (f === 'name' && !v) { renderPlaces(); return; }
  else x[f] = v === '' ? null : v;
  const r = await guard(() => saveOne('places', x, PLACE_KEYS)); renderPlaces(); renderMasters(); if (r) toast(`${r.name} saved`);
});
$('placeTable').addEventListener('click', e => {
  const tr = e.target.closest('[data-id]'), p = tr && S.places.find(q => q.id === tr.dataset.id); if (!p) return;
  if (e.target.closest('[data-del]')) delPlace(p);
  else if (e.target.closest('[data-show]')) { showTab('routes'); setTimeout(() => { rmap.invalidateSize(); rmap.setView([p.lat, p.lng], 15); }, 60); }
});
HDR.places = { name: /^(name|hospital|hospital name|base|base name|place|place name)$/, kind: /^(kind|type|category)$/, ll: /^(location|lat, ?lng|coordinates|maps link|google maps link)$/, lat: /^(lat|latitude)$/, lng: /^(lng|lon|long|longitude)$/, address: /^(address|area)$/, phone: /^(phone|contact|mobile|phone no|contact no)$/, capabilities: /^(capabilities|facilities|services|speciality|specialities)$/, notes: /^(notes|remarks)$/, active: /^(active|status)$/ };
const kindOf = v => { const t = String(v || '').toLowerCase(); return !t ? null : /hosp|medical|clinic|centre|center|chc|phc/.test(t) ? 'Hospital' : /base|station|depot|garage/.test(t) ? 'Base' : /stand ?by|parking|point|hold/.test(t) ? 'Standby' : 'Other'; };
const normHead = h => String(h || '').toLowerCase().replace(/\(.*?\)/g, ' ').replace(/[^a-z0-9, #]/g, ' ').replace(/\s+/g, ' ').trim();
function bulkCheckPlaces() {
  const rows = splitRows($('bulkText').value); if (rows.length < 2) { $('bulkInfo').textContent = 'Paste a header row and at least one data row.'; return; }
  if (S.placesErr) { $('bulkInfo').innerHTML = '<span class="err">Run setup.sql again in Supabase first (adds the hospitals & bases table).</span>'; return; }
  const head = rows[0].map(normHead), col = {};
  Object.entries(HDR.places).forEach(([k, re]) => { const i = head.findIndex(h => re.test(h)); if (i >= 0) col[k] = i; });
  if (col.name == null) { $('bulkInfo').innerHTML = `<span class="err">Header row needs a Name column.</span> Found: ${esc(rows[0].join(' | '))}`; $('bulkGo').disabled = true; return; }
  const g = (r, k) => col[k] != null ? String(r[col[k]] ?? '').trim() : undefined, out = [], seen = new Set();
  rows.slice(1).forEach((r, n) => {
    const msgs = [], name = g(r, 'name');
    if (!name) { out.push({ n: n + 2, act: 'Skip', msgs: ['Name missing'], show: r }); return; }
    if (seen.has(name.toLowerCase())) { out.push({ n: n + 2, act: 'Skip', msgs: ['Repeated in this paste'], show: r }); return; } seen.add(name.toLowerCase());
    const ex = S.places.find(p => p.name.toLowerCase() === name.toLowerCase());
    let ll = null; if (col.ll != null && g(r, 'll')) ll = parseLatLng(g(r, 'll')); else if (col.lat != null && col.lng != null && g(r, 'lat')) ll = parseLatLng(`${g(r, 'lat')}, ${g(r, 'lng')}`);
    if (!ll && !ex) { out.push({ n: n + 2, act: 'Skip', msgs: ['Location missing or not understood (use “lat, lng” or a Google Maps link)'], show: r }); return; }
    if (!ll && ((col.ll != null && g(r, 'll')) || (col.lat != null && g(r, 'lat')))) msgs.push('Location not understood: kept the old one');
    const rec = { ...(ex || { id: DB.uuid(), active: true, kind: 'Hospital', address: null, phone: null, capabilities: null, notes: null }), name };
    const kv = g(r, 'kind'); if (kv) { rec.kind = kindOf(kv); if (rec.kind === 'Other' && !/other/i.test(kv)) msgs.push(`Kind “${kv}” read as Other`); }
    if (ll) { rec.lat = +ll.lat.toFixed(6); rec.lng = +ll.lng.toFixed(6); }
    ['address', 'phone', 'capabilities', 'notes'].forEach(k => { const v = g(r, k); if (v !== undefined) rec[k] = v || null; });
    if (col.active != null) rec.active = isActive(g(r, 'active'));
    out.push({ n: n + 2, act: ex ? 'Update' : 'New', msgs, rec, show: [rec.name, rec.kind, `${rec.lat}, ${rec.lng}`, rec.address || '', rec.phone || ''] });
  });
  S.bulk = { kind: 'places', rows: out };
  const ok = out.filter(x => x.rec), nNew = ok.filter(x => x.act === 'New').length, nUp = ok.length - nNew, nSkip = out.length - ok.length;
  $('bulkInfo').innerHTML = `${nNew} new · ${nUp} update · ${nSkip ? `<span class="err">${nSkip} skipped</span>` : '0 skipped'}`;
  $('bulkGo').disabled = !ok.length;
  const hd = ['Name', 'Kind', 'Lat, lng', 'Address', 'Phone'];
  $('bulkPrev').innerHTML = `<table class="t"><thead><tr><th>Row</th><th>Action</th>${hd.map(h => `<th>${h}</th>`).join('')}<th>Notes</th></tr></thead><tbody>${out.map(x => `<tr><td>${x.n}</td><td class="${x.act === 'Skip' ? 'err' : x.act === 'New' ? 'good' : ''}">${x.act}</td>${hd.map((_, i) => `<td>${esc((x.show || [])[i] ?? '')}</td>`).join('')}<td class="${x.msgs.length ? 'warn' : ''}">${esc(x.msgs.join('; '))}</td></tr>`).join('')}</tbody></table>`;
}

/* =========================================================
   Route import / export (Excel template)
   ========================================================= */
const RT_HEAD = ['Route name', 'Start time', 'Planned speed (km/h)', 'Default halt (min)', 'Coverage radius (km)', 'Road routing', 'Travel time from', 'Coverage shape'];
const ST_HEAD = ['Route name', 'Stop no', 'Location name', 'Location (lat, lng / Maps link / place name)', 'Halt (min)', 'Speed to here (km/h)', 'Fixed arrival', 'Fixed departure', 'Population', 'Population source', 'Population updated', 'Coverage radius (km)', 'Remarks'];
const RT_HDR = { name: /^(route|route name|name)$/, start: /^(start|start time)$/, speed: /^(planned speed|speed|avg speed|planned avg speed)$/, halt: /^(default halt|halt)$/, radius: /^(coverage radius|radius)$/, engine: /^(road routing|engine|routing)$/, time_src: /^(travel time from|time source)$/, shape: /^(coverage shape|shape)$/ };
const ST_HDR = { route: /^(route|route name)$/, no: /^(stop no|stop|#|no|sequence|seq|order|stop number)$/, name: /^(location name|stop name|name|place|place name)$/, ll: /^(location|lat, ?lng|coordinates|maps link|google maps link)$/, lat: /^(lat|latitude)$/, lng: /^(lng|lon|long|longitude)$/, halt: /^(halt|halt time)$/, speed: /^(speed to here|speed)$/, arr_ov: /^(fixed arrival|arrival|arrival time)$/, dep_ov: /^(fixed departure|departure|departure time)$/, pop: /^(population)$/, pop_src: /^(population source)$/, pop_date: /^(population updated|population date)$/, radius: /^(coverage radius|radius)$/, remarks: /^(remarks|notes|instructions)$/ };
const engineOf = v => { const t = String(v || '').toLowerCase(); return /tom/.test(t) ? 'tomtom' : /ola/.test(t) ? 'ola' : /ors|openroute|free|road/.test(t) ? 'ors' : null; };
const engineLabel = e => ({ ors: 'openrouteservice', tomtom: 'TomTom (traffic)', ola: 'Ola Maps' })[e] || e;
function toHM(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number' && v >= 0 && v < 1) { const m = Math.round(v * 1440); return `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; }
  const m = /^(\d{1,2})[:.](\d{2})(?::\d{2})?\s*(am|pm)?$/i.exec(String(v).trim()); if (!m) return undefined;
  let h = +m[1]; const mi = +m[2], ap = (m[3] || '').toLowerCase(); if (ap === 'pm' && h < 12) h += 12; if (ap === 'am' && h === 12) h = 0;
  return h < 24 && mi < 60 ? `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}` : undefined;
}
const isoDate = v => { const s = String(v || '').trim(); if (!s) return null; let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s); if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`; m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(s); if (m) return `${m[3].length === 2 ? '20' + m[3] : m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`; return null; };
function sheetRows(wb, re, avoid) { const n = wb.SheetNames.find(x => re.test(x) && !(avoid && avoid.test(x))); return n ? XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: false, defval: '' }).filter(r => r.some(c => String(c).trim())) : null; }
function colsOf(head, map) { const h = head.map(normHead), c = {}; Object.entries(map).forEach(([k, re]) => { const i = h.findIndex(x => re.test(x)); if (i >= 0) c[k] = i; }); return c; }
function routesBook(routes, example) {
  const wb = XLSX.utils.book_new(), R = [RT_HEAD], St = [ST_HEAD.concat(example ? [] : ['Arrive (calculated)', 'Depart (calculated)', 'Road km from previous'])];
  if (example) {
    R.push(['Example – Sohna Road loop', '08:00', 30, 30, 2, 'openrouteservice', 'Planned speed', 'Circle']);
    St.push(['Example – Sohna Road loop', 1, 'PB Health Hospital (base)', '28.479814, 77.074042', 0, '', '', '', '', '', '', '', 'Start from hospital']);
    St.push(['Example – Sohna Road loop', 2, 'Subhash Chowk', '28.4302, 77.0400', 45, '', '', '', 12000, 'External', '', '', '']);
    St.push(['Example – Sohna Road loop', 3, 'Badshahpur', 'Badshahpur, Gurugram', 60, '', '10:30', '', '', '', '', 3, 'Market area, park near police post']);
  } else routes.forEach(r => {
    const d = r.data, sc = schedule(r);
    R.push([r.name, d.start_time, d.speed, d.halt, d.radius, engineLabel(d.engine), d.time_src === 'engine' ? 'Routing engine estimate' : 'Planned speed', d.shape === 'hex' ? 'Hexagon' : 'Circle']);
    sc.rows.forEach((x, i) => { const s = x.s; St.push([r.name, i + 1, s.name, `${s.lat}, ${s.lng}`, s.halt ?? '', s.speed ?? '', s.arr_ov || '', s.dep_ov || '', s.pop_src === 'Grid' ? '' : (s.pop ?? ''), s.pop_src || 'Manual', s.pop_date || '', s.radius ?? '', s.remarks || '', min2hm(x.arr), min2hm(x.dep), x.leg && isFinite(x.leg.km) ? +x.leg.km.toFixed(2) : '']); });
  });
  const ws1 = XLSX.utils.aoa_to_sheet(R), ws2 = XLSX.utils.aoa_to_sheet(St);
  ws1['!cols'] = RT_HEAD.map(h => ({ wch: Math.max(14, h.length + 2) })); ws2['!cols'] = St[0].map((h, i) => ({ wch: i === 3 ? 34 : Math.max(10, h.length + 2) }));
  XLSX.utils.book_append_sheet(wb, ws1, 'Routes'); XLSX.utils.book_append_sheet(wb, ws2, 'Stops');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['How to fill the route template'],
    ['Routes sheet: one row per route. Only Route name is required; blank cells use the defaults (start 08:00, 30 km/h, 30 min halt, 2 km radius).'],
    ['Stops sheet: one row per stop. Route name must match the Routes sheet. Stop no sets the order (1, 2, 3…).'],
    ['Location: "28.4798, 77.0740", a Google Maps link, or a place name (place names are looked up online; check them on the map after import).'],
    ['Halt and Speed to here: leave blank to use the route default. Fixed arrival / departure: optional exact times like 10:30.'],
    ['Population source: Manual, External or Grid. Population updated: a date like 2026-11-01.'],
    ['Road routing: openrouteservice (free roads) or TomTom (traffic). Travel time from: Planned speed or Routing engine estimate. Coverage shape: Circle or Hexagon.'],
    ['Importing a route with the same name REPLACES its stops. Columns marked "calculated" are ignored on import.'],
    ['Upload in Route planner → Import routes (Excel template).']]), 'Read me');
  return wb;
}
$('expRoutes').addEventListener('click', () => { const list = S.routes.map(curOf); if (!list.length) { toast('No saved routes yet.', true); return; } XLSX.writeFile(routesBook(list), `routes-${todayIST()}.xlsx`); });
$('impBtn').addEventListener('click', () => {
  openModal(`<h2>Import routes from Excel</h2>
    <ol class="note" style="margin:0 0 10px 18px;padding:0"><li>Download the template (or download your current routes to edit them).</li><li>Fill the <b>Routes</b> and <b>Stops</b> sheets. The <b>Read me</b> sheet explains each column.</li><li>Upload it here, check the preview, then press Import. Road distances are measured for each route automatically.</li></ol>
    <div class="row"><button class="btn sm" id="imTpl"><svg class="i"><use href="#i-save"/></svg>Download template</button><button class="btn sm" id="imCur">Download current routes</button><label class="btn sm primary" style="cursor:pointer"><svg class="i"><use href="#i-open"/></svg>Upload filled file<input type="file" id="imFile" accept=".xlsx,.xls,.csv" hidden></label></div>
    <div id="imPrev" style="margin-top:10px"></div>
    <div class="row" style="margin-top:10px"><button class="btn primary" id="imGo" disabled>Import</button><button class="btn" id="imCancel">Cancel</button></div>`, true);
  $('imCancel').onclick = closeModal;
  $('imTpl').onclick = () => XLSX.writeFile(routesBook([], true), 'route-import-template.xlsx');
  $('imCur').onclick = () => $('expRoutes').click();
  $('imFile').onchange = async e => { const f = e.target.files[0]; e.target.value = ''; if (!f) return; try { await imParse(XLSX.read(await f.arrayBuffer(), { type: 'array' })); } catch (err) { console.error(err); toast(`Couldn’t read ${f.name}: ${err.message}`, true); } };
});
let IMP = null;
async function imParse(wb) {
  const rr = sheetRows(wb, /route/i, /stop/i), sr = sheetRows(wb, /stop/i) || (wb.SheetNames.length === 1 ? sheetRows(wb, /./) : null);
  if (!sr || sr.length < 2) { $('imPrev').innerHTML = '<p class="err">No “Stops” sheet with data found. Use the template.</p>'; return; }
  const settings = new Map(), warn = [];
  if (rr && rr.length > 1) {
    const c = colsOf(rr[0], RT_HDR);
    if (c.name == null) warn.push('Routes sheet has no “Route name” column: its settings were ignored.');
    else rr.slice(1).forEach((r, n) => {
      const g = k => c[k] != null ? String(r[c[k]] ?? '').trim() : '', name = g('name'); if (!name) return;
      const o = {}, st = toHM(g('start')); if (st) o.start_time = st; else if (g('start')) warn.push(`Routes row ${n + 2}: start time “${g('start')}” not understood`);
      [['speed', 'speed'], ['halt', 'halt'], ['radius', 'radius']].forEach(([k, f]) => { const v = num(g(k)); if (v != null) o[f] = v; });
      const en = engineOf(g('engine')); if (en) o.engine = en; if (g('time_src')) o.time_src = /engine|estimate/i.test(g('time_src')) ? 'engine' : 'speed'; if (g('shape')) o.shape = /hex/i.test(g('shape')) ? 'hex' : 'circle';
      settings.set(name.toLowerCase(), { name, o });
    });
  }
  const c = colsOf(sr[0], ST_HDR);
  const miss = ['route'].filter(k => c[k] == null).concat(c.ll == null && (c.lat == null || c.lng == null) ? ['location'] : []);
  if (miss.length) { $('imPrev').innerHTML = `<p class="err">Stops sheet needs a ${miss.join(' and ')} column. Found: ${esc(sr[0].join(' | '))}</p>`; return; }
  const groups = new Map();
  sr.slice(1).forEach((r, n) => {
    const g = k => c[k] != null ? String(r[c[k]] ?? '').trim() : '', rn = g('route'); if (!rn) { if (r.some(x => String(x).trim())) warn.push(`Stops row ${n + 2}: no route name, skipped`); return; }
    const key = rn.toLowerCase(); if (!groups.has(key)) groups.set(key, { name: settings.has(key) ? settings.get(key).name : rn, rows: [] });
    let ll = null, q = '';
    if (c.ll != null && g('ll')) { ll = parseLatLng(g('ll')); if (!ll) q = g('ll'); } else if (c.lat != null && g('lat')) ll = parseLatLng(`${g('lat')}, ${g('lng')}`);
    if (!ll && !q) { warn.push(`Stops row ${n + 2} (${rn}): no location, skipped`); return; }
    const s = { id: DB.uuid(), name: (g('name') || q || '').slice(0, 80), lat: ll ? +ll.lat.toFixed(6) : null, lng: ll ? +ll.lng.toFixed(6) : null, q, pop: null, pop_src: 'Manual', pop_date: null, radius: null, halt: null, speed: null, arr_ov: null, dep_ov: null, remarks: g('remarks').slice(0, 300), _no: num(g('no')), _row: n + 2 };
    ['halt', 'speed', 'pop', 'radius'].forEach(k => { const v = num(g(k)); if (v != null && v >= 0) s[k] = v; });
    ['arr_ov', 'dep_ov'].forEach(k => { const v = toHM(g(k)); if (v) s[k] = v; else if (g(k)) warn.push(`Stops row ${n + 2}: time “${g(k)}” not understood`); });
    if (g('pop_src')) s.pop_src = /grid/i.test(g('pop_src')) ? 'Grid' : /ext/i.test(g('pop_src')) ? 'External' : 'Manual';
    s.pop_date = isoDate(g('pop_date'));
    groups.get(key).rows.push(s);
  });
  groups.forEach(gp => gp.rows.sort((a, b) => (a._no ?? 1e9) - (b._no ?? 1e9) || a._row - b._row));
  const lookups = [...groups.values()].reduce((t, gp) => t + gp.rows.filter(s => s.q).length, 0);
  IMP = { groups, settings, warn };
  const ex = gp => S.routes.find(r => r.name.toLowerCase() === gp.name.toLowerCase());
  $('imPrev').innerHTML = `<div class="tw"><table class="t"><thead><tr><th>Route</th><th>Action</th><th>Stops</th><th>Place names to look up</th></tr></thead><tbody>${[...groups.values()].map(gp => `<tr><td>${esc(gp.name)}</td><td class="${ex(gp) ? 'warn' : 'good'}">${ex(gp) ? 'Replace stops' : 'New'}</td><td>${gp.rows.length}${gp.rows.length < 2 ? ' <span class="err">(needs 2+)</span>' : ''}</td><td>${gp.rows.filter(s => s.q).length || '–'}</td></tr>`).join('')}</tbody></table></div>
    ${warn.length ? `<p class="note warn">${warn.slice(0, 12).map(esc).join('<br>')}${warn.length > 12 ? `<br>…and ${warn.length - 12} more` : ''}</p>` : ''}
    ${lookups ? `<p class="note">${lookups} place name${lookups > 1 ? 's' : ''} will be looked up online (about 1 per second). Check their pins after import.</p>` : ''}`;
  $('imGo').disabled = ![...groups.values()].some(gp => gp.rows.length >= 2);
  $('imGo').onclick = imRun;
}
async function geocodeOne(q) {
  const j = await httpJSON(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=in&accept-language=en&viewbox=76.6,28.9,77.6,28.1&q=${encodeURIComponent(q)}`, {}, 'Place search');
  return j && j[0] ? { lat: +j[0].lat, lng: +j[0].lon } : null;
}
async function measureRoute(r) {
  const d = r.data; if (d.stops.length < 2 || !engReady(d.engine)) return false;
  const tag = engTag(d), pts = d.stops.map(s => ({ lat: s.lat, lng: s.lng }));
  let legs;
  if (d.engine === 'ors') legs = await orsLegs(pts);
  else if (d.engine === 'tomtom') legs = await tomtomLegs(pts, nextWeekdayISO(d.start_time).iso);
  else { legs = []; for (let i = 1; i < pts.length; i++) { try { legs.push(await olaLeg(pts[i - 1], pts[i])); } catch (e) { legs.push({ err: e.message }); } } }
  d.legs = {}; legs.forEach((lg, k) => { const key = legKey(tag, pts[k], pts[k + 1]); LEG.set(key, lg); if (!lg.err) d.legs[key] = lg; });
  return true;
}
async function imRun() {
  if (!IMP) return; const { groups, settings } = IMP, done = [], probs = [];
  $('imGo').disabled = true; busy(true, 'Importing routes…');
  try {
    let lastGeo = 0;
    for (const gp of groups.values()) {
      if (gp.rows.length < 2) { probs.push(`${gp.name}: fewer than 2 stops, skipped`); continue; }
      for (const s of gp.rows.filter(x => x.q)) {
        busy(true, `Looking up “${s.q}”…`);
        const wait = 1100 - (Date.now() - lastGeo); if (wait > 0) await new Promise(res => setTimeout(res, wait)); lastGeo = Date.now();
        try { const p = await geocodeOne(s.q); if (p) { s.lat = +p.lat.toFixed(6); s.lng = +p.lng.toFixed(6); } } catch (e) { /* reported below */ }
        if (s.lat == null) probs.push(`${gp.name}: “${s.q}” not found, stop skipped`);
      }
      const ex = S.routes.find(r => r.name.toLowerCase() === gp.name.toLowerCase());
      const base = ex ? clone(ex) : newRoute(); delete base._new;
      base.name = gp.name.slice(0, 80);
      Object.assign(base.data, (settings.get(gp.name.toLowerCase()) || {}).o || {});
      base.data.stops = gp.rows.filter(s => s.lat != null).map(s => { const o = { ...s }; delete o.q; delete o._no; delete o._row; return o; });
      normRoute(base);
      if (base.data.stops.length < 2) { probs.push(`${gp.name}: fewer than 2 stops with a location, skipped`); continue; }
      busy(true, `Measuring roads: ${gp.name}…`);
      try { if (!(await measureRoute(base))) probs.push(`${gp.name}: no road routing key, times stay blank until roads are measured`); }
      catch (e) { probs.push(`${gp.name}: ${e.message}`); }
      busy(true, `Saving ${gp.name}…`);
      const [row] = await DB.upsert('routes', [{ id: base.id, name: base.name, data: base.data }]);
      const i = S.routes.findIndex(x => x.id === row.id); if (i >= 0) S.routes[i] = normRoute(row); else S.routes.push(normRoute(row));
      done.push(row);
      if (ex) await refreshPlansForRoute(row.id);
    }
  } catch (e) { console.error(e); probs.push(e.message); }
  finally { busy(false); }
  S.routes.sort((a, b) => a.name.localeCompare(b.name));
  if (done.length) { const cur = S.route && done.find(x => x.id === S.route.id); if (cur || !S.route || S.route._new) { S.dirty = false; setRoute(routeById((cur || done[0]).id)); } else renderRouteSel(); }
  $('imPrev').innerHTML = `<p class="good">${done.length} route${done.length === 1 ? '' : 's'} imported.</p>${probs.length ? `<p class="note warn">${probs.map(esc).join('<br>')}</p>` : ''}<p class="note">Tip: choose <b>All routes</b> on the map to see them together.</p>`;
  $('imCancel').textContent = 'Close';
  if (done.length) { fillViewAmb(); renderMasters(); }
}

/* =========================================================
   Optimise order, reverse
   ========================================================= */
$('revBtn').addEventListener('click', () => { if (!S.route || S.route.data.stops.length < 2) return; S.route.data.stops.reverse(); markDirty(); renderRoute(); toast('Stop order reversed. Check times, then save.'); });
async function distMatrix(stops) {
  if (ENGINES.ors.key() && stops.length <= 58) {
    const j = await httpJSON('https://api.openrouteservice.org/v2/matrix/driving-car', { method: 'POST', headers: { 'Authorization': ENGINES.ors.key(), 'Content-Type': 'application/json' }, body: JSON.stringify({ locations: stops.map(s => [s.lng, s.lat]), metrics: ['distance'], units: 'km' }) }, 'openrouteservice');
    if (j && j.distances) return { m: j.distances.map(r => r.map(v => v == null ? 1e6 : v)), road: true };
  }
  return { m: stops.map(a => stops.map(b => haversine([a.lat, a.lng], [b.lat, b.lng]) * 1.35)), road: false };
}
function bestOrder(M, keepLast) {
  const n = M.length, last = keepLast ? n - 1 : -1, cost = p => p.reduce((t, v, i) => i ? t + M[p[i - 1]][v] : 0, 0);
  const left = new Set([...Array(n).keys()].filter(i => i !== 0 && i !== last)), p = [0];
  while (left.size) { const a = p[p.length - 1]; let b = null; left.forEach(c => { if (b == null || M[a][c] < M[a][b]) b = c; }); p.push(b); left.delete(b); }
  if (keepLast) p.push(last);
  let better = true, guardN = 0;
  while (better && guardN++ < 200) {
    better = false;
    for (let i = 1; i < p.length - 2; i++) for (let k = i + 1; k < p.length - (keepLast ? 1 : 0); k++) {
      const q = p.slice(0, i).concat(p.slice(i, k + 1).reverse(), p.slice(k + 1));
      if (cost(q) < cost(p) - 1e-6) { p.splice(0, p.length, ...q); better = true; }
    }
  }
  return { p, cost: cost(p), before: cost([...Array(n).keys()]) };
}
$('optBtn').addEventListener('click', () => {
  const r = S.route; if (!r || r.data.stops.length < 3) { toast('Add at least three stops first.', true); return; }
  openModal(`<h2>Optimise stop order</h2><p class="note">Finds the shortest order by road distance. Stop 1 (${esc(r.data.stops[0].name)}) stays first.${ENGINES.ors.key() ? '' : ' No openrouteservice key, so straight-line distance is used.'}</p>
    <label class="hint"><input type="checkbox" id="opLast"> Keep the last stop last (e.g. return to base: ${esc(r.data.stops[r.data.stops.length - 1].name)})</label>
    <p class="note">Fixed arrival/departure times stay on their stops, so check them after reordering.</p>
    <div class="row" style="margin-top:10px"><button class="btn primary" id="opGo">Optimise</button><button class="btn" id="opNo">Cancel</button></div>`);
  $('opNo').onclick = closeModal;
  $('opGo').onclick = async () => {
    const keep = $('opLast').checked; closeModal();
    const res = await guard(async () => { const dm = await distMatrix(r.data.stops); return { ...bestOrder(dm.m, keep), road: dm.road }; }, 'Working out the best order…');
    if (!res) return;
    if (res.cost >= res.before - 0.05) { toast('The current order is already the shortest found.'); return; }
    const old = r.data.stops.slice(); r.data.stops = res.p.map(i => old[i]); markDirty(); renderRoute();
    $('optNote').innerHTML = `Optimised: about ${fmt(res.before)} → ${fmt(res.cost)} km${res.road ? '' : ' (straight-line estimate)'} <button class="btn sm" id="opUndo">Undo</button>`;
    $('opUndo').onclick = () => { if (S.route === r) { r.data.stops = old; markDirty(); renderRoute(); } $('optNote').innerHTML = ''; };
  };
});

/* =========================================================
   Scenario file (backup / move between browsers), print route
   ========================================================= */
const BK_TABLES = ['staff', 'places', 'routes', 'ambulances', 'deployments', 'radius_layouts'];
$('bkSave').addEventListener('click', async () => {
  const out = await guard(async () => { const t = {}; for (const n of BK_TABLES) { try { t[n] = await DB.list(n); } catch (e) { t[n] = []; } } return t; }, 'Collecting data…');
  if (!out) return;
  download(`ambulance-planner-scenario-${todayIST()}.json`, JSON.stringify({ app: 'ambulance-planner', version: 1, at: new Date().toISOString(), org: CFG.ORG_NAME || '', tables: out }, null, 1), 'application/json');
  toast(`Saved: ${BK_TABLES.map(n => `${out[n].length} ${n.replace('_', ' ')}`).join(' · ')}`);
});
$('bkLoad').addEventListener('change', async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  let j; try { j = JSON.parse(await f.text()); } catch (err) { toast('That file is not a scenario file.', true); return; }
  if (!j || j.app !== 'ambulance-planner' || !j.tables) { toast('That file is not a scenario file from this app.', true); return; }
  const cnt = BK_TABLES.map(n => `${(j.tables[n] || []).length} ${n}`).join(', ');
  if (!confirm(`Load scenario saved ${j.at ? new Date(j.at).toLocaleString('en-IN') : ''}?\n\n${cnt}\n\nRecords with the same ID are replaced; nothing else is deleted.`)) return;
  const skipped = [];
  const ok = await guard(async () => {
    for (const n of BK_TABLES) {
      const rows = (j.tables[n] || []).filter(x => x && x.id); if (!rows.length) continue;
      const keys = [...new Set(rows.flatMap(Object.keys))].filter(k => k !== 'created_at' && k !== 'updated_at'), step = n === 'radius_layouts' ? 5 : 400;
      try { for (let i = 0; i < rows.length; i += step) { busy(true, `Loading ${n}… ${Math.min(i + step, rows.length)}/${rows.length}`); await DB.upsert(n, rows.slice(i, i + step).map(x => pick(x, keys))); } }
      catch (e) { if (n === 'places' || n === 'radius_layouts') skipped.push(`${n}: ${e.message}`); else throw e; }
    }
    return true;
  }, 'Loading scenario…');
  if (ok) { S.dirty = false; if (skipped.length) alert(`Loaded, except:\n${skipped.join('\n')}`); toast('Scenario loaded. Reloading…'); setTimeout(() => location.reload(), 900); }
});
function routeReportHTML(r, start, label) {
  const d = r.data, sc = schedule(r, start), t = sc.tot;
  const gm = `https://www.google.com/maps/dir/${d.stops.slice(0, 10).map(s => `${s.lat},${s.lng}`).join('/')}`;
  return `<div style="page-break-inside:avoid;margin-bottom:18px"><h1>${esc(r.name || 'Route')}${label ? ` <span style="font-size:12px;color:#555">(${esc(label)})</span>` : ''}</h1>
    <div>${esc(CFG.ORG_NAME || '')} · Start ${esc(start != null ? min2hm(start) : d.start_time)} · planned ${d.speed} km/h · default halt ${d.halt} min · ${d.radius} km ${d.shape === 'hex' ? 'hexagon' : 'radius'} · roads by ${esc(ENGINES[d.engine].name)}</div>
    <div>${t.stops} stops · ${fmt(t.km)} km by road · driving ${dur(t.drive)} · halts ${dur(t.halt)} · ${min2hm(t.start)} → ${min2hm(t.end)}${dayTag(t.end)} (${dur(t.dur)})${t.pop_best != null ? ` · population ${fmtInt(t.pop_best)}` : ''} · ${fmt(t.area, 0)} km² covered</div>
    <table><tr><th>#</th><th>Location</th><th>Arrive</th><th>Halt</th><th>Depart</th><th>Road km</th><th>Travel</th><th>Speed</th><th>Population</th><th>Nearest hospital</th><th>Remarks</th></tr>
    ${sc.rows.map((x, i) => { const s = x.s, nh = nearestPlace(s, 'Hospital'); return `<tr><td>${i + 1}</td><td>${esc(s.name)}<br><span style="color:#555">${s.lat.toFixed(5)}, ${s.lng.toFixed(5)}</span></td><td>${min2hm(x.arr)}${x.arr != null ? dayTag(x.arr) : ''}</td><td>${x.halt != null ? Math.round(x.halt) + ' min' : ''}</td><td>${min2hm(x.dep)}</td><td>${i ? (x.leg && isFinite(x.leg.km) ? fmt(x.leg.km) : '–') : 'Start'}</td><td>${i && x.travel != null ? dur(x.travel) : ''}</td><td>${i && x.speed ? fmt(x.speed, 0) + ' km/h' : ''}</td><td>${x.pop != null ? fmtInt(x.pop) : ''}</td><td>${nh ? `${esc(nh.p.name)} (${fmt(nh.km)} km)` : ''}</td><td>${esc(s.remarks || '')}</td></tr>`; }).join('')}</table>
    <p style="font-size:10px;color:#555">Google Maps (first 10 stops): ${esc(gm)}</p></div>`;
}
const viewItems = () => S.view === 'one' ? (S.route && S.route.data.stops.length ? [{ r: S.route, start: null, label: '' }] : []) : manyItems();
$('routePrint').addEventListener('click', () => {
  const items = viewItems(); if (!items.length) { toast('Open a route with stops first.', true); return; }
  const now = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
  const head = S.view === 'one' ? '' : `<div style="margin-bottom:12px"><h1>${S.view === 'amb' ? `Routes of ${esc((ambById(S.viewAmb) || {}).reg_no || '')}` : 'All routes'}</h1><div>${esc(CFG.ORG_NAME || '')} · ${now} IST · ${items.length} route${items.length > 1 ? 's' : ''}</div>${$('mLegend').classList.contains('show') ? `<div style="margin-top:6px">${$('mLegend').innerHTML}</div>` : ''}</div>`;
  $('printArea').innerHTML = head + items.map(it => routeReportHTML(it.r, it.start, it.label)).join('');
  setTimeout(() => window.print(), 150);
});
$('csvBtn').addEventListener('click', () => {
  const items = viewItems(); if (!items.length) { toast('Open a route with stops first.', true); return; }
  const q = v => /[",\n]/.test(String(v ?? '')) ? `"${String(v).replace(/"/g, '""')}"` : (v ?? '');
  const rows = [['Route', 'Stop no', 'Location name', 'Latitude', 'Longitude', 'Arrive', 'Halt (min)', 'Depart', 'Road km from previous', 'Travel (min)', 'Population', 'Coverage (km)', 'Coverage shape', 'Nearest hospital', 'Hospital distance (km, straight)', 'Remarks', 'Google Maps']];
  items.forEach(it => { const r = it.r, d = r.data, sc = schedule(r, it.start); sc.rows.forEach((x, i) => { const s = x.s, nh = nearestPlace(s, 'Hospital'); rows.push([r.name || 'Route', i + 1, s.name, s.lat.toFixed(6), s.lng.toFixed(6), min2hm(x.arr), x.halt != null ? Math.round(x.halt) : '', min2hm(x.dep), i && x.leg && isFinite(x.leg.km) ? x.leg.km.toFixed(2) : '', i && x.travel != null ? Math.round(x.travel) : '', x.pop ?? '', num(s.radius) || d.radius, d.shape === 'hex' ? 'Hexagon' : 'Circle', nh ? nh.p.name : '', nh ? nh.km.toFixed(2) : '', s.remarks || '', `https://www.google.com/maps?q=${s.lat},${s.lng}`]); }); });
  download(`${S.view === 'one' ? (S.route.name || 'route').toLowerCase().replace(/[^a-z0-9]+/g, '-') : 'routes'}-stops.csv`, '﻿' + rows.map(r => r.map(q).join(',')).join('\n'), 'text/csv');
});
$('waBtn').addEventListener('click', () => {
  const items = viewItems(); if (!items.length) { toast('Open a route with stops first.', true); return; }
  const txt = items.slice(0, 6).map(it => { const r = it.r, d = r.data, sc = schedule(r, it.start), t = sc.tot;
    return `*${r.name || 'Route'}*${it.label ? ` (${it.label})` : ''}\n${t.stops} stops · ${fmt(t.km)} km · ${min2hm(t.start)}–${min2hm(t.end)}${t.pop_best != null ? ` · population ${fmtInt(t.pop_best)}` : ''}\n` +
      sc.rows.map((x, i) => `${i + 1}. ${x.s.name} – ${min2hm(x.arr)}–${min2hm(x.dep)}`).join('\n') + `\nMap: https://www.google.com/maps/dir/${d.stops.slice(0, 10).map(s => `${s.lat},${s.lng}`).join('/')}`; }).join('\n\n');
  window.open('https://wa.me/?text=' + encodeURIComponent(`${CFG.ORG_NAME || 'Ambulance'} route plan\n\n${txt}${items.length > 6 ? `\n\n…and ${items.length - 6} more routes` : ''}`), '_blank', 'noopener');
});
/* share link: the open route (stops and settings, no road shapes) packed into the address */
function b64u(bytes) { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function unb64u(str) { str = str.replace(/-/g, '+').replace(/_/g, '/'); while (str.length % 4) str += '='; return Uint8Array.from(atob(str), c => c.charCodeAt(0)); }
async function packRoute(r) {
  const d = { ...r.data, legs: {} }, json = JSON.stringify({ v: 1, name: r.name, data: d });
  if (window.CompressionStream) { const cs = new Blob([json]).stream().pipeThrough(new CompressionStream('deflate-raw')); return 'z' + b64u(new Uint8Array(await new Response(cs).arrayBuffer())); }
  return 'j' + b64u(new TextEncoder().encode(json));
}
async function unpackRoute(code) {
  const bytes = unb64u(code.slice(1));
  if (code[0] === 'z') { const ds = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw')); return JSON.parse(await new Response(ds).text()); }
  return JSON.parse(new TextDecoder().decode(bytes));
}
$('linkBtn').addEventListener('click', async () => {
  if (!S.route || !S.route.data.stops.length) { toast('Open a route with stops first.', true); return; }
  try {
    const url = location.origin + location.pathname + '#r=' + await packRoute(S.route);
    try { await navigator.clipboard.writeText(url); toast('Link copied. It opens this route for any signed-in admin, who can save it as a new route.'); }
    catch (e) { prompt('Copy this link:', url); }
  } catch (e) { toast('Could not make the link: ' + e.message, true); }
});
async function openSharedRoute() {
  if (!location.hash.startsWith('#r=')) return;
  const code = location.hash.slice(3); history.replaceState(null, '', location.pathname + location.search);
  try {
    const o = await unpackRoute(code); if (!o || !o.data || !Array.isArray(o.data.stops)) throw new Error('bad');
    if (!confirm(`Open the shared route “${String(o.name || 'Route').slice(0, 80)}” (${o.data.stops.length} stops)? It opens as a new route; press Save to keep it.`)) return;
    if (S.dirty && !confirm('Discard unsaved changes to the open route?')) return;
    const n = newRoute(); n.name = `${String(o.name || 'Shared route').slice(0, 70)} (shared)`; n.data = { ...o.data, legs: {} }; n.data.stops = n.data.stops.map(s => ({ ...s, id: DB.uuid() }));
    S.dirty = false; setRoute(n); showTab('routes'); setView('one');
  } catch (e) { toast('That share link is damaged or incomplete.', true); }
}


async function boot() {
  busy(true, 'Loading…');
  try { if (!(await checkAdmin())) { busy(false); return; } } catch (e) { busy(false); toast(e.message, true); }
  try {
    [S.staff, S.amb, S.routes] = await Promise.all([DB.list('staff'), DB.list('ambulances'), DB.list('routes')]);
    S.routes = S.routes.map(normRoute);
    try { S.places = await DB.list('places'); } catch (e) { S.places = []; S.placesErr = e.message; toast('Hospitals & bases need the updated database: run setup.sql again in Supabase → SQL Editor.', true); }
    cacheMaster(); drawPlaces(); fillViewAmb();
  } catch (e) { busy(false); toast(e.message, true); renderSettings(); showTab('settings'); return; }
  busy(false);
  setRoute(S.routes[0] || newRoute());
  let t = 'routes'; try { t = localStorage.getItem('ap-route-tab') || 'routes'; } catch (e) {}
  showTab(t);
  loadDeps(addDays(weekStart(S.day), -7), addDays(weekStart(S.day), 6)).then(updateLiveCount).catch(() => {});
  openSharedRoute(); window.addEventListener('hashchange', openSharedRoute);
  DB.list('pop_grid').then(rows => { if (rows.length) { S.grid = rows.map(r => [+r.lat, +r.lng, +r.pop]); buildGridIdx(); if (S.route) renderRoute(true); } }).catch(() => {});
}
(async () => {
  if (!DB.cloud) { boot(); return; }
  try { const s = await DB.auth.session(); if (s) boot(); else $('login').classList.add('show'); }
  catch (e) { $('login').classList.add('show'); $('lErr').textContent = e.message; }
})();
