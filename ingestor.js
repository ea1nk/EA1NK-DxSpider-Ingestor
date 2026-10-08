/**
 * RBN & TRADITIONAL INGESTOR + API + WEBSOCKETS
*/

require('dotenv').config();

const net=require('net');
const { MongoClient }=require('mongodb');
const fastify=require('fastify')({ logger: false });
const websocket=require('@fastify/websocket');
const jwt=require('@fastify/jwt');
const fp = require('fastify-plugin');
const { lookupCallsignInfo }=require('./callsignLookup');
const path = require('path');

// --- CONFIGURATION ---
const MONGO_URL=process.env.MONGO_URL||'mongodb://db:27017';
const DB_NAME=process.env.DB_NAME||'spider_spots';
const COLLECTION_NAME=process.env.COLLECTION_NAME||'spots';
const DX_HOST=process.env.DX_HOST||'localhost';
const DX_PORT=parseInt(process.env.DX_PORT, 10)||7300;
const DX_HOST_BACKUP=process.env.DX_HOST_BACKUP||'';
const DX_PORT_BACKUP=parseInt(process.env.DX_PORT_BACKUP, 10)||DX_PORT;
const FAILOVER_ATTEMPTS=parseInt(process.env.FAILOVER_ATTEMPTS, 10)||3;
const PRIMARY_CHECK_INTERVAL_MS=parseInt(process.env.PRIMARY_CHECK_INTERVAL_MS, 10)||300000;
const CALLSIGN=process.env.CALLSIGN||'YOUR_CALLSIGN';
const SECRET_KEY=process.env.SECRET_KEY||'YOUR_SUPERSECRET_KEY';
const API_PASSWORD=process.env.API_PASSWORD||'radio_password';
const DISABLE_TOKEN_AUTH=(process.env.DISABLE_TOKEN_AUTH||'false').toLowerCase()==='true';
const SERVER_HOST=process.env.SERVER_HOST||'0.0.0.0';
const SERVER_PORT=parseInt(process.env.SERVER_PORT, 10)||3000;
const BUFFER_LIMIT=parseInt(process.env.BUFFER_LIMIT, 10)||15;
const TTL_SECONDS=parseInt(process.env.TTL_SECONDS, 10)||604800;
const RECONNECT_DELAY_MS=parseInt(process.env.RECONNECT_DELAY_MS, 10)||10000;
const FLUSH_INTERVAL_MS=parseInt(process.env.FLUSH_INTERVAL_MS, 10)||5000;
const CONNECT_TIMEOUT_MS=parseInt(process.env.CONNECT_TIMEOUT_MS, 10)||15000;
const INACTIVITY_TIMEOUT_MS=parseInt(process.env.INACTIVITY_TIMEOUT_MS, 10)||300000;

let spotsCollection;
let mongoClient;
let buffer=[];
const clients=new Set(); 
let flushTimer;
let dxConnected=false;
// Nodo principal y, opcionalmente, de respaldo
// DX_HOST_BACKUP admite varios nodos separados por comas: "host1,host2:7300"
const dxNodes=[{ name: 'principal', host: DX_HOST, port: DX_PORT }];
DX_HOST_BACKUP.split(',').map(h => h.trim()).filter(Boolean).forEach((entry, i) => {
    const [host, port]=entry.split(':');
    dxNodes.push({ name: `respaldo ${i + 1}`, host, port: parseInt(port, 10)||DX_PORT_BACKUP });
});
let activeNode=0;
let consecutiveFailures=0;
let primaryCheckTimer=null;
let dxSocket=null;
let reconnectTimer=null;
let shuttingDown=false;
let lastSpotTimestamp=null;
// Store seen spots: Key is the fingerprint, Value is the timestamp
const seenSpots = new Map();
const DUP_WINDOW_MS = 60 * 1000; // 60 seconds window

