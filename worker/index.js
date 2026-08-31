const ALLOWED_REMINDERS = new Set([15, 30, 60, 120, 1440, 2880, 10080]);
const ALLOWED_ORIGINS = new Set([
  'https://ondreju11.github.io',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
]);
const ID_PATTERN = /^[A-Za-z0-9]{7}$/u;
const CREATE_LIMIT_PER_DAY = 250;

const worker = {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    const publicMatch = /^\/e\/([A-Za-z0-9]{7})$/u.exec(url.pathname);
    if (request.method === 'GET' && publicMatch) {
      const destination = new URL(env.SITE_URL);
      destination.searchParams.set('event', publicMatch[1]);
      return Response.redirect(destination.toString(), 302);
    }

    const apiMatch = /^\/api\/events\/([A-Za-z0-9]{7})$/u.exec(url.pathname);
    if (request.method === 'GET' && apiMatch) {
      return getEvent(request, env, apiMatch[1]);
    }

    if (request.method === 'POST' && url.pathname === '/api/events') {
      return createEvent(request, env);
    }

    if (request.method === 'PUT' && apiMatch) {
      return updateEvent(request, env, apiMatch[1]);
    }

    return json(request, { error: 'Nenalezeno.' }, 404);
  },
};

export default worker;

async function getEvent(request, env, id) {
  const row = await env.EVENTS.prepare(
    'SELECT payload, updated_at FROM events WHERE id = ?',
  )
    .bind(id)
    .first();

  if (!row) return json(request, { error: 'Událost nebyla nalezena.' }, 404);

  try {
    return json(
      request,
      { event: JSON.parse(row.payload), updatedAt: row.updated_at },
      200,
      { 'Cache-Control': 'no-store' },
    );
  } catch {
    return json(request, { error: 'Událost se nepodařilo načíst.' }, 500);
  }
}

async function createEvent(request, env) {
  const body = await readJson(request);
  const event = validateEvent(body?.event);
  if (!event) return json(request, { error: 'Údaje události nejsou platné.' }, 400);

  const day = new Date().toISOString().slice(0, 10);
  const limit = await env.EVENTS.prepare(
    `INSERT INTO daily_creates (day, count) VALUES (?, 1)
     ON CONFLICT(day) DO UPDATE SET count = count + 1
     RETURNING count`,
  )
    .bind(day)
    .first();

  if (!limit || Number(limit.count) > CREATE_LIMIT_PER_DAY) {
    return json(
      request,
      { error: 'Dnešní limit nových odkazů byl vyčerpán. Zkuste to znovu zítra.' },
      429,
    );
  }

  const editKey = randomToken(32);
  const editKeyHash = await sha256(editKey);
  const timestamp = Date.now();

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const id = randomId();
    try {
      await env.EVENTS.prepare(
        `INSERT INTO events (id, edit_key_hash, payload, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
        .bind(id, editKeyHash, JSON.stringify(event), timestamp, timestamp)
        .run();

      return json(request, {
        id,
        editKey,
        publicUrl: `${new URL(request.url).origin}/e/${id}`,
      });
    } catch (error) {
      if (!String(error).toLowerCase().includes('unique')) throw error;
    }
  }

  return json(request, { error: 'Odkaz se nepodařilo vytvořit.' }, 500);
}

async function updateEvent(request, env, id) {
  if (!ID_PATTERN.test(id)) return json(request, { error: 'Neplatný odkaz.' }, 400);

  const body = await readJson(request);
  const event = validateEvent(body?.event);
  const editKey = typeof body?.editKey === 'string' ? body.editKey : '';
  if (!event || editKey.length < 32 || editKey.length > 100) {
    return json(request, { error: 'Údaje pro úpravu nejsou platné.' }, 400);
  }

  const row = await env.EVENTS.prepare('SELECT edit_key_hash FROM events WHERE id = ?')
    .bind(id)
    .first();
  if (!row) return json(request, { error: 'Událost nebyla nalezena.' }, 404);

  const candidateHash = await sha256(editKey);
  if (!timingSafeEqual(candidateHash, String(row.edit_key_hash))) {
    return json(request, { error: 'Tento odkaz nemáte oprávnění upravit.' }, 403);
  }

  await env.EVENTS.prepare('UPDATE events SET payload = ?, updated_at = ? WHERE id = ?')
    .bind(JSON.stringify(event), Date.now(), id)
    .run();

  return json(request, {
    id,
    publicUrl: `${new URL(request.url).origin}/e/${id}`,
    updated: true,
  });
}

function validateEvent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (
    value.v !== 1 ||
    value.timeZone !== 'Europe/Prague' ||
    typeof value.title !== 'string' ||
    typeof value.start !== 'string' ||
    typeof value.end !== 'string' ||
    typeof value.location !== 'string' ||
    typeof value.description !== 'string' ||
    typeof value.website !== 'string' ||
    typeof value.reminder !== 'number' ||
    !value.title.trim() ||
    value.title.length > 180 ||
    value.location.length > 300 ||
    value.description.length > 4000 ||
    value.website.length > 1000 ||
    !ALLOWED_REMINDERS.has(value.reminder) ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u.test(value.start) ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u.test(value.end) ||
    value.end <= value.start ||
    !isSafeHttpUrl(value.website)
  ) {
    return null;
  }

  return {
    v: 1,
    title: value.title.trim(),
    start: value.start,
    end: value.end,
    location: value.location.trim(),
    description: value.description.trim(),
    website: value.website.trim(),
    reminder: value.reminder,
    timeZone: 'Europe/Prague',
  };
}

function isSafeHttpUrl(value) {
  if (!value) return true;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

async function readJson(request) {
  if (!request.headers.get('content-type')?.includes('application/json')) return null;
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function randomId() {
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const bytes = crypto.getRandomValues(new Uint8Array(7));
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('');
}

function randomToken(byteLength) {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

async function sha256(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqual(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function corsHeaders(request) {
  const origin = request.headers.get('origin');
  const headers = {
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    Vary: 'Origin',
  };
  if (origin && ALLOWED_ORIGINS.has(origin)) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

function json(request, body, status = 200, extraHeaders = {}) {
  return Response.json(body, {
    status,
    headers: {
      ...corsHeaders(request),
      ...extraHeaders,
      'Content-Type': 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
