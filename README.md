# Ambulance Planner

Two modules, switchable from the top bar:

| Module | Page | What it is for |
|---|---|---|
| **Radius coverage** | `index.html` | Where to base ambulances: coverage radius, response time, NAS 2026 norms, traffic, day-wise plan. Works without any database. |
| **Route deployment** | `route.html` | Moving deployments: multi-stop road routes with timings, population covered, roster with pilot and EMT, QR link for the crew, live progress, dashboard, Excel export. Needs Supabase for real use. |
| Team page | `team.html` | Opened from the QR code on the crew's phone. No login. Shows only that one deployment. |

All files sit in one folder (no sub-folders), so GitHub upload is a single drag and drop. No build step.

## Settings: `config.js`

The only file you edit. Fill in the values between the quotes:

| Setting | Needed for | Where to get it |
|---|---|---|
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | Route deployment (database, admin login, QR links on any phone) | supabase.com → your project → Project Settings → API |
| `ORS_API_KEY` | Road distances and routes (Route deployment), road-time coverage and “Optimise order” | openrouteservice.org → Dashboard → token (free, no card) |
| `TOMTOM_API_KEY` | Optional: road times with typical traffic for the route’s start time; traffic calibration in Radius coverage | developer.tomtom.com → Dashboard → Keys (free, no card) |
| `OLA_MAPS_API_KEY` | Optional second routing engine | maps.olakrutrim.com |
| `GOOGLE_MAPS_API_KEY` | Optional Google map, search and traffic in Radius coverage | Google Cloud console (restrict to your site) |
| `ORG_NAME` | Name on team page and exports | — |

Without Supabase the Route module runs in **demo mode**: data stays in that browser, and QR links only open on the same device.

## Database: `setup.sql`

Run it once in Supabase → SQL Editor. It creates the tables (staff, ambulances, places (hospitals & bases), routes, deployments, pings, pop_grid, app_settings, app_admins), the access rules and the three functions the team page uses. Running it again is safe and is how you update: it only adds what is missing and never deletes data.

Security model:
- Admin pages need a Supabase login **and** the email on the admin list (`app_admins`). The first person to sign in becomes admin; add others in Route deployment → Settings → Admins.
- The team page cannot read any table. It can only call `team_get`, `team_event` and `team_ping` with the secret token in its QR link, and only for that deployment. “Make a new link” in the QR window cancels the old one.
- Turn off public sign-ups in Supabase (Authentication settings).

## How the numbers are worked out

- **Road distance**: from openrouteservice (OpenStreetMap roads), TomTom (with typical traffic) or Ola Maps, per leg. If a leg has no road route, its times stay blank; there is no straight-line fallback. A deployment can’t be shared until every leg has a road route.
- **Travel time**: road distance ÷ planned speed (default per route, override per stop), or the routing engine’s own estimate if you choose that.
- **Schedule**: start time → arrive → halt → leave → travel → next arrival. Change speed, halt, order or start time and all later times move. A fixed arrival or departure typed for a stop is marked *manual*, and later stops show how much they moved.
- **Population**: typed per stop, or from an uploaded population grid (CSV lat, lng, pop) within each stop’s radius. Overlapping circles are flagged; with a grid, the total counts each grid point once (unique population).
- **Delay**: actual time tapped by the crew minus planned time. Later stops’ ETAs move by the current delay.
- **Live location**: only while the crew has the team page open and has ticked “Share live location”. Scanning the QR is not tracking.

## Radius coverage features (new)

- **Coverage shape** (Settings → Map & scenario): *Circle* or *Hexagon*. A hexagon has its corners at the ambulance's radius; coverage %, overlap and response figures are counted inside the hexagons.
- **Hexagon grid** (Overlay → Hexagon grid): the target zone tiled with equal hexagons (0.5–3 km wide), each coloured by call → scene time from its centre. Hover a hexagon for the nearest ambulance, minutes, whether it is inside a coverage area, and its share of calls. The map key counts hexagons and calls per time band.
- **Saved layouts (database)** (Settings): save named layouts to Supabase (table `radius_layouts`), open them on any device, and autosave the open one. Admin sign-in is the same as Route deployment. Without Supabase they stay in the browser. The Route module's scenario file also backs them up.

## Route module features

- **Hospitals & bases** (Ambulances & staff tab, or “Add hospital / base” on the map): shown on both maps; pick one as an ambulance’s base; “Start at a base…” uses them; each stop’s hover shows the nearest hospital. Radius coverage → Bulk action → *Sync ambulances & hospitals* copies them across (same browser).
- **Show routes**: *This route*, *All routes* (each route in its own colour with a legend, total area, population and cross-route overlaps) or *By ambulance* (its default route plus routes of its deployments in the loaded roster weeks).
- **Hover** any stop for arrival, halt, departure, distance and speed from the previous stop, next stop, population and nearest hospital; hover a road for that leg’s times.
- **Import routes (Excel template)**: sheets *Routes* and *Stops*; location as lat, lng, a Google Maps link or a place name. A route with the same name is replaced. Roads are measured on import. *Download all routes* gives the same format.
- **Optimise order** (first stop fixed, optionally last), **Reverse**, **Print this route**.
- **Map & scenario** (same layout as Radius coverage): base maps (same list, with automatic fallback), overlay (response-time heatmap from the nearest stop, hexagon grid, population density), coverage shape per route (circle or hexagon), Show routes, toggles, Share on WhatsApp, Copy share link (opens the route for any signed-in admin), PDF report, Export stops (CSV), Save / Load scenario and Reset map to default.
- Deployment editor warns when the route ends after the shift.
- Team page: “Open the remaining stops in Google Maps” (up to 10 at a time).

## Files

| File | Purpose |
|---|---|
| `index.html` | Radius coverage module |
| `route.html`, `route.js` | Route deployment module (admin) |
| `team.html` | Crew page opened from the QR |
| `common.js`, `db.js` | Shared helpers and the database layer |
| `config.js` | Your settings (keys) |
| `setup.sql` | Database setup, run in Supabase |
| `leaflet.js`, `leaflet.css` | Map library (BSD-2, `leaflet-LICENSE.txt`) |
| `supabase.js`, `xlsx.js`, `qrcode.js` | Database client, Excel, QR code (`THIRD-PARTY-LICENSES.txt`) |
| `exo2-*.woff2` | Exo 2 font (OFL, `exo2-OFL.txt`) |
| `manifest.webmanifest`, `icon*`, `apple-touch-icon.png`, `sw.js` | Install as an app, offline start |
| `vercel.json` | Hosting headers |

The old `api` folder from earlier versions is no longer used; it can stay in GitHub or be deleted.
