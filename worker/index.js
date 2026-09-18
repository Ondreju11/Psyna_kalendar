const ALLOWED_REMINDERS = new Set([
  15, 30, 60, 120, 1440, 2880, 4320, 7200, 10080,
]);
const REPEAT_FREQUENCIES = new Set(['daily', 'weekly', 'monthly', 'yearly']);
const ALLOWED_ORIGINS = new Set([
  'https://ondreju11.github.io',
  'https://akce.psynaffuk.cz',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
]);
const ID_PATTERN = /^[A-Za-z0-9]{7}$/u;
const CREATE_LIMIT_PER_DAY = 20;
const PLACE_SUGGEST_LIMIT_PER_DAY = 500;
const MAX_JSON_BYTES = 16 * 1024;
const MAX_MAPY_RESPONSE_BYTES = 128 * 1024;
const MAX_COLLECTION_EVENTS = 12;
const MAX_COLLECTION_TITLE_LENGTH = 180;
const TIME_ZONE = 'Europe/Prague';
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

    const collectionPublicMatch = /^\/s\/([A-Za-z0-9]{7})\/?$/u.exec(
      url.pathname,
    );
    if (request.method === 'GET' && collectionPublicMatch) {
      return redirectToCollection(env, collectionPublicMatch[1]);
    }

    if (request.method === 'GET' && url.pathname === '/') {
      return redirect(env.SITE_URL);
    }

    const eventIcsMatch = /^\/api\/events\/([A-Za-z0-9]{7})\.ics$/u.exec(
      url.pathname,
    );
    if (request.method === 'GET' && eventIcsMatch) {
      return getEventIcs(request, env, eventIcsMatch[1]);
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

    const collectionIcsMatch =
      /^\/api\/collections\/([A-Za-z0-9]{7})\.ics$/u.exec(url.pathname);
    if (request.method === 'GET' && collectionIcsMatch) {
      return getCollectionIcs(request, env, collectionIcsMatch[1], url);
    }

    const collectionApiMatch = /^\/api\/collections\/([A-Za-z0-9]{7})$/u.exec(
      url.pathname,
    );
    if (request.method === 'GET' && collectionApiMatch) {
      return getCollection(request, env, collectionApiMatch[1]);
    }

    if (request.method === 'POST' && url.pathname === '/api/collections') {
      return createCollection(request, env);
    }

    if (request.method === 'GET' && url.pathname === '/api/places') {
      return suggestPlaces(request, env, url);
    }

    return json(request, { error: 'Nenalezeno.' }, 404);
  },
};

export default worker;

