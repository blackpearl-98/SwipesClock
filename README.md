# SwipeClock — greytHR Swipes Time Tracker (Chrome Extension)

A clean, lightweight Manifest V3 Chrome extension for greytHR (`https://*.greythr.com/*`).

## What It Does
- **Consent-gated sync**: SwipeClock waits for the user to allow swipe access before reading greytHR page or API data. After consent, it uses same-origin greytHR requests and falls back to Shadow DOM scraping when the Swipes view is open.
- **Cross-tab live sync**: Works even when greytHR is open in a background tab, and caches today's swipes locally using your local timezone date.
- **Live Circular Timer (`HH:MM:SS`)**: Counts your effective working hours second-by-second while clocked in.
- **Ideal Leaving Time**: Instantly tells you when you hit your daily shift target (`8h`, `8.5h`, `9h`, or custom `HH:MM:SS`).
- **Gross, Break & Remaining**: Shows paired IN → OUT sessions (Present → Past) and break totals at a glance.
- **Toolbar Badge**: Displays your logged hours (e.g. `6.2h` or `OK`) directly on the Chrome extension icon.

## Privacy
- Swipe data is stored only in Chrome local storage. Daily target preferences are stored in Chrome Sync.
- SwipeClock does not capture or store Authorization headers and does not send swipe data to a SwipeClock server.
- Users can stop sync and clear the swipe cache from the popup.
- Site access is limited to `https://*.greythr.com/*`; the extension does not request the separate `activeTab` permission.

## Configured Default Target
- Daily Shift Target: 08:00:00
- Time Format: 24h
- Double-Tap Debounce: 2 min

## Install in Chrome
1. Unzip this folder to a permanent directory.
2. Open `chrome://extensions` in Google Chrome.
3. Enable **Developer mode** (top-right).
4. Click **Load unpacked** and select the unzipped folder containing `manifest.json`.
5. Open the SwipeClock popup and allow swipe access. SwipeClock then syncs while a greytHR tab is open.

---
Developed with ❤️ in Hyderabad by BlackPearl.
