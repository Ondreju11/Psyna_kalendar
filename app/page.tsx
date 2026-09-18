'use client';

import {
  Bell,
  CalendarDays,
  Check,
  Clock3,
  Copy,
  Download,
  ExternalLink,
  Link2,
  MapPin,
  Plus,
  Repeat2,
  Trash2,
} from 'lucide-react';
import { strFromU8, strToU8, unzlibSync, zlibSync } from 'fflate';
import Image from 'next/image';
import {
  type SyntheticEvent,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';

const TIME_ZONE = 'Europe/Prague';
const PUBLIC_EVENT_BASE =
  process.env.NEXT_PUBLIC_PUBLIC_EVENT_BASE ?? 'https://kalendar.psynaffuk.cz';
const EVENTS_API = PUBLIC_EVENT_BASE;
const REMINDER_OPTIONS = [15, 30, 60, 120, 1440, 2880, 4320, 7200, 10080];
const ALLOWED_REMINDERS = new Set(REMINDER_OPTIONS);
const REPEAT_FREQUENCIES = ['daily', 'weekly', 'monthly', 'yearly'] as const;

type RepeatFrequency = (typeof REPEAT_FREQUENCIES)[number];
type RepeatRule = { frequency: RepeatFrequency; until: string };

type EventData = {
  v: 1;
  title: string;
  start: string;
  end: string;
  location: string;
  description: string;
  website: string;
  reminder: number;
  reminders?: number[];
  repeat?: RepeatRule;
  timeZone: typeof TIME_ZONE;
};

type FormData = Omit<
  EventData,
  'v' | 'timeZone' | 'reminder' | 'reminders' | 'repeat'
> & {
  reminders: number[];
  repeatFrequency: '' | RepeatFrequency;
  repeatUntil: string;
};

type GeneratedLink = {
  value: string;
  manageUrl?: string;
  fallback?: boolean;
};

type ManagedEvent = {
  id: string;
  editKey: string;
};

type DraftEvent = {
  id: string;
  event: EventData;
  publicUrl: string;
  manageUrl: string;
};

type SharedCollection = {
  id: string;
  title: string;
  events: { id: string; event: EventData }[];
};

type CompactEvent = [
  string,
  string,
  string,
  string,
  string,
  string,
  number,
  number[]?,
  RepeatRule?,
];

const emptyForm: FormData = {
  title: '',
  start: '',
  end: '',
  location: '',
  description: '',
  website: '',
  reminders: [1440],
  repeatFrequency: '',
  repeatUntil: '',
};

const fieldClass =
  'mt-2 h-11 rounded-xl border-stone-200 bg-white px-3 shadow-none focus-visible:border-[#38634f] focus-visible:ring-[#38634f]/15';

function subscribeToUserAgent() {
  return () => {};
}

function isMessengerOnIos() {
  const userAgent = navigator.userAgent;
  const isIos = /iPad|iPhone|iPod/iu.test(userAgent);
  const isMessenger = /FBAN|FBAV|FB_IAB|MessengerForiOS/iu.test(userAgent);
  return isIos && isMessenger;
}

function encodeEvent(event: EventData) {
  const compact: CompactEvent = [
    event.title,
    event.start,
    event.end,
    event.location,
    event.description,
    event.website,
    event.reminder,
  ];
  if (event.reminders) compact.push(event.reminders);
  if (event.repeat) {
    if (!event.reminders) compact.push([event.reminder]);
    compact.push(event.repeat);
  }
  const bytes = zlibSync(strToU8(JSON.stringify(compact)), { level: 9 });
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}

function decodeBase64Url(value: string) {
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/');
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(base64 + padding);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function isSafeHttpUrl(value: string) {
  if (!value) return true;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function decodeEvent(value: string, compressed = false): EventData | null {
  try {
    const bytes = decodeBase64Url(value);
    const json = compressed
      ? strFromU8(unzlibSync(bytes))
      : new TextDecoder().decode(bytes);
    const decoded = JSON.parse(json) as Partial<EventData> | unknown[];
    const parsed: Partial<EventData> = Array.isArray(decoded)
      ? {
          v: 1,
          title: decoded[0] as string,
          start: decoded[1] as string,
          end: decoded[2] as string,
          location: decoded[3] as string,
          description: decoded[4] as string,
          website: decoded[5] as string,
          reminder: decoded[6] as number,
          reminders: decoded[7] as number[] | undefined,
          repeat: decoded[8] as RepeatRule | undefined,
          timeZone: TIME_ZONE,
        }
      : decoded;

    if (
      parsed.v !== 1 ||
      typeof parsed.title !== 'string' ||
      typeof parsed.start !== 'string' ||
      typeof parsed.end !== 'string' ||
      typeof parsed.location !== 'string' ||
      typeof parsed.description !== 'string' ||
      typeof parsed.website !== 'string' ||
      typeof parsed.reminder !== 'number' ||
      parsed.timeZone !== TIME_ZONE ||
      !parsed.title.trim() ||
      !ALLOWED_REMINDERS.has(parsed.reminder) ||
      (parsed.reminders !== undefined &&
        (!Array.isArray(parsed.reminders) ||
          parsed.reminders.length < 1 ||
          parsed.reminders.length > 5 ||
          parsed.reminders[0] !== parsed.reminder ||
          new Set(parsed.reminders).size !== parsed.reminders.length ||
          !parsed.reminders.every((minutes) =>
            ALLOWED_REMINDERS.has(minutes),
          ))) ||
      !isSafeHttpUrl(parsed.website) ||
      parsed.title.length > 180 ||
      parsed.description.length > 4000 ||
      parsed.location.length > 300 ||
      parsed.website.length > 1000
    ) {
      return null;
    }

    const start = zonedLocalToUtc(parsed.start, parsed.timeZone);
    const end = zonedLocalToUtc(parsed.end, parsed.timeZone);
    const legacyBasicEvent =
      parsed.repeat === undefined && parsed.reminders === undefined;
    if (
      !Number.isFinite(start.getTime()) ||
      !Number.isFinite(end.getTime()) ||
      (!legacyBasicEvent &&
        (!isValidZonedLocalDateTime(parsed.start, start) ||
          !isValidZonedLocalDateTime(parsed.end, end))) ||
      end <= start
    ) {
      return null;
    }

    if (parsed.repeat !== undefined) {
      if (
        !parsed.repeat ||
        !REPEAT_FREQUENCIES.includes(parsed.repeat.frequency) ||
        !/^\d{4}-\d{2}-\d{2}$/u.test(parsed.repeat.until) ||
        parsed.repeat.until < parsed.start.slice(0, 10)
      )
        return null;
      const until = new Date(`${parsed.repeat.until}T00:00:00Z`);
      const firstDay = new Date(`${parsed.start.slice(0, 10)}T00:00:00Z`);
      if (
        !Number.isFinite(until.getTime()) ||
        until.toISOString().slice(0, 10) !== parsed.repeat.until ||
        until.getTime() - firstDay.getTime() > 730 * 86_400_000
      )
        return null;
    }

    return parsed as EventData;
  } catch {
    return null;
  }
}

function zonedLocalToUtc(value: string, timeZone = TIME_ZONE) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/u.exec(value);
  if (!match) return new Date(Number.NaN);

  const desired = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
  );
  let guess = desired;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(guess));
    const values = Object.fromEntries(
      parts.map((part) => [part.type, part.value]),
    );
    const represented = Date.UTC(
      Number(values.year),
      Number(values.month) - 1,
      Number(values.day),
      Number(values.hour),
      Number(values.minute),
    );
    guess += desired - represented;
  }

  return new Date(guess);
}

