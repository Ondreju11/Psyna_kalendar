'use client';

import {
  ArrowLeft,
  Bell,
  CalendarDays,
  Check,
  Clock3,
  Copy,
  Download,
  ExternalLink,
  Link2,
  LoaderCircle,
  MapPin,
} from 'lucide-react';
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
  long: string;
  short?: string;
};

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
  const bytes = new TextEncoder().encode(JSON.stringify(event));
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
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

function decodeEvent(value: string): EventData | null {
  try {
    const base64 = value.replaceAll('-', '+').replaceAll('_', '/');
    const padding = '='.repeat((4 - (base64.length % 4)) % 4);
    const binary = atob(base64 + padding);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Partial<EventData>;

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
            <h1 className="text-xl font-semibold tracking-tight text-stone-950">
              Vytvořit odkaz na událost
            </h1>
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
      setCopyNotice('Odkaz je zkopírovaný. Vložte ho do Safari.');
    } catch {
      setCopyNotice('Použijte nabídku ••• a zvolte Otevřít v prohlížeči.');
    }
  }

  function createOwnEvent() {
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
    window.location.reload();
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
                <p className="font-medium">Apple Kalendář otevřete mimo Messenger</p>
                <p className="mt-1.5 leading-6 text-amber-900/80">
                  Klepněte vpravo nahoře na ••• a zvolte Otevřít v prohlížeči. V Safari
                  potom použijte tlačítko Přidat do kalendáře.
                </p>
                <Button
                  type="button"
                  variant="outline"
                  className="mt-3 h-10 rounded-xl border-amber-300 bg-white px-3 text-amber-950 hover:bg-amber-100"
                  onClick={copyInvitationLink}
                >
                  <Copy aria-hidden="true" />
                  Zkopírovat odkaz pro Safari
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
              Apple, Android, počítač i další kalendáře podporují soubor .ics. Konečné
              potvrzení zajišťuje vaše kalendářová aplikace.
            </p>
          </div>
        </article>

        <button
          type="button"
          onClick={createOwnEvent}
          className="mx-auto mt-7 flex items-center gap-2 text-sm font-medium text-stone-500 hover:text-stone-900"
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
          Vytvořit vlastní událost
        </button>
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
        <Button
          type="button"
          className="mt-6 h-11 rounded-xl bg-[#38634f] px-5 text-white hover:bg-[#2f5543]"
          onClick={() => {
            window.location.hash = '';
          }}
        >
          Otevřít generátor
        </Button>
      </div>
    </main>
  );
}

