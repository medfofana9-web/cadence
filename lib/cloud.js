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
  const { audioUrl, artUrlLocal, ...data } = t;
  const { error } = await c.from('tracks').upsert({ user_id: await uid(), id: t.id, data, deleted: false, updated_at: new Date().toISOString() });
  if (error) throw error;
  return true;
}
export async function deleteTrack(id) {
  const c = await sb(); if (!c || !(await user())) return;
  await c.from('tracks').upsert({ user_id: await uid(), id, data: {}, deleted: true, updated_at: new Date().toISOString() });
  await c.storage.from(BUCKET).remove([await full(`audio/${id}`), await full(`art/${id}`)]);
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

export async function uploadFile(path, blob) {
  const c = await sb(); if (!c || !(await user())) return false;
  const { error } = await c.storage.from(BUCKET).upload(await full(path), blob, { upsert: true, contentType: blob.type || 'application/octet-stream', cacheControl: '31536000' });
  if (error) throw error;
  return true;
}

const signed = new Map();
export async function fileUrl(path) {
  const hit = signed.get(path);
  if (hit && hit.exp > Date.now()) return hit.url;
  const c = await sb(); if (!c) return null;
  const { data, error } = await c.storage.from(BUCKET).createSignedUrl(await full(path), 60 * 60 * 12);
  if (error) return null;
  signed.set(path, { url: data.signedUrl, exp: Date.now() + 1000 * 60 * 60 * 11 });
  return data.signedUrl;
}
export async function fileUrls(paths) {
  const need = paths.filter(p => !(signed.get(p)?.exp > Date.now()));
  if (need.length) {
    const c = await sb(); if (!c) return;
    const prefix = (await uid()) + '/';
    const { data } = await c.storage.from(BUCKET).createSignedUrls(need.map(p => prefix + p), 60 * 60 * 12);
    for (const d of data || []) if (d.signedUrl) signed.set(d.path.slice(prefix.length), { url: d.signedUrl, exp: Date.now() + 1000 * 60 * 60 * 11 });
  }
}
export const cachedUrl = path => signed.get(path)?.url || null;
