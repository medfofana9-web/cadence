// Cadence file storage on Cloudflare R2.
// - Uploads and deletes need the person's Cadence (Supabase) login; each person can only touch files under their own id.
// - Playback uses short-lived signed links, so the audio player can stream with seeking (range requests).
//
// Bindings (Worker → Settings → Bindings / Variables):
//   BUCKET          R2 bucket binding
//   SUPABASE_URL    https://<project>.supabase.co
//   SUPABASE_KEY    the publishable key
//   SIGNING_SECRET  any long random text (secret)
//   ALLOWED_ORIGIN  https://medfofana9-web.github.io

const enc = new TextEncoder();
const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function hmac(secret, data) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}

const users = new Map(); // token -> { id, exp } (per worker instance, short-lived)
async function userId(req, env) {
  const auth = req.headers.get('authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const hit = users.get(token);
  if (hit && hit.exp > Date.now()) return hit.id;
  const r = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, { headers: { apikey: env.SUPABASE_KEY, authorization: `Bearer ${token}` } });
  if (!r.ok) return null;
  const u = await r.json();
  if (!u?.id) return null;
  users.set(token, { id: u.id, exp: Date.now() + 5 * 60 * 1000 });
  if (users.size > 500) users.clear();
  return u.id;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const origin = req.headers.get('origin') || '';
    const allowed = !env.ALLOWED_ORIGIN || origin === env.ALLOWED_ORIGIN || /^http:\/\/localhost(:\d+)?$/.test(origin);
    const cors = {
      'access-control-allow-origin': allowed && origin ? origin : (env.ALLOWED_ORIGIN || '*'),
      'access-control-allow-headers': 'authorization,content-type,range',
      'access-control-allow-methods': 'GET,HEAD,PUT,DELETE,POST,OPTIONS',
      'access-control-expose-headers': 'content-length,content-range,accept-ranges,etag',
      'access-control-max-age': '86400',
      vary: 'origin',
    };
    const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...cors, 'content-type': 'application/json' } });
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });

    // POST /sign  { paths: ["<uid>/audio/<id>", ...] }  → { urls: { path: url } }
    if (url.pathname === '/sign' && req.method === 'POST') {
      const uid = await userId(req, env);
      if (!uid) return json({ error: 'sign in' }, 401);
      const { paths = [] } = await req.json().catch(() => ({}));
      const exp = Math.floor(Date.now() / 1000) + 12 * 3600;
      const urls = {};
      for (const p of paths.slice(0, 500)) {
        if (typeof p !== 'string' || !p.startsWith(uid + '/') || p.includes('..')) continue;
        urls[p] = `${url.origin}/f/${p.split('/').map(encodeURIComponent).join('/')}?exp=${exp}&sig=${await hmac(env.SIGNING_SECRET, p + '|' + exp)}`;
      }
      return json({ urls });
    }

    if (!url.pathname.startsWith('/f/')) return json({ ok: true, service: 'cadence-files' });
    const path = decodeURIComponent(url.pathname.slice(3));
    if (!path || path.includes('..')) return json({ error: 'bad path' }, 400);

    if (req.method === 'PUT' || req.method === 'DELETE') {
      const uid = await userId(req, env);
      if (!uid || !path.startsWith(uid + '/')) return json({ error: 'not allowed' }, 403);
      if (req.method === 'DELETE') { await env.BUCKET.delete(path); return json({ ok: true }); }
      const type = req.headers.get('content-type') || 'application/octet-stream';
      await env.BUCKET.put(path, req.body, { httpMetadata: { contentType: type, cacheControl: 'private, max-age=31536000, immutable' } });
      return json({ ok: true });
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      const exp = +url.searchParams.get('exp'), sig = url.searchParams.get('sig') || '';
      if (!exp || exp < Date.now() / 1000 || sig !== await hmac(env.SIGNING_SECRET, path + '|' + exp)) return json({ error: 'link expired' }, 403);
      const obj = await env.BUCKET.get(path, { range: req.headers, onlyIf: req.headers });
      if (!obj) return json({ error: 'not found' }, 404);
      const h = new Headers(cors);
      obj.writeHttpMetadata(h);
      h.set('etag', obj.httpEtag);
      h.set('accept-ranges', 'bytes');
      let status = 200;
      if (obj.range && ('offset' in obj.range || 'suffix' in obj.range)) {
        const start = 'suffix' in obj.range ? obj.size - obj.range.suffix : obj.range.offset;
        const len = 'suffix' in obj.range ? obj.range.suffix : (obj.range.length ?? (obj.size - start));
        h.set('content-range', `bytes ${start}-${start + len - 1}/${obj.size}`);
        h.set('content-length', String(len));
        status = 206;
      } else h.set('content-length', String(obj.size));
      return new Response(req.method === 'HEAD' || !('body' in obj) ? null : obj.body, { status, headers: h });
    }
    return json({ error: 'method' }, 405);
  },
};