// --- UTILITIES ---
const getBand=(f) => {
    const mhz=f>1000? f/1000:f;
    if (mhz>=1.8&&mhz<=2.0) return "160m";
    if (mhz>=3.5&&mhz<=3.8) return "80m";
    if (mhz>=5.0&&mhz<=5.5) return "60m";
    if (mhz>=7.0&&mhz<=7.2) return "40m";
    if (mhz>=10.1&&mhz<=10.15) return "30m";
    if (mhz>=14.0&&mhz<=14.35) return "20m";
    if (mhz>=18.068&&mhz<=18.168) return "17m";
    if (mhz>=21.0&&mhz<=21.45) return "15m";
    if (mhz>=24.89&&mhz<=24.99) return "12m";
    if (mhz>=28.0&&mhz<=29.7) return "10m";
    if (mhz>=50.0&&mhz<=54.0) return "6m";
    if (mhz>=70.0&&mhz<=71.0) return "4m";
    if (mhz>=144.0&&mhz<=148.0) return "2m";
    if (mhz>=430.0&&mhz<=440.0) return "70cm";
    return "OTRO";
};

const toMHz=(f) => (f>1000? f/1000:f);
const isNear=(value, target, delta=0.003) => Math.abs(value-target)<=delta;

function inferModeByHFSubband(freq) {
    let mhz = freq > 500 ? freq / 1000 : freq;

    // 160m - 10m
    if (mhz >= 1.8 && mhz < 1.838) return "CW";
    if (mhz >= 1.838 && mhz < 1.84) return "DIGI";
    if (mhz >= 1.84 && mhz <= 2.0) return "SSB";
    if (mhz >= 3.5 && mhz < 3.57) return "CW";
    if (mhz >= 3.57 && mhz < 3.6) return "DIGI";
    if (mhz >= 3.6 && mhz <= 3.8) return "SSB";
    if (mhz >= 7.0 && mhz < 7.04) return "CW";
    if (mhz >= 7.04 && mhz < 7.05) return "DIGI";
    if (mhz >= 7.05 && mhz <= 7.3) return "SSB"; // Extended for 7217, 7240
    if (mhz >= 10.1 && mhz < 10.13) return "CW";
    if (mhz >= 10.13 && mhz <= 10.15) return "DIGI";
    if (mhz >= 14.0 && mhz < 14.07) return "CW";
    if (mhz >= 14.07 && mhz < 14.1) return "DIGI";
    if (mhz >= 14.1 && mhz <= 14.35) return "SSB";
    if (mhz >= 18.068 && mhz < 18.095) return "CW";
    if (mhz >= 18.095 && mhz < 18.11) return "DIGI";
    if (mhz >= 18.11 && mhz <= 18.168) return "SSB";
    if (mhz >= 21.0 && mhz < 21.07) return "CW";
    if (mhz >= 21.07 && mhz < 21.12) return "DIGI";
    if (mhz >= 21.12 && mhz <= 21.45) return "SSB";
    if (mhz >= 24.89 && mhz < 24.915) return "CW";
    if (mhz >= 24.915 && mhz < 24.94) return "DIGI";
    if (mhz >= 24.94 && mhz <= 24.99) return "SSB";
    if (mhz >= 28.0 && mhz < 28.07) return "CW";
    if (mhz >= 28.07 && mhz < 28.2) return "DIGI";
    if (mhz >= 28.2 && mhz <= 29.7) return "SSB"; // Extended for 28285

    // 6m (VHF)
    if (mhz >= 50.0 && mhz < 50.1) return "CW";
    if (mhz >= 50.1 && mhz < 50.3) return "SSB";
    if (mhz >= 50.3 && mhz <= 52.0) return "DIGI";

    // 2m (VHF)
    if (mhz >= 144.0 && mhz < 144.1) return "CW";
    if (mhz >= 144.1 && mhz < 144.15) return "SSB";
    if (mhz >= 144.15 && mhz <= 144.4) return "DIGI"; // For 144174
    if (mhz >= 144.5 && mhz <= 148.0) return "FM"; 

    return "UNK";
}

