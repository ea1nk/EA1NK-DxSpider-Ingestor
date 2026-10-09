```
███████╗ ██████╗ ██████╗     ██████╗ ███████╗██╗   ██╗██╗ ██████╗███████╗███████╗
██╔════╝██╔════╝██╔═══██╗    ██╔══██╗██╔════╝██║   ██║██║██╔════╝██╔════╝██╔════╝
███████╗██║     ██║   ██║    ██║  ██║█████╗  ██║   ██║██║██║     █████╗  ███████╗
╚════██║██║     ██║▄▄ ██║    ██║  ██║██╔══╝  ╚██╗ ██╔╝██║██║     ██╔══╝  ╚════██║
███████║╚██████╗╚██████╔╝    ██████╔╝███████╗ ╚████╔╝ ██║╚██████╗███████╗███████║
╚══════╝ ╚═════╝ ╚══▀▀═╝     ╚═════╝ ╚══════╝  ╚═══╝  ╚═╝ ╚═════╝╚══════╝╚══════╝
                                                                                 
███████╗ █████╗  ██╗███╗   ██╗██╗  ██╗                                           
██╔════╝██╔══██╗███║████╗  ██║██║ ██╔╝                                           
█████╗  ███████║╚██║██╔██╗ ██║█████╔╝                                            
██╔══╝  ██╔══██║ ██║██║╚██╗██║██╔═██╗                                            
███████╗██║  ██║ ██║██║ ╚████║██║  ██╗           
2026 EA1NK-DxSpider-Ingestor
```

# :card_index: DXSpider Ingestor API

This repository is designed to run in Docker and is part of the EA1NK-Docker-DxSpider project:
https://github.com/ea1nk/EA1NK-Docker-DxSpider

Node.js service that ingests DX spots from one or more DX clusters, enriches them with CTY data from `cty_dict.json`, stores them in MongoDB, and provides:
- A live spots web page with propagation data and filters
- An activity statistics page with a world heatmap
- An administration panel (sources, users, system status) with JWT login
- A REST API (history, activity, space weather) and a WebSocket stream for real-time spots
- Spanish and English interface

## Runtime overview

1. Connects to one or more DX clusters via telnet (sources managed from `/admin`, each with its own backup nodes).
2. Parses each `DX de ...` line into a normalized spot; spots repeated across sources are stored once.
3. Enriches `spotter` and `spotted` callsigns with `lookupCallsignInfo` from `callsignLookup.js`.
4. Buffers spots and writes to MongoDB in batches (`BUFFER_LIMIT`).
5. Serves the web UI, API and WebSocket with Fastify on port `3000`.

Users, DX cluster sources and settings are stored in SQLite (`DATA_DIR/ingestor.db`, mounted at `./data` by `docker-compose.yml`). Spots stay in MongoDB.

## Web views

All pages are in Spanish by default, with an ES | EN switch in the header (or `?lang=en`). They share a `Powered by EA1NK - SCQ Devices` footer.

### `/` Live spots
- Real-time spot table (one line per spot) with UTC time, frequency, DXCC entity and flag, mode, LoTW/eQSL, spotter and comment/SNR. Double-click a callsign to open QRZ.
- Filter bar: bands, modes, RBN/manual, LoTW/eQSL and watched callsigns; active filters shown as removable chips, remembered in the browser.
- Space weather: SFI and SSN (30-day trend), A and K indices, X-ray class, solar wind, Bz, HF noise and NOAA R/S/G scales.
- Side panel: HF band conditions day/night, band activity and most active entities/callsigns (last hour), Kp (3 days + NOAA forecast), GOES X-ray (6 h), VHF conditions and a live image of the Sun (NASA SDO).
- UTC/local clocks and DX cluster connection status. Reconnects automatically and recovers recent spots after a disconnection.

### `/activity` Activity statistics
Period selector (15 min, 1 h, 6 h, 24 h), refreshed every minute:
- KPIs: spots and spots/min, unique callsigns, DXCC entities, spotters, RBN vs manual, busiest band.
- **World heatmap** of spot density, switchable between DX stations and spotters. Positions are approximate: CTY coordinates of the entity or prefix area (e.g. `K9` and `K` are different points).
- Spots over time, band × time heatmap (with table view), bands and modes, continent-to-continent paths (who hears whom), most spotted DXCC entities and callsigns, most active spotters, and spots per source when there are several.

