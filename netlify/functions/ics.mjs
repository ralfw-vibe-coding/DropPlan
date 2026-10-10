// Holt eine iCal-Datei (Kalender-Abo) für den Browser ab.
// Nötig, weil Kalenderdienste (Google, iCloud, Outlook) keinen direkten Abruf aus dem Browser erlauben (CORS).
// Die Abo-Adresse kommt per POST im Body, damit sie nicht in Server- oder CDN-Logs landet. Gespeichert wird nichts.
//
// iCal-Adressen liefern immer den ganzen Kalender (oft Jahre an Terminen). Mit from/to im Body schickt die Funktion
// nur den Ausschnitt zurück: Termine im Zeitraum, Serien, die hineinreichen, und alles außerhalb von Terminen
// (Kopf, Zeitzonen).

const MAX_FETCH_BYTES = 50 * 1024 * 1024; // so groß darf der ganze Kalender sein
const MAX_RESPONSE_BYTES = 5.5 * 1024 * 1024; // Grenze für die Antwort einer Netlify-Funktion: 6 MB
const MARGIN_DAYS = 2; // Puffer für Zeitzonen

// Lokale Entwicklung (python3 dev-server.py) ruft die Funktion auf Netlify auf
const ALLOWED_ORIGINS = ['http://localhost:8080', 'http://127.0.0.1:8080'];

function corsHeaders(req) {
  const origin = req.headers.get('origin');
  if (!origin || !ALLOWED_ORIGINS.includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    Vary: 'Origin',
  };
}

const fail = (req, status, message) =>
  new Response(message, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...corsHeaders(req) } });

// Keine IP-Adressen und keine internen Namen – die Funktion soll kein Tor ins interne Netz sein
function forbiddenHost(hostname) {
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    /^[\d.]+$/.test(hostname) ||
    hostname.includes(':') ||
    hostname.startsWith('[')
  );
}

// "2026-10-01" ± Tage -> "20260929"
function compactDate(iso, deltaDays) {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

function addDaysCompact(yyyymmdd, days) {
  const d = new Date(Date.UTC(+yyyymmdd.slice(0, 4), +yyyymmdd.slice(4, 6) - 1, +yyyymmdd.slice(6, 8) + days));
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

// Soll dieser VEVENT-Block in den Ausschnitt [from, to] (YYYYMMDD) ?
function keepEvent(lines, from, to) {
  const props = {};
  let current = '';
  const take = (line) => {
    const m = /^(DTSTART|DTEND|DURATION|RRULE|RECURRENCE-ID)[;:]/.exec(line);
    if (m && !(m[1] in props)) props[m[1]] = line.slice(line.lastIndexOf(':') + 1).trim();
  };
  for (const line of lines) {
    if (line.startsWith(' ') || line.startsWith('\t')) current += line.slice(1); // gefaltete Zeile
    else {
      take(current);
      current = line;
    }
  }
  take(current);

  if (!props.DTSTART) return true;
  const start = props.DTSTART.slice(0, 8);
  if (props.RRULE) {
    const until = /UNTIL=(\d{8})/.exec(props.RRULE);
    return !until || until[1] >= from; // Serie läuft (noch) in den Zeitraum hinein
  }
  if (props['RECURRENCE-ID'] && props['RECURRENCE-ID'].slice(0, 8) >= from && props['RECURRENCE-ID'].slice(0, 8) <= to) return true;
  let end = start;
  if (props.DTEND) end = props.DTEND.slice(0, 8);
  else if (props.DURATION) {
    const m = /P(?:(\d+)W)?(?:(\d+)D)?/.exec(props.DURATION);
    end = addDaysCompact(start, (Number(m?.[1] || 0) * 7) + Number(m?.[2] || 0) + 1);
  }
  return start <= to && end >= from;
}

// Nur Termine im Zeitraum behalten; alles außerhalb von VEVENT-Blöcken bleibt unverändert
export function cutIcs(text, from, to) {
  const out = [];
  let block = null;
  for (const line of text.split(/\r?\n/)) {
    if (block) {
      block.push(line);
      if (line.startsWith('END:VEVENT')) {
        if (keepEvent(block, from, to)) out.push(...block);
        block = null;
      }
    } else if (line.startsWith('BEGIN:VEVENT')) block = [line];
    else if (line) out.push(line);
  }
  return out.join('\r\n') + '\r\n';
}

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(req) });
  if (req.method !== 'POST') return fail(req, 405, 'Nur POST');

  let url, from, to;
  try {
    const body = await req.json();
    url = new URL(String(body.url).trim().replace(/^webcal:/i, 'https:'));
    if (body.from && body.to) {
      from = compactDate(String(body.from), -MARGIN_DAYS);
      to = compactDate(String(body.to), MARGIN_DAYS);
    }
  } catch {
    return fail(req, 400, 'Keine gültige Adresse');
  }
  if (!['https:', 'http:'].includes(url.protocol) || forbiddenHost(url.hostname)) {
    return fail(req, 400, 'Adresse nicht erlaubt');
  }

  let res;
  try {
    res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(9_000),
      headers: { 'User-Agent': 'DropPlan calendar fetch', Accept: 'text/calendar, */*' },
    });
  } catch (e) {
    return fail(req, 502, `Kalender nicht erreichbar: ${e.message}`);
  }
  if (!res.ok) return fail(req, 502, `Kalenderdienst antwortet mit HTTP ${res.status}`);
  if (Number(res.headers.get('content-length')) > MAX_FETCH_BYTES) return fail(req, 413, 'Kalender größer als 50 MB');

  let text = await res.text();
  if (text.length > MAX_FETCH_BYTES) return fail(req, 413, 'Kalender größer als 50 MB');
  if (!text.includes('BEGIN:VCALENDAR')) return fail(req, 422, 'Das ist keine iCal-Datei');
  if (from && to) text = cutIcs(text, from, to);
  if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) return fail(req, 413, 'Auch der Ausschnitt ist zu groß (über 5 MB)');

  return new Response(text, {
    headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'no-store', ...corsHeaders(req) },
  });
};

export const config = { path: '/api/ics' };
