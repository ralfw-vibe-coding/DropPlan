// App key der Dropbox-App (App Console -> Settings). Er ist öffentlich, das App secret wird NICHT gebraucht.
export const DROPBOX_APP_KEY = 'mj4cfwl8id3ly2m';

// OAuth-Client-ID aus der Google Cloud Console (Typ "Webanwendung"). Ebenfalls öffentlich, kein Client Secret nötig.
export const GOOGLE_CLIENT_ID = '265860758816-31tn4bal33dtnin0aoos9rn4g7n5jhj4.apps.googleusercontent.com';

// Netlify-Funktion, die iCal-Abos abholt. Lokal (localhost) wird die Funktion der veröffentlichten Seite benutzt.
export const ICS_PROXY_URL =
  location.hostname === 'localhost' || location.hostname === '127.0.0.1'
    ? 'https://ralfw-dropplan.netlify.app/api/ics'
    : '/api/ics';
