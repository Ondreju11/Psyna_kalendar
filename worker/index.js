const ALLOWED_REMINDERS = new Set([15, 30, 60, 120, 1440, 2880, 10080]);
const ALLOWED_ORIGINS = new Set([
  'https://ondreju11.github.io',
  'https://akce.psynaffuk.cz',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
]);
const ID_PATTERN = /^[A-Za-z0-9]{7}$/u;
const CREATE_LIMIT_PER_DAY = 20;
const MAX_JSON_BYTES = 16 * 1024;
const SECURITY_HEADERS = {
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
};

const worker = {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.protocol !== 'https:') {
      url.protocol = 'https:';
      return redirect(url.toString(), 308);
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    const publicMatch = /^\/e\/([A-Za-z0-9]{7})$/u.exec(url.pathname);
    if (request.method === 'GET' && publicMatch) {
      return redirectToEvent(env, publicMatch[1]);
    }

    const canonicalPublicMatch = /^\/([A-Za-z0-9]{7})\/?$/u.exec(url.pathname);
    if (request.method === 'GET' && canonicalPublicMatch) {
      return redirectToEvent(env, canonicalPublicMatch[1]);
    }

    if (request.method === 'GET' && url.pathname === '/') {
      return redirect(env.SITE_URL);
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

async function redirectToEvent(env, id) {
  const row = await env.EVENTS.prepare('SELECT payload FROM events WHERE id = ?')
    .bind(id)
    .first();
  const destination = new URL(env.SITE_URL);

  if (!row) {
    destination.hash = 'invalid';
    return redirect(destination.toString());
  }

  try {
    const event = validateEvent(JSON.parse(row.payload));
    if (!event) throw new Error('Invalid stored event');
    destination.searchParams.set('source', id);
    destination.hash = `e=${encodeBase64Url(JSON.stringify(event))}`;
    return redirect(destination.toString());
  } catch {
    destination.hash = 'invalid';
    return redirect(destination.toString());
  }
}

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
     WHERE daily_creates.count < ?
     RETURNING count`,
  )
    .bind(day, CREATE_LIMIT_PER_DAY)
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
        publicUrl: publicEventUrl(env, id),
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
    publicUrl: publicEventUrl(env, id),
    updated: true,
  });
}

function publicEventUrl(env, id) {
  return `${env.PUBLIC_URL.replace(/\/$/u, '')}/${id}`;
}

function redirect(destination, status = 302) {
  return new Response(null, {
    status,
    headers: {
      Location: destination,
      'Cache-Control': 'no-store, private',
      'Referrer-Policy': 'no-referrer',
      ...SECURITY_HEADERS,
    },
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

  const declaredLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_BYTES) return null;
  if (!request.body) return null;

  const reader = request.body.getReader();
  const chunks = [];
  let totalLength = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalLength += value.byteLength;
      if (totalLength > MAX_JSON_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }

    const bytes = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(bytes));
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

function encodeBase64Url(value) {
  const bytes = new TextEncoder().encode(value);
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
    ...SECURITY_HEADERS,
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
    },
  });
}
