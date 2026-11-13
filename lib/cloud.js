// Cloud library (Supabase): your songs live online so every device you sign in on can play them.
import { CONFIG } from '../config.js';

let client = null, loading = null;
const BUCKET = 'music';

export const cloudConfigured = () => !!(CONFIG.supabaseUrl && CONFIG.supabaseAnonKey);

export async function sb() {
  if (!cloudConfigured()) return null;
  if (client) return client;
  if (!loading) loading = import('https://esm.sh/@supabase/supabase-js@2.49.4').then(m => {
    client = m.createClient(CONFIG.supabaseUrl, CONFIG.supabaseAnonKey, { auth: { persistSession: true, autoRefreshToken: true } });
    return client;
  });
  return loading;
}

export async function user() {
  const c = await sb(); if (!c) return null;
  const { data } = await c.auth.getSession();
  return data.session?.user || null;
}

export async function signIn(email, password) {
  const c = await sb();
  const { error } = await c.auth.signInWithPassword({ email, password });
  if (error) throw error;
}
export async function signUp(email, password) {
  const c = await sb();
  const { data, error } = await c.auth.signUp({ email, password });
  if (error) throw error;
  return !!data.session;
}
export async function signOut() { const c = await sb(); await c?.auth.signOut(); uidCache = null; signed.clear(); }
export async function changePassword(password) { const c = await sb(); const { error } = await c.auth.updateUser({ password }); if (error) throw error; }

/** Listening history, settings and play log, one row per person. */
export async function pullState() {
  const c = await sb(); if (!c || !(await user())) return null;
  const { data, error } = await c.from('user_state').select('data,updated_at').maybeSingle();
  if (error) throw error;
  return data;
}
export async function pushState(data) {
  const c = await sb(); if (!c || !(await user())) return;
  const { error } = await c.from('user_state').upsert({ user_id: await uid(), data, updated_at: new Date().toISOString() });
  if (error) throw error;
}
/** Removes everything this person has stored online: songs, artwork, playlists, history. */
export async function deleteEverything() {
  const c = await sb(); if (!c || !(await user())) return;
  const me = await uid();
  for (const folder of ['audio', 'art']) {
    for (;;) {
      const { data } = await c.storage.from(BUCKET).list(`${me}/${folder}`, { limit: 100 });
      if (!data?.length) break;
      await c.storage.from(BUCKET).remove(data.map(f => `${me}/${folder}/${f.name}`));
    }
  }
  await c.from('tracks').delete().eq('user_id', me);
  await c.from('playlists').delete().eq('user_id', me);
  await c.from('user_state').delete().eq('user_id', me);
}

export async function pullTracks() {
  const c = await sb(); if (!c || !(await user())) return null;
  const { data, error } = await c.from('tracks').select('id,data,deleted,updated_at');
  if (error) throw error;
  return data;
}
export async function pullPlaylists() {
  const c = await sb(); if (!c || !(await user())) return null;
  const { data, error } = await c.from('playlists').select('id,data,deleted');
  if (error) throw error;
  return data;
}

export async function saveTrack(t) {
  const c = await sb(); if (!c || !(await user())) return false;
  const { audioUrl, artUrlLocal, local, downloaded, ...data } = t;
  const { error } = await c.from('tracks').upsert({ user_id: await uid(), id: t.id, data, deleted: false, updated_at: new Date().toISOString() });
  if (error) throw error;
  return true;
}
export async function deleteTrack(id) {
  const c = await sb(); if (!c || !(await user())) return;
  await c.from('tracks').upsert({ user_id: await uid(), id, data: {}, deleted: true, updated_at: new Date().toISOString() });
  await c.storage.from(BUCKET).remove([await full(`audio/${id}`), await full(`art/${id}`)]);
  if (r2On()) await r2Delete([`audio/${id}`, `art/${id}`]);
}
export async function savePlaylist(p) {
  const c = await sb(); if (!c || !(await user())) return;
  await c.from('playlists').upsert({ user_id: await uid(), id: p.id, data: p, deleted: false, updated_at: new Date().toISOString() });
}
export async function deletePlaylist(id) {
  const c = await sb(); if (!c || !(await user())) return;
  await c.from('playlists').upsert({ user_id: await uid(), id, data: {}, deleted: true, updated_at: new Date().toISOString() });
}

let uidCache = null;
async function uid() { if (uidCache) return uidCache; const u = await user(); uidCache = u?.id || null; return uidCache; }
const full = async path => `${await uid()}/${path}`;

