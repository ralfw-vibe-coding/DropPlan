// Holt eine iCal-Datei (Kalender-Abo) für den Browser ab.
// Nötig, weil Kalenderdienste (Google, iCloud, Outlook) keinen direkten Abruf aus dem Browser erlauben (CORS).
// Die Abo-Adresse kommt per POST im Body, damit sie nicht in Server- oder CDN-Logs landet. Gespeichert wird nichts.

const MAX_BYTES = 5 * 1024 * 1024;

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

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(req) });
  if (req.method !== 'POST') return fail(req, 405, 'Nur POST');

  let url;
  try {
    const body = await req.json();
    url = new URL(String(body.url).trim().replace(/^webcal:/i, 'https:'));
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
      signal: AbortSignal.timeout(10_000),
      headers: { 'User-Agent': 'DropPlan calendar fetch', Accept: 'text/calendar, */*' },
    });
  } catch (e) {
    return fail(req, 502, `Kalender nicht erreichbar: ${e.message}`);
  }
  if (!res.ok) return fail(req, 502, `Kalenderdienst antwortet mit HTTP ${res.status}`);
  if (Number(res.headers.get('content-length')) > MAX_BYTES) return fail(req, 413, 'Kalender zu groß');

  const text = await res.text();
  if (text.length > MAX_BYTES) return fail(req, 413, 'Kalender zu groß');
  if (!text.includes('BEGIN:VCALENDAR')) return fail(req, 422, 'Das ist keine iCal-Datei');

  return new Response(text, {
    headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'no-store', ...corsHeaders(req) },
  });
};

export const config = { path: '/api/ics' };
