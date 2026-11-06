/* Ambulance Planner – shared helpers for the Route deployment module and the team page */
(function (W) {
  'use strict';
  const CFG = W.APP_CONFIG || {};
  const TZ = 'Asia/Kolkata', IST_MIN = 330;
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad2 = n => String(n).padStart(2, '0');
  const fmt = (v, d = 1) => (v == null || !isFinite(v)) ? '–' : (+v).toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d });
  const fmtInt = v => (v == null || !isFinite(v)) ? '–' : Math.round(v).toLocaleString('en-IN');

  /* ---------- time (all plans are in Indian Standard Time) ---------- */
  const hm2min = s => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim()); return m && +m[1] < 24 && +m[2] < 60 ? +m[1] * 60 + +m[2] : null; };
  const min2hm = m => { if (m == null || !isFinite(m)) return '–'; const r = ((Math.round(m) % 1440) + 1440) % 1440; return `${pad2(Math.floor(r / 60))}:${pad2(r % 60)}`; };
  const dayTag = m => m >= 1440 ? ` +${Math.floor(m / 1440)}d` : '';
  const dur = m => { if (m == null || !isFinite(m)) return '–'; const t = Math.round(m), h = Math.floor(t / 60), r = t % 60; return h ? `${h} h ${pad2(r)} min` : `${r} min`; };
  /* minutes after midnight IST on dateStr -> ISO timestamp */
  function istISO(dateStr, minutes) {
    const [y, mo, d] = String(dateStr).split('-').map(Number);
    return new Date(Date.UTC(y, mo - 1, d, 0, 0) - IST_MIN * 60000 + Math.round(minutes) * 60000).toISOString();
  }
  const istParts = t => { const x = new Date(new Date(t).getTime() + IST_MIN * 60000); return { y: x.getUTCFullYear(), mo: x.getUTCMonth() + 1, d: x.getUTCDate(), h: x.getUTCHours(), mi: x.getUTCMinutes(), wd: x.getUTCDay() }; };
  const istHM = t => { if (!t) return '–'; const p = istParts(t); return `${pad2(p.h)}:${pad2(p.mi)}`; };
  const istDate = t => { const p = istParts(t); return `${p.y}-${pad2(p.mo)}-${pad2(p.d)}`; };
  const todayIST = () => istDate(Date.now());
  const addDays = (dateStr, n) => { const [y, m, d] = dateStr.split('-').map(Number), x = new Date(Date.UTC(y, m - 1, d + n)); return `${x.getUTCFullYear()}-${pad2(x.getUTCMonth() + 1)}-${pad2(x.getUTCDate())}`; };
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'], WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const niceDate = dateStr => { if (!dateStr) return '–'; const [y, m, d] = dateStr.split('-').map(Number), wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); return `${WD[wd]} ${d} ${MON[m - 1]} ${y}`; };
  const ago = t => { if (!t) return 'never'; const s = Math.max(0, (Date.now() - new Date(t).getTime()) / 1000); return s < 90 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`; };

  /* ---------- geometry ---------- */
  function haversine(a, b) {
    const R = 6371.0088, r = Math.PI / 180, dLa = (b[0] - a[0]) * r, dLo = (b[1] - a[1]) * r;
    const h = Math.sin(dLa / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLo / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  /* km from point p to a polyline (local flat approximation, fine for a few km) */
  function distToLine(p, line) {
    if (!line || !line.length) return Infinity;
    const kx = 111.32 * Math.cos(p[0] * Math.PI / 180), ky = 110.57;
    const P = [p[1] * kx, p[0] * ky]; let best = Infinity;
    for (let i = 0; i < line.length; i++) {
      const A = [line[i][1] * kx, line[i][0] * ky];
      if (i === line.length - 1) { best = Math.min(best, Math.hypot(P[0] - A[0], P[1] - A[1])); break; }
      const B = [line[i + 1][1] * kx, line[i + 1][0] * ky], dx = B[0] - A[0], dy = B[1] - A[1], L2 = dx * dx + dy * dy;
      const t = L2 ? Math.max(0, Math.min(1, ((P[0] - A[0]) * dx + (P[1] - A[1]) * dy) / L2)) : 0;
      best = Math.min(best, Math.hypot(P[0] - A[0] - t * dx, P[1] - A[1] - t * dy));
    }
    return best;
  }
  const navUrl = (lat, lng) => `https://www.google.com/maps/dir/?api=1&destination=${(+lat).toFixed(6)},${(+lng).toFixed(6)}&travelmode=driving`;
  const mapUrl = (lat, lng) => `https://www.google.com/maps?q=${(+lat).toFixed(6)},${(+lng).toFixed(6)}`;

  /* ---------- progress of a deployment (shared by admin live view and team page) ----------
     plan.stops[i] = { name, arr, dep (ISO planned) }, progress.stops[i] = { arr, halt, dep (ISO actual) } */
  function progressInfo(plan, progress, now) {
    const stops = (plan && plan.stops) || [], ps = (progress && progress.stops) || {}, n = stops.length;
    now = now || Date.now();
    const done = !!(progress && progress.done);
    let cur = -1;                       // first stop not yet departed
    for (let i = 0; i < n; i++) { const e = ps[i] || {}; if (!e.dep) { cur = i; break; } }
    if (cur === -1 && n) cur = n;       // all departed
    // current delay: latest actual event vs its plan, or "now" past the next planned event
    let delay = 0, lastEvt = null;
    for (let i = 0; i < n; i++) {
      const e = ps[i] || {}, p = stops[i];
      if (e.arr && p.arr) lastEvt = (new Date(e.arr) - new Date(p.arr)) / 60000;
      if (e.dep && p.dep) lastEvt = (new Date(e.dep) - new Date(p.dep)) / 60000;
    }
    if (lastEvt != null) delay = lastEvt;
    if (!done && cur >= 0 && cur < n) {
      const e = ps[cur] || {}, p = stops[cur], due = e.arr ? p.dep : p.arr;
      if (due) { const late = (now - new Date(due)) / 60000; if (late > delay) delay = late; }
    }
    const rows = stops.map((p, i) => {
      const e = ps[i] || {}, st = done || e.dep ? 'done' : e.arr ? 'at' : i === cur ? 'next' : 'pending';
      const shift = st === 'done' ? 0 : delay;
      return {
        i, stop: p, st, actArr: e.arr || null, actHalt: e.halt || null, actDep: e.dep || null,
        arrDelay: e.arr && p.arr ? (new Date(e.arr) - new Date(p.arr)) / 60000 : null,
        depDelay: e.dep && p.dep ? (new Date(e.dep) - new Date(p.dep)) / 60000 : null,
        etaArr: e.arr ? e.arr : p.arr ? new Date(new Date(p.arr).getTime() + shift * 60000).toISOString() : null,
        etaDep: e.dep ? e.dep : p.dep ? new Date(new Date(p.dep).getTime() + shift * 60000).toISOString() : null
      };
    });
    const nDone = rows.filter(r => r.st === 'done').length;
    return { rows, cur, done, delay, nDone, n, started: rows.some(r => r.actArr), allDeparted: n > 0 && cur === n };
  }
  const delayText = m => m == null || !isFinite(m) ? '' : Math.abs(m) < 3 ? 'on time' : m > 0 ? `${Math.round(m)} min late` : `${Math.round(-m)} min early`;

  W.AP = { CFG, TZ, esc, pad2, fmt, fmtInt, hm2min, min2hm, dayTag, dur, istISO, istHM, istDate, istParts, todayIST, addDays, niceDate, ago, haversine, distToLine, navUrl, mapUrl, progressInfo, delayText, MON, WD };
})(window);