### `/admin` Administration
See below.

### Error pages
Browsers get styled 404/500 pages; API clients get JSON.

## Administration (`/admin`)

- **Status**: uptime, spots per minute, stored spots, CPU/memory, per-source connection state and stats, external data sources.
- **Sources**: add, edit, enable/disable, reconnect or delete DX cluster sources. Each source has its own callsign (use a different SSID per source), login commands (default `set/skim`) and backup clusters.
- **Users**: create users, change roles and passwords. `admin` can use `/admin`; `user` can use the history API (`/api/spots`).
- **My account**: change your own password.

On first start:
- If there are no sources, one is created from `DX_HOST`, `DX_PORT`, `CALLSIGN` and `DX_HOST_BACKUP` in `.env`. After that, sources are managed only from `/admin`.
- If there are no users, an admin is created from `ADMIN_USERNAME` / `ADMIN_PASSWORD`. If `ADMIN_PASSWORD` is not set, a random password is printed once in the container log (`docker logs dxspider-ingestor`).

## Configuration

Environment variables:

- `MONGO_URL` (default: `mongodb://db:27017`)
- `DB_NAME` (default: `spider_spots`)
- `COLLECTION_NAME` (default: `spots`)
- `DATA_DIR` (SQLite directory, default: `./data`; `/data` in Docker)
- `ADMIN_USERNAME` / `ADMIN_PASSWORD` (initial admin, only used when there are no users)
- `SECRET_KEY` (JWT signing key; if unset, a random key is generated and stored in SQLite)
- `TOKEN_TTL` (JWT lifetime, default: `12h`)
- `TRUST_PROXY` (`true` only behind a reverse proxy, so the login rate limit uses the real client IP)
- `DX_HOST`, `DX_PORT`, `CALLSIGN`, `DX_HOST_BACKUP`, `DX_PORT_BACKUP` (only seed the first source on first start)
- `FAILOVER_ATTEMPTS` (consecutive failures before switching node, default: `3`)
- `PRIMARY_CHECK_INTERVAL_MS` (how often to check the primary while on backup, default: `300000`)
- `RECONNECT_DELAY_MS` (default: `10000`)
- `CONNECT_TIMEOUT_MS` (default: `15000`)
- `INACTIVITY_TIMEOUT_MS` (reconnect if no data is received, default: `300000`)
- `HEALTH_GRACE_MS` (`/health` returns 503 once every source has been down this long, default: `120000`)
- `MAX_BUFFER` (max spots kept in memory while MongoDB is unavailable, default: `5000`)
- `RECENT_SPOTS_LIMIT` (recent spots sent to WebSocket clients on connect, default: `200`)
- `WS_HEARTBEAT_MS` (WebSocket heartbeat interval, default: `30000`)
- `SPACE_WEATHER_REFRESH_MS` (refresh interval for propagation data, default: `900000`)
- `API_PASSWORD` (legacy password-only login, read-only API token; leave empty to disable)
- `DISABLE_TOKEN_AUTH` (`true` makes `/api/spots` public)

## Authentication

### `POST /login`
Returns a JWT token for a user stored in SQLite. Max 10 failed attempts per IP every 15 minutes (HTTP 429).

```json
{ "username": "admin", "password": "your-password" }
```

Response:

```json
{ "token": "<jwt-token>", "user": { "id": 1, "username": "admin", "role": "admin" } }
```

Legacy: `{ "password": "<API_PASSWORD>" }` without username still returns a read-only API token.

Use the token in protected endpoints:

`Authorization: Bearer <jwt-token>`

### `GET /api/me` / `POST /api/me/password`
Current user, and change own password (`{ "currentPassword", "newPassword" }`).

## Endpoints

### `GET /api/spots` (protected)
Returns spot history sorted by `timestamp` descending. Requires a token unless `DISABLE_TOKEN_AUTH=true`.

Query params:

