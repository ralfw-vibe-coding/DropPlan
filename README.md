# DropPlan

Kapazitätsplanung für Aufgaben: links eine Aufgabenliste, rechts ein Kalender. Aufgaben werden auf Tage gezogen und verbrauchen dort Kapazität (Standard 8 h).

Reine statische Web-App ohne Server und ohne Build-Schritt. Die Daten liegen als JSON-Dateien in der Dropbox des jeweiligen Nutzers, im App-Ordner `Apps/<App-Name>/`.

## Ausprobieren ohne Dropbox

```bash
python3 dev-server.py
```

Dann <http://localhost:8080/?local> öffnen. Die Daten liegen dann im localStorage, der hier die Dropbox nachbildet. Zwei Tabs mit `?local=a` und `?local=b` verhalten sich wie zwei Geräte an derselben Dropbox.

## Dropbox einrichten (einmalig)

1. Auf <https://www.dropbox.com/developers/apps> auf **Create app** klicken.
   - **Scoped access**
   - Zugriffsart **App folder**
   - Einen eindeutigen Namen vergeben
2. Reiter **Permissions**: `files.metadata.read`, `files.content.read` und `files.content.write` anhaken, dann **Submit**.
3. Reiter **Settings**:
   - Unter **Redirect URIs** jede Adresse eintragen, unter der die App läuft, z. B. `http://localhost:8080/` und `https://<deine-domain>/`.
   - **Allow public clients (PKCE)** muss auf **Allow** stehen.
4. Den **App key** in `js/config.js` eintragen. Er ist öffentlich. Das App secret wird nicht gebraucht.

Bis zu 500 Dropbox-Nutzer können die App verbinden, ohne dass sie bei Dropbox auf „Production“ gestellt werden muss.

## Dateien im App-Ordner

| Pfad | Inhalt |
|---|---|
| `/tasks/<id>.json` | Aufgabe: Titel, Notiz, Tags, Farbe (`color`), Schätzung (`estimateMinutes`), Deadline, Wiedervorlage, `activatedAt`, `archivedAt` |
| `/bookings/<id>.json` | Einplanung einer Aufgabe an einem Tag: `date`, `minutes`, `start` (`"HH:MM"` oder `null` = nur reserviert) |
| `/days/<YYYY-MM-DD>.json` | Kapazität eines einzelnen Tages, nur wenn sie vom Standard abweicht |
| `/settings.json` | Standard-Dauer, Kapazität pro Wochentag, Kernzeit |

Aufgaben und Einplanungen liegen bewusst in getrennten Dateien:

- Verschieben im Kalender schreibt nur die kleine Einplanungsdatei. Die Aufgabendatei mit der Notiz bleibt unberührt.
- Eine Aufgabe kann beliebig oft eingeplant werden, ohne dass ihre Datei wächst.

## Synchronisation

- Jedes Gerät hält einen eigenen Index aller Dateien in IndexedDB. Damit erscheint die App beim Start sofort.
- Danach holt die App über den Dropbox-Cursor nur die Änderungen seit dem letzten Mal.
- Über Longpoll kommen Änderungen anderer Geräte nach wenigen Sekunden an.
- Gespeichert wird lokal sofort, hochgeladen wird im Hintergrund. Auch offline gemachte Änderungen werden später hochgeladen.
- Konflikte: Jeder Upload gibt die zuletzt gelesene Version (`rev`) mit. Hat ein anderes Gerät inzwischen geschrieben, lehnt Dropbox den Upload ab. Die App führt dann beide Stände feldweise zusammen und lädt erneut hoch.

## Kalender im Hintergrund (Google, iCal)

Termine aus Google Calendar und aus iCal-Abos (Apple iCloud, Google, Outlook …) erscheinen hinter den eigenen Einplanungen. Pro Kalender lässt sich einstellen, ob er **angezeigt** wird und ob er **mitzählt**. Mitzählende Termine, die als „beschäftigt“ markiert sind, belegen Kapazität. Ein ganztägiger Termin belegt dabei die volle Tageskapazität. Aktualisiert wird alle 5 Minuten (einstellbar), solange die Seite sichtbar ist, oder über ⟳.

**Wo was liegt:**
- In `settings.json` (Dropbox, auf allen Geräten gleich): Quellen ein/aus, Kalenderauswahl, iCal-Adressen, Intervall.
- Nur im Browser: die Google-Anmeldung und die abgerufenen Termine als Zwischenspeicher.

**iCal-Abos:** Die Abo-Adresse (`https://…ics` oder `webcal://…`) unter ⚙︎ eintragen. Kalenderdienste erlauben keinen direkten Abruf aus dem Browser, deshalb holt die Netlify-Funktion [`netlify/functions/ics.mjs`](netlify/functions/ics.mjs) die Datei ab (`/api/ics`, Adresse per POST, nichts wird gespeichert). Lokal benutzt die App die Funktion der veröffentlichten Seite.

**Google Calendar (einmalig in der [Google Cloud Console](https://console.cloud.google.com/)):**
1. Projekt anlegen und die *Google Calendar API* aktivieren.
2. *Google Auth Platform* einrichten: Zielgruppe „Extern“, Datenzugriff `…/auth/calendar.readonly`, Testnutzer eintragen. Alternativ die App veröffentlichen; dann erscheint ein Hinweis „nicht überprüft“.
3. OAuth-Client vom Typ *Webanwendung* mit den JavaScript-Ursprüngen der Seite, z. B. `https://ralfw-dropplan.netlify.app` und `http://localhost:8080`.
4. Die Client-ID in `js/config.js` eintragen. Ein Client Secret wird nicht gebraucht und gehört nicht ins Repo.

Die Google-Anmeldung gilt pro Browser und etwa eine Stunde. Danach steht oben „Google neu verbinden“, und es reicht ein Klick.

## Code

| Datei | Aufgabe |
|---|---|
| `js/dropbox.js` | OAuth mit PKCE und Dropbox-API über `fetch` |
| `js/fakeremote.js` | Nachbildung der Dropbox für den Testmodus |
| `js/store.js` | Sync-Engine: Cache, Cursor, Upload-Warteschlange, Merge |
| `js/model.js` | Fachlogik: Aufgaben, Einplanungen, Kapazität |
| `js/ui-tasks.js`, `js/ui-calendar.js` | HTML für Liste, Monat und Woche |
| `js/drag.js` | Ziehen und Ablegen für Maus und Touch (auf Touch-Geräten lange drücken) |
| `js/app.js` | Verdrahtung, Dialoge, Popover |
| `js/calendars.js` | Externe Kalender: Abruf, Zwischenspeicher, Termine pro Tag, belegte Minuten |
| `js/google.js` | Google-Anmeldung (Google Identity Services) und Calendar API |
| `js/icsfeed.js` | iCal-Abos abrufen und einlesen |
| `netlify/functions/ics.mjs` | Abruf der iCal-Abos auf dem Server (wegen CORS) |

## Fremdcode

`js/vendor/ical.min.js` ist [ical.js](https://github.com/kewisch/ical.js) 2.2.1, unverändert, unter der Mozilla Public License 2.0 (siehe `js/vendor/ical.LICENSE.txt`).

Die Symbole für Archivieren und Löschen stammen von [Lucide](https://lucide.dev) (ISC-Lizenz).