/* ---- Cloudflare R2 (when CONFIG.filesUrl is set): bigger free storage and free streaming ---- */
export const r2On = () => !!CONFIG.filesUrl;
async function token() { const c = await sb(); const { data } = await c.auth.getSession(); return data.session?.access_token; }
const PART = 50 * 1024 * 1024;
async function r2Put(path, blob) {
  if (blob.size > 90 * 1024 * 1024) return r2PutParts(path, blob);
  const r = await fetch(`${CONFIG.filesUrl}/f/${await uid()}/${path}`, { method: 'PUT', headers: { authorization: `Bearer ${await token()}`, 'content-type': blob.type || 'application/octet-stream' }, body: blob });
  if (!r.ok) throw new Error('upload ' + r.status);
  return true;
}
async function r2PutParts(path, blob) {
  const base = `${CONFIG.filesUrl}/f/${await uid()}/${path}`;
  const auth = async () => ({ authorization: `Bearer ${await token()}` });
  const c = await fetch(`${base}?mp=create`, { method: 'POST', headers: { ...(await auth()), 'content-type': blob.type || 'application/octet-stream' } });
  if (!c.ok) throw new Error('upload ' + c.status);
  const { uploadId } = await c.json();
  const id = encodeURIComponent(uploadId), parts = [];
  try {
    for (let i = 0, n = 1; i < blob.size; i += PART, n++) {
      let r;
      for (let tries = 0; tries < 3; tries++) {
        r = await fetch(`${base}?mp=${id}&part=${n}`, { method: 'PUT', headers: await auth(), body: blob.slice(i, i + PART) }).catch(() => null);
        if (r?.ok) break;
      }
      if (!r?.ok) throw new Error('upload part ' + n);
      parts.push(await r.json());
    }
    const d = await fetch(`${base}?mp=${id}&done=1`, { method: 'POST', headers: { ...(await auth()), 'content-type': 'application/json' }, body: JSON.stringify({ parts }) });
    if (!d.ok) throw new Error('upload ' + d.status);
    return true;
  } catch (e) {
    fetch(`${base}?mp=${id}`, { method: 'DELETE', headers: await auth() }).catch(() => {});
    throw e;
  }
}
async function r2Delete(paths) {
  const t = await token(), me = await uid();
  await Promise.all(paths.map(p => fetch(`${CONFIG.filesUrl}/f/${me}/${p}`, { method: 'DELETE', headers: { authorization: `Bearer ${t}` } }).catch(() => {})));
}
export let lastFileError = '';
async function r2Sign(paths) {
  const me = await uid(); if (!me) { lastFileError = 'not signed in'; return; }
  const send = async () => fetch(`${CONFIG.filesUrl || 'https://cadence-files.medfofana9.workers.dev'}/sign`, { method: 'POST', headers: { authorization: `Bearer ${await token()}`, 'content-type': 'application/json' }, body: JSON.stringify({ paths: paths.map(p => `${me}/${p}`) }) });
  let r;
  try {
    r = await send();
    // an expired sign-in (common after the phone has been asleep) gets refreshed once
    if (r.status === 401) { const c = await sb(); await c.auth.refreshSession().catch(() => {}); r = await send(); }
  } catch (e) { lastFileError = 'network: ' + (e.message || e); return; }
  if (!r.ok) { lastFileError = 'storage ' + r.status; return; }
  const { urls } = await r.json();
  for (const [full, u] of Object.entries(urls || {})) signed.set('r2:' + full.slice(me.length + 1), { url: u, exp: Date.now() + 1000 * 60 * 60 * 11 });
  lastFileError = '';
}
/** Old Supabase copies, removed after a song has moved to R2. */
export async function removeSupabaseFiles(paths) {
  const c = await sb(); if (!c) return;
  const me = await uid();
  for (let i = 0; i < paths.length; i += 100) await c.storage.from(BUCKET).remove(paths.slice(i, i + 100).map(p => `${me}/${p}`));
}
export async function supabaseBlob(path) {
  const c = await sb(); const { data } = await c.storage.from(BUCKET).createSignedUrl(await full(path), 600);
  if (!data?.signedUrl) return null;
  const r = await fetch(data.signedUrl); return r.ok ? await r.blob() : null;
}

/** Uploads to R2 when it's set up (returns 'r2'), otherwise to Supabase storage (returns 'sb'). */
export async function uploadFile(path, blob) {
  const c = await sb(); if (!c || !(await user())) return false;
  if (r2On()) { await r2Put(path, blob); return 'r2'; }
  const { error } = await c.storage.from(BUCKET).upload(await full(path), blob, { upsert: true, contentType: blob.type || 'application/octet-stream', cacheControl: '31536000' });
  if (error) throw error;
  return 'sb';
}

const signed = new Map();
export async function fileUrl(path, r2) {
  if (r2) { const k = 'r2:' + path; if (!(signed.get(k)?.exp > Date.now())) await r2Sign([path]); return signed.get(k)?.url || null; }
  const hit = signed.get(path);
  if (hit && hit.exp > Date.now()) return hit.url;
  const c = await sb(); if (!c) return null;
  const { data, error } = await c.storage.from(BUCKET).createSignedUrl(await full(path), 60 * 60 * 12);
  // files moved to R2 may still be marked as Supabase on a device that hasn't caught up
  if (error) return fileUrl(path, true);
  signed.set(path, { url: data.signedUrl, exp: Date.now() + 1000 * 60 * 60 * 11 });
  return data.signedUrl;
}
export async function fileUrls(paths, r2) {
  if (r2) { const need = paths.filter(p => !(signed.get('r2:' + p)?.exp > Date.now())); for (let i = 0; i < need.length; i += 400) await r2Sign(need.slice(i, i + 400)); return; }
  const need = paths.filter(p => !(signed.get(p)?.exp > Date.now()));
  if (need.length) {
    const c = await sb(); if (!c) return;
    const prefix = (await uid()) + '/';
    const { data } = await c.storage.from(BUCKET).createSignedUrls(need.map(p => prefix + p), 60 * 60 * 12);
    for (const d of data || []) if (d.signedUrl) signed.set(d.path.slice(prefix.length), { url: d.signedUrl, exp: Date.now() + 1000 * 60 * 60 * 11 });
  }
}
export const cachedUrl = (path, r2) => signed.get((r2 ? 'r2:' : '') + path)?.url || null;
