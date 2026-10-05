# Lumina Calendar — Microsoft Store package guide

Lumina Calendar is a Progressive Web App (PWA). It runs completely offline, keeps all data on the
user's PC, and is packaged for the Microsoft Store with **PWABuilder**, exactly like your other Store
apps. This folder is the complete website — upload it as-is to a GitHub repository.

```
Lumina/
├── index.html              the app
├── css/app.css             styles (light + dark, LTR + RTL)
├── js/app.js               views, editor, quick add, calendars, settings, reminders, sync, sharing
├── js/core.js              dates, repeating events, ICS import/export, sync merge
├── js/nlp.js               natural-language parser (English + Arabic)
├── js/store.js             IndexedDB storage
├── js/i18n.js              English / Arabic strings
├── js/icons.js             bundled icons (Lucide, ISC licence)
├── sw.js                   service worker — offline support + updates
├── manifest.webmanifest    PWA manifest (name, icons, shortcuts, screenshots)
├── privacy.html            privacy policy (English + Arabic) — link it in Partner Center
├── icons/                  app icons (16 → 1024 px, maskable, monochrome, favicon)
└── screenshots/            screenshots referenced by the manifest
```

---

## 1. Publish the site on GitHub Pages

1. On GitHub create a **public** repository named `Lumina` (under your HAYMOHSEN account).
2. Upload **everything in this folder** to the root of the `main` branch (keep the sub-folders
   `css`, `js`, `icons`, `screenshots`). The easiest way: *Add file → Upload files*, drag the whole
   folder contents in, commit.
3. Repository **Settings → Pages → Build and deployment**: Source = *Deploy from a branch*,
   Branch = `main`, folder = `/ (root)`, Save.
4. After a minute the app is live at **https://haymohsen.github.io/Lumina/** (case-sensitive — the
   repository name decides the address). Open it in Edge and check:
   - the calendar loads and you can add an event;
   - `https://haymohsen.github.io/Lumina/manifest.webmanifest` opens as JSON;
   - `https://haymohsen.github.io/Lumina/privacy.html` opens (this is your Privacy Policy URL).

If you name the repository differently, nothing else needs to change — all paths in the app are
relative.

---

## 2. Reserve the name in Partner Center

1. Partner Center → *Apps and games → New product → MSIX or PWA app*.
2. Reserve the name **Lumina Calendar** (if it is taken, try *Lumina Smart Calendar* or
   *Lumina — Smart Calendar*; whatever you reserve must be used **exactly** in step 3).
3. Open the new product → *Product management → Product identity* and keep the page open. You need:
   - **Package Identity Name** (looks like `12345HaniMuhsen.LuminaCalendar`)
   - **Package/Identity/Publisher** (looks like `CN=XXXXXXXX-XXXX-...`)
   - **Publisher display name**

---

## 3. Build the Store package with PWABuilder

1. Go to **https://www.pwabuilder.com**, paste `https://haymohsen.github.io/Lumina/` and press *Start*.
   The report card should show the manifest, the service worker and the icons all detected.
2. Press **Package for stores → Windows → Generate package** and fill the form:
   - **Package ID** → Package Identity Name from Partner Center
   - **Publisher ID** → Package/Identity/Publisher (the `CN=…` value)
   - **Publisher display name** → your publisher display name
   - **App name** → *the exact reserved Store name* (e.g. `Lumina Calendar`). This is the value the
     Store rejected last time for Awraq PDF when it did not match — it must be identical, including
     spaces and punctuation.
   - **App version** → `1.0.1` and **Classic app version** → `1.0.0` (the Store requires the classic
     package version to be lower than the app version). For every later update raise both numbers.
   - Leave the icon and URL fields as detected (the 512 px icon is in the manifest).
3. Download the zip. Inside you will find a `.msixbundle` (the real package) and a `.appx` (classic
   package). Upload **both** in the submission.

Tip: in the *Windows → Options* panel PWABuilder can also generate all Windows tile images from
`icons/icon-1024.png`; the default generated set is fine.

---

## 4. Submit in Partner Center