- `mode`: exact match against stored `mode` field (auto uppercased)
- `band`: exact match (`160m`, `80m`, `40m`, etc.)
- `limit`: max results (default: `100`, max: `1000`)

Example:

```bash
curl -H "Authorization: Bearer <token>" \
  "http://localhost:3000/api/spots?band=20m&mode=CW&limit=50"
```

### `GET /api/space-weather` (public)
Solar indices and propagation data, refreshed every 15 minutes (`SPACE_WEATHER_REFRESH_MS`) from open sources and cached by the server:
- `hamqsl`: N0NBH / HamQSL (SFI, SSN, A, K, X-ray, solar wind, HF band conditions day/night, VHF phenomena, noise, MUF)
- `kp`: NOAA planetary Kp, last 3 days
- `xray`: GOES X-ray flux (0.1-0.8 nm), last 6 hours, current and max class
- `windSpeed`, `windMag`: solar wind speed and IMF Bt/Bz (NOAA)
- `scales`: NOAA R/S/G scales and 3-day forecast
- `daily`: daily SFI and sunspot number, last 30 days (NOAA)
- `sources`: per-source status and last update

### `GET /api/activity` (public)
Spot activity over the last 60 minutes from stored spots: `total`, and counts by `bands`, `modes`, `countries`, spotted `calls` and `sources`. Cached for 60 s.

With `?detail=1&minutes=15|60|360|1440` it returns the data used by `/activity`: `timeline`, `bandTime` (band × time buckets), `continents` (spotter → DX continent), unique counts, RBN/manual split, top `countries`/`calls`/`spotters`, and `map.spotted` / `map.spotters` (spot counts per CTY coordinate, longitude east-positive). Results are cached (1 min for ≤ 1 h, 5 min otherwise) and the 6 h / 24 h windows are refreshed in the background.

### Admin API (`/api/admin/*`, role `admin`)

- `GET /api/admin/status`: system status and statistics
- `GET|POST /api/admin/sources`, `PUT|DELETE /api/admin/sources/:id`, `POST /api/admin/sources/:id/reconnect`
- `GET|POST /api/admin/users`, `PUT|DELETE /api/admin/users/:id` (the last admin cannot be removed or demoted)

### Errors
Browsers get a styled 404/500 page; API paths (`/api/*`, `/login`, `/health`) and non-HTML clients get `{ "error": "..." }`.

### `GET /ws` (websocket)
Real-time stream of parsed/enriched spots.

Each message is a JSON spot document.

Besides spots, the server sends two control messages (they have no `spotted` field):
- `{"type":"history","spots":[...]}` right after connecting, with the latest spots (oldest first), to recover what was missed while disconnected.
- `{"type":"ping","t":...}` every 30 s. If nothing arrives for ~75 s, treat the connection as dead and reconnect.

## Stored document shape

Example structure inserted into MongoDB:

```json
{
  "spotter": "F4ABC",
  "spotted": "EA1XYZ",
  "freq": 14074.0,
  "band": "20m",
  "mode": "FT8",
  "snr": 18,
  "rbn": true,
  "time_z": "1205",
  "timestamp": "2026-03-13T12:05:00.000Z",
  "cty": {
    "spotter": {
      "searchedCallsign": "F4ABC",
      "matchedCallsign": "F",
      "data": {
        "Country": "France",
        "Prefix": "F",
        "ADIF": 227,
        "CQZone": 14,
        "ITUZone": 27,
        "Continent": "EU",
        "Latitude": 46,
        "Longitude": -2,
        "GMTOffset": -1,
        "ExactCallsign": false
      }
    },
    "spotted": {
      "searchedCallsign": "EA1XYZ",
      "matchedCallsign": "EA1",
      "data": {
        "Country": "Spain"
      }
    }
  }
}
```

## Notes

- Spots expire automatically after 7 days (TTL index on `timestamp`).
- There are dedicated indexes for timestamp, RBN, CTY country, CTY prefix, and CTY continent fields.
- Each spot also stores `source`: the name of the DX cluster source it came from.
- The world map outline (`assets/world.json`) comes from Natural Earth 1:110m via world-atlas (public domain).