async function redirectToEvent(env, id) {
  const row = await env.EVENTS.prepare(
    'SELECT payload FROM events WHERE id = ?',
  )
    .bind(id)
    .first();
  const destination = new URL(env.SITE_URL);

  if (!row) {
    destination.hash = 'invalid';
    return redirect(destination.toString());
  }

  try {
    const event = validateStoredEvent(JSON.parse(row.payload));
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
  if (!event)
    return json(request, { error: 'Údaje události nejsou platné.' }, 400);

  if (!(await reserveDailyCreate(env))) {
    return json(
      request,
      {
        error:
          'Dnešní limit nových odkazů byl vyčerpán. Zkuste to znovu zítra.',
      },
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

async function createCollection(request, env) {
  const body = await readJson(request);
  const collection = validateCollection(body);
  if (!collection) {
    return json(request, { error: 'Údaje kolekce nejsou platné.' }, 400);
  }

  const existingRows = await selectEventsByIds(env, collection.eventIds, 'id');
  const existingIds = new Set(existingRows.map((row) => String(row.id)));
  if (collection.eventIds.some((eventId) => !existingIds.has(eventId))) {
    return json(
      request,
      { error: 'Některá vybraná událost nebyla nalezena.' },
      400,
    );
  }

  if (!(await reserveDailyCreate(env))) {
    return json(
      request,
      {
        error:
          'Dnešní limit nových odkazů byl vyčerpán. Zkuste to znovu zítra.',
      },
      429,
    );
  }

  const timestamp = Date.now();
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const id = randomId();
    try {
      await env.EVENTS.prepare(
        `INSERT INTO collections (id, payload, created_at)
         VALUES (?, ?, ?)`,
      )
        .bind(id, JSON.stringify(collection), timestamp)
        .run();

      return json(request, {
        id,
        publicUrl: collectionPublicUrl(env, id),
      });
    } catch (error) {
      if (!String(error).toLowerCase().includes('unique')) throw error;
    }
  }

  return json(request, { error: 'Kolekci se nepodařilo vytvořit.' }, 500);
}

async function reserveDailyCreate(env) {
  const day = new Date().toISOString().slice(0, 10);
  const limit = await env.EVENTS.prepare(
    `INSERT INTO daily_creates (day, count) VALUES (?, 1)
     ON CONFLICT(day) DO UPDATE SET count = count + 1
     WHERE daily_creates.count < ?
     RETURNING count`,
  )
    .bind(day, CREATE_LIMIT_PER_DAY)
    .first();

  return Boolean(limit) && Number(limit.count) <= CREATE_LIMIT_PER_DAY;
}

async function reservePlaceSuggest(env) {
  const day = new Date().toISOString().slice(0, 10);
  const limit = await env.EVENTS.prepare(
    `INSERT INTO daily_place_suggests (day, count) VALUES (?, 1)
     ON CONFLICT(day) DO UPDATE SET count = count + 1
     WHERE daily_place_suggests.count < ?
     RETURNING count`,
  )
    .bind(day, PLACE_SUGGEST_LIMIT_PER_DAY)
    .first();

  return Boolean(limit) && Number(limit.count) <= PLACE_SUGGEST_LIMIT_PER_DAY;
}

async function updateEvent(request, env, id) {
  if (!ID_PATTERN.test(id))
    return json(request, { error: 'Neplatný odkaz.' }, 400);

  const body = await readJson(request);
  const event = validateEvent(body?.event);
  const editKey = typeof body?.editKey === 'string' ? body.editKey : '';
  if (!event || editKey.length < 32 || editKey.length > 100) {
    return json(request, { error: 'Údaje pro úpravu nejsou platné.' }, 400);
  }

  const row = await env.EVENTS.prepare(
    'SELECT edit_key_hash FROM events WHERE id = ?',
  )
    .bind(id)
    .first();
  if (!row) return json(request, { error: 'Událost nebyla nalezena.' }, 404);

  const candidateHash = await sha256(editKey);
  if (!timingSafeEqual(candidateHash, String(row.edit_key_hash))) {
    return json(
      request,
      { error: 'Tento odkaz nemáte oprávnění upravit.' },
      403,
    );
  }

  await env.EVENTS.prepare(
    'UPDATE events SET payload = ?, updated_at = ? WHERE id = ?',
  )
    .bind(JSON.stringify(event), Date.now(), id)
    .run();

  return json(request, {
    id,
    publicUrl: publicEventUrl(env, id),
    updated: true,
  });
}

async function getCollection(request, env, id) {
  if (!ID_PATTERN.test(id))
    return json(request, { error: 'Neplatný odkaz.' }, 400);

  const row = await env.EVENTS.prepare(
    'SELECT payload FROM collections WHERE id = ?',
  )
    .bind(id)
    .first();
  if (!row) return json(request, { error: 'Kolekce nebyla nalezena.' }, 404);

  let collection;
  try {
    collection = validateCollection(JSON.parse(row.payload));
  } catch {
    collection = null;
  }
  if (!collection)
    return json(request, { error: 'Kolekci se nepodařilo načíst.' }, 500);

  const events = await loadEventsByIds(env, collection.eventIds);
  if (!events)
    return json(request, { error: 'Kolekci se nepodařilo načíst.' }, 500);

  return json(request, { title: collection.title, events }, 200, {
    'Cache-Control': 'no-store',
  });
}

async function getEventIcs(request, env, id) {
  const row = await env.EVENTS.prepare(
    'SELECT payload FROM events WHERE id = ?',
  )
    .bind(id)
    .first();
  if (!row) return json(request, { error: 'Událost nebyla nalezena.' }, 404);

  let event;
  try {
    event = validateStoredEvent(JSON.parse(row.payload));
  } catch {
    event = null;
  }
  if (!event)
    return json(request, { error: 'Událost se nepodařilo načíst.' }, 500);

  return calendarResponse(
    request,
    buildCalendar([{ id, event }], event.title),
    `event-${id}.ics`,
  );
}

async function getCollectionIcs(request, env, id, url) {
  if (!ID_PATTERN.test(id))
    return json(request, { error: 'Neplatný odkaz.' }, 400);

  const row = await env.EVENTS.prepare(
    'SELECT payload FROM collections WHERE id = ?',
  )
    .bind(id)
    .first();
  if (!row) return json(request, { error: 'Kolekce nebyla nalezena.' }, 404);

  let collection;
  try {
    collection = validateCollection(JSON.parse(row.payload));
  } catch {
    collection = null;
  }
  if (!collection)
    return json(request, { error: 'Kolekci se nepodařilo načíst.' }, 500);

  const selectedIds = parseCollectionEventIds(
    url.searchParams.get('ids'),
    collection.eventIds,
  );
  if (!selectedIds) {
    return json(request, { error: 'Vybrané události nejsou platné.' }, 400);
  }

  const events = await loadEventsByIds(env, selectedIds);
  if (!events)
    return json(request, { error: 'Kolekci se nepodařilo načíst.' }, 500);

  return calendarResponse(
    request,
    buildCalendar(events, collection.title),
    `collection-${id}.ics`,
  );
}

async function suggestPlaces(request, env, url) {
  const query = url.searchParams.get('q')?.trim() ?? '';
  if (query.length < 3 || query.length > 80) {
    return json(request, { error: 'Dotaz musí mít 3 až 80 znaků.' }, 400);
  }

  if (typeof env.MAPY_API_KEY !== 'string' || !env.MAPY_API_KEY.trim()) {
    return json(request, { error: 'Našeptávání není nakonfigurované.' }, 503);
  }

  if (!(await reservePlaceSuggest(env))) {
    return json(
      request,
      { error: 'Dnešní limit našeptávání byl vyčerpán.' },
      429,
    );
  }

  const upstreamUrl = new URL('https://api.mapy.cz/v1/suggest');
  upstreamUrl.searchParams.set('query', query);
  upstreamUrl.searchParams.set('lang', 'cs');
  upstreamUrl.searchParams.set('limit', '5');
  upstreamUrl.searchParams.set('locality', 'cz');

  try {
    const response = await fetch(upstreamUrl, {
      headers: {
        Accept: 'application/json',
        'X-Mapy-Api-Key': env.MAPY_API_KEY,
      },
    });
    if (!response.ok) {
      return json(request, { error: 'Našeptávání není dostupné.' }, 502);
    }

    const responseText = await readLimitedText(
      response,
      MAX_MAPY_RESPONSE_BYTES,
    );
    if (responseText === null) {
      return json(request, { error: 'Našeptávání není dostupné.' }, 502);
    }

    let result;
    try {
      result = JSON.parse(responseText);
    } catch {
      return json(request, { error: 'Našeptávání není dostupné.' }, 502);
    }

    return json(
      request,
      { suggestions: normalizeMapySuggestions(result) },
      200,
      { 'Cache-Control': 'no-store' },
    );
  } catch {
    return json(request, { error: 'Našeptávání není dostupné.' }, 502);
  }
}

function redirectToCollection(env, id) {
  const destination = new URL(env.SITE_URL);
  destination.searchParams.set('collection', id);
  return redirect(destination.toString());
}

function publicEventUrl(env, id) {
  return `${env.PUBLIC_URL.replace(/\/$/u, '')}/${id}`;
}

function collectionPublicUrl(env, id) {
  return `${env.PUBLIC_URL.replace(/\/$/u, '')}/s/${id}`;
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
    value.timeZone !== TIME_ZONE ||
    typeof value.title !== 'string' ||
    typeof value.start !== 'string' ||
    typeof value.end !== 'string' ||
    typeof value.location !== 'string' ||
    typeof value.description !== 'string' ||
    typeof value.website !== 'string' ||
    typeof value.reminder !== 'number' ||
    !ALLOWED_REMINDERS.has(value.reminder)
  ) {
    return null;
  }

  const title = value.title.trim();
  const location = value.location.trim();
  const description = value.description.trim();
  const website = value.website.trim();
  const start = parseLocalDateTime(value.start);
  const end = parseLocalDateTime(value.end);
  if (
    !title ||
    title.length > 180 ||
    location.length > 300 ||
    description.length > 4000 ||
    website.length > 1000 ||
    !start ||
    !end ||
    !isSafeHttpUrl(website)
  ) {
    return null;
  }

  const startUtc = localDateTimeToUtc(value.start, start);
  const endUtc = localDateTimeToUtc(value.end, end);
  if (!startUtc || !endUtc || endUtc.getTime() <= startUtc.getTime())
    return null;

  let reminders;
  if (value.reminders !== undefined) {
    if (
      !Array.isArray(value.reminders) ||
      value.reminders.length < 1 ||
      value.reminders.length > 5 ||
      value.reminders[0] !== value.reminder ||
      new Set(value.reminders).size !== value.reminders.length ||
      !value.reminders.every((minutes) => ALLOWED_REMINDERS.has(minutes))
    ) {
      return null;
    }
    reminders = [...value.reminders];
  }

  let repeat;
  if (value.repeat !== undefined) {
    if (
      !value.repeat ||
      typeof value.repeat !== 'object' ||
      Array.isArray(value.repeat) ||
      !REPEAT_FREQUENCIES.has(value.repeat.frequency) ||
      typeof value.repeat.until !== 'string'
    ) {
      return null;
    }
    const until = parseIsoDate(value.repeat.until);
    const startDate = parseIsoDate(value.start.slice(0, 10));
    if (!until || !startDate) return null;
    const maximumUntil = startDate.value + 730 * 86_400_000;
    if (until.value < startDate.value || until.value > maximumUntil)
      return null;
    repeat = { frequency: value.repeat.frequency, until: value.repeat.until };
  }

  return {
    v: 1,
    title,
    start: value.start,
    end: value.end,
    location,
    description,
    website,
    reminder: value.reminder,
    ...(reminders ? { reminders } : {}),
    ...(repeat ? { repeat } : {}),
    timeZone: TIME_ZONE,
  };
}

function validateStoredEvent(value) {
  const current = validateEvent(value);
  if (current) return current;

  // The original API accepted DST-gap times. Keep those stored links readable,
  // but continue rejecting invalid local times on new creates and updates.
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    value.reminders !== undefined ||
    value.repeat !== undefined ||
    value.v !== 1 ||
    value.timeZone !== TIME_ZONE ||
    typeof value.title !== 'string' ||
    typeof value.start !== 'string' ||
    typeof value.end !== 'string' ||
    typeof value.location !== 'string' ||
    typeof value.description !== 'string' ||
    typeof value.website !== 'string' ||
    typeof value.reminder !== 'number' ||
    !ALLOWED_REMINDERS.has(value.reminder) ||
    !value.title.trim() ||
    value.title.length > 180 ||
    value.location.length > 300 ||
    value.description.length > 4000 ||
    value.website.length > 1000 ||
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
    timeZone: TIME_ZONE,
  };
}

function validateCollection(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (typeof value.title !== 'string' || !Array.isArray(value.eventIds))
    return null;

  const title = value.title.trim();
  if (!title || title.length > MAX_COLLECTION_TITLE_LENGTH) return null;
  if (
    value.eventIds.length < 2 ||
    value.eventIds.length > MAX_COLLECTION_EVENTS
  )
    return null;

  const eventIds = value.eventIds.map((eventId) =>
    typeof eventId === 'string' ? eventId : '',
  );
  if (
    eventIds.some((eventId) => !ID_PATTERN.test(eventId)) ||
    new Set(eventIds).size !== eventIds.length
  ) {
    return null;
  }

  return { title, eventIds };
}

function parseCollectionEventIds(value, collectionEventIds) {
  if (value === null) return [...collectionEventIds];
  if (!value) return null;

  const eventIds = value.split(',');
  if (
    eventIds.length < 1 ||
    eventIds.length > MAX_COLLECTION_EVENTS ||
    eventIds.some((eventId) => !ID_PATTERN.test(eventId)) ||
    new Set(eventIds).size !== eventIds.length
  ) {
    return null;
  }

  const collectionIds = new Set(collectionEventIds);
  if (eventIds.some((eventId) => !collectionIds.has(eventId))) return null;
  return eventIds;
}

async function selectEventsByIds(env, eventIds, columns = 'id, payload') {
  const placeholders = eventIds.map(() => '?').join(', ');
  const result = await env.EVENTS.prepare(
    `SELECT ${columns} FROM events WHERE id IN (${placeholders})`,
  )
    .bind(...eventIds)
    .all();
  return Array.isArray(result?.results) ? result.results : [];
}

async function loadEventsByIds(env, eventIds) {
  const rows = await selectEventsByIds(env, eventIds);
  const rowsById = new Map(rows.map((row) => [String(row.id), row]));
  const events = [];

  for (const id of eventIds) {
    const row = rowsById.get(id);
    if (!row || typeof row.payload !== 'string') return null;

    let event;
    try {
      event = validateStoredEvent(JSON.parse(row.payload));
    } catch {
      event = null;
    }
    if (!event) return null;
    events.push({ id, event });
  }

  return events;
}

function normalizeMapySuggestions(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.items))
    return [];

  const suggestions = [];
  const seen = new Set();
  for (const item of value.items) {
    if (!item || typeof item !== 'object') continue;
    const name = typeof item.name === 'string' ? item.name.trim() : '';
    const location =
      typeof item.location === 'string' ? item.location.trim() : '';
    const fallback = typeof item.label === 'string' ? item.label.trim() : '';
    const label = [name, location].filter(Boolean).join(', ') || fallback;
    if (!label || seen.has(label)) continue;
    seen.add(label);
    suggestions.push({ label });
    if (suggestions.length >= 5) break;
  }
  return suggestions;
}

function parseIsoDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const date = createUtcDate(year, month, day);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return { year, month, day, value: date.getTime() };
}

function parseLocalDateTime(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/u.exec(value);
  if (!match) return null;

  const date = parseIsoDate(`${match[1]}-${match[2]}-${match[3]}`);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  if (!date || hour > 23 || minute > 59) return null;
  return { ...date, hour, minute };
}

function createUtcDate(year, month, day, hour = 0, minute = 0, second = 0) {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  return date;
}

function localDateTimeToUtc(value, parsed = parseLocalDateTime(value)) {
  if (!parsed) return null;

  const desired = createUtcDate(
    parsed.year,
    parsed.month,
    parsed.day,
    parsed.hour,
    parsed.minute,
  ).getTime();
  let guess = desired;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const represented = localPartsAsUtc(guess);
    if (!represented) return null;
    const difference = desired - represented;
    guess += difference;
    if (difference === 0) break;
  }

  const result = new Date(guess);
  if (
    !Number.isFinite(result.getTime()) ||
    formatLocalDateTime(result) !== value
  )
    return null;
  return result;
}

function localPartsAsUtc(timestamp) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    calendar: 'gregory',
    numberingSystem: 'latn',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  if (
    !values.year ||
    !values.month ||
    !values.day ||
    !values.hour ||
    !values.minute
  )
    return null;

  return createUtcDate(
    Number(values.year),
    Number(values.month),
    Number(values.day),
    Number(values.hour),
    Number(values.minute),
  ).getTime();
}

