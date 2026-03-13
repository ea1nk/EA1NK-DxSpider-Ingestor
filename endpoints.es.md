# Endpoints API (resumen)

Base URL: `http://localhost:3000`

## 1) Login

`POST /login`

Obtiene un token JWT para usar en endpoints protegidos.

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

Usar en requests protegidos:

`Authorization: Bearer <jwt-token>`

## 2) Historico de spots

`GET /api/spots` (protegido con JWT)

Devuelve spots ordenados por `timestamp` descendente.

Filtros soportados:

- `rbn=true|false`
- `mode=<valor>`
- `band=<valor>`
- `callsign=<regex sobre spotter>`
- `spotterCountry=<texto>`
- `spottedCountry=<texto>`
- `country=<texto>` (spotter OR spotted)
- `spotterPrefix=<prefijo>`
- `spottedPrefix=<prefijo>`
- `prefix=<prefijo>` (spotter OR spotted)
- `spotterContinent=<EU|AS|NA|...>`
- `spottedContinent=<EU|AS|NA|...>`
- `continent=<EU|AS|NA|...>` (spotter OR spotted)
- `limit=<n>` (default `100`)

Ejemplos:

```bash
curl "http://localhost:3000/api/spots?limit=20" \
  -H "Authorization: Bearer <jwt-token>"
```

```bash
curl "http://localhost:3000/api/spots?country=Spain&prefix=EA&continent=EU" \
  -H "Authorization: Bearer <jwt-token>"
```

## 3) Stream en tiempo real

`GET /ws` (WebSocket)

No es un endpoint REST para abrir en el navegador como pagina.
Es una conexion WebSocket persistente: te conectas una vez y recibes mensajes JSON cada vez que entra un spot nuevo.

Ejemplo con `wscat`:

```bash
wscat -c ws://localhost:3000/ws
```

Ejemplo desde interfaz web (JavaScript):

```javascript
const ws = new WebSocket("ws://localhost:3000/ws");

ws.onopen = () => {
  console.log("Conectado al stream de spots");
};

ws.onmessage = (event) => {
  const spot = JSON.parse(event.data);
  console.log("Spot recibido:", spot);
};

ws.onclose = () => {
  console.log("Conexion cerrada");
};

ws.onerror = (err) => {
  console.error("Error WebSocket:", err);
};
```

## Estructura basica de un spot

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