/**
 * Main inference engine.
 * Added logic for Beacons (/B) and refined band ranges.
 */
function inferMode(freq, comment, callsign) {
    const mhz = freq > 500 ? freq / 1000 : freq;
    const text = (comment || "").toUpperCase();
    const call = (callsign || "").toUpperCase();

    // 1. Check if it is a Beacon (/B)
    if (call.endsWith("/B")) return "CW";

    // 2. Check for specific Digital Modes in comment
    if (/\bFT8\b/.test(text)) return "FT8";
    if (/\bFT4\b/.test(text)) return "FT4";
    if (/\b(RTTY|FSK)\b/.test(text)) return "RTTY";
    
    // 3. Magic Frequencies (Standard and DXpedition)
    const isNear = (f1, f2) => Math.abs(f1 - f2) <= 0.003;
    const ft8Freqs = [1.84, 3.573, 7.074, 10.136, 14.074, 18.1, 21.074, 24.915, 28.074, 50.313, 144.174];
    const dxFreqs = [1.844, 3.567, 7.056, 10.131, 14.090, 18.095, 21.091, 24.911, 28.091];
    if (ft8Freqs.some(f => isNear(mhz, f)) || dxFreqs.some(f => isNear(mhz, f))) return "FT8";

    // 4. Analog Modes in comment
    if (/\b(CW|WPM)\b/.test(text) || /\b\d+\s?DB\b/.test(text)) return "CW";
    if (/\b(SSB|USB|LSB|PHONE|PH)\b/.test(text)) return "SSB";
    if (/\bAM\b/.test(text)) return "AM";
    if (/\bFM\b/.test(text)) return "FM";

    // 5. Fallback to band plan
    return inferModeByHFSubband(mhz);
}

function normalizeMode(mode) {
    const text=(mode||"").toString().toUpperCase().trim();
    if (!text) return "UNK";
    if (text==="PHONE"||text==="USB"||text==="LSB") return "SSB";
    const validModes=new Set(["CW", "SSB", "AM", "FM", "FT8", "FT4", "RTTY", "PSK31", "WSPR", "UNK"]);
    return validModes.has(text) ? text : "UNK";
}


function detectAutomatedPatterns(comment, mode) {
    const c = comment.toUpperCase();
    const hasSNR = /\d+\s*DB/.test(c);
    const hasWPM = /\d+\s*WPM/.test(c);
    
    if ((mode === 'FT8' || mode === 'FT4') && hasSNR && comment.length < 12) {
        return true;
    }
    
    if (hasSNR && hasWPM) return true;

    return false;
}


