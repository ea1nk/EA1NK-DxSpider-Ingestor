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

# :card_index: API del Ingestor DXSpider

Este repositorio esta pensado para ejecutarse en Docker y forma parte del proyecto EA1NK-Docker-DxSpider:
https://github.com/ea1nk/EA1NK-Docker-DxSpider

Servicio Node.js que ingiere spots DX, los enriquece con datos CTY desde `cty_dict.json`, los guarda en MongoDB y expone:

- Endpoint de login con JWT
- Endpoint de consulta historica con filtros
- WebSocket en tiempo real

## Flujo de funcionamiento

1. Se conecta por telnet a uno o varios clusters DX (orígenes gestionados desde `/admin`, cada uno con sus nodos de respaldo).
2. Parsea cada linea `DX de ...` en un spot normalizado; los spots repetidos entre orígenes se guardan una sola vez.
3. Enriquece `spotter` y `spotted` usando `lookupCallsignInfo` de `callsignLookup.js`.
4. Acumula spots en buffer y los inserta en MongoDB por lotes (`BUFFER_LIMIT`).
5. Sirve la web, la API y el WebSocket con Fastify en el puerto `3000`.

Los usuarios, los orígenes de spots y los ajustes se guardan en SQLite (`DATA_DIR/ingestor.db`, montado en `./data` por `docker-compose.yml`). Los spots siguen en MongoDB.

## Administración (`/admin`)

- **Estado**: tiempo activo, spots por minuto, spots guardados, CPU/memoria, estado y estadísticas de cada origen y de las fuentes de datos externas.
- **Orígenes**: añadir, editar, activar/desactivar, reconectar o eliminar orígenes. Cada origen tiene su indicativo (usa un SSID distinto por origen), comandos tras el login (por defecto `set/skim`) y clusters de respaldo.
- **Usuarios**: crear usuarios, cambiar roles y contraseñas. `admin` accede a `/admin`; `user` accede a la API histórica (`/api/spots`).
- **Mi cuenta**: cambiar tu contraseña.

En el primer arranque:
- Si no hay orígenes, se crea uno con `DX_HOST`, `DX_PORT`, `CALLSIGN` y `DX_HOST_BACKUP` del `.env`. A partir de ahí los orígenes se gestionan solo desde `/admin`.
- Si no hay usuarios, se crea un administrador con `ADMIN_USERNAME` / `ADMIN_PASSWORD`. Si `ADMIN_PASSWORD` no está definido, se genera una contraseña aleatoria que aparece una sola vez en el log del contenedor (`docker logs dxspider-ingestor`).

## Configuracion

Variables de entorno:

- `MONGO_URL` (por defecto: `mongodb://db:27017`)
- `DB_NAME` (por defecto: `spider_spots`)
- `COLLECTION_NAME` (por defecto: `spots`)
- `DATA_DIR` (directorio de SQLite, por defecto: `./data`; `/data` en Docker)
- `ADMIN_USERNAME` / `ADMIN_PASSWORD` (administrador inicial, solo si no hay usuarios)
- `SECRET_KEY` (clave de firma JWT; si no se define, se genera una aleatoria y se guarda en SQLite)
- `TOKEN_TTL` (duración del token JWT, por defecto: `12h`)
- `TRUST_PROXY` (`true` solo detrás de un proxy inverso, para que el límite de intentos de login use la IP real)
- `DX_HOST`, `DX_PORT`, `CALLSIGN`, `DX_HOST_BACKUP`, `DX_PORT_BACKUP` (solo crean el primer origen en el primer arranque)
- `FAILOVER_ATTEMPTS` (fallos seguidos antes de cambiar de nodo, por defecto: `3`)
- `PRIMARY_CHECK_INTERVAL_MS` (cada cuánto se comprueba el principal mientras se usa un respaldo, por defecto: `300000`)
- `RECONNECT_DELAY_MS` (por defecto: `10000`)
- `CONNECT_TIMEOUT_MS` (por defecto: `15000`)
- `INACTIVITY_TIMEOUT_MS` (reconecta si no llegan datos, por defecto: `300000`)
- `HEALTH_GRACE_MS` (`/health` devuelve 503 si todos los orígenes llevan este tiempo caídos, por defecto: `120000`)
- `MAX_BUFFER` (máximo de spots en memoria mientras MongoDB no está disponible, por defecto: `5000`)
- `RECENT_SPOTS_LIMIT` (spots recientes enviados a los clientes WebSocket al conectar, por defecto: `200`)
- `WS_HEARTBEAT_MS` (intervalo del heartbeat del WebSocket, por defecto: `30000`)
- `SPACE_WEATHER_REFRESH_MS` (intervalo de actualización de los datos de propagación, por defecto: `900000`)
- `API_PASSWORD` (login antiguo solo con contraseña, token de solo lectura para la API; vacío para desactivarlo)
- `DISABLE_TOKEN_AUTH` (`true` hace pública `/api/spots`)

