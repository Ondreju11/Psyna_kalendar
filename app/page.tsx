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
} from 'lucide-react';
import { strFromU8, strToU8, unzlibSync, zlibSync } from 'fflate';
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
const EVENTS_API = 'https://kalendar-akci.kt-mcp-9992a27c899e8bf9.workers.dev';
const ALLOWED_REMINDERS = new Set([15, 30, 60, 120, 1440, 2880, 10080]);

type EventData = {
  v: 1;
  title: string;
  start: string;
  end: string;
  location: string;
  description: string;
  website: string;
  reminder: number;
  timeZone: typeof TIME_ZONE;
};

type FormData = Omit<EventData, 'v' | 'timeZone' | 'reminder'> & {
  reminder: string;
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

type CompactEvent = [string, string, string, string, string, string, number];

const emptyForm: FormData = {
  title: '',
  start: '',
  end: '',
  location: '',
  description: '',
  website: '',
  reminder: '1440',
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
  const bytes = zlibSync(strToU8(JSON.stringify(compact)), { level: 9 });
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
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
    const json = compressed ? strFromU8(unzlibSync(bytes)) : new TextDecoder().decode(bytes);
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
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) {
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
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
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

function toCalendarTimestamp(date: Date) {
  return date.toISOString().replaceAll('-', '').replaceAll(':', '').replace(/\.\d{3}Z$/u, 'Z');
}

function simpleHash(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function calendarIcsUrl(event: EventData) {
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
  const details = [event.description, event.website].filter(Boolean).join('\n\n');
  const google = new URL('https://calendar.google.com/calendar/render');
  google.search = new URLSearchParams({
    action: 'TEMPLATE',
    text: event.title,
    dates: `${toCalendarTimestamp(start)}/${toCalendarTimestamp(end)}`,
    details,
    location: event.location,
    ctz: event.timeZone,
  }).toString();

  const outlook = new URL('https://outlook.live.com/calendar/0/deeplink/compose');
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
  return `${date}, ${time.format(start)}–${time.format(end)}`;
}

function reminderLabel(minutes: number) {
  if (minutes === 15) return '15 minut předem';
  if (minutes === 30) return '30 minut předem';
  if (minutes === 60) return '1 hodinu předem';
  if (minutes === 120) return '2 hodiny předem';
  if (minutes === 1440) return '24 hodin předem';
  if (minutes === 2880) return '2 dny předem';
  if (minutes === 10080) return '7 dní předem';
  return `${minutes} minut předem`;
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
                Vytvořit pozvánku na událost
              </h1>
              <p className="mt-0.5 text-xs text-stone-500">
                Jeden odkaz pro všechny běžné kalendáře.
              </p>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

function EventView({ event }: { event: EventData }) {
  const links = useMemo(() => calendarLinks(event), [event]);
  const icsUrl = useMemo(() => calendarIcsUrl(event), [event]);
  const messengerOnIos = useSyncExternalStore(subscribeToUserAgent, isMessengerOnIos, () => false);
  const [copyNotice, setCopyNotice] = useState('');

  async function copyInvitationLink() {
    try {
      await navigator.clipboard.writeText(window.location.href);
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
                <Clock3 aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-[#38634f]" />
                <span className="first-letter:uppercase">{formatEventDate(event)}</span>
              </p>
              {event.location && (
                <p className="flex items-start gap-3">
                  <MapPin aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-[#38634f]" />
                  <span>{event.location}</span>
                </p>
              )}
              <p className="flex items-start gap-3">
                <Bell aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-[#38634f]" />
                <span>Upozornění {reminderLabel(event.reminder)}</span>
              </p>
            </div>
          </div>

          {(event.description || event.website) && (
            <div className="space-y-4 border-b border-stone-100 px-5 py-6 text-sm leading-6 text-stone-600 sm:px-8">
              {event.description && <p className="whitespace-pre-wrap">{event.description}</p>}
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
                  Pro vložení události do Apple Kalendáře zkopírujte odkaz a vložte ho do
                  Safari. Případně klepněte vpravo nahoře na ••• a zvolte Otevřít v
                  externím prohlížeči.
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
                {copyNotice && <output className="mt-2 block text-xs">{copyNotice}</output>}
              </div>
            ) : (
              <a
                href={icsUrl}
                className="inline-flex h-12 w-full items-center justify-center gap-1.5 rounded-xl bg-[#38634f] px-2.5 text-base font-medium whitespace-nowrap text-white transition-all hover:bg-[#2f5543] active:translate-y-px"
              >
                <Download aria-hidden="true" />
                Přidat do kalendáře
              </a>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              <Button
                type="button"
                variant="outline"
                size="lg"
                className="h-11 rounded-xl border-stone-200"
                onClick={() => window.open(links.google, '_blank', 'noopener,noreferrer')}
              >
                Google Kalendář
                <ExternalLink aria-hidden="true" />
              </Button>
              <Button
                type="button"
                variant="outline"
                size="lg"
                className="h-11 rounded-xl border-stone-200"
                onClick={() => window.open(links.outlook, '_blank', 'noopener,noreferrer')}
              >
                Outlook
                <ExternalLink aria-hidden="true" />
              </Button>
            </div>
            <p className="pt-1 text-center text-xs leading-5 text-stone-500">
              Pro Apple Kalendář a další aplikace použijte soubor .ics. Uložení dokončíte
              ve své kalendářové aplikaci.
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
        <h1 className="mt-5 text-xl font-semibold text-stone-950">Odkaz není platný</h1>
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
        <CalendarDays aria-hidden="true" className="mx-auto mb-3 size-6 text-[#38634f]" />
        Načítám událost…
      </div>
    </main>
  );
}

export default function Home() {
  const [form, setForm] = useState<FormData>(emptyForm);
  const [sharedEvent, setSharedEvent] = useState<EventData | null>(null);
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

      if (eventId && /^[A-Za-z0-9]{7}$/u.test(eventId)) {
        setLoadingEvent(true);
        setInvalidSharedEvent(false);
        try {
          const response = await fetch(`${EVENTS_API}/api/events/${eventId}`, {
            signal: controller.signal,
          });
          if (!response.ok) throw new Error('Událost nebyla nalezena.');
          const result = (await response.json()) as { event?: EventData };
          const event = result.event ? decodeEvent(encodeEvent(result.event), true) : null;
          setSharedEvent(event);
          setInvalidSharedEvent(!event);
        } catch (fetchError) {
          if ((fetchError as Error).name !== 'AbortError') setInvalidSharedEvent(true);
        } finally {
          setLoadingEvent(false);
        }
        return;
      }

      const manageMatch = /^#key=([A-Za-z0-9_-]{32,100})$/u.exec(window.location.hash);
      if (manageId && /^[A-Za-z0-9]{7}$/u.test(manageId) && manageMatch) {
        setLoadingEvent(true);
        try {
          const response = await fetch(`${EVENTS_API}/api/events/${manageId}`, {
            signal: controller.signal,
          });
          if (!response.ok) throw new Error('Událost nebyla nalezena.');
          const result = (await response.json()) as { event?: EventData };
          const loaded = result.event ? decodeEvent(encodeEvent(result.event), true) : null;
          if (!loaded) throw new Error('Událost není platná.');
          setForm({
            title: loaded.title,
            start: loaded.start,
            end: loaded.end,
            location: loaded.location,
            description: loaded.description,
            website: loaded.website,
            reminder: String(loaded.reminder),
          });
          setManagedEvent({ id: manageId, editKey: manageMatch[1] });
          setGenerated({
            value: `${EVENTS_API}/e/${manageId}`,
            manageUrl: window.location.href,
          });
          setNotice('Událost je otevřená pro úpravy. Veřejný odkaz zůstane stejný.');
        } catch (fetchError) {
          if ((fetchError as Error).name !== 'AbortError') {
            setError('Správcovský odkaz není platný nebo událost už neexistuje.');
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
        setInvalidSharedEvent(false);
        return;
      }
      const event = decodeEvent(match[1], Boolean(compactMatch));
      setSharedEvent(event);
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

  function updateDateTimePart(field: 'start' | 'end', part: 'date' | 'time', value: string) {
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

  async function handleSubmit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setNotice('');

    const start = zonedLocalToUtc(form.start);
    const end = zonedLocalToUtc(form.end);
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) {
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

    const eventData: EventData = {
      v: 1,
      title: form.title.trim(),
      start: form.start,
      end: form.end,
      location: form.location.trim(),
      description: form.description.trim(),
      website: form.website.trim(),
      reminder: Number(form.reminder),
      timeZone: TIME_ZONE,
    };
    const baseUrl = `${window.location.origin}${window.location.pathname}`;
    setSubmitting(true);

    try {
      const response = await fetch(
        managedEvent ? `${EVENTS_API}/api/events/${managedEvent.id}` : `${EVENTS_API}/api/events`,
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
      setManagedEvent(management);
      setGenerated({ value: result.publicUrl, manageUrl });
      setNotice(
        managedEvent
          ? 'Změny jsou uložené. Veřejný odkaz zůstal stejný.'
          : 'Krátký odkaz je připravený. Správcovský odkaz si bezpečně uložte.',
      );
    } catch (submitError) {
      setGenerated({ value: `${baseUrl}#c=${encodeEvent(eventData)}`, fallback: true });
      setNotice('Cloudflare teď neodpověděl. Vytvořil jsem funkční záložní odkaz.');
      setError(submitError instanceof Error ? submitError.message : 'Krátký odkaz selhal.');
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
      setNotice('Správcovský odkaz je zkopírovaný. Nesdílejte ho s návštěvníky.');
    } catch {
      setNotice('Správcovský odkaz označte a zkopírujte ručně.');
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
  if (sharedEvent) return <EventView event={sharedEvent} />;
  if (invalidSharedEvent) return <InvalidEventView />;

  return (
    <main className="min-h-screen px-4 py-8 sm:px-6 sm:py-12">
      <div className="mx-auto max-w-3xl">
        <AppHeader />

        <section className="rounded-3xl border border-stone-200 bg-white p-5 shadow-[0_20px_60px_rgba(40,36,29,0.06)] sm:p-8">
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
                      onChange={(event) => updateDateTimePart('start', 'date', event.target.value)}
                      className="h-11 rounded-xl border-stone-200 bg-white px-3 shadow-none"
                    />
                    <Input
                      aria-label="Čas začátku"
                      name="start-time"
                      type="time"
                      step={300}
                      required
                      value={timePart(form.start)}
                      onChange={(event) => updateDateTimePart('start', 'time', event.target.value)}
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
                      onChange={(event) => updateDateTimePart('end', 'date', event.target.value)}
                      className="h-11 rounded-xl border-stone-200 bg-white px-3 shadow-none"
                    />
                    <Input
                      aria-label="Čas konce"
                      name="end-time"
                      type="time"
                      step={300}
                      required
                      value={timePart(form.end)}
                      onChange={(event) => updateDateTimePart('end', 'time', event.target.value)}
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
              <Input
                id="location"
                name="location"
                maxLength={300}
                value={form.location}
                onChange={(event) => updateField('location', event.target.value)}
                placeholder="Adresa nebo název místa"
                className={fieldClass}
              />
            </div>

            <div>
              <label htmlFor="description" className="field-label">
                Popis
                <span className="ml-1 font-normal text-stone-400">volitelný</span>
              </label>
              <Textarea
                id="description"
                name="description"
                maxLength={4000}
                value={form.description}
                onChange={(event) => updateField('description', event.target.value)}
                placeholder="Co by měli účastníci vědět?"
                className="mt-2 min-h-28 resize-y rounded-xl border-stone-200 bg-white px-3 py-3 shadow-none focus-visible:border-[#38634f] focus-visible:ring-[#38634f]/15"
              />
            </div>

            <div>
              <label htmlFor="website" className="field-label">
                Odkaz na podrobnosti
                <span className="ml-1 font-normal text-stone-400">volitelný</span>
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

            <div>
              <label htmlFor="reminder" className="field-label">
                Upozornění
              </label>
              <NativeSelect
                id="reminder"
                name="reminder"
                value={form.reminder}
                onChange={(event) => updateField('reminder', event.target.value)}
                className="mt-2 w-full [&_select]:h-11 [&_select]:rounded-xl [&_select]:border-stone-200 [&_select]:bg-white"
              >
                <NativeSelectOption value="15">15 minut předem</NativeSelectOption>
                <NativeSelectOption value="30">30 minut předem</NativeSelectOption>
                <NativeSelectOption value="60">1 hodinu předem</NativeSelectOption>
                <NativeSelectOption value="120">2 hodiny předem</NativeSelectOption>
                <NativeSelectOption value="1440">24 hodin předem</NativeSelectOption>
                <NativeSelectOption value="2880">2 dny předem</NativeSelectOption>
                <NativeSelectOption value="10080">7 dní předem</NativeSelectOption>
              </NativeSelect>
            </div>

            {error && (
              <p role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">
                {error}
              </p>
            )}

            <div className="border-t border-stone-100 pt-6">
              <Button
                type="submit"
                size="lg"
                disabled={submitting}
                className="h-12 w-full rounded-xl bg-[#38634f] text-base text-white hover:bg-[#2f5543]"
              >
                <Link2 aria-hidden="true" />
                {submitting
                  ? 'Ukládám…'
                  : managedEvent
                    ? 'Uložit změny'
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
                  <p className="text-sm font-medium text-stone-800">Soukromý odkaz pro úpravy</p>
                  <p className="mt-1 text-xs leading-5 text-stone-500">
                    Uložte si ho. Kdo ho má, může událost změnit. Návštěvníkům posílejte
                    pouze krátký odkaz výše.
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
