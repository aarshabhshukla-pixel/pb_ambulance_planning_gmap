/* Ambulance Planner – data layer.
   Cloud mode: Supabase (shared database, admin login, QR team links work on any phone).
   Demo mode (no Supabase in config.js): data stays in this browser only. */
(function (W) {
  'use strict';
  const CFG = (W.AP && W.AP.CFG) || W.APP_CONFIG || {};
  const cloud = !!(CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY && W.supabase && W.supabase.createClient);
  const sb = cloud ? W.supabase.createClient(String(CFG.SUPABASE_URL).replace(/\/+$/, ''), CFG.SUPABASE_ANON_KEY, { auth: { persistSession: true, autoRefreshToken: true } }) : null;
  const uuid = () => (W.crypto && crypto.randomUUID) ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); });
  const token = () => { const a = new Uint8Array(16); (W.crypto || {}).getRandomValues ? crypto.getRandomValues(a) : a.forEach((_, i) => { a[i] = Math.random() * 256 | 0; }); return Array.from(a, b => b.toString(16).padStart(2, '0')).join(''); };

  function friendly(e) {
    if (!e) return 'Unknown error';
    const c = e.code || '', m = e.message || String(e);
    if (c === '42P01' || /relation .* does not exist|Could not find the table/i.test(m)) return 'The database is not set up yet. Run setup.sql in Supabase → SQL Editor (see the setup guide).';
    if (c === '42883' || /Could not find the function/i.test(m)) return 'The database functions are missing. Run setup.sql again in Supabase → SQL Editor.';
    if (c === '23505') return 'Already exists: ' + ((e.details || m).replace(/^Key \((.*?)\)=\((.*?)\).*$/, '$1 “$2”'));
    if (c === '23503') return 'This record is still used elsewhere (for example by a deployment), so it can’t be deleted. Mark it inactive instead.';
    if (c === '42501' || /permission denied|row-level security/i.test(m)) return 'Not allowed. Sign in again, or check that setup.sql ran fully.';
    if (/JWT|token is expired|invalid claim/i.test(m)) return 'Your session expired. Please sign in again.';
    if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return 'No connection to the database. Check the internet connection and the Supabase URL in config.js.';
    return m;
  }
  const chk = r => { if (r.error) { const err = new Error(friendly(r.error)); err.raw = r.error; throw err; } return r.data; };

  /* ---------------- demo (this browser) ---------------- */
  const LK = 'ap-local-db', TABLES = ['staff', 'ambulances', 'places', 'routes', 'deployments', 'pings', 'pop_grid', 'app_settings', 'app_admins', 'radius_layouts'];
  function lload() { let o = {}; try { o = JSON.parse(localStorage.getItem(LK) || '{}') || {}; } catch (e) {} TABLES.forEach(t => { if (!Array.isArray(o[t])) o[t] = []; }); return o; }
  function lsave(o) { try { localStorage.setItem(LK, JSON.stringify(o)); } catch (e) { throw new Error('This browser’s storage is full. Demo mode keeps data in the browser only; connect Supabase for real use.'); } }
  const now = () => new Date().toISOString();
  const UNIQ = { staff: ['emp_code'], ambulances: ['reg_no'] };
  function lupsert(t, rows) {
    const o = lload(), out = [];
    rows.forEach(r => {
      const i = o[t].findIndex(x => x.id === r.id);
      (UNIQ[t] || []).forEach(k => { if (r[k] && o[t].some(x => x.id !== r.id && x[k] && String(x[k]).toLowerCase() === String(r[k]).toLowerCase())) { const e = new Error(friendly({ code: '23505', details: `Key (${k})=(${r[k]}) already exists.` })); throw e; } });
      let row;
      if (i >= 0) { row = { ...o[t][i], ...r, updated_at: now() }; o[t][i] = row; }
      else {
        row = { created_at: now(), updated_at: now(), ...r };
        if (!row.id) row.id = t === 'pings' || t === 'pop_grid' ? Date.now() + Math.random() : uuid();
        if (t === 'deployments') row = { status: 'Planned', plan: {}, progress: {}, start_time: '08:00', end_time: '16:00', token: token(), ...row };
        if (t === 'ambulances') row = { type: 'BLS', active: true, ...row };
        if (t === 'staff') row = { role: 'Pilot', active: true, ...row };
        if (t === 'places') row = { kind: 'Hospital', active: true, ...row };
        o[t].push(row);
      }
      out.push(row);
    });
    lsave(o); return out;
  }
  function lremove(t, id) {
    const o = lload();
    if (t === 'ambulances' && o.deployments.some(d => d.ambulance_id === id)) throw new Error(friendly({ code: '23503' }));
    o[t] = o[t].filter(x => x.id !== id);
    if (t === 'staff') { o.ambulances.forEach(a => { if (a.default_pilot === id) a.default_pilot = null; if (a.default_emt === id) a.default_emt = null; }); o.deployments.forEach(d => { if (d.pilot_id === id) d.pilot_id = null; if (d.emt_id === id) d.emt_id = null; }); }
    if (t === 'routes') o.deployments.forEach(d => { if (d.route_id === id) d.route_id = null; });
    if (t === 'deployments') o.pings = o.pings.filter(p => p.deployment_id !== id);
    lsave(o);
  }
  /* mirror of the SQL team_* functions */
  function lteamView(o, d) {
    const a = o.ambulances.find(x => x.id === d.ambulance_id) || {}, p = o.staff.find(x => x.id === d.pilot_id), e = o.staff.find(x => x.id === d.emt_id);
    return { id: d.id, date: d.dep_date, start_time: d.start_time, end_time: d.end_time, status: d.status, plan: d.plan, progress: d.progress, last_seen: d.last_seen, reg_no: a.reg_no, type: a.type,
      pilot: p ? { name: p.name, phone: p.phone } : null, emt: e ? { name: e.name, phone: e.phone } : null, now: now() };
  }
  function lrpc(fn, a) {
    const o = lload(), d = o.deployments.find(x => x.token === a.p_token);
    if (fn === 'team_get') return d && d.status !== 'Cancelled' ? lteamView(o, d) : null;
    if (!d || d.status === 'Cancelled') throw new Error('This deployment link is not valid any more');
    if (fn === 'team_ping') {
      if (d.status === 'Completed') return false;
      Object.assign(d, { last_lat: a.p_lat, last_lng: a.p_lng, last_acc: a.p_acc, last_seen: now() });
      const lastP = o.pings.filter(p => p.deployment_id === d.id).pop();
      if (!lastP || Date.now() - new Date(lastP.at) > 25000) o.pings.push({ id: Date.now(), deployment_id: d.id, lat: a.p_lat, lng: a.p_lng, acc: a.p_acc, at: now() });
      lsave(o); return true;
    }
    if (fn === 'team_event') {
      const n = ((d.plan || {}).stops || []).length, k = a.p_kind;
      let t = a.p_at ? new Date(a.p_at) : new Date(); if (isNaN(t) || t > Date.now() + 300000 || t < Date.now() - 86400000) t = new Date();
      const at = t.toISOString(), pr = JSON.parse(JSON.stringify(d.progress || {})); pr.stops = pr.stops || {};
      if (!['arr', 'halt', 'dep', 'undo', 'complete'].includes(k)) throw new Error('Unknown action');
      if (k === 'undo') {
        if (pr.done) delete pr.done;
        else for (let i = n - 1; i >= 0; i--) { const ev = pr.stops[i]; if (ev && Object.keys(ev).length) { for (const kk of ['dep', 'halt', 'arr']) if (ev[kk]) { delete ev[kk]; break; } break; } }
      } else if (k === 'complete') pr.done = at;
      else {
        if (a.p_stop == null || a.p_stop < 0 || a.p_stop >= n) throw new Error('Unknown stop');
        const ev = pr.stops[a.p_stop] = pr.stops[a.p_stop] || {};
        if (!ev[k]) ev[k] = at; if ((k === 'halt' || k === 'dep') && !ev.arr) ev.arr = at;
      }
      d.progress = pr;
      d.status = pr.done ? 'Completed' : Object.values(pr.stops).some(e => Object.keys(e).length) ? 'In progress' : ['In progress', 'Completed'].includes(d.status) ? 'Assigned' : d.status;
      d.updated_at = now(); lsave(o); return lteamView(o, d);
    }
    throw new Error('Unknown function ' + fn);
  }

  /* ---------------- public API ---------------- */
  const ORDER = { staff: 'name', ambulances: 'reg_no', places: 'name', radius_layouts: 'name', routes: 'name', deployments: 'dep_date', pings: 'at', pop_grid: 'id', app_settings: 'key', app_admins: 'email' };
  async function list(t, q = {}) {
    if (!cloud) {
      let r = lload()[t];
      if (q.from) r = r.filter(x => x.dep_date >= q.from); if (q.to) r = r.filter(x => x.dep_date <= q.to);
      if (q.eq) Object.entries(q.eq).forEach(([k, v]) => { r = r.filter(x => x[k] === v); });
      if (q.ids) r = r.filter(x => q.ids.includes(x.id));
      const k = ORDER[t]; return r.slice().sort((a, b) => String(a[k]).localeCompare(String(b[k]), 'en', { numeric: true }));
    }
    const out = [], page = 1000;
    for (let off = 0; ; off += page) {
      let qq = sb.from(t).select(q.select || '*').order(ORDER[t]).range(off, off + page - 1);
      if (q.from) qq = qq.gte('dep_date', q.from); if (q.to) qq = qq.lte('dep_date', q.to);
      if (q.eq) Object.entries(q.eq).forEach(([k, v]) => { qq = qq.eq(k, v); });
      if (q.ids) qq = qq.in('id', q.ids);
      const rows = chk(await qq); out.push(...rows);
      if (rows.length < page || (q.limit && out.length >= q.limit)) break;
    }
    return out;
  }
  async function upsert(t, rows) {
    rows = (Array.isArray(rows) ? rows : [rows]).map(r => (r.id || ['pings', 'pop_grid', 'app_settings', 'app_admins'].includes(t)) ? r : { ...r, id: uuid() });
    if (!rows.length) return [];
    if (!cloud) return lupsert(t, rows);
    const out = [];
    for (let i = 0; i < rows.length; i += 500) out.push(...chk(await sb.from(t).upsert(rows.slice(i, i + 500), t === 'app_settings' ? { onConflict: 'key' } : t === 'app_admins' ? { onConflict: 'email' } : undefined).select()));
    return out;
  }
  async function insert(t, rows) {
    if (!rows.length) return 0;
    if (!cloud) { const o = lload(); rows.forEach((r, i) => o[t].push({ id: Date.now() + i, ...r })); lsave(o); return rows.length; }
    for (let i = 0; i < rows.length; i += 1000) chk(await sb.from(t).insert(rows.slice(i, i + 1000)));
    return rows.length;
  }
  async function update(t, id, patch) {
    if (!cloud) { const o = lload(), r = o[t].find(x => x.id === id); if (!r) throw new Error('Record not found'); Object.assign(r, patch, { updated_at: now() }); lsave(o); return r; }
    const rows = chk(await sb.from(t).update(patch).eq('id', id).select()); if (!rows.length) throw new Error('Record not found'); return rows[0];
  }
  async function remove(t, id) { if (!cloud) return lremove(t, id); chk(await sb.from(t).delete().eq('id', id)); }
  async function removeWhere(t, col, val) { if (!cloud) { const o = lload(); o[t] = o[t].filter(x => x[col] !== val); lsave(o); return; } chk(await sb.from(t).delete().eq(col, val)); }
  async function clear(t) { if (!cloud) { const o = lload(); o[t] = []; lsave(o); return; } chk(await sb.from(t).delete().gte('id', 0)); }
  async function rpc(fn, args) {
    if (!cloud) return lrpc(fn, args);
    return chk(await sb.rpc(fn, args));
  }
  const auth = {
    async session() { if (!cloud) return { user: { email: 'demo' } }; const r = await sb.auth.getSession(); return r.data && r.data.session; },
    async signIn(email, password) { const r = await sb.auth.signInWithPassword({ email, password }); if (r.error) throw new Error(/Invalid login/i.test(r.error.message) ? 'Wrong email or password.' : /Email not confirmed/i.test(r.error.message) ? 'This email is not confirmed yet. In Supabase → Authentication → Users, confirm the user (or create it with “Auto confirm”).' : friendly(r.error)); return r.data.session; },
    async signOut() { if (cloud) await sb.auth.signOut(); },
    async setPassword(pw) { const r = await sb.auth.updateUser({ password: pw }); if (r.error) throw new Error(friendly(r.error)); },
    onChange(cb) { if (cloud) sb.auth.onAuthStateChange((ev, s) => cb(ev, s)); }
  };
  W.DB = { cloud, sb, list, upsert, update, insert, remove, removeWhere, clear, rpc, auth, uuid, token, friendly };
})(window);