## Autenticacion

### `POST /login`
Devuelve un token JWT para un usuario guardado en SQLite. Máximo 10 intentos fallidos por IP cada 15 minutos (HTTP 429).

```json
{ "username": "admin", "password": "tu-contraseña" }
```

Respuesta:

```json
{ "token": "<jwt-token>", "user": { "id": 1, "username": "admin", "role": "admin" } }
```

Compatibilidad: `{ "password": "<API_PASSWORD>" }` sin usuario sigue devolviendo un token de solo lectura para la API.

Usa el token en endpoints protegidos:

`Authorization: Bearer <jwt-token>`

### `GET /api/me` / `POST /api/me/password`
Usuario actual y cambio de la propia contraseña (`{ "currentPassword", "newPassword" }`).

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

### `GET /api/space-weather` (público)
Índices solares y datos de propagación, actualizados cada 15 minutos (`SPACE_WEATHER_REFRESH_MS`) desde fuentes abiertas y cacheados en el servidor:
- `hamqsl`: N0NBH / HamQSL (SFI, SSN, A, K, rayos X, viento solar, condiciones HF día/noche, fenómenos VHF, ruido, MUF)
- `kp`: Kp planetario de NOAA, últimos 3 días
- `xray`: flujo de rayos X GOES (0,1-0,8 nm), últimas 6 horas, clase actual y máxima
- `windSpeed`, `windMag`: velocidad del viento solar e IMF Bt/Bz (NOAA)
- `scales`: escalas NOAA R/S/G y previsión a 3 días
- `daily`: SFI y número de manchas diarios, últimos 30 días (NOAA)
- `sources`: estado y última actualización de cada fuente

### `GET /api/activity` (público)
Actividad de spots en los últimos 60 minutos a partir de los spots guardados: `total` y recuentos por `bands`, `modes`, `countries` e indicativos (`calls`). Cacheado 60 s.

### API de administración (`/api/admin/*`, rol `admin`)

- `GET /api/admin/status`: estado y estadísticas del sistema
- `GET|POST /api/admin/sources`, `PUT|DELETE /api/admin/sources/:id`, `POST /api/admin/sources/:id/reconnect`
- `GET|POST /api/admin/users`, `PUT|DELETE /api/admin/users/:id` (el último administrador no se puede eliminar ni degradar)

### Errores
Los navegadores reciben una página 404/500 con estilo; las rutas de API (`/api/*`, `/login`, `/health`) y los clientes que no piden HTML reciben `{ "error": "..." }`.

### `GET /ws` (websocket)
Canal en tiempo real de spots parseados/enriquecidos.

Cada mensaje es un documento spot en JSON.

Además de los spots, el servidor envía dos mensajes de control (sin campo `spotted`):
- `{"type":"history","spots":[...]}` nada más conectar, con los últimos spots (del más antiguo al más reciente), para recuperar los perdidos durante una desconexión.
- `{"type":"ping","t":...}` cada 30 s. Si no llega nada en ~75 s, la conexión está muerta y hay que reconectar.

## Estructura del documento en MongoDB

Ejemplo de spot guardado:

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

## Notas

- Los spots caducan automaticamente a los 7 dias (indice TTL en `timestamp`).
- Hay indices para `timestamp`, `rbn`, pais CTY, prefijo CTY y continente CTY.
