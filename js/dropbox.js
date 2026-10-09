// Dropbox-Anbindung direkt per fetch, ohne SDK.
// Anmeldung: OAuth 2 mit PKCE (kein App-Secret nötig, läuft komplett im Browser).
// Die App hat nur Zugriff auf ihren App-Ordner; "/" ist dort der App-Ordner selbst.

const TOKENS_KEY = 'dropplan.dropbox.tokens';
const VERIFIER_KEY = 'dropplan.dropbox.verifier';

export class ConflictError extends Error {}
export class ResetError extends Error {}

class DbxError extends Error {
  constructor(summary, status) {
    super(`Dropbox: ${summary}`);
    this.summary = summary;
    this.status = status;
  }
}

function base64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Dropbox-API-Arg ist ein HTTP-Header und darf nur ASCII enthalten
function headerJson(obj) {
  return JSON.stringify(obj).replace(/[\u007f-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function entryOf(e) {
  return { path: e.path_lower, rev: e.rev, deleted: e['.tag'] === 'deleted', folder: e['.tag'] === 'folder' };
}

export class Dropbox {
  constructor(appKey) {
    this.appKey = appKey;
    this.tokens = JSON.parse(localStorage.getItem(TOKENS_KEY) || 'null');
  }

  get redirectUri() {
    return location.origin + location.pathname;
  }

  isConnected() {
    return !!this.tokens?.refresh;
  }

  async login() {
    const verifier = base64url(crypto.getRandomValues(new Uint8Array(48)));
    const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
    sessionStorage.setItem(VERIFIER_KEY, verifier);
    const url = new URL('https://www.dropbox.com/oauth2/authorize');
    url.search = new URLSearchParams({
      client_id: this.appKey,
      response_type: 'code',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      redirect_uri: this.redirectUri,
      token_access_type: 'offline',
    });
    location.assign(url);
  }

  // Nach der Rückkehr von Dropbox steht ?code=… in der Adresse. Gibt true zurück, wenn gerade neu verbunden wurde.
  async handleRedirect() {
    const params = new URLSearchParams(location.search);
    const code = params.get('code');
    if (!code && !params.has('error')) return false;
    history.replaceState(null, '', this.redirectUri);
    if (!code) return false;
    const verifier = sessionStorage.getItem(VERIFIER_KEY);
    sessionStorage.removeItem(VERIFIER_KEY);
    if (!verifier) return false;
    await this.tokenRequest({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: this.redirectUri,
    });
    return true;
  }

  async logout() {
    try {
      await this.rpc('auth/token/revoke', null);
    } catch {
      // Token ist evtl. schon ungültig, egal
    }
    this.tokens = null;
    localStorage.removeItem(TOKENS_KEY);
  }

  async tokenRequest(fields) {
    const res = await fetch('https://api.dropboxapi.com/oauth2/token', {
      method: 'POST',
      body: new URLSearchParams({ client_id: this.appKey, ...fields }),
    });
    const json = await res.json();
    if (!res.ok) throw new DbxError(json.error_description || json.error || 'Anmeldung fehlgeschlagen', res.status);
    this.tokens = {
      access: json.access_token,
      refresh: json.refresh_token || this.tokens?.refresh,
      expiresAt: Date.now() + json.expires_in * 1000,
    };
    localStorage.setItem(TOKENS_KEY, JSON.stringify(this.tokens));
  }

  async accessToken(forceRefresh = false) {
    if (!this.tokens) throw new DbxError('nicht verbunden', 401);
    if (forceRefresh || Date.now() > this.tokens.expiresAt - 60_000) {
      await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: this.tokens.refresh });
    }
    return this.tokens.access;
  }

  // Ein Request mit Token, Wiederholung bei abgelaufenem Token und bei Rate-Limit
  async send(url, init, retries = 3) {
    let refreshed = false;
    for (;;) {
      const res = await fetch(url, {
        ...init,
        headers: { ...init.headers, Authorization: `Bearer ${await this.accessToken(refreshed)}` },
      });
      if (res.status === 401 && !refreshed) {
        refreshed = true;
        continue;
      }
      if ((res.status === 429 || res.status >= 500) && retries-- > 0) {
        await sleep((Number(res.headers.get('Retry-After')) || 2) * 1000);
        continue;
      }
      if (!res.ok) {
        let summary = `HTTP ${res.status}`;
        try {
          summary = (await res.json()).error_summary || summary;
        } catch {
          // Antwort war kein JSON
        }
        throw new DbxError(summary, res.status);
      }
      return res;
    }
  }

  async rpc(endpoint, body) {
    const init = { method: 'POST', headers: {} };
    if (body !== null) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const res = await this.send(`https://api.dropboxapi.com/2/${endpoint}`, init);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  // ---- Schnittstelle, die der Store benutzt ----

  async listFolder() {
    let page;
    try {
      page = await this.rpc('files/list_folder', { path: '', recursive: true });
    } catch (e) {
      if (!String(e.summary).startsWith('path/not_found')) throw e;
      // App-Ordner existiert noch nicht: einmal anlegen lassen
      await this.rpc('files/create_folder_v2', { path: '/tasks' });
      page = await this.rpc('files/list_folder', { path: '', recursive: true });
    }
    const entries = page.entries.map(entryOf);
    while (page.has_more) {
      page = await this.rpc('files/list_folder/continue', { cursor: page.cursor });
      entries.push(...page.entries.map(entryOf));
    }
    return { entries, cursor: page.cursor };
  }

  async listChanges(cursor) {
    const entries = [];
    let page;
    do {
      try {
        page = await this.rpc('files/list_folder/continue', { cursor });
      } catch (e) {
        if (String(e.summary).startsWith('reset')) throw new ResetError();
        throw e;
      }
      entries.push(...page.entries.map(entryOf));
      cursor = page.cursor;
    } while (page.has_more);
    return { entries, cursor };
  }

  // Wartet, bis sich im App-Ordner etwas ändert (max. ~60 s). Braucht kein Token.
  async waitForChanges(cursor) {
    const res = await fetch('https://notify.dropboxapi.com/2/files/list_folder/longpoll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cursor, timeout: 60 }),
    });
    if (!res.ok) throw new DbxError(`longpoll HTTP ${res.status}`, res.status);
    const json = await res.json();
    if (json.backoff) await sleep(json.backoff * 1000);
    return json.changes;
  }

  async download(path) {
    try {
      const res = await this.send('https://content.dropboxapi.com/2/files/download', {
        method: 'POST',
        headers: { 'Dropbox-API-Arg': headerJson({ path }) },
      });
      const meta = JSON.parse(res.headers.get('Dropbox-API-Result'));
      return { rev: meta.rev, text: await res.text() };
    } catch (e) {
      if (String(e.summary).startsWith('path/not_found')) return null;
      throw e;
    }
  }

  // rev = Version, die wir zuletzt gelesen haben; null = Datei soll neu sein.
  // Hat jemand anderes inzwischen geschrieben, lehnt Dropbox ab -> ConflictError.
  async upload(path, text, rev) {
    try {
      const res = await this.send('https://content.dropboxapi.com/2/files/upload', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Dropbox-API-Arg': headerJson({
            path,
            mode: rev ? { '.tag': 'update', update: rev } : 'add',
            autorename: false,
            mute: true,
            strict_conflict: true,
          }),
        },
        body: text,
      });
      return (await res.json()).rev;
    } catch (e) {
      if (String(e.summary).startsWith('path/conflict')) throw new ConflictError(path);
      throw e;
    }
  }

  async remove(path) {
    try {
      await this.rpc('files/delete_v2', { path });
    } catch (e) {
      if (!String(e.summary).startsWith('path_lookup/not_found')) throw e;
    }
  }
}
