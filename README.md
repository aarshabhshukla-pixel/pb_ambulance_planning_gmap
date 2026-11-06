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
| `ORS_API_KEY` | Road distances and routes (Route deployment) | openrouteservice.org → Dashboard → token (free, no card) |
| `OLA_MAPS_API_KEY` | Optional second routing engine | maps.olakrutrim.com |
| `GOOGLE_MAPS_API_KEY` | Optional Google map, search and traffic in Radius coverage | Google Cloud console (restrict to your site) |
| `ORG_NAME` | Name on team page and exports | — |

Without Supabase the Route module runs in **demo mode**: data stays in that browser, and QR links only open on the same device.

## Database: `setup.sql`

Run it once in Supabase → SQL Editor. It creates the tables (staff, ambulances, routes, deployments, pings, pop_grid, app_settings, app_admins), the access rules and the three functions the team page uses. Running it again is safe.

Security model:
- Admin pages need a Supabase login **and** the email on the admin list (`app_admins`). The first person to sign in becomes admin; add others in Route deployment → Settings → Admins.
- The team page cannot read any table. It can only call `team_get`, `team_event` and `team_ping` with the secret token in its QR link, and only for that deployment. “Make a new link” in the QR window cancels the old one.
- Turn off public sign-ups in Supabase (Authentication settings).

## How the numbers are worked out

- **Road distance**: from openrouteservice (OpenStreetMap roads) or Ola Maps, per leg. If a leg has no road route, its times stay blank; there is no straight-line fallback. A deployment can’t be shared until every leg has a road route.
- **Travel time**: road distance ÷ planned speed (default per route, override per stop), or the routing engine’s own estimate if you choose that.
- **Schedule**: start time → arrive → halt → leave → travel → next arrival. Change speed, halt, order or start time and all later times move. A fixed arrival or departure typed for a stop is marked *manual*, and later stops show how much they moved.
- **Population**: typed per stop, or from an uploaded population grid (CSV lat, lng, pop) within each stop’s radius. Overlapping circles are flagged; with a grid, the total counts each grid point once (unique population).
- **Delay**: actual time tapped by the crew minus planned time. Later stops’ ETAs move by the current delay.
- **Live location**: only while the crew has the team page open and has ticked “Share live location”. Scanning the QR is not tracking.

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
