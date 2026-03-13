# API Endpoints (Summary)

Base URL: `http://localhost:3000`

## 1) Login

`POST /login`

Returns a JWT token to call protected endpoints.

Request:

```bash
curl -X POST "http://localhost:3000/login" \
  -H "Content-Type: application/json" \
  -d '{"password":"radio_password"}'
```

Response:

```json
{
  "token": "<jwt-token>"
}
```

Use this header for protected requests:

`Authorization: Bearer <jwt-token>`

## 2) Spot history

`GET /api/spots` (JWT protected)

Returns spots sorted by `timestamp` descending.

Supported filters:

- `rbn=true|false`
- `mode=<value>`
- `band=<value>`
- `callsign=<regex on spotter>`
- `spotterCountry=<text>`
- `spottedCountry=<text>`
- `country=<text>` (spotter OR spotted)
- `spotterPrefix=<prefix>`
- `spottedPrefix=<prefix>`
- `prefix=<prefix>` (spotter OR spotted)
- `spotterContinent=<EU|AS|NA|...>`
- `spottedContinent=<EU|AS|NA|...>`
- `continent=<EU|AS|NA|...>` (spotter OR spotted)
- `limit=<n>` (default `100`)

Examples:

```bash
curl "http://localhost:3000/api/spots?limit=20" \
  -H "Authorization: Bearer <jwt-token>"
```

```bash
curl "http://localhost:3000/api/spots?country=Spain&prefix=EA&continent=EU" \
  -H "Authorization: Bearer <jwt-token>"
```

## 3) Real-time stream

`GET /ws` (WebSocket)

This is not a regular REST endpoint/page.
It is a persistent WebSocket connection: connect once and receive one JSON message per new incoming spot.

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