export default function Home() {
  const [form, setForm] = useState<FormData>(emptyForm);
  const [sharedEvent, setSharedEvent] = useState<EventData | null>(null);
  const [invalidSharedEvent, setInvalidSharedEvent] = useState(false);
  const [shorten, setShorten] = useState(true);
  const [generated, setGenerated] = useState<GeneratedLink | null>(null);
  const [shortening, setShortening] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    const readHash = () => {
      const match = /^#e=(.+)$/u.exec(window.location.hash);
      if (!match) {
        setSharedEvent(null);
        setInvalidSharedEvent(false);
        return;
      }
      const event = decodeEvent(match[1]);
      setSharedEvent(event);
      setInvalidSharedEvent(!event);
    };
    readHash();
    window.addEventListener('hashchange', readHash);
    return () => window.removeEventListener('hashchange', readHash);
  }, []);

  function updateField(field: keyof FormData, value: string) {
    setForm((current) => ({ ...current, [field]: value }));
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
    const longUrl = `${baseUrl}#e=${encodeEvent(eventData)}`;
    setGenerated({ long: longUrl });

    if (!shorten) return;

    setShortening(true);
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch('https://spoo.me/api/v1/shorten', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ long_url: longUrl }),
        signal: controller.signal,
      });
      const result = (await response.json()) as {
        short_url?: string;
        detail?: string;
      };
      if (!response.ok || !result.short_url) {
        throw new Error(result.detail || 'Zkrácení se nepodařilo.');
      }
      setGenerated({ long: longUrl, short: result.short_url });
    } catch {
      setNotice('Krátký odkaz se nepodařilo vytvořit. Původní odkaz je plně funkční.');
    } finally {
      window.clearTimeout(timeout);
      setShortening(false);
    }
  }

  async function copyLink() {
    if (!generated) return;
    const link = generated.short || generated.long;
    try {
      await navigator.clipboard.writeText(link);
      setNotice('Odkaz je zkopírovaný.');
      window.setTimeout(() => setNotice(''), 2500);
    } catch {
      setNotice('Odkaz označte a zkopírujte ručně.');
    }
  }

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

            <div className="grid gap-5 sm:grid-cols-2">
              <div>
                <label htmlFor="start" className="field-label">
                  Začátek
                </label>
                <Input
                  id="start"
                  name="start"
                  type="datetime-local"
                  required
                  value={form.start}
                  onChange={(event) => updateField('start', event.target.value)}
                  className={fieldClass}
                />
              </div>
              <div>
                <label htmlFor="end" className="field-label">
                  Konec
                </label>
                <Input
                  id="end"
                  name="end"
                  type="datetime-local"
                  required
                  value={form.end}
                  onChange={(event) => updateField('end', event.target.value)}
                  className={fieldClass}
                />
              </div>
            </div>
            <p className="-mt-3 text-xs text-stone-400">Časové pásmo: Praha</p>

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

            <div className="flex items-start gap-3 rounded-xl bg-stone-50 px-4 py-3.5 text-sm text-stone-600">
              <input
                id="shorten-link"
                type="checkbox"
                checked={shorten}
                onChange={(event) => setShorten(event.target.checked)}
                className="mt-0.5 size-4 accent-[#38634f]"
              />
              <label htmlFor="shorten-link" className="cursor-pointer">
                <strong className="font-medium text-stone-800">Vytvořit krátký odkaz zdarma</strong>
                <span className="mt-0.5 block text-xs leading-5 text-stone-500">
                  Použije se veřejná služba spoo.me. Původní odkaz bude vždy k dispozici.
                </span>
              </label>
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
                disabled={shortening}
                className="h-12 w-full rounded-xl bg-[#38634f] text-base text-white hover:bg-[#2f5543]"
              >
                {shortening ? (
                  <LoaderCircle aria-hidden="true" className="animate-spin" />
                ) : (
                  <Link2 aria-hidden="true" />
                )}
                {shortening ? 'Zkracuji odkaz…' : 'Vygenerovat odkaz'}
              </Button>
              <p className="mt-3 text-center text-xs leading-5 text-stone-500">
                Bez registrace a bez poplatků. Při zkrácení se odkaz uloží u služby spoo.me.
              </p>
            </div>
          </form>

          {generated && (
            <div className="mt-7 border-t border-stone-100 pt-7">
              <div className="mb-3 flex items-center gap-2 text-sm font-medium text-stone-800">
                <Check aria-hidden="true" className="size-4 text-[#38634f]" />
                Odkaz na událost je připravený
              </div>
              <div className="flex gap-2">
                <Input
                  readOnly
                  aria-label="Vygenerovaný odkaz"
                  value={generated.short || generated.long}
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
                  href={generated.long}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 font-medium text-[#38634f] hover:underline"
                >
                  Otevřít událost
                  <ExternalLink aria-hidden="true" className="size-3.5" />
                </a>
                {generated.short && (
                  <button
                    type="button"
                    onClick={async () => {
                      await navigator.clipboard.writeText(generated.long);
                      setNotice('Původní odkaz je zkopírovaný.');
                    }}
                    className="text-stone-500 hover:text-stone-900"
                  >
                    Kopírovat původní odkaz
                  </button>
                )}
              </div>
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
