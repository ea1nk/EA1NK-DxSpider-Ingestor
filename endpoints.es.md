# Endpoints API (resumen)

Base URL: `http://localhost:3000`

## 1) Login

`POST /login`

Devuelve un token JWT para un usuario creado en `/admin` (máximo 10 intentos fallidos por IP cada 15 minutos).

Peticion:

```bash
curl -X POST "http://localhost:3000/login" \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"tu-contraseña"}'
```

Respuesta:

```json
{
  "token": "<jwt-token>",
  "user": { "id": 1, "username": "admin", "role": "admin" }
}
```

Compatibilidad: `{"password":"<API_PASSWORD>"}` sin usuario devuelve un token de solo lectura para la API si `API_PASSWORD` está definido.

Usa esta cabecera en peticiones protegidas:

`Authorization: Bearer <jwt-token>`

## 2) Historico de spots

`GET /api/spots` (protegido con JWT salvo con `DISABLE_TOKEN_AUTH=true`)

Devuelve spots ordenados por `timestamp` descendente.

Filtros soportados:

- `mode=<valor>`
- `band=<valor>`
- `limit=<n>` (por defecto `100`, máximo `1000`)

Ejemplo:

```bash
curl "http://localhost:3000/api/spots?band=20m&mode=CW&limit=20" \
  -H "Authorization: Bearer <jwt-token>"
```

## 2b) Actividad y meteorología espacial (públicos)

- `GET /api/activity`: recuentos de la última hora por banda, modo, país, indicativo y origen.
- `GET /api/activity?detail=1&minutes=15|60|360|1440`: estadísticas completas de `/activity` (serie temporal, mapa de calor banda × hora, rutas entre continentes, puntos del mapa mundial).
- `GET /api/space-weather`: índices solares, condiciones de bandas, Kp, rayos X, viento solar y escalas NOAA.
- `GET /health`: estado del servicio y de los clusters (503 si todos los orígenes llevan un rato caídos).

## 3) Stream en tiempo real

`GET /ws` (WebSocket)

No es un endpoint REST para abrir en el navegador como pagina.
Es una conexion WebSocket persistente: te conectas una vez y recibes mensajes JSON cada vez que entra un spot nuevo.

Además de los spots, el servidor envía dos mensajes de control (sin campo `spotted`):
- `{"type":"history","spots":[...]}` nada más conectar, con los últimos spots (del más antiguo al más reciente), para recuperar los perdidos durante una desconexión.
- `{"type":"ping","t":...}` cada 30 s. Si no llega nada en ~75 s, la conexión está muerta y hay que reconectar.

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