function parseSpot(data) {
    // 1. Pre-processing: Remove control characters (like bell \x07) and trim whitespace
    const cleanData = data.toString().replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "").trim();
    
    // 2. Regex Breakdown:
    // ^DX de\s+           -> Matches the start of the spot
    // ([\w\d/-]+(?:-#)?)  -> Group 1: Spotter callsign (allows -# suffix)
    // :\s+([\d.]+)        -> Group 2: Frequency
    // \s+([\w\d/]+)       -> Group 3: Spotted callsign
    // \s+(.*?)            -> Group 4: Comment/Payload (lazy match)
    // (?:\s+(\d{4})Z)?$   -> Group 5: Optional Time (e.g., 1731Z) at the end
    const regex = /^DX de\s+([\w\d/-]+(?:-#)?):\s+([\d.]+)\s+([\w\d/]+)\s+(.*?)(?:\s+(\d{4})Z)?$/i;
    const match = cleanData.match(regex);

    if (!match) return null;

    const [, rawSpotter, rawFreq, rawSpotted, payload, timeZ] = match;
    const freq = parseFloat(rawFreq);
    const spotter = rawSpotter.toUpperCase();
    const spotted = rawSpotted.toUpperCase();
    
    // Ensure the full comment is preserved
    const comment = payload ? payload.trim() : ""; 
    const mode = normalizeMode(inferMode(freq, comment));

    // 3. SNR Extraction: Look for [+-]Number followed by 'dB'
    const snrMatch = comment.match(/([+-]?\d+)\s*dB/i);
    const snr = snrMatch ? parseInt(snrMatch[1], 10) : null;

    // 4. RBN vs TRAD Differentiation Logic
    const hasRbnSuffix = spotter.endsWith('-#');
    const hasWpm = /\d+\s*WPM/i.test(comment);
    
    // Heuristic: Identify automated spots even if they lack the -# suffix
    // Automated spots typically include SNR and WPM or are very short digital reports
    let isRbn = hasRbnSuffix || (snr !== null && hasWpm);
    
    // Refinement: If it's a long comment without an RBN suffix, assume it's a manual entry
    if (!hasRbnSuffix && comment.length > 20) {
        isRbn = false;
    }

    // 5. Timestamp Handling: always use insertion time
    const timestamp = new Date();
    const time_z = timeZ || (timestamp.getUTCHours().toString().padStart(2, '0') + timestamp.getUTCMinutes().toString().padStart(2, '0'));

    return {
        spotter,
        spotted,
        freq,
        band: getBand(freq),
        mode,
        comment, // Full original comment is stored here
        snr,
        rbn: isRbn,
        time_z,
        timestamp,
        cty: { 
            spotter: lookupCallsignInfo(spotter), 
            spotted: lookupCallsignInfo(spotted) 
        }
    };
}

function isDuplicate(spot) {
    // We round the frequency to 0.1 kHz to catch spots that are slightly off
    const roundedFreq = Math.round(spot.freq * 10) / 10;
    const fingerprint = `${spot.spotted}|${roundedFreq}|${spot.mode}`;
    
    const now = Date.now();
    const lastSeen = seenSpots.get(fingerprint);

    if (lastSeen && (now - lastSeen) < DUP_WINDOW_MS) {
        return true; // It's a duplicate
    }

    // Update the cache with the current time
    seenSpots.set(fingerprint, now);

    // Optional: Cleanup old entries to prevent memory leaks every 100 spots
    if (seenSpots.size > 1000) {
        cleanupCache(now);
    }

    return false;
}


function cleanupCache(now) {
    for (const [key, timestamp] of seenSpots.entries()) {
        if (now - timestamp > DUP_WINDOW_MS) {
            seenSpots.delete(key);
        }
    }
}

async function flushBuffer() {
    if (!spotsCollection||buffer.length===0) return;
    const batch=[...buffer];
    buffer=[];
    try { await spotsCollection.insertMany(batch); }
    catch (error) { buffer=batch.concat(buffer); console.error('DB Flush Error:', error); }
}

function scheduleBufferFlush() {
    if (flushTimer) clearInterval(flushTimer);
    flushTimer=setInterval(() => flushBuffer().catch(console.error), FLUSH_INTERVAL_MS);
}

function scheduleReconnect() {
    if (reconnectTimer || shuttingDown) return; // Una sola reconexión pendiente
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connectToDxCluster();
    }, RECONNECT_DELAY_MS);
}

// Cierre ordenado: 'bye' para que el cluster libere la sesión, y destroy como respaldo
function closeDxSocket(socket) {
    if (!socket || socket.destroyed) return;
    try {
        if (socket.writable) socket.end('bye\n');
    } catch (_) { /* ignorar */ }
    setTimeout(() => socket.destroy(), 3000).unref();
}

async function handleDxLine(line) {
    // Un prompt sin salto de línea puede quedar delante del spot
    const start = line.indexOf('DX de');
    if (start === -1) return;
    const spot = parseSpot(line.slice(start));
    if (!spot) return false;
    if (isDuplicate(spot)) return true;

    lastSpotTimestamp = spot.timestamp;
    const msg = JSON.stringify(spot);

    for (const c of clients) {
        if (c.readyState === 1) c.send(msg);
    }

    buffer.push(spot);
    if (buffer.length >= BUFFER_LIMIT) await flushBuffer();
    return true;
}

