# NYC Tennis & Padel Courts Map

## What this project is
A single-page web app that maps every tennis and padel court/facility in Manhattan, Brooklyn, Queens, and the Bronx. Built with vanilla HTML/JS — no framework, no build step.

## Stack
- **Map:** Google Maps JavaScript API (basemap tiles + markers)
- **Court data:** OpenStreetMap via Overpass API (fetched live on page load)
- **Geocoding:** Nominatim (free, OSM-based)
- **Drive-time routing:** OSRM public server (free, no API key)
- **Font:** Inter via Google Fonts

## Key file
- `index.html` — the entire app lives here (HTML + CSS + JS, ~700 lines)

## API keys
- Google Maps: stored directly in the `<script src>` tag at the bottom of index.html
- Restrict the key at: https://console.cloud.google.com/google/maps-apis/credentials

## Deployment
- GitHub repo: https://github.com/jsimon1997/nyc-courts
- Live site: https://jsimon1997.github.io/nyc-courts (GitHub Pages, auto-deploys on push to master)
- To deploy: `git add index.html && git commit -m "..." && git push`

## How the app works
1. Page loads → fetches all tennis/padel courts in NYC bounding box from Overpass API
2. Courts are clustered: named facilities group by name, unnamed group within 300m radius
3. Known false positives (closed clubs, non-tennis venues) are filtered via OVERRIDES list
4. Each cluster becomes one marker, color-coded by access type
5. Clicking a marker shows a popup; unnamed courts reverse-geocode via Nominatim on first click
6. Address filter: user types home address → Nominatim geocodes it → OSRM calculates drive times → filters markers

## Color coding
- 🔵 Blue border = Tennis, 🟠 Orange border = Padel
- 🟢 Green fill = First come, first serve
- 🟡 Yellow fill = Reservable / NYC Parks permit required
- 🟣 Purple fill = Membership only
- ⚪ Grey fill = Unknown access

## Common tasks
- **Add/fix a known facility:** edit the `OVERRIDES` array in index.html
- **Adjust clustering radius:** change the `300` in the greedy clustering loop
- **Change map style:** edit the `MAP_STYLE` array in `initMap()`
- **Push to GitHub:** `git add index.html && git commit -m "description" && git push`
