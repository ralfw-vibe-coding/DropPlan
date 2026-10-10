// Google Calendar: Anmeldung über Google Identity Services (Token-Modell, ohne Client Secret)
// und Lesezugriff auf Kalenderliste und Termine.
// Das Zugriffstoken gilt ca. 1 Stunde und bleibt nur in diesem Browser; danach ist ein Klick auf "neu verbinden" nötig.

import { GOOGLE_CLIENT_ID } from './config.js';

const SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';
const KEY = 'dropplan.google';

export class NotConnectedError extends Error {}

function read() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || 'null');
  } catch {
    return null;
  }
}
function write(value) {
  try {
    if (value) localStorage.setItem(KEY, JSON.stringify(value));
    else localStorage.removeItem(KEY);
  } catch {
    // Speicher nicht verfügbar: dann eben nur für diese Sitzung
  }
}

let gisPromise = null;

// Google-Bibliothek vorab laden: das Anmeldefenster muss direkt im Klick geöffnet werden, sonst blockt der Browser es
export function preload() {
  if (!gisPromise) {
    gisPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true;
      s.onload = resolve;
      s.onerror = () => {
        gisPromise = null;
        reject(new Error('Google-Anmeldung konnte nicht geladen werden'));
      };
      document.head.append(s);
    });
  }
  return gisPromise;
}

export const Google = {
  // gültiges Token oder null
  token() {
    const t = read();
    return t?.token && t.expiresAt > Date.now() + 60_000 ? t.token : null;
  },

  // war dieser Browser schon einmal verbunden (Token evtl. abgelaufen)?
  known() {
    return !!read();
  },

  email() {
    return read()?.email || '';
  },

  // Muss aus einem Klick heraus aufgerufen werden (öffnet ein Google-Fenster)
  connect() {
    return new Promise((resolve, reject) => {
      if (!window.google?.accounts?.oauth2) {
        preload().catch(() => {});
        reject(new Error('Google lädt noch – bitte gleich noch einmal klicken'));
        return;
      }
      const previous = read();
      const client = window.google.accounts.oauth2.initTokenClient({
        client_id: GOOGLE_CLIENT_ID,
        scope: SCOPE,
        prompt: previous ? '' : 'consent',
        login_hint: previous?.email || undefined,
        callback: (resp) => {
          if (resp.error) return reject(new Error(resp.error_description || resp.error));
          write({ token: resp.access_token, expiresAt: Date.now() + resp.expires_in * 1000, email: previous?.email || '' });
          resolve();
        },
        error_callback: (err) =>
          reject(new Error(err.type === 'popup_closed' ? 'Anmeldefenster geschlossen' : err.message || err.type)),
      });
      client.requestAccessToken();
    });
  },

  disconnect() {
    const t = read();
    if (t?.token) window.google?.accounts?.oauth2?.revoke(t.token, () => {});
    write(null);
  },

  async api(path, params = {}) {
    const token = this.token();
    if (!token) throw new NotConnectedError('Google nicht verbunden');
    const res = await fetch(`https://www.googleapis.com/calendar/v3/${path}?${new URLSearchParams(params)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 401) {
      write({ ...read(), expiresAt: 0 });
      throw new NotConnectedError('Google-Anmeldung abgelaufen');
    }
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try {
        msg = (await res.json()).error?.message || msg;
      } catch {
        // kein JSON
      }
      throw new Error(`Google: ${msg}`);
    }
    return res.json();
  },

  // Kalender, die der Nutzer in Google sieht
  async calendars() {
    const items = [];
    let pageToken;
    do {
      const page = await this.api('users/me/calendarList', { maxResults: 250, ...(pageToken && { pageToken }) });
      items.push(...page.items);
      pageToken = page.nextPageToken;
    } while (pageToken);
    const primary = items.find((c) => c.primary);
    if (primary) write({ ...read(), email: primary.id });
    return items.map((c) => ({
      id: c.id,
      name: c.summaryOverride || c.summary,
      color: c.backgroundColor,
      primary: !!c.primary,
      selected: !!c.selected,
    }));
  },

  // Termine eines Kalenders im Zeitraum [from, to) als einheitliche Termin-Objekte
  async events(calendarId, from, to) {
    const out = [];
    let pageToken;
    do {
      const page = await this.api(`calendars/${encodeURIComponent(calendarId)}/events`, {
        timeMin: new Date(from).toISOString(),
        timeMax: new Date(to).toISOString(),
        singleEvents: 'true',
        maxResults: '2500',
        fields: 'nextPageToken,items(id,summary,start,end,transparency,status,eventType,attendees(self,responseStatus))',
        ...(pageToken && { pageToken }),
      });
      for (const e of page.items || []) {
        if (e.status === 'cancelled' || e.eventType === 'workingLocation') continue;
        if (e.attendees?.some((a) => a.self && a.responseStatus === 'declined')) continue; // abgesagt
        const busy = e.transparency !== 'transparent';
        const title = e.summary || '(ohne Titel)';
        if (e.start.date) out.push({ id: e.id, title, allDay: true, startDate: e.start.date, endDate: e.end.date, busy });
        else out.push({ id: e.id, title, allDay: false, start: Date.parse(e.start.dateTime), end: Date.parse(e.end.dateTime), busy });
      }
      pageToken = page.nextPageToken;
    } while (pageToken);
    return out;
  },
};