// Cambia de nodo tras FAILOVER_ATTEMPTS fallos seguidos
function registerFailure() {
    consecutiveFailures++;
    if (dxNodes.length < 2 || consecutiveFailures < FAILOVER_ATTEMPTS) return;
    consecutiveFailures = 0;
    activeNode = (activeNode + 1) % dxNodes.length;
    const node = dxNodes[activeNode];
    console.warn(`⚠️ Cambiando al nodo ${node.name} (${node.host}:${node.port})`);
}

// Comprueba si el principal acepta conexiones TCP (sin hacer login)
function probeNode(node) {
    return new Promise((resolve) => {
        const probe = net.connect(node.port, node.host);
        const done = (ok) => { probe.destroy(); resolve(ok); };
        probe.setTimeout(CONNECT_TIMEOUT_MS, () => done(false));
        probe.once('connect', () => done(true));
        probe.once('error', () => done(false));
    });
}

// Mientras se usa el respaldo, vuelve al principal en cuanto esté disponible
function startPrimaryCheck() {
    if (primaryCheckTimer || dxNodes.length < 2) return;
    primaryCheckTimer = setInterval(async () => {
        if (activeNode === 0 || shuttingDown) return;
        if (!(await probeNode(dxNodes[0]))) return;
        if (activeNode === 0 || shuttingDown) return;
        console.log(`✅ Nodo principal disponible de nuevo, volviendo a ${DX_HOST}:${DX_PORT}`);
        activeNode = 0;
        consecutiveFailures = 0;
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
        connectToDxCluster();
    }, PRIMARY_CHECK_INTERVAL_MS);
    primaryCheckTimer.unref();
}

function connectToDxCluster() {
    if (shuttingDown) return;
    // Nunca más de una conexión viva
    if (dxSocket) {
        const old = dxSocket;
        dxSocket = null;
        closeDxSocket(old);
    }

    const telnet = new net.Socket();
    dxSocket = telnet;
    let pending = '';
    let loginLines = 0;
    let connected = false;
    let gotSpot = false;
    const node = dxNodes[activeNode];

    telnet.setKeepAlive(true, 60000); // Detecta conexiones muertas a nivel TCP
    telnet.setTimeout(CONNECT_TIMEOUT_MS); // Timeout de conexión; luego, de inactividad

    telnet.on('timeout', () => {
        console.error(connected
            ? `Sin datos del cluster en ${INACTIVITY_TIMEOUT_MS / 1000}s, reconectando...`
            : `Timeout conectando a ${node.host}:${node.port}`);
        closeDxSocket(telnet);
    });

    telnet.on('error', (e) => {
        console.error(`Cluster error: ${e.message}`);
    });

    console.log(`Conectando al nodo ${node.name} ${node.host}:${node.port} como ${CALLSIGN}...`);
    telnet.connect(node.port, node.host, () => {
        connected = true;
        dxConnected = true;
        telnet.setTimeout(INACTIVITY_TIMEOUT_MS);
        console.log(`📡 Conectado al DXSpider (${node.name})`);
        telnet.write(`${CALLSIGN}\n`);
        setTimeout(() => { if (telnet.writable) telnet.write('set/skim\n'); }, 1000);
    });

    telnet.on('data', async (data) => {
        // Las líneas pueden llegar partidas entre paquetes TCP
        const lines = (pending + data.toString()).split(/\r?\n/);
        pending = lines.pop();
        if (pending.length > 4096) pending = '';

        for (const line of lines) {
            // Mostrar las primeras líneas tras conectar (login, rechazos, etc.)
            if (loginLines < 15 && line.trim() && !line.includes('DX de')) {
                loginLines++;
                console.log(`[cluster] ${line.trim()}`);
            }
            try {
                if (await handleDxLine(line)) gotSpot = true;
            } catch (err) {
                console.error('Error procesando línea:', err.message, '|', line);
            }
        }
    });

    telnet.on('close', () => {
        if (dxSocket !== telnet) return; // Socket antiguo ya reemplazado
        dxSocket = null;
        dxConnected = false;
        if (shuttingDown) return;
        // Una sesión que llegó a recibir spots no cuenta como fallo
        if (gotSpot) consecutiveFailures = 0;
        else registerFailure();
        console.warn(`Conexión cerrada, reconectando en ${RECONNECT_DELAY_MS / 1000}s...`);
        scheduleReconnect();
    });
}