- **Packages**: upload the `.msixbundle` and the classic `.appx` from the PWABuilder zip.
- **Pricing and availability**: one-time price (see `STORE-LISTING.md` for a suggestion), all markets.
- **Properties**: Category *Productivity*; Privacy policy URL
  `https://haymohsen.github.io/Lumina/privacy.html`; support contact `haymohsen@gmail.com`.
- **Age ratings**: complete the IARC questionnaire — the app has no user-generated public content,
  no ads, no purchases, no location → rated for everyone.
- **Store listing**: copy the texts from `STORE-LISTING.md` (English and Arabic listings), upload the
  screenshots from the `store-assets` folder (1920×1080) and the 1080×1080 logo tile.
- Submit for certification. Certification usually takes 1–3 days.

---

## 5. Releasing an update later

1. Change the files, then open `sw.js` and raise `VERSION` (e.g. `lumina-v1.1.1`) — this is what
   tells installed copies that a new version exists. Also update `APP_VERSION` at the top of
   `js/app.js` so the About section shows the new number.
2. Upload the changed files to GitHub. Every installed copy picks the update up automatically the
   next time it is opened (a *"new version ready — Reload"* toast appears).
3. A new Store submission is only needed when something about the package changes (name, icon,
   identity). The Store package simply points at the website, so content updates do **not** require a
   resubmission.

---

## Features at a glance (version 1.1)

- **Quick add in plain language** (English and Arabic): "Lunch with Sara tomorrow 1pm for 2 hours,
  remind me 30 min before at Cafe Nero", «اجتماع كل اثنين الساعة 9 صباحاً في قاعة ب». A live preview
  shows how it was understood; Enter saves, Shift+Enter opens the full editor.
- Month, week (time grid with overlap layout) and agenda views; "Smart Agenda" sidebar with
  *Next up* countdown, overlap warnings and monthly / weekly counts.
- **Several calendars**: the six built-in ones can be renamed and recoloured, new ones added, and any
  of them hidden or shown from the sidebar. **Subscribe to public .ics feeds** (holidays, timetables);
  they refresh when online and are read-only.
- Events with start/end time or all-day, location and notes; repeating events (daily / weekly /
  monthly / yearly, optional end date) — delete one occurrence or the whole series.
- Reminders with Windows notifications and an optional sound (while the app is open or minimised);
  **Add to Windows Calendar / Outlook** hands an event with its reminder to Windows so it fires even
  when Lumina is closed; a settings tip explains how to start Lumina at sign-in (shell:startup).
- **Share an event** through the Windows share panel (as an .ics invitation plus text), copy its
  details, or save the invitation file.
- Drag an event to another day; double-click a day or click a free slot in the week to add one.
- Search across all events; keyboard shortcuts (N, T, Q, ←/→, 1/2/3, /, Esc).
- English and Arabic (full right-to-left layout), optional Hijri dates, Western or Arabic-Indic
  digits, 12/24-hour time, week starting Saturday/Sunday/Monday, light/dark/system theme.
- **Sync & backup folder**: every change is written to `lumina-calendar-backup.json` in a folder the
  user picks, and Lumina also reads changes written there by Lumina on other PCs (newest edit wins,
  deletions carried across). Put the folder in OneDrive / Google Drive / Dropbox and the calendar
  follows the user between PCs — with no account and no server.
- JSON export/import, ICS export/import (works with Outlook and Google Calendar files).
- Fully offline after the first launch; Windows jump-list shortcuts (*New event*, *Agenda*).

### What stays a limitation (by design of a PWA)

- No live collaboration or RSVP tracking: sharing is by invitation file / text.
- Reminders need Lumina open or minimised; the two bridges above cover the closed-app case.
- Feed subscriptions only work for servers that allow browser access (CORS). GitHub Pages and most
  published holiday/timetable feeds do; Google's and Outlook's private links do not — the app says so
  and the user can import the .ics file instead.

## Credits

Icons: [Lucide](https://lucide.dev) — ISC licence. Everything else © Hani Muhsen.
