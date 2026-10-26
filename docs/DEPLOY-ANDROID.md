# Putting Crop Analytics on farmers' phones

There are two ways to get the app onto a phone, and they share the same
foundation:

| | **A. Direct install** | **B. Play Store app** |
|---|---|---|
| How a farmer gets it | Opens a link, taps Install | Searches the Play Store |
| What it is | A **PWA** — Chrome builds a real app on the device | A **TWA** — an APK containing your website |
| Address bar visible? | No | No, *if* Digital Asset Links is set up |
| Cost | Free | US$25 once |
| Time to first release | Minutes | A few days, including review |
| Signing key you must never lose | — | Yes |
| Privacy policy, data-safety form | — | Mandatory |
| Getting a fix to farmers | Next time they open it | Next time they open it |

**This is the approach you were describing** — many banks and airlines ship a
Play Store app that is really their website in a full-screen wrapper. It is
called a **Trusted Web Activity (TWA)**.

The important thing: **B is built from A.** A TWA has no code of its own — it is
a thin APK that opens your PWA full-screen using Chrome's engine. So the work
already done is the prerequisite, not something replaced. Both routes ship the
same app, and both update the same way: you deploy, and the next time a farmer
opens it they are on the new version. No app-store review for content changes.

Do **[DEPLOY.md](DEPLOY.md)** first. Both routes need the site live on HTTPS.

---

## Contents