function formatLocalDateTime(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    calendar: 'gregory',
    numberingSystem: 'latn',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  if (
    !values.year ||
    !values.month ||
    !values.day ||
    !values.hour ||
    !values.minute
  )
    return '';
  return `${values.year.padStart(4, '0')}-${values.month}-${values.day}T${values.hour}:${values.minute}`;
}

function calendarResponse(request, calendar, filename) {
  return new Response(calendar, {
    status: 200,
    headers: {
      ...corsHeaders(request),
      ...SECURITY_HEADERS,
      'Cache-Control': 'no-store',
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
}

function buildCalendar(events, calendarName) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Psyna Kalendar//Calendar//CS',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeIcsText(calendarName)}`,
    `X-WR-TIMEZONE:${TIME_ZONE}`,
    ...pragueTimeZoneLines(),
  ];

  for (const item of events)
    lines.push(...buildEventLines(item.id, item.event));
  lines.push('END:VCALENDAR');
  return foldIcsLines(lines);
}

function pragueTimeZoneLines() {
  return [
    'BEGIN:VTIMEZONE',
    `TZID:${TIME_ZONE}`,
    `X-LIC-LOCATION:${TIME_ZONE}`,
    'BEGIN:STANDARD',
    'TZNAME:CET',
    'TZOFFSETFROM:+0200',
    'TZOFFSETTO:+0100',
    'DTSTART:19701025T030000',
    'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
    'END:STANDARD',
    'BEGIN:DAYLIGHT',
    'TZNAME:CEST',
    'TZOFFSETFROM:+0100',
    'TZOFFSETTO:+0200',
    'DTSTART:19700329T020000',
    'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
    'END:DAYLIGHT',
    'END:VTIMEZONE',
  ];
}

function buildEventLines(id, event) {
  const lines = [
    'BEGIN:VEVENT',
    `UID:${id}@kalendar.psynaffuk.cz`,
    `DTSTAMP:${formatIcsUtc(new Date())}`,
    'SEQUENCE:0',
    `DTSTART;TZID=${TIME_ZONE}:${formatIcsLocal(event.start)}`,
    `DTEND;TZID=${TIME_ZONE}:${formatIcsLocal(event.end)}`,
    `SUMMARY:${escapeIcsText(event.title)}`,
  ];

  if (event.description)
    lines.push(`DESCRIPTION:${escapeIcsText(event.description)}`);
  if (event.location) lines.push(`LOCATION:${escapeIcsText(event.location)}`);
  if (event.website) lines.push(`URL:${escapeIcsText(event.website)}`);
  if (event.repeat) {
    const until = repeatUntilUtc(event);
    if (until)
      lines.push(
        `RRULE:FREQ=${event.repeat.frequency.toUpperCase()};UNTIL=${until}`,
      );
  }

  for (const reminder of event.reminders ?? [event.reminder]) {
    lines.push(
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      `DESCRIPTION:${escapeIcsText(event.title)}`,
      `TRIGGER:${formatIcsTrigger(reminder)}`,
      'END:VALARM',
    );
  }
  lines.push('END:VEVENT');
  return lines;
}

function repeatUntilUtc(event) {
  const lastMoment = localDateTimeToUtc(`${event.repeat.until}T23:59`);
  if (!lastMoment) return '';
  return formatIcsUtc(lastMoment);
}

function formatIcsTrigger(minutes) {
  if (minutes % 1440 === 0) return `-P${minutes / 1440}D`;
  if (minutes % 60 === 0) return `-PT${minutes / 60}H`;
  return `-PT${minutes}M`;
}

function formatIcsLocal(value) {
  return value.replaceAll('-', '').replace(':', '');
}

function formatIcsUtc(date) {
  return date
    .toISOString()
    .replace(/[-:]/gu, '')
    .replace(/\.\d{3}Z$/u, 'Z');
}

function escapeIcsText(value) {
  return String(value)
    .replaceAll('\\', '\\\\')
    .replaceAll(';', '\\;')
    .replaceAll(',', '\\,')
    .replace(/\r\n|\r|\n/gu, '\\n');
}

function foldIcsLines(lines) {
  const folded = [];
  for (const line of lines) {
    let chunk = '';
    let bytes = 0;
    for (const character of line) {
      const codePoint = character.codePointAt(0);
      const characterBytes =
        codePoint <= 0x7f
          ? 1
          : codePoint <= 0x7ff
            ? 2
            : codePoint <= 0xffff
              ? 3
              : 4;
      if (bytes + characterBytes > 75 && chunk) {
        folded.push(chunk);
        chunk = ' ';
        bytes = 1;
      }
      chunk += character;
      bytes += characterBytes;
    }
    folded.push(chunk);
  }
  return `${folded.join('\r\n')}\r\n`;
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
  if (!request.headers.get('content-type')?.includes('application/json'))
    return null;

  const declaredLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_BYTES)
    return null;
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

async function readLimitedText(response, maxBytes) {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) return null;
  if (!response.body) return '';

  const reader = response.body.getReader();
  const chunks = [];
  let totalLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalLength += value.byteLength;
      if (totalLength > maxBytes) {
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
    return new TextDecoder().decode(bytes);
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
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}

function encodeBase64Url(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}

async function sha256(value) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
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
  if (origin && ALLOWED_ORIGINS.has(origin))
    headers['Access-Control-Allow-Origin'] = origin;
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