function isValidZonedLocalDateTime(value: string, date: Date) {
  if (!Number.isFinite(date.getTime())) return false;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const fields = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  return (
    value ===
    `${fields.year}-${fields.month}-${fields.day}T${fields.hour}:${fields.minute}`
  );
}

function toCalendarTimestamp(date: Date) {
  return date
    .toISOString()
    .replaceAll('-', '')
    .replaceAll(':', '')
    .replace(/\.\d{3}Z$/u, 'Z');
}

function simpleHash(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function calendarIcsUrl(event: EventData, sourceId: string | null) {
  if (sourceId) return `${EVENTS_API}/api/events/${sourceId}.ics`;
  if (event.repeat || (event.reminders?.length ?? 1) > 1) return null;
  const start = zonedLocalToUtc(event.start, event.timeZone);
  const end = zonedLocalToUtc(event.end, event.timeZone);
  const parameters = new URLSearchParams({
    title: event.title,
    start: start.toISOString(),
    end: end.toISOString(),
    reminder: String(event.reminder),
    uid: `${simpleHash(JSON.stringify(event))}@kalendar-akci`,
  });
  if (event.description) parameters.set('description', event.description);
  if (event.location) parameters.set('location', event.location);
  if (event.website) parameters.set('url', event.website);
  return `https://api.getcal.link/event.ics?${parameters.toString()}`;
}

function calendarLinks(event: EventData) {
  const start = zonedLocalToUtc(event.start, event.timeZone);
  const end = zonedLocalToUtc(event.end, event.timeZone);
  const details = [event.description, event.website]
    .filter(Boolean)
    .join('\n\n');
  const google = new URL('https://calendar.google.com/calendar/render');
  google.search = new URLSearchParams({
    action: 'TEMPLATE',
    text: event.title,
    dates: `${toCalendarTimestamp(start)}/${toCalendarTimestamp(end)}`,
    details,
    location: event.location,
    ctz: event.timeZone,
  }).toString();

  const outlook = new URL(
    'https://outlook.live.com/calendar/0/deeplink/compose',
  );
  outlook.search = new URLSearchParams({
    path: '/calendar/action/compose',
    rru: 'addevent',
    subject: event.title,
    startdt: start.toISOString(),
    enddt: end.toISOString(),
    body: details,
    location: event.location,
  }).toString();

  return { google: google.toString(), outlook: outlook.toString() };
}

function formatEventDate(event: EventData) {
  const start = zonedLocalToUtc(event.start, event.timeZone);
  const end = zonedLocalToUtc(event.end, event.timeZone);
  const date = new Intl.DateTimeFormat('cs-CZ', {
    timeZone: event.timeZone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(start);
  const time = new Intl.DateTimeFormat('cs-CZ', {
    timeZone: event.timeZone,
    hour: '2-digit',
    minute: '2-digit',
  });
  if (datePart(event.start) !== datePart(event.end)) {
    return `${date}, ${time.format(start)} – ${new Intl.DateTimeFormat(
      'cs-CZ',
      {
        timeZone: event.timeZone,
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      },
    ).format(end)}, ${time.format(end)}`;
  }
  return `${date}, ${time.format(start)}–${time.format(end)}`;
}

function reminderLabel(minutes: number) {
  if (minutes === 15) return '15 minut předem';
  if (minutes === 30) return '30 minut předem';
  if (minutes === 60) return '1 hodinu předem';
  if (minutes === 120) return '2 hodiny předem';
  if (minutes === 1440) return '24 hodin předem';
  if (minutes === 2880) return '2 dny předem';
  if (minutes === 4320) return '3 dny předem';
  if (minutes === 7200) return '5 dní předem';
  if (minutes === 10080) return '7 dní předem';
  return `${minutes} minut předem`;
}

function repeatLabel(repeat: RepeatRule) {
  const frequency = {
    daily: 'Každý den',
    weekly: 'Každý týden',
    monthly: 'Každý měsíc',
    yearly: 'Každý rok',
  }[repeat.frequency];
  return `${frequency} do ${new Intl.DateTimeFormat('cs-CZ').format(new Date(`${repeat.until}T12:00:00Z`))}`;
}

function datePart(value: string) {
  return value.split('T')[0] ?? '';
}

function timePart(value: string) {
  return value.split('T')[1] ?? '';
}

function addMinutesToLocalDateTime(value: string, minutes: number) {
  const timestamp = Date.parse(`${value}:00Z`);
  if (!Number.isFinite(timestamp)) return '';
  return new Date(timestamp + minutes * 60_000).toISOString().slice(0, 16);
}

function maxRepeatDate(value: string) {
  const timestamp = Date.parse(`${datePart(value)}T00:00:00Z`);
  if (!Number.isFinite(timestamp)) return undefined;
  return new Date(timestamp + 730 * 86_400_000).toISOString().slice(0, 10);
}

function AppHeader({ compact = false }: { compact?: boolean }) {
  return (
    <header className={compact ? 'mb-8' : 'mb-8 flex items-center gap-3'}>
      <div className="flex items-center gap-3">
        <span className="grid size-10 place-items-center rounded-xl bg-[#38634f] text-white">
          <CalendarDays aria-hidden="true" className="size-5" />
        </span>
        <div>
          <p className="text-sm font-medium text-[#38634f]">Kalendář akcí</p>
          {!compact && (
            <div>
              <h1 className="text-xl font-semibold tracking-tight text-stone-950">
                Vytvořit pozvánku do kalendáře
              </h1>
              <p className="mt-0.5 text-xs text-stone-500">
                Sdílejte jednu akci nebo celý přehled.
              </p>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

function EventView({
  event,
  sourceId,
}: {
  event: EventData;
  sourceId: string | null;
}) {
  const links = useMemo(() => calendarLinks(event), [event]);
  const icsUrl = useMemo(
    () => calendarIcsUrl(event, sourceId),
    [event, sourceId],
  );
  const advancedEvent = Boolean(
    event.repeat || (event.reminders?.length ?? 1) > 1,
  );
  const messengerOnIos = useSyncExternalStore(
    subscribeToUserAgent,
    isMessengerOnIos,
    () => false,
  );
  const [copyNotice, setCopyNotice] = useState('');

  async function copyInvitationLink() {
    try {
      const invitationUrl =
        sourceId && /^[A-Za-z0-9]{7}$/u.test(sourceId)
          ? `${PUBLIC_EVENT_BASE}/${sourceId}`
          : window.location.href;
      await navigator.clipboard.writeText(invitationUrl);
      setCopyNotice('Odkaz je zkopírovaný. Teď ho vložte do Safari.');
    } catch {
      setCopyNotice('Klepněte na ••• a zvolte Otevřít v externím prohlížeči.');
    }
  }

  return (
    <main className="min-h-screen px-4 py-8 sm:px-6 sm:py-12">
      <div className="mx-auto max-w-2xl">
        <AppHeader compact />
        <article className="overflow-hidden rounded-3xl border border-stone-200 bg-white shadow-[0_20px_60px_rgba(40,36,29,0.06)]">
          <div className="border-b border-stone-100 px-5 py-7 sm:px-8 sm:py-9">
            <p className="mb-3 text-xs font-semibold uppercase tracking-[0.12em] text-[#38634f]">
              Pozvánka do kalendáře
            </p>
            <h1 className="text-3xl font-semibold tracking-tight text-stone-950 sm:text-4xl">
              {event.title}
            </h1>
            <div className="mt-6 space-y-3 text-sm text-stone-600">
              <p className="flex items-start gap-3">
                <Clock3
                  aria-hidden="true"
                  className="mt-0.5 size-4 shrink-0 text-[#38634f]"
                />
                <span className="first-letter:uppercase">
                  {formatEventDate(event)}
                </span>
              </p>
              {event.location && (
                <p className="flex items-start gap-3">
                  <MapPin
                    aria-hidden="true"
                    className="mt-0.5 size-4 shrink-0 text-[#38634f]"
                  />
                  <span>{event.location}</span>
                </p>
              )}
              <p className="flex items-start gap-3">
                <Bell
                  aria-hidden="true"
                  className="mt-0.5 size-4 shrink-0 text-[#38634f]"
                />
                <span>
                  Upozornění{' '}
                  {(event.reminders ?? [event.reminder])
                    .map(reminderLabel)
                    .join(', ')}
                </span>
              </p>
              {event.repeat && (
                <p className="flex items-start gap-3">
                  <Repeat2
                    aria-hidden="true"
                    className="mt-0.5 size-4 shrink-0 text-[#38634f]"
                  />
                  <span>{repeatLabel(event.repeat)}</span>
                </p>
              )}
            </div>
          </div>

          {(event.description || event.website) && (
            <div className="space-y-4 border-b border-stone-100 px-5 py-6 text-sm leading-6 text-stone-600 sm:px-8">
              {event.description && (
                <p className="whitespace-pre-wrap">{event.description}</p>
              )}
              {event.website && (
                <a
                  href={event.website}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 font-medium text-[#38634f] underline-offset-4 hover:underline"
                >
                  Více informací
                  <ExternalLink aria-hidden="true" className="size-3.5" />
                </a>
              )}
            </div>
          )}

          <div className="space-y-3 px-5 py-6 sm:px-8 sm:py-8">
            {messengerOnIos ? (
              <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-4 text-sm text-amber-950">
                <p className="font-medium">Apple Kalendář otevřete v Safari</p>
                <p className="mt-1.5 leading-6 text-amber-900/80">
                  Pro vložení události do Apple Kalendáře zkopírujte odkaz a
                  vložte ho do Safari. Případně klepněte vpravo nahoře na ••• a
                  zvolte Otevřít v externím prohlížeči.
                </p>
                <Button
                  type="button"
                  variant="outline"
                  className="mt-3 h-10 rounded-xl border-amber-300 bg-white px-3 text-amber-950 hover:bg-amber-100"
                  onClick={copyInvitationLink}
                >
                  <Copy aria-hidden="true" />
                  Zkopírovat odkaz
                </Button>
                {copyNotice && (
                  <output className="mt-2 block text-xs">{copyNotice}</output>
                )}
              </div>
            ) : icsUrl ? (
              <a
                href={icsUrl}
                className="inline-flex h-12 w-full items-center justify-center gap-1.5 rounded-xl bg-[#38634f] px-2.5 text-base font-medium whitespace-nowrap text-white transition-all hover:bg-[#2f5543] active:translate-y-px"
              >
                <Download aria-hidden="true" />
                Přidat do kalendáře
              </a>
            ) : (
              <p className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-950">
                Tato záložní pozvánka neumí přenést opakování nebo více
                upozornění. Požádejte pořadatele o krátký odkaz na událost.
              </p>
            )}
            {!advancedEvent && (
              <div className="grid gap-3 sm:grid-cols-2">
                <Button
                  type="button"
                  variant="outline"
                  size="lg"
                  className="h-11 rounded-xl border-stone-200"
                  onClick={() =>
                    window.open(links.google, '_blank', 'noopener,noreferrer')
                  }
                >
                  Google Kalendář
                  <ExternalLink aria-hidden="true" />
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="lg"
                  className="h-11 rounded-xl border-stone-200"
                  onClick={() =>
                    window.open(links.outlook, '_blank', 'noopener,noreferrer')
                  }
                >
                  Outlook
                  <ExternalLink aria-hidden="true" />
                </Button>
              </div>
            )}
            <p className="pt-1 text-center text-xs leading-5 text-stone-500">
              {advancedEvent
                ? 'Opakování a více upozornění jsou v souboru .ics. Kalendářové aplikace je mohou zpracovat různě; po přidání si je zkontrolujte.'
                : 'Pro Apple Kalendář a další aplikace použijte soubor .ics. Přímé odkazy Google a Outlook nepřenášejí upozornění; nastavte je při uložení.'}
            </p>
          </div>
        </article>
      </div>
    </main>
  );
}

function InvalidEventView() {
  return (
    <main className="grid min-h-screen place-items-center px-4 py-10">
      <div className="max-w-md rounded-3xl border border-stone-200 bg-white p-8 text-center shadow-[0_20px_60px_rgba(40,36,29,0.06)]">
        <span className="mx-auto grid size-11 place-items-center rounded-xl bg-stone-100 text-stone-600">
          <CalendarDays aria-hidden="true" className="size-5" />
        </span>
        <h1 className="mt-5 text-xl font-semibold text-stone-950">
          Odkaz není platný
        </h1>
        <p className="mt-2 text-sm leading-6 text-stone-500">
          Údaje události jsou neúplné nebo byl odkaz poškozen.
        </p>
      </div>
    </main>
  );
}

function LoadingEventView() {
  return (
    <main className="grid min-h-screen place-items-center px-4 py-10">
      <div className="text-center text-sm text-stone-500">
        <CalendarDays
          aria-hidden="true"
          className="mx-auto mb-3 size-6 text-[#38634f]"
        />
        Načítám událost…
      </div>
    </main>
  );
}

function CollectionView({ collection }: { collection: SharedCollection }) {
  const [selectedIds, setSelectedIds] = useState<string[]>(() =>
    collection.events.map(({ id }) => id),
  );
  const messengerOnIos = useSyncExternalStore(
    subscribeToUserAgent,
    isMessengerOnIos,
    () => false,
  );
  const [copyNotice, setCopyNotice] = useState('');
  const selectedUrl = `${EVENTS_API}/api/collections/${collection.id}.ics?ids=${selectedIds.join(',')}`;

  async function copyCollectionLink() {
    try {
      await navigator.clipboard.writeText(
        `${PUBLIC_EVENT_BASE}/s/${collection.id}`,
      );
      setCopyNotice('Odkaz je zkopírovaný. Otevřete ho v Safari.');
    } catch {
      setCopyNotice('Klepněte na ••• a zvolte Otevřít v externím prohlížeči.');
    }
  }

  function toggleEvent(id: string) {
    setSelectedIds((current) =>
      current.includes(id)
        ? current.filter((item) => item !== id)
        : [...current, id],
    );
  }

  return (
    <main className="min-h-screen px-4 py-8 sm:px-6 sm:py-12">
      <div className="mx-auto max-w-2xl">
        <AppHeader compact />
        <div className="rounded-3xl border border-stone-200 bg-white p-5 shadow-[0_20px_60px_rgba(40,36,29,0.06)] sm:p-8">
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#38634f]">
            Pozvánka na více akcí
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-stone-950">
            {collection.title}
          </h1>
          <p className="mt-2 text-sm leading-6 text-stone-600">
            Vyberte akce, které si chcete přidat. Jednotlivé pozvánky můžete
            otevřít zvlášť.
          </p>
          <div className="mt-6 space-y-3">
            {collection.events.map(({ id, event }) => (
              <article
                key={id}
                className="rounded-2xl border border-stone-200 p-4"
              >
                <div className="flex items-start gap-3">
                  <input
                    type="checkbox"
                    aria-label={`Vybrat akci ${event.title}`}
                    checked={selectedIds.includes(id)}
                    onChange={() => toggleEvent(id)}
                    className="mt-1 size-5 accent-[#38634f]"
                  />
                  <div className="min-w-0 flex-1">
                    <h2 className="text-lg font-semibold text-stone-950">
                      {event.title}
                    </h2>
                    <p className="mt-1 text-sm text-stone-600">
                      {formatEventDate(event)}
                    </p>
                    {event.location && (
                      <p className="mt-1 text-sm text-stone-600">
                        {event.location}
                      </p>
                    )}
                    {event.repeat && (
                      <p className="mt-1 text-xs text-stone-500">
                        {repeatLabel(event.repeat)}
                      </p>
                    )}
                    <a
                      href={`${PUBLIC_EVENT_BASE}/${id}`}
                      className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-[#38634f] hover:underline"
                    >
                      Otevřít pozvánku{' '}
                      <ExternalLink aria-hidden="true" className="size-3.5" />
                    </a>
                  </div>
                </div>
              </article>
            ))}
          </div>
          <div className="mt-6 border-t border-stone-100 pt-6">
            {messengerOnIos ? (
              <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
                <p className="font-medium">
                  Pro Apple Kalendář otevřete pozvánku v Safari
                </p>
                <p className="mt-1 leading-6">
                  Zkopírujte odkaz a vložte ho do Safari, nebo v Messengeru
                  klepněte na ••• a zvolte Otevřít v externím prohlížeči.
                </p>
                <Button
                  type="button"
                  variant="outline"
                  className="mt-3"
                  onClick={copyCollectionLink}
                >
                  <Copy aria-hidden="true" /> Zkopírovat odkaz
                </Button>
                {copyNotice && (
                  <output className="mt-2 block text-xs">{copyNotice}</output>
                )}
              </div>
            ) : (
              <a
                href={selectedIds.length ? selectedUrl : undefined}
                aria-disabled={!selectedIds.length}
                className={`inline-flex h-12 w-full items-center justify-center gap-2 rounded-xl px-4 text-white ${selectedIds.length ? 'bg-[#38634f] hover:bg-[#2f5543]' : 'cursor-not-allowed bg-stone-300'}`}
              >
                <Download aria-hidden="true" className="size-5" />
                Přidat vybrané do kalendáře ({selectedIds.length})
              </a>
            )}
            <p className="mt-3 text-center text-xs leading-5 text-stone-500">
              Vybrané akce stáhnete jako soubor .ics. Uložení dokončíte v
              kalendářové aplikaci a po přidání si zkontrolujte upozornění.
            </p>
          </div>
        </div>
      </div>
    </main>
  );
}

function LocationAutocomplete({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [selectedValue, setSelectedValue] = useState('');
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    const query = value.trim();
    if (query.length < 3 || query === selectedValue) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch(
          `${EVENTS_API}/api/places?q=${encodeURIComponent(query)}`,
          {
            signal: controller.signal,
          },
        );
        if (response.status === 503) {
          setUnavailable(true);
          setSuggestions([]);
          return;
        }
        if (!response.ok) throw new Error('Našeptávání není dostupné.');
        setUnavailable(false);
        const result = (await response.json()) as {
          suggestions?: { label?: string }[];
        };
        const labels = (result.suggestions ?? [])
          .map(({ label }) => label)
          .filter((label): label is string => typeof label === 'string');
        setSuggestions(labels);
      } catch {
        if (!controller.signal.aborted) setSuggestions([]);
      }
    }, 400);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [value, selectedValue]);

  return (
    <div>
      <Input
        id="location"
        name="location"
        list="location-suggestions"
        maxLength={300}
        value={value}
        onChange={(event) => {
          const nextValue = event.target.value;
          onChange(nextValue);
          setSelectedValue(suggestions.includes(nextValue) ? nextValue : '');
        }}
        placeholder="Adresa nebo název místa"
        className={fieldClass}
      />
      <datalist id="location-suggestions">
        {suggestions.map((label, index) => (
          <option key={`${label}-${index}`} value={label}>
            {label}
          </option>
        ))}
      </datalist>
      {suggestions.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-stone-500">
          <span>Adresy nabízí</span>
          <a
            href="https://mapy.com/"
            target="_blank"
            rel="noreferrer"
            aria-label="Mapy.com"
          >
            <Image
              src="https://api.mapy.com/img/api/logo.svg"
              alt="Mapy.com"
              width={80}
              height={12}
              unoptimized
              className="h-3 w-auto"
            />
          </a>
          <a
            href="https://api.mapy.com/copyright"
            target="_blank"
            rel="noreferrer"
            className="underline-offset-2 hover:underline"
          >
            Seznam.cz a.s. a další
          </a>
          <span>· Můžete napsat i vlastní místo.</span>
        </div>
      )}
      {unavailable && (
        <p className="mt-1 text-xs text-stone-500">
          Našeptávání adres zatím není aktivní. Místo můžete napsat ručně.
        </p>
      )}
    </div>
  );
}

export default function Home() {
  const [form, setForm] = useState<FormData>(emptyForm);
  const [mode, setMode] = useState<'single' | 'multiple'>('single');
  const [draftEvents, setDraftEvents] = useState<DraftEvent[]>([]);
  const [collectionTitle, setCollectionTitle] = useState('');
  const [collectionGenerated, setCollectionGenerated] = useState('');
  const [sharedCollection, setSharedCollection] =
    useState<SharedCollection | null>(null);
  const [creatingCollection, setCreatingCollection] = useState(false);
  const [sharedEvent, setSharedEvent] = useState<EventData | null>(null);
  const [sharedSourceId, setSharedSourceId] = useState<string | null>(null);
  const [invalidSharedEvent, setInvalidSharedEvent] = useState(false);
  const [loadingEvent, setLoadingEvent] = useState(false);
  const [managedEvent, setManagedEvent] = useState<ManagedEvent | null>(null);
  const [generated, setGenerated] = useState<GeneratedLink | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const controller = new AbortController();

    const readLocation = async () => {
      const parameters = new URLSearchParams(window.location.search);
      const eventId = parameters.get('event');
      const manageId = parameters.get('manage');
      const collectionId = parameters.get('collection');

      if (eventId && /^[A-Za-z0-9]{7}$/u.test(eventId)) {
        setLoadingEvent(true);
        window.location.replace(`${EVENTS_API}/e/${eventId}`);
        return;
      }

      if (collectionId) {
        if (!/^[A-Za-z0-9]{7}$/u.test(collectionId)) {
          setInvalidSharedEvent(true);
          return;
        }
        setLoadingEvent(true);
        try {
          const response = await fetch(
            `${EVENTS_API}/api/collections/${collectionId}`,
            {
              signal: controller.signal,
            },
          );
          if (!response.ok) throw new Error('Přehled akcí nebyl nalezen.');
          const result = (await response.json()) as {
            title?: string;
            events?: { id: string; event: EventData }[];
          };
          if (
            typeof result.title !== 'string' ||
            !Array.isArray(result.events)
          ) {
            throw new Error('Přehled akcí není platný.');
          }
          const events = result.events.map(({ id, event }) => ({
            id,
            event: decodeEvent(encodeEvent(event), true),
          }));
          if (
            !events.length ||
            events.some(
              ({ id, event }) => !/^[A-Za-z0-9]{7}$/u.test(id) || !event,
            )
          ) {
            throw new Error('Přehled akcí není platný.');
          }
          setSharedCollection({
            id: collectionId,
            title: result.title,
            events: events as { id: string; event: EventData }[],
          });
        } catch (fetchError) {
          if ((fetchError as Error).name !== 'AbortError')
            setInvalidSharedEvent(true);
        } finally {
          setLoadingEvent(false);
        }
        return;
      }

      const manageMatch = /^#key=([A-Za-z0-9_-]{32,100})$/u.exec(
        window.location.hash,
      );
      if (manageId && /^[A-Za-z0-9]{7}$/u.test(manageId) && manageMatch) {
        setLoadingEvent(true);
        try {
          const response = await fetch(`${EVENTS_API}/api/events/${manageId}`, {
            signal: controller.signal,
          });
          if (!response.ok) throw new Error('Událost nebyla nalezena.');
          const result = (await response.json()) as { event?: EventData };
          const loaded = result.event
            ? decodeEvent(encodeEvent(result.event), true)
            : null;
          if (!loaded) throw new Error('Událost není platná.');
          setForm({
            title: loaded.title,
            start: loaded.start,
            end: loaded.end,
            location: loaded.location,
            description: loaded.description,
            website: loaded.website,
            reminders: loaded.reminders ?? [loaded.reminder],
            repeatFrequency: loaded.repeat?.frequency ?? '',
            repeatUntil: loaded.repeat?.until ?? '',
          });
          setManagedEvent({ id: manageId, editKey: manageMatch[1] });
          setGenerated({
            value: `${PUBLIC_EVENT_BASE}/${manageId}`,
            manageUrl: window.location.href,
          });
          setNotice(
            'Událost je otevřená pro úpravy. Veřejný odkaz zůstane stejný.',
          );
        } catch (fetchError) {
          if ((fetchError as Error).name !== 'AbortError') {
            setError(
              'Správcovský odkaz není platný nebo událost už neexistuje.',
            );
          }
        } finally {
          setLoadingEvent(false);
        }
        return;
      }

      const sourceId = parameters.get('source');
      if (sourceId && /^[A-Za-z0-9]{7}$/u.test(sourceId)) {
        setLoadingEvent(true);
        try {
          const response = await fetch(`${EVENTS_API}/api/events/${sourceId}`, {
            signal: controller.signal,
          });
          if (!response.ok) throw new Error('Událost nebyla nalezena.');
          const result = (await response.json()) as { event?: EventData };
          const loaded = result.event
            ? decodeEvent(encodeEvent(result.event), true)
            : null;
          if (!loaded) throw new Error('Událost není platná.');
          setSharedEvent(loaded);
          setSharedSourceId(sourceId);
          setInvalidSharedEvent(false);
        } catch (fetchError) {
          if ((fetchError as Error).name !== 'AbortError') {
            setSharedEvent(null);
            setInvalidSharedEvent(true);
          }
        } finally {
          setLoadingEvent(false);
        }
        return;
      }

      const compactMatch = /^#c=(.+)$/u.exec(window.location.hash);
      const legacyMatch = /^#e=(.+)$/u.exec(window.location.hash);
      const match = compactMatch ?? legacyMatch;
      if (!match) {
        setSharedEvent(null);
        setInvalidSharedEvent(window.location.hash === '#invalid');
        return;
      }
      const event = decodeEvent(match[1], Boolean(compactMatch));
      setSharedEvent(event);
      setSharedSourceId(null);
      setInvalidSharedEvent(!event);
    };
    void readLocation();
    window.addEventListener('hashchange', readLocation);
    return () => {
      controller.abort();
      window.removeEventListener('hashchange', readLocation);
    };
  }, []);

  function updateField(field: keyof FormData, value: string) {
    setForm((current) => ({ ...current, [field]: value }));
    setGenerated(null);
    setError('');
    setNotice('');
  }

  function updateDateTimePart(
    field: 'start' | 'end',
    part: 'date' | 'time',
    value: string,
  ) {
    setForm((current) => {
      const date = part === 'date' ? value : datePart(current[field]);
      const time = part === 'time' ? value : timePart(current[field]);
      const nextValue = `${date}T${time}`;
      const next = { ...current, [field]: nextValue };

      if (field === 'start' && !current.end && date && time) {
        next.end = addMinutesToLocalDateTime(nextValue, 60);
      }
      return next;
    });
    setGenerated(null);
    setError('');
    setNotice('');
  }

  function updateReminder(index: number, value: number) {
    setForm((current) => {
      if (
        current.reminders.some(
          (minutes, reminderIndex) =>
            reminderIndex !== index && minutes === value,
        )
      ) {
        return current;
      }
      const reminders = [...current.reminders];
      reminders[index] = value;
      return { ...current, reminders };
    });
    setGenerated(null);
  }

  function removeReminder(index: number) {
    setForm((current) => ({
      ...current,
      reminders: current.reminders.filter(
        (_, reminderIndex) => reminderIndex !== index,
      ),
    }));
    setGenerated(null);
  }

  function addReminder() {
    setForm((current) => ({
      ...current,
      reminders: [
        ...current.reminders,
        REMINDER_OPTIONS.find(
          (minutes) => !current.reminders.includes(minutes),
        ) ?? 15,
      ],
    }));
    setGenerated(null);
  }

  async function handleSubmit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setNotice('');

    const start = zonedLocalToUtc(form.start);
    const end = zonedLocalToUtc(form.end);
    if (
      !isValidZonedLocalDateTime(form.start, start) ||
      !isValidZonedLocalDateTime(form.end, end)
    ) {
      setError('Vyplňte platný začátek a konec akce.');
      return;
    }
    if (end <= start) {
      setError('Konec akce musí být později než začátek.');
      return;
    }
    if (!isSafeHttpUrl(form.website.trim())) {
      setError('Odkaz na podrobnosti musí začínat http:// nebo https://.');
      return;
    }
    if (
      form.reminders.length < 1 ||
      form.reminders.length > 5 ||
      new Set(form.reminders).size !== form.reminders.length
    ) {
      setError('Vyberte jedno až pět různých upozornění.');
      return;
    }
    if (
      form.repeatFrequency &&
      (!form.repeatUntil || form.repeatUntil < datePart(form.start))
    ) {
      setError('Zadejte datum, do kterého se má akce opakovat.');
      return;
    }
    if (
      form.repeatFrequency &&
      form.repeatUntil > (maxRepeatDate(form.start) ?? '')
    ) {
      setError('Opakování může trvat nejvýše dva roky.');
      return;
    }

    const eventData: EventData = {
      v: 1,
      title: form.title.trim(),
      start: form.start,
      end: form.end,
      location: form.location.trim(),
      description: form.description.trim(),
      website: form.website.trim(),
      reminder: form.reminders[0],
      ...(form.reminders.length > 1 ? { reminders: form.reminders } : {}),
      ...(form.repeatFrequency
        ? {
            repeat: {
              frequency: form.repeatFrequency,
              until: form.repeatUntil,
            },
          }
        : {}),
      timeZone: TIME_ZONE,
    };
    const baseUrl = `${window.location.origin}${window.location.pathname}`;
    setSubmitting(true);

    try {
      const response = await fetch(
        managedEvent
          ? `${EVENTS_API}/api/events/${managedEvent.id}`
          : `${EVENTS_API}/api/events`,
        {
          method: managedEvent ? 'PUT' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            event: eventData,
            ...(managedEvent ? { editKey: managedEvent.editKey } : {}),
          }),
        },
      );
      const result = (await response.json()) as {
        id?: string;
        editKey?: string;
        publicUrl?: string;
        error?: string;
      };
      if (!response.ok || !result.id || !result.publicUrl) {
        throw new Error(result.error || 'Krátký odkaz se nepodařilo vytvořit.');
      }

      const editKey = managedEvent?.editKey ?? result.editKey;
      if (!editKey) throw new Error('Chybí klíč pro správu události.');
      const management: ManagedEvent = { id: result.id, editKey };
      const manageUrl = `${baseUrl}?manage=${result.id}#key=${editKey}`;
      if (mode === 'multiple' && !managedEvent) {
        setDraftEvents((current) => [
          ...current,
          {
            id: result.id!,
            event: eventData,
            publicUrl: result.publicUrl!,
            manageUrl,
          },
        ]);
        setCollectionGenerated('');
        setForm(emptyForm);
        setNotice(
          'Akce je v přehledu. Přidejte další nebo vytvořte společný odkaz.',
        );
      } else {
        setManagedEvent(management);
        setGenerated({ value: result.publicUrl, manageUrl });
        setNotice(
          managedEvent
            ? 'Změny jsou uložené. Veřejný odkaz zůstal stejný.'
            : 'Krátký odkaz je připravený. Správcovský odkaz si bezpečně uložte.',
        );
      }
    } catch (submitError) {
      const message =
        submitError instanceof TypeError
          ? 'Spojení se službou se nepodařilo. Zkuste to znovu.'
          : submitError instanceof Error
            ? submitError.message
            : 'Krátký odkaz se nepodařilo vytvořit.';
      setError(message);
      if (managedEvent) {
        setNotice('Původní událost zůstala beze změny. Zkuste uložení znovu.');
      } else {
        if (eventData.repeat || (eventData.reminders?.length ?? 1) > 1) {
          setNotice(
            'Tuto pozvánku nelze bezpečně nahradit záložním odkazem. Zkuste uložení znovu.',
          );
        } else {
          setGenerated({
            value: `${baseUrl}#c=${encodeEvent(eventData)}`,
            fallback: true,
          });
          setNotice(
            'Krátký odkaz se nepodařilo vytvořit. Záložní odkaz funguje, ale nejde upravovat.',
          );
        }
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function copyLink() {
    if (!generated) return;
    try {
      await navigator.clipboard.writeText(generated.value);
      setNotice('Odkaz je zkopírovaný.');
      window.setTimeout(() => setNotice(''), 2500);
    } catch {
      setNotice('Odkaz označte a zkopírujte ručně.');
    }
  }

  async function copyManageLink() {
    if (!generated?.manageUrl) return;
    try {
      await navigator.clipboard.writeText(generated.manageUrl);
      setNotice(
        'Správcovský odkaz je zkopírovaný. Nesdílejte ho s návštěvníky.',
      );
    } catch {
      setNotice('Správcovský odkaz označte a zkopírujte ručně.');
    }
  }

  async function createCollection() {
    if (draftEvents.length < 2 || draftEvents.length > 12) {
      setError('Do společné pozvánky přidejte dvě až dvanáct akcí.');
      return;
    }
    if (!collectionTitle.trim()) {
      setError('Zadejte název přehledu akcí.');
      return;
    }
    setCreatingCollection(true);
    setError('');
    try {
      const response = await fetch(`${EVENTS_API}/api/collections`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: collectionTitle.trim(),
          eventIds: draftEvents.map(({ id }) => id),
        }),
      });
      const result = (await response.json()) as {
        publicUrl?: string;
        error?: string;
      };
      if (!response.ok || !result.publicUrl) {
        throw new Error(
          result.error || 'Společný odkaz se nepodařilo vytvořit.',
        );
      }
      setCollectionGenerated(result.publicUrl);
      setNotice(
        'Společný odkaz je připravený. Správcovské odkazy jednotlivých akcí si uložte.',
      );
    } catch (collectionError) {
      setError(
        collectionError instanceof Error
          ? collectionError.message
          : 'Společný odkaz se nepodařilo vytvořit.',
      );
    } finally {
      setCreatingCollection(false);
    }
  }

  async function copyValue(value: string, message: string) {
    try {
      await navigator.clipboard.writeText(value);
      setNotice(message);
    } catch {
      setNotice('Odkaz označte a zkopírujte ručně.');
    }
  }

  function startNewEvent() {
    setForm(emptyForm);
    setManagedEvent(null);
    setGenerated(null);
    setError('');
    setNotice('');
    window.history.replaceState(null, '', window.location.pathname);
  }

  if (loadingEvent) return <LoadingEventView />;
  if (sharedCollection) return <CollectionView collection={sharedCollection} />;
  if (sharedEvent)
    return <EventView event={sharedEvent} sourceId={sharedSourceId} />;
  if (invalidSharedEvent) return <InvalidEventView />;

  return (
    <main className="min-h-screen px-4 py-8 sm:px-6 sm:py-12">
      <div className="mx-auto max-w-3xl">
        <AppHeader />

        <section className="rounded-3xl border border-stone-200 bg-white p-5 shadow-[0_20px_60px_rgba(40,36,29,0.06)] sm:p-8">
          {!managedEvent && (
            <fieldset className="mb-7 grid grid-cols-2 rounded-xl bg-stone-100 p-1">
              <legend className="sr-only">Typ pozvánky</legend>
              <button
                type="button"
                aria-pressed={mode === 'single'}
                className={`rounded-lg px-3 py-2.5 text-sm font-medium ${mode === 'single' ? 'bg-white text-stone-950 shadow-sm' : 'text-stone-600'}`}
                onClick={() => {
                  setMode('single');
                  setError('');
                  setNotice('');
                }}
              >
                Jedna akce
              </button>
              <button
                type="button"
                aria-pressed={mode === 'multiple'}
                className={`rounded-lg px-3 py-2.5 text-sm font-medium ${mode === 'multiple' ? 'bg-white text-stone-950 shadow-sm' : 'text-stone-600'}`}
                onClick={() => {
                  setMode('multiple');
                  setError('');
                  setNotice('');
                }}
              >
                Více akcí
              </button>
            </fieldset>
          )}

          {mode === 'multiple' && !managedEvent && (
            <div className="mb-7 rounded-2xl border border-[#cbded1] bg-[#f4f8f4] p-4 sm:p-5">
              <label htmlFor="collection-title" className="field-label">
                Název přehledu
              </label>
              <Input
                id="collection-title"
                maxLength={180}
                value={collectionTitle}
                onChange={(event) => {
                  setCollectionTitle(event.target.value);
                  setCollectionGenerated('');
                }}
                placeholder="Např. Říjnové akce spolku"
                className={fieldClass}
              />
              <p className="mt-2 text-xs leading-5 text-stone-600">
                Akce přidávejte postupně (nejvýše 12). Na konci vznikne jeden
                odkaz s celým výběrem.
              </p>
              {draftEvents.length > 0 && (
                <div className="mt-4 space-y-2">
                  {draftEvents.map(
                    ({ id, event, publicUrl, manageUrl }, index) => (
                      <div
                        key={id}
                        className="rounded-xl border border-stone-200 bg-white p-3"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium text-stone-900">
                              {index + 1}. {event.title}
                            </p>
                            <p className="text-xs text-stone-500">
                              {formatEventDate(event)}
                            </p>
                          </div>
                          <Button
                            type="button"
                            variant="outline"
                            size="icon"
                            aria-label={`Odebrat akci ${event.title} z přehledu`}
                            className="size-9 shrink-0 rounded-lg"
                            onClick={() => {
                              setDraftEvents((current) =>
                                current.filter((item) => item.id !== id),
                              );
                              setCollectionGenerated('');
                            }}
                          >
                            <Trash2 aria-hidden="true" className="size-4" />
                          </Button>
                        </div>
                        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
                          <a
                            href={publicUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="text-[#38634f] hover:underline"
                          >
                            Veřejná pozvánka
                          </a>
                          <button
                            type="button"
                            className="text-[#38634f] hover:underline"
                            onClick={() =>
                              copyValue(
                                publicUrl,
                                'Odkaz na akci je zkopírovaný.',
                              )
                            }
                          >
                            Kopírovat pozvánku
                          </button>
                          <button
                            type="button"
                            className="text-stone-600 hover:underline"
                            onClick={() =>
                              copyValue(
                                manageUrl,
                                'Správcovský odkaz je zkopírovaný. Nesdílejte ho s návštěvníky.',
                              )
                            }
                          >
                            Kopírovat odkaz pro úpravy
                          </button>
                        </div>
                      </div>
                    ),
                  )}
                  <p className="text-xs text-stone-500">
                    Každá akce má vlastní správcovský odkaz. Uložte si je před
                    zavřením stránky.
                  </p>
                  <Button
                    type="button"
                    disabled={draftEvents.length < 2 || creatingCollection}
                    className="w-full rounded-xl bg-[#38634f] text-white hover:bg-[#2f5543]"
                    onClick={createCollection}
                  >
                    <Link2 aria-hidden="true" />
                    {creatingCollection
                      ? 'Vytvářím přehled…'
                      : 'Vytvořit společný odkaz'}
                  </Button>
                  {collectionGenerated && (
                    <div className="rounded-xl border border-[#cbded1] bg-white p-3">
                      <p className="text-sm font-medium text-[#38634f]">
                        Společný odkaz je připravený
                      </p>
                      <div className="mt-2 flex gap-2">
                        <Input
                          readOnly
                          aria-label="Společný odkaz"
                          value={collectionGenerated}
                          onFocus={(event) => event.target.select()}
                          className="h-10 min-w-0 rounded-lg font-mono text-xs"
                        />
                        <Button
                          type="button"
                          variant="outline"
                          aria-label="Kopírovat společný odkaz"
                          className="size-10 shrink-0 rounded-lg"
                          onClick={() =>
                            copyValue(
                              collectionGenerated,
                              'Společný odkaz je zkopírovaný.',
                            )
                          }
                        >
                          <Copy aria-hidden="true" />
                        </Button>
                      </div>
                      <a
                        href={collectionGenerated}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-[#38634f] hover:underline"
                      >
                        Otevřít přehled{' '}
                        <ExternalLink aria-hidden="true" className="size-3.5" />
                      </a>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          <form className="space-y-6" onSubmit={handleSubmit}>
            <div>
              <label htmlFor="title" className="field-label">
                Název akce
              </label>
              <Input
                id="title"
                name="title"
                required
                maxLength={180}
                value={form.title}
                onChange={(event) => updateField('title', event.target.value)}
                placeholder="Např. Podzimní výlet"
                className={fieldClass}
              />
            </div>

            <fieldset>
              <legend className="field-label">Datum a čas</legend>
              <div className="mt-2 grid gap-3 sm:grid-cols-2">
                <div className="rounded-2xl border border-stone-200 bg-stone-50 p-3.5">
                  <p className="text-sm font-medium text-stone-800">Začátek</p>
                  <div className="mt-2.5 grid grid-cols-[minmax(0,1fr)_7.5rem] gap-2">
                    <Input
                      aria-label="Datum začátku"
                      name="start-date"
                      type="date"
                      required
                      value={datePart(form.start)}
                      onChange={(event) =>
                        updateDateTimePart('start', 'date', event.target.value)
                      }
                      className="h-11 rounded-xl border-stone-200 bg-white px-3 shadow-none"
                    />
                    <Input
                      aria-label="Čas začátku"
                      name="start-time"
                      type="time"
                      step={300}
                      required
                      value={timePart(form.start)}
                      onChange={(event) =>
                        updateDateTimePart('start', 'time', event.target.value)
                      }
                      className="h-11 rounded-xl border-stone-200 bg-white px-3 shadow-none"
                    />
                  </div>
                </div>
                <div className="rounded-2xl border border-stone-200 bg-stone-50 p-3.5">
                  <p className="text-sm font-medium text-stone-800">Konec</p>
                  <div className="mt-2.5 grid grid-cols-[minmax(0,1fr)_7.5rem] gap-2">
                    <Input
                      aria-label="Datum konce"
                      name="end-date"
                      type="date"
                      min={datePart(form.start) || undefined}
                      required
                      value={datePart(form.end)}
                      onChange={(event) =>
                        updateDateTimePart('end', 'date', event.target.value)
                      }
                      className="h-11 rounded-xl border-stone-200 bg-white px-3 shadow-none"
                    />
                    <Input
                      aria-label="Čas konce"
                      name="end-time"
                      type="time"
                      step={300}
                      required
                      value={timePart(form.end)}
                      onChange={(event) =>
                        updateDateTimePart('end', 'time', event.target.value)
                      }
                      className="h-11 rounded-xl border-stone-200 bg-white px-3 shadow-none"
                    />
                  </div>
                </div>
              </div>
              <p className="mt-2 text-xs text-stone-400">
                Časové pásmo Praha · konec předvyplníme hodinu po začátku.
              </p>
            </fieldset>

            <div>
              <label htmlFor="location" className="field-label">
                Místo
              </label>
              <LocationAutocomplete
                value={form.location}
                onChange={(value) => updateField('location', value)}
              />
            </div>

            <div>
              <label htmlFor="description" className="field-label">
                Popis
                <span className="ml-1 font-normal text-stone-400">
                  volitelný
                </span>
              </label>
              <Textarea
                id="description"
                name="description"
                maxLength={4000}
                value={form.description}
                onChange={(event) =>
                  updateField('description', event.target.value)
                }
                placeholder="Co by měli účastníci vědět?"
                className="mt-2 min-h-28 resize-y rounded-xl border-stone-200 bg-white px-3 py-3 shadow-none focus-visible:border-[#38634f] focus-visible:ring-[#38634f]/15"
              />
            </div>

            <div>
              <label htmlFor="website" className="field-label">
                Odkaz na podrobnosti
                <span className="ml-1 font-normal text-stone-400">
                  volitelný
                </span>
              </label>
              <Input
                id="website"
                name="website"
                type="url"
                maxLength={1000}
                value={form.website}
                onChange={(event) => updateField('website', event.target.value)}
                placeholder="https://…"
                className={fieldClass}
              />
            </div>

            <fieldset>
              <legend className="field-label">Opakování</legend>
              <div className="mt-2 grid gap-3 sm:grid-cols-2">
                <NativeSelect
                  aria-label="Jak často se akce opakuje"
                  value={form.repeatFrequency}
                  onChange={(event) =>
                    updateField('repeatFrequency', event.target.value)
                  }
                  className="w-full [&_select]:h-11 [&_select]:rounded-xl [&_select]:border-stone-200 [&_select]:bg-white"
                >
                  <NativeSelectOption value="">Neopakuje se</NativeSelectOption>
                  <NativeSelectOption value="daily">
                    Každý den
                  </NativeSelectOption>
                  <NativeSelectOption value="weekly">
                    Každý týden
                  </NativeSelectOption>
                  <NativeSelectOption value="monthly">
                    Každý měsíc
                  </NativeSelectOption>
                  <NativeSelectOption value="yearly">
                    Každý rok
                  </NativeSelectOption>
                </NativeSelect>
                {form.repeatFrequency && (
                  <Input
                    aria-label="Opakovat do data včetně"
                    type="date"
                    required
                    min={datePart(form.start) || undefined}
                    max={maxRepeatDate(form.start)}
                    value={form.repeatUntil}
                    onChange={(event) =>
                      updateField('repeatUntil', event.target.value)
                    }
                    className="h-11 rounded-xl border-stone-200 bg-white px-3 shadow-none"
                  />
                )}
              </div>
              {form.repeatFrequency && (
                <p className="mt-2 text-xs text-stone-500">
                  Koncové datum se počítá včetně.
                </p>
              )}
            </fieldset>

            <fieldset>
              <legend className="field-label">Upozornění</legend>
              <div className="mt-2 space-y-2">
                {form.reminders.map((minutes, index) => (
                  <div key={index} className="flex gap-2">
                    <NativeSelect
                      aria-label={`Upozornění ${index + 1}`}
                      value={String(minutes)}
                      onChange={(event) =>
                        updateReminder(index, Number(event.target.value))
                      }
                      className="w-full [&_select]:h-11 [&_select]:rounded-xl [&_select]:border-stone-200 [&_select]:bg-white"
                    >
                      {REMINDER_OPTIONS.map((option) => (
                        <NativeSelectOption
                          key={option}
                          value={String(option)}
                          disabled={
                            option !== minutes &&
                            form.reminders.includes(option)
                          }
                        >
                          {reminderLabel(option)}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                    {form.reminders.length > 1 && (
                      <Button
                        type="button"
                        variant="outline"
                        aria-label={`Odebrat upozornění ${index + 1}`}
                        className="size-11 shrink-0 rounded-xl border-stone-200"
                        onClick={() => removeReminder(index)}
                      >
                        <Trash2 aria-hidden="true" className="size-4" />
                      </Button>
                    )}
                  </div>
                ))}
              </div>
              {form.reminders.length < 5 && (
                <Button
                  type="button"
                  variant="outline"
                  className="mt-2 rounded-xl border-stone-200"
                  onClick={addReminder}
                >
                  <Plus aria-hidden="true" className="size-4" />
                  Přidat upozornění
                </Button>
              )}
            </fieldset>

            {error && (
              <p
                role="alert"
                className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700"
              >
                {error}
              </p>
            )}

            <div className="border-t border-stone-100 pt-6">
              <Button
                type="submit"
                size="lg"
                disabled={
                  submitting ||
                  (mode === 'multiple' && draftEvents.length >= 12)
                }
                className="h-12 w-full rounded-xl bg-[#38634f] text-base text-white hover:bg-[#2f5543]"
              >
                <Link2 aria-hidden="true" />
                {submitting
                  ? 'Ukládám…'
                  : managedEvent
                    ? 'Uložit změny'
                    : mode === 'multiple'
                      ? 'Přidat akci do přehledu'
                      : 'Vytvořit krátký odkaz'}
              </Button>
            </div>
          </form>

          {generated && (
            <div className="mt-7 border-t border-stone-100 pt-7">
              <div className="mb-3 flex items-center gap-2 text-sm font-medium text-stone-800">
                <Check aria-hidden="true" className="size-4 text-[#38634f]" />
                {generated.fallback
                  ? 'Záložní odkaz je připravený'
                  : 'Krátký odkaz je připravený ke sdílení'}
              </div>
              <div className="flex gap-2">
                <Input
                  readOnly
                  aria-label="Vygenerovaný odkaz"
                  value={generated.value}
                  onFocus={(event) => event.target.select()}
                  className="h-11 rounded-xl border-stone-200 bg-stone-50 font-mono text-xs"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon-lg"
                  aria-label="Kopírovat odkaz"
                  className="size-11 shrink-0 rounded-xl border-stone-200"
                  onClick={copyLink}
                >
                  <Copy aria-hidden="true" />
                </Button>
              </div>
              <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-xs">
                <a
                  href={generated.value}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 font-medium text-[#38634f] hover:underline"
                >
                  Otevřít událost
                  <ExternalLink aria-hidden="true" className="size-3.5" />
                </a>
                {managedEvent && (
                  <button
                    type="button"
                    className="font-medium text-stone-500 hover:text-stone-800 hover:underline"
                    onClick={startNewEvent}
                  >
                    Vytvořit novou událost
                  </button>
                )}
              </div>
              {generated.manageUrl && (
                <div className="mt-6 rounded-2xl border border-stone-200 bg-stone-50 p-4">
                  <p className="text-sm font-medium text-stone-800">
                    Soukromý odkaz pro úpravy
                  </p>
                  <p className="mt-1 text-xs leading-5 text-stone-500">
                    Uložte si ho. Kdo ho má, může událost změnit. Návštěvníkům
                    posílejte pouze krátký odkaz výše.
                  </p>
                  <div className="mt-3 flex gap-2">
                    <Input
                      readOnly
                      aria-label="Soukromý odkaz pro úpravy"
                      value={generated.manageUrl}
                      onFocus={(event) => event.target.select()}
                      className="h-10 rounded-xl border-stone-200 bg-white font-mono text-xs"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      aria-label="Kopírovat správcovský odkaz"
                      className="size-10 shrink-0 rounded-xl border-stone-200 bg-white"
                      onClick={copyManageLink}
                    >
                      <Copy aria-hidden="true" />
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}

          {notice && (
            <output className="mt-4 block text-sm leading-5 text-stone-500">
              {notice}
            </output>
          )}
        </section>
      </div>
    </main>
  );
}