- [Part A — Direct install (works today)](#part-a--direct-install)
- **[Part B — The Play Store app (TWA)](#part-b--the-play-store-app-twa)**
  1. [What you need](#b1-what-you-need)
  2. [Generate the APK with Bubblewrap](#b2-generate-the-app-with-bubblewrap)
  3. [The signing key](#b3-the-signing-key--read-this-twice)
  4. [Digital Asset Links — the step that removes the address bar](#b4-digital-asset-links)
  5. [Play Console setup](#b5-play-console-setup)
  6. [Release, and release again](#b6-release-and-release-again)
- [Changing the icon](#changing-the-icon)
- [How updates reach farmers](#how-updates-reach-farmers)
- [Testing](#testing)
- [Troubleshooting](#troubleshooting)

---

# Part A — Direct install

Already working. Send farmers the link: `https://app.yourdomain.com`

**Android (Chrome):** open the link, tap **Install** on the login screen, confirm.
Chrome generates a real app on the device — its own icon, its own entry in the
app drawer and in Settings → Apps. It is not "a bookmark".

**iPhone (Safari):** Apple offers no install button, so the app shows the steps:
**Share** → **Add to Home Screen**. Chrome on iOS cannot do this; it must be
Safari.

Useful while you wait for a Play Store listing, and for iOS, where a TWA is not
an option at all.

---

# Part B — The Play Store app (TWA)

## B1. What you need

- The site live on HTTPS with a working PWA — done, if the site is deployed.
- **JDK 17+** and the **Android SDK**. Both are already installed on this
  machine. Bubblewrap can also fetch its own copies.
- A **Play Console account**: US$25 once, at
  [play.google.com/console](https://play.google.com/console). Identity
  verification takes a day or two, and a business account needs a D-U-N-S
  number — start this early.

## B2. Generate the app with Bubblewrap

[Bubblewrap](https://github.com/GoogleChromeLabs/bubblewrap) is Google's tool for
exactly this. It reads your live manifest and produces an Android project.

```bash
cd ~/Desktop/personal/crop-pulse
mkdir -p android-twa && cd android-twa

npx @bubblewrap/cli init \
  --manifest https://app.yourdomain.com/manifest.webmanifest
```

It asks a series of questions. The answers that matter:

| Question | Answer |
|---|---|
| Application ID | `com.geotrans.cropanalytics` — must match `set-assetlinks.mjs` |
| App name | Crop Analytics |
| Display mode | `standalone` |
| Status bar colour | `#1e1a5f` |
| Include support for Play Billing | No |
| Signing key | Create a new one — see B3 immediately below |

Then build:

```bash
npx @bubblewrap/cli build
```

You get `app-release-bundle.aab` (for the Play Store) and `app-release-signed.apk`
(for testing on a phone directly).

> `android-twa/` is generated and holds your signing key. **Do not commit it.**
> Add `android-twa/` to `.gitignore` before your first commit after this step.

## B3. The signing key — read this twice

Android apps are signed, and the signature is what proves an update came from
you.

**If you lose this key you can never update the app again.** Not "it is
difficult" — you would have to publish a new listing under a new package name and
ask every farmer to reinstall. This is the most common irreversible mistake in
Android publishing.

When Bubblewrap creates the keystore:

1. **Copy the `.keystore` file into a password manager**, or somewhere backed up
   that is not this laptop.
2. **Store the password with it.** The key is useless without it.
3. Never commit it. The repository's `.gitignore` already excludes `*.keystore`,
   `*.jks` and `keystore.properties`.

> **Accept Play App Signing** when the Play Console offers it. Google then holds
> the final signing key and you keep only an *upload* key, so losing yours stops
> being fatal. This also changes which fingerprint goes in the next step.

## B4. Digital Asset Links

**This is the step that makes it look like an app instead of a browser.**

Android will not trust an APK's claim to own your website just because it says
so. You prove it by publishing a file at your domain that names the app. Without
it the app still works, but Chrome shows a **URL bar across the top** — the exact
thing you are trying to avoid.

### Get the fingerprint

If you accepted Play App Signing (recommended), use Google's key, not yours:

> Play Console → your app → **Setup → App integrity → App signing** →
> **App signing key certificate** → copy the **SHA-256 certificate fingerprint**.

If you are signing everything yourself:

```bash
keytool -list -v -keystore android.keystore -alias android | grep SHA256
```

### Publish it

```bash
cd ~/Desktop/personal/crop-pulse/frontend
npm run assetlinks -- "AA:BB:CC:...:FF"     # paste the fingerprint
```

That writes `public/.well-known/assetlinks.json`. Commit and push; the deploy
pipeline publishes it with the right content type and no caching, because a stale
copy here breaks the app's trust check.

### Verify it

```bash
curl https://app.yourdomain.com/.well-known/assetlinks.json
```

You should get JSON back, not an HTML page. Then check Google agrees:

```
https://digitalassetlinks.googleapis.com/v1/statements:list?source.web.site=https://app.yourdomain.com&relation=delegate_permission/common.handle_all_urls
```

A `"maxAge"` in the response and no error means it is valid.

> Order matters and trips people up: you cannot get the final fingerprint until
> you have uploaded a build to the Play Console, but the app shows a URL bar
> until the fingerprint is published. That is expected. Upload first, publish
> assetlinks second, then re-test with an internal-testing build.

## B5. Play Console setup

**Create app** → name *Crop Analytics*, language, **App**, **Free**.

Then the paperwork. All of it is mandatory, and it is where most first
submissions stall:

| Item | What applies to this app |
|---|---|
| **Privacy policy URL** | **Required** — the app collects a phone number. Must be a public URL; host it next to the web app. |
| **Data safety** | Declare you collect **phone number** for *Account management / App functionality*, **encrypted in transit** (true — HTTPS), and whether users can request deletion. |
| **Account deletion** | Google requires apps with sign-in to offer a deletion route, including a web URL. See the note below. |
| **Content rating** | Questionnaire. This app rates *Everyone*. |
| **Target audience** | 18+. Do not tick "designed for children". |
| **App access** | Sign-in is required, so **you must give reviewers a way in**. Without this they will reject the app. |
| **Store listing** | Short description (80 chars), full description, icon (512×512), feature graphic (1024×500), and at least two phone screenshots. |

> **Both of the old gaps here are now built.** What is left is filling in real
> details and ticking the boxes.

### Privacy policy and account deletion — the URLs to paste

Two static pages ship with the site, so they are live the moment you deploy and
they load even if the app itself fails to start:

| Play Console field | URL |
|---|---|
| Privacy policy | `https://app.yourdomain.com/privacy.html` |
| Account deletion | `https://app.yourdomain.com/delete-account.html` |

Both are also linked from the bottom of the sign-in screen, because Google
requires them to be reachable **inside** the app and not only from the listing.

> **Before you submit:** open `frontend/public/privacy.html` and
> `frontend/public/delete-account.html` and replace every `[SQUARE BRACKET]`
> with the real mill email, phone, address, region and date. A policy with
> placeholder contact details is worse than none — and make sure whoever
> receives deletion requests knows to act on them within 30 days.

### Reviewer access — the fixed-code sign-in

A Google reviewer sitting outside India cannot receive your OTP, and Play
rejects apps behind a sign-in with no way in. So one number can be given a
**fixed code that is never sent by SMS**:

```bash
# in backend/.env on the server
REVIEW_PHONE=+919000000000     # a demo account you control
REVIEW_OTP=424242              # must be exactly OTP_LENGTH digits
```

Then restart the API and put the same number and code in Play Console under
**App access → All functionality is restricted**.

How it behaves:

- The number must **also be enrolled normally** — as a farmer, or as a read-only
  admin from the admin screen. This only changes how its code is made and
  delivered, never who it turns out to be. Point it at a demo account with
  little data.
- Everything else is unchanged: the code is still hashed, still expires in five
  minutes, still single use, still locks after five wrong attempts.
- The code is never returned by the API, so it cannot be discovered by calling
  the endpoint.
- Blank means the feature does not exist. There is no default number and no
  default code.
- Setting only one of the two, or a code that is not exactly `OTP_LENGTH`
  digits, **stops the API from starting** rather than half-working.
- Every boot logs a warning while it is on.

> **Treat the pair as a password.** Anyone who learns both can sign in as that
> account. Clear both and restart once review is done.

## B6. Release, and release again

Use the test tracks — they exist so a bad build does not reach everyone at once.

1. **Internal testing** — up to 100 testers by email, live within minutes. Always
   start here, and confirm there is no URL bar.
2. **Closed testing** — a wider group, e.g. one unit's field officers.
3. **Production** — everyone. First review takes a few days; later ones hours.

For production, use a **staged rollout** (20% → 50% → 100%) so you can halt it if
something is wrong.

### When do you need a new Play release?

Almost never. The APK is a shell around your website, so:

| Change | New Play release? |
|---|---|
| Anything in the web app — screens, colours, layout | **No.** Deploy, and it is live. |
| New survey date, categories, units, backend fixes | **No.** |
| App name, icon, or the URL it opens | **Yes** |
| Android API level bumps Google mandates yearly | **Yes** |

When you do need one, bump `appVersion` and `appVersionCode` in
`android-twa/twa-manifest.json`, then:

```bash
cd android-twa
npx @bubblewrap/cli update      # pulls in the latest manifest/icons
npx @bubblewrap/cli build
```

`appVersionCode` must be **higher** than the last upload or Google rejects it.

---

## Changing the icon

Both routes use the same source. Replace `frontend/assets/app-icon.svg`
(**square**, same name), then:

```bash
cd frontend
npm run icons          # regenerates every size, including maskable and iOS
```

Commit the results in `public/icons/`. For the Play Store app, re-run
`npx @bubblewrap/cli update` so the APK picks up the new icons.

Design it to work small: a wordmark is unreadable at 48px, which is why the icon
is a simple mark rather than the GEOtrans logotype. Keep the important part in
the middle 80%, or Android's icon cropping will cut it.

---

## How updates reach farmers

```bash
git push
```

The pipeline builds and publishes; the service worker fetches the new version in
the background; the next time the farmer opens the app they are on it. Identical
for both routes — a TWA loads your live site, so it is updated the moment you
deploy.

Backend changes — new survey dates, renamed categories, recoloured legends, a new
unit — reach everyone immediately, because those come from the API rather than
being built into the app.

---

## Testing

### Where the Install button appears (Part A)

Not mobile-only — Chrome and Edge on a desktop can install it too, which is the
quickest way to check changes. It needs **all** of:

| Requirement | Notes |
|---|---|
| HTTPS, or `localhost` | `localhost` counts as secure |
| A linked manifest | Generated by the build |
| A registered service worker | Generated by the build |
| Not already installed | Uninstall, or use a fresh profile, to see it again |

**Firefox and desktop Safari cannot install PWAs** — the button will never appear
there, and that is normal.

`npm run dev` serves the manifest and a service worker, so the button works
locally. For something closer to production:

```bash
cd frontend
npm run build && npm run preview      # http://localhost:4173
```

Then in Chrome DevTools: **Application → Manifest** (no errors, four icons) and
**Application → Service Workers** (activated and running).

### Testing the TWA

Install the signed APK directly:

```bash
adb install android-twa/app-release-signed.apk
```

**The thing to check: is there a URL bar at the top?** If yes, Digital Asset
Links is not working — see B4 and the troubleshooting table.

### Debugging on a real phone

Plug it into your Mac, open **Chrome** on the Mac, go to `chrome://inspect`, and
click **inspect**. You get the full DevTools console and network tab for what is
running on the phone — for both the PWA and the TWA, since both are Chrome.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| **TWA shows a URL bar** | Digital Asset Links failed. Check the file is reachable, the fingerprint matches the key Google actually signs with (Play App Signing changes it), and the package name matches exactly. Then reinstall — Android caches the check. |
| `assetlinks.json` returns HTML | It is not being served. Confirm it is in `dist/.well-known/` after a build, and that the deploy uploaded it. |
| Play rejects: version code | `appVersionCode` must be higher than the last upload. |
| Play rejects: "cannot access the app" | No working test credentials under **App access**. |
| No Install button on Android (Part A) | Not HTTPS; already installed; or dismissed — clear site data to see it again. |
| Nothing happens on iOS | They are using Chrome. Only **Safari** can install on iOS. |
| App shows an old version | The service worker updates on the *next* open. Fully closing and reopening applies it. |
| Works on wi-fi, blank on mobile data | Not an app issue — check the API is reachable and `CORS_ORIGINS` lists your domain. |

---

## What neither route can do

| Limit | Does it matter here? |
|---|---|
| No camera, GPS or filesystem beyond browser APIs | The app needs none of these |
| Push notifications: Android yes, iOS only from 16.4+ and only once installed | Not used today. Worth revisiting to alert farmers to a new survey. |
| Genuine offline use needs more work | The app shell loads offline; the data does not. Say the word if farmers need offline access in the field. |
| TWA is Android only | iOS has no equivalent — Part A is the route there. |
