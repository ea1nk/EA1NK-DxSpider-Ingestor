# RBN Ingestor API

Node.js service that ingests DX spots, enriches them with CTY data from `cty_dict.json`, stores them in MongoDB, and exposes:

- JWT login endpoint
- Historical query endpoint with filters
- WebSocket stream for real-time spots

## Runtime overview

1. Connects to DXSpider via telnet (`DX_HOST` / `DX_PORT`).
2. Parses each `DX de ...` line into a normalized spot.
3. Enriches `spotter` and `spotted` callsigns with `lookupCallsignInfo` from `callsignLookup.js`.
4. Buffers spots and writes to MongoDB in batches (`BUFFER_LIMIT`).
5. Serves API with Fastify on port `3000`.

## Configuration

Environment variables and constants currently used in `ingestor.js`:

- `MONGO_URL` (default: `mongodb://db:27017`)
- `DB_NAME` (default: `rbn_radio`)
- `COLLECTION_NAME` (default: `spots`)
- `DX_HOST` (default: `localhost`)
- `DX_PORT` (default: `7300`)
- `CALLSIGN` (default placeholder: `TU_CALLSIGN`)
- `SECRET_KEY` (JWT signing key)
- `API_PASSWORD` (password for `/login`)

## Authentication

### `POST /login`
Returns a JWT token when the password is correct.

Request body:

```json
{
  "password": "radio_password"
}
```

Response:

```json
{
  "token": "<jwt-token>"
}
```

Use that token in protected endpoints:

`Authorization: Bearer <jwt-token>`

## Endpoints

### `GET /api/spots` (protected)
Returns spot history sorted by `timestamp` descending.

Query params:

- `rbn`: `true` or `false`
- `mode`: exact match against stored `mode` field
- `band`: exact match (`160m`, `80m`, `40m`, etc.)
- `callsign`: regex match on `spotter`
- `spotterCountry`: regex on `cty.spotter.data.Country`
- `spottedCountry`: regex on `cty.spotted.data.Country`
- `country`: generic country filter (spotter OR spotted)
- `spotterPrefix`: prefix match on `cty.spotter.matchedCallsign`
- `spottedPrefix`: prefix match on `cty.spotted.matchedCallsign`
- `prefix`: generic prefix filter (spotter OR spotted)
- `spotterContinent`: exact match on `cty.spotter.data.Continent` (auto uppercased)
- `spottedContinent`: exact match on `cty.spotted.data.Continent` (auto uppercased)
- `continent`: generic continent filter (spotter OR spotted)
- `limit`: max results (default: `100`)

Examples:

```bash
curl -H "Authorization: Bearer <token>" \
  "http://localhost:3000/api/spots?spotterCountry=Spain&limit=50"
```

```bash
curl -H "Authorization: Bearer <token>" \
  "http://localhost:3000/api/spots?prefix=EA&continent=EU"
```

### `GET /ws` (websocket)
Real-time stream of parsed/enriched spots.

Each message is a JSON spot document.

## Stored document shape

Example structure inserted into MongoDB:

```json
{
  "spotter": "F4ABC",
  "spotted": "EA1XYZ",
  "freq": 14074.0,
  "band": "20m",
  "mode": "EA1XYZ",
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
- Legacy note: `mode` currently stores the parsed spotted callsign value.
