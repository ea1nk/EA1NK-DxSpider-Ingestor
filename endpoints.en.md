# API Endpoints (Summary)

Base URL: `http://localhost:3000`

## 1) Login

`POST /login`

Returns a JWT token for a user created in `/admin` (max 10 failed attempts per IP every 15 minutes).

Request:

```bash
curl -X POST "http://localhost:3000/login" \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"your-password"}'
```

Response:

```json
{
  "token": "<jwt-token>",
  "user": { "id": 1, "username": "admin", "role": "admin" }
}
```

Legacy: `{"password":"<API_PASSWORD>"}` without username returns a read-only API token if `API_PASSWORD` is set.

Use this header for protected requests:

`Authorization: Bearer <jwt-token>`

## 2) Spot history

`GET /api/spots` (JWT protected unless `DISABLE_TOKEN_AUTH=true`)

Returns spots sorted by `timestamp` descending.

Supported filters:

- `mode=<value>`
- `band=<value>`
- `limit=<n>` (default `100`, max `1000`)

Example:

```bash
curl "http://localhost:3000/api/spots?band=20m&mode=CW&limit=20" \
  -H "Authorization: Bearer <jwt-token>"
```

## 2b) Activity and space weather (public)

- `GET /api/activity`: last-hour counts by band, mode, country, callsign and source.
- `GET /api/activity?detail=1&minutes=15|60|360|1440`: full statistics used by `/activity` (time series, band × time heatmap, continent paths, world map points).
- `GET /api/space-weather`: solar indices, band conditions, Kp, X-ray, solar wind and NOAA scales.
- `GET /health`: service and DX cluster status (503 when every source has been down for a while).

## 3) Real-time stream

`GET /ws` (WebSocket)

This is not a regular REST endpoint/page.
It is a persistent WebSocket connection: connect once and receive one JSON message per new incoming spot.

Besides spots, the server sends two control messages (they have no `spotted` field):
- `{"type":"history","spots":[...]}` right after connecting, with the latest spots (oldest first), to recover what was missed while disconnected.
- `{"type":"ping","t":...}` every 30 s. If nothing arrives for ~75 s, treat the connection as dead and reconnect.

Example with `wscat`:

```bash
wscat -c ws://localhost:3000/ws
```

Frontend example (JavaScript):

```javascript
const ws = new WebSocket("ws://localhost:3000/ws");

ws.onopen = () => {
  console.log("Connected to spot stream");
};

ws.onmessage = (event) => {
  const spot = JSON.parse(event.data);
  console.log("Spot received:", spot);
};

ws.onclose = () => {
  console.log("Connection closed");
};

ws.onerror = (err) => {
  console.error("WebSocket error:", err);
};
```

## Basic spot shape

```json
{
  "spotter": "F4ABC",
  "spotted": "EA1XYZ",
  "freq": 14074,
  "band": "20m",
  "snr": 18,
  "rbn": true,
  "timestamp": "2026-03-13T12:05:00.000Z",
  "cty": {
    "spotter": { "matchedCallsign": "F", "data": { "Country": "France" } },
    "spotted": { "matchedCallsign": "EA1", "data": { "Country": "Spain" } }
  }
}
```
