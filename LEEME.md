# API del Ingestor RBN

Servicio Node.js que ingiere spots DX, los enriquece con datos CTY desde `cty_dict.json`, los guarda en MongoDB y expone:

- Endpoint de login con JWT
- Endpoint de consulta historica con filtros
- WebSocket en tiempo real

## Flujo de funcionamiento

1. Se conecta por telnet a DXSpider (`DX_HOST` / `DX_PORT`).
2. Parsea cada linea `DX de ...` en un spot normalizado.
3. Enriquece `spotter` y `spotted` usando `lookupCallsignInfo` de `callsignLookup.js`.
4. Acumula spots en buffer y los inserta en MongoDB por lotes (`BUFFER_LIMIT`).
5. Levanta la API Fastify en el puerto `3000`.

## Configuracion

Variables de entorno y constantes usadas en `ingestor.js`:

- `MONGO_URL` (por defecto: `mongodb://db:27017`)
- `DB_NAME` (por defecto: `rbn_radio`)
- `COLLECTION_NAME` (por defecto: `spots`)
- `DX_HOST` (por defecto: `localhost`)
- `DX_PORT` (por defecto: `7300`)
- `CALLSIGN` (placeholder por defecto: `TU_CALLSIGN`)
- `SECRET_KEY` (clave de firma JWT)
- `API_PASSWORD` (password para `/login`)

## Autenticacion

### `POST /login`
Devuelve un token JWT si la password es correcta.

Body:

```json
{
  "password": "radio_password"
}
```

Respuesta:

```json
{
  "token": "<jwt-token>"
}
```

Usa el token en endpoints protegidos:

`Authorization: Bearer <jwt-token>`

## Endpoints

### `GET /api/spots` (protegido)
Devuelve historico de spots ordenado por `timestamp` descendente.

Query params:

- `rbn`: `true` o `false`
- `mode`: coincidencia exacta sobre el campo `mode`
- `band`: coincidencia exacta (`160m`, `80m`, `40m`, etc.)
- `callsign`: regex sobre `spotter`
- `spotterCountry`: regex en `cty.spotter.data.Country`
- `spottedCountry`: regex en `cty.spotted.data.Country`
- `country`: filtro generico de pais (spotter OR spotted)
- `spotterPrefix`: prefijo en `cty.spotter.matchedCallsign`
- `spottedPrefix`: prefijo en `cty.spotted.matchedCallsign`
- `prefix`: filtro generico de prefijo (spotter OR spotted)
- `spotterContinent`: coincidencia exacta en `cty.spotter.data.Continent` (se pasa a mayusculas)
- `spottedContinent`: coincidencia exacta en `cty.spotted.data.Continent` (se pasa a mayusculas)
- `continent`: filtro generico de continente (spotter OR spotted)
- `limit`: maximo de resultados (por defecto: `100`)

Ejemplos:

```bash
curl -H "Authorization: Bearer <token>" \
  "http://localhost:3000/api/spots?spotterCountry=Spain&limit=50"
```

```bash
curl -H "Authorization: Bearer <token>" \
  "http://localhost:3000/api/spots?prefix=EA&continent=EU"
```

### `GET /ws` (websocket)
Canal en tiempo real de spots parseados/enriquecidos.

Cada mensaje es un documento spot en JSON.

## Estructura del documento en MongoDB

Ejemplo de spot guardado:

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

## Notas

- Los spots caducan automaticamente a los 7 dias (indice TTL en `timestamp`).
- Hay indices para `timestamp`, `rbn`, pais CTY, prefijo CTY y continente CTY.
- Nota de compatibilidad: el campo `mode` actualmente guarda el indicativo parseado como `spotted`.