// --- FASTIFY SETUP ---
fastify.register(jwt, { secret: SECRET_KEY });
fastify.register(fp(async (instance) => { instance.register(websocket); }));

fastify.register(require('@fastify/static'), {
    root: path.join(__dirname, 'assets/'),
    prefix: '/',
    decorateReply: true
});

fastify.decorate("authenticate", async (request, reply) => {
    if (DISABLE_TOKEN_AUTH) return;
    try { await request.jwtVerify(); }
    catch (err) { reply.code(401).send({ error: 'Unauthorized' }); }
});

// --- API & WS INSTANCE ---
fastify.register(async (instance) => {
    
    instance.get('/monitor', (req, reply) => {
        return reply.sendFile('spots.html');
    });
    
    // WebSocket Channel
    instance.get('/ws', { websocket: true }, async (connection, req) => {
        clients.add(connection);
        connection.send(JSON.stringify({ status: "ok", message: "Connected" }));
        
        connection.on('close', () => clients.delete(connection));
        connection.on('error', (err) => console.error(`[WS Error]:`, err.message));
        
        await new Promise((resolve) => {
            connection.on('close', resolve);
            connection.on('error', resolve);
        });
    });

    instance.post('/login', async (req) => {
        if (req.body.password===API_PASSWORD) return { token: instance.jwt.sign({ user: 'admin' }) };
        throw new Error('Invalid Password');
    });

    instance.get('/health', async (_req, reply) => {
        return {
            ok: true,
            dxCluster: {
                connected: dxConnected,
                node: dxNodes[activeNode].name,
                host: dxNodes[activeNode].host,
                port: dxNodes[activeNode].port
            },
            buffer: { length: buffer.length, lastSpot: lastSpotTimestamp },
            uptime: Math.round(process.uptime())
        };
    });

    // API Histórica
    instance.get('/api/spots', { onRequest: [instance.authenticate] }, async (req) => {
        const { mode, band, limit }=req.query;
        let query={};
        if (mode) query.mode=mode.toUpperCase();
        if (band) query.band=band;
        return await spotsCollection.find(query).sort({ timestamp: -1 }).limit(parseInt(limit)||100).toArray();
    });
});

// --- START ---
async function start() {
    mongoClient=new MongoClient(MONGO_URL);
    await mongoClient.connect();
    spotsCollection=mongoClient.db(DB_NAME).collection(COLLECTION_NAME);
    await spotsCollection.createIndex({ timestamp: -1 });
    await spotsCollection.createIndex({ timestamp: 1 }, { expireAfterSeconds: TTL_SECONDS });
    
    scheduleBufferFlush();
    await fastify.listen({ port: SERVER_PORT, host: SERVER_HOST });
    console.log(`🚀 Server running on ${SERVER_HOST}:${SERVER_PORT}`);
    connectToDxCluster();
    startPrimaryCheck();
}

// Cierre limpio (docker stop/restart): avisar al cluster para no dejar sesiones colgadas
async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} recibido, cerrando...`);
    clearTimeout(reconnectTimer);
    closeDxSocket(dxSocket);
    try { await flushBuffer(); } catch (_) { /* ignorar */ }
    setTimeout(() => process.exit(0), 1000);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start().catch(console.error);