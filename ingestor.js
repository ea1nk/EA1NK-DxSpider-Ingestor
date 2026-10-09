/**
 * RBN & TRADITIONAL INGESTOR + API + WEBSOCKETS
*/

require('dotenv').config();

const os=require('os');
const fs=require('fs');
const { MongoClient }=require('mongodb');
// Only trust X-Forwarded-For behind a reverse proxy; otherwise clients could spoof their IP
const fastify=require('fastify')({ logger: false, trustProxy: (process.env.TRUST_PROXY||'false').toLowerCase()==='true' });
const websocket=require('@fastify/websocket');
const jwt=require('@fastify/jwt');
const fp = require('fastify-plugin');
const { lookupCallsignInfo, reloadReferenceData, preloadReferenceData, referenceCounts }=require('./callsignLookup');
const referenceData=require('./referenceData');
const { startSpaceWeather, getSpaceWeather }=require('./spaceWeather');
const db=require('./db');
const auth=require('./auth');
const ClusterSource=require('./clusterSource');
const path = require('path');

// --- CONFIGURATION ---
// DX cluster sources and users live in SQLite (managed from /admin).
// DX_HOST, DX_PORT, CALLSIGN and DX_HOST_BACKUP only seed the first source on first run.
const MONGO_URL=process.env.MONGO_URL||'mongodb://db:27017';
const DB_NAME=process.env.DB_NAME||'spider_spots';
const COLLECTION_NAME=process.env.COLLECTION_NAME||'spots';
const FAILOVER_ATTEMPTS=parseInt(process.env.FAILOVER_ATTEMPTS, 10)||3;
const PRIMARY_CHECK_INTERVAL_MS=parseInt(process.env.PRIMARY_CHECK_INTERVAL_MS, 10)||300000;
const API_PASSWORD=process.env.API_PASSWORD||'';
const DISABLE_TOKEN_AUTH=(process.env.DISABLE_TOKEN_AUTH||'false').toLowerCase()==='true';
const SERVER_HOST=process.env.SERVER_HOST||'0.0.0.0';
const SERVER_PORT=parseInt(process.env.SERVER_PORT, 10)||3000;
const BUFFER_LIMIT=parseInt(process.env.BUFFER_LIMIT, 10)||15;
const TTL_SECONDS=parseInt(process.env.TTL_SECONDS, 10)||604800;
const RECONNECT_DELAY_MS=parseInt(process.env.RECONNECT_DELAY_MS, 10)||10000;
const FLUSH_INTERVAL_MS=parseInt(process.env.FLUSH_INTERVAL_MS, 10)||5000;
const CONNECT_TIMEOUT_MS=parseInt(process.env.CONNECT_TIMEOUT_MS, 10)||15000;
const INACTIVITY_TIMEOUT_MS=parseInt(process.env.INACTIVITY_TIMEOUT_MS, 10)||300000;
const MAX_BUFFER=parseInt(process.env.MAX_BUFFER, 10)||5000;
const RECENT_SPOTS_LIMIT=parseInt(process.env.RECENT_SPOTS_LIMIT, 10)||200;
const WS_HEARTBEAT_MS=parseInt(process.env.WS_HEARTBEAT_MS, 10)||30000;
const WS_MAX_BUFFERED_BYTES=1024 * 1024;
const HEALTH_GRACE_MS=parseInt(process.env.HEALTH_GRACE_MS, 10)||120000;
const TOKEN_TTL=process.env.TOKEN_TTL||'12h';
const MONGO_RETRY_MS=5000;

const SOURCE_OPTS={
    reconnectDelayMs: RECONNECT_DELAY_MS,
    connectTimeoutMs: CONNECT_TIMEOUT_MS,
    inactivityTimeoutMs: INACTIVITY_TIMEOUT_MS,
    failoverAttempts: FAILOVER_ATTEMPTS,
    primaryCheckMs: PRIMARY_CHECK_INTERVAL_MS
};

let spotsCollection;
let mongoClient;
let buffer=[];
const clients=new Set();
let flushTimer;
// Running DX cluster sessions, by source id
const sources=new Map();
const startedAt=Date.now();
// Latest spots, sent to WebSocket clients when they (re)connect
const recentSpots=[];
// Spots accepted per minute over the last hour (for /admin)
const spotsPerMinute=new Map();
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
    if (/\bPSK(31|63|125)?\b/.test(text)) return "PSK31";
    const digi = text.match(/\b(JT65|JT9|Q65|MSK144|JS8|OLIVIA|FST4W?|WSPR)\b/);
    if (digi) return digi[1];
    
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
    // DIGI = digital segment of the band plan without a more specific mode
    const validModes=new Set(["CW", "SSB", "AM", "FM", "FT8", "FT4", "RTTY", "PSK31", "WSPR", "JT65", "JT9", "Q65", "MSK144", "JS8", "OLIVIA", "FST4", "FST4W", "DIGI", "UNK"]);
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
    catch (error) {
        buffer=batch.concat(buffer);
        // Keep memory bounded while MongoDB is down: drop the oldest spots
        if (buffer.length>MAX_BUFFER) {
            console.warn(`Buffer full, dropping ${buffer.length-MAX_BUFFER} oldest spots`);
            buffer=buffer.slice(-MAX_BUFFER);
        }
        console.error('DB Flush Error:', error.message);
    }
}

function scheduleBufferFlush() {
    if (flushTimer) clearInterval(flushTimer);
    flushTimer=setInterval(() => flushBuffer().catch(console.error), FLUSH_INTERVAL_MS);
}

function broadcast(msg) {
    for (const c of clients) {
        // Skip slow clients until they drain their send queue
        if (c.readyState === 1 && c.bufferedAmount < WS_MAX_BUFFERED_BYTES) c.send(msg);
    }
}

function countSpotMinute() {
    const minute = Math.floor(Date.now() / 60000);
    spotsPerMinute.set(minute, (spotsPerMinute.get(minute) || 0) + 1);
    for (const m of spotsPerMinute.keys()) if (m < minute - 60) spotsPerMinute.delete(m);
}

// Called by every source for each line received. Returns 'new', 'dup' or null.
// Duplicates are detected across all sources, so the same spot seen on two clusters is stored once.
async function handleDxLine(line, source) {
    // A prompt without a trailing newline may precede the spot
    const start = line.indexOf('DX de');
    if (start === -1) return null;
    const spot = parseSpot(line.slice(start));
    if (!spot) return null;
    if (isDuplicate(spot)) return 'dup';

    spot.source = source.config.name;
    lastSpotTimestamp = spot.timestamp;
    countSpotMinute();
    const msg = JSON.stringify(spot);

    recentSpots.push(spot);
    if (recentSpots.length > RECENT_SPOTS_LIMIT) recentSpots.shift();
    broadcast(msg);

    buffer.push(spot);
    if (buffer.length >= BUFFER_LIMIT) await flushBuffer();
    return 'new';
}

// --- DX CLUSTER SOURCES ---
const sourceKey = (s) => JSON.stringify([s.name, s.host, s.port, s.callsign, s.login_commands, s.backups]);

// Start, stop or restart sessions so they match the sources stored in SQLite
function syncSources() {
    if (shuttingDown) return;
    const rows = db.listSources().filter(s => s.enabled);
    const wanted = new Map(rows.map(r => [r.id, r]));

    for (const [id, running] of sources) {
        const row = wanted.get(id);
        if (!row || sourceKey(row) !== sourceKey(running.config)) {
            running.stop();
            sources.delete(id);
        }
    }
    for (const row of rows) {
        if (sources.has(row.id)) continue;
        const src = new ClusterSource(row, SOURCE_OPTS, handleDxLine);
        sources.set(row.id, src);
        // Give a restarted session time to send 'bye' before logging in again with the same callsign
        setTimeout(() => { if (sources.get(row.id) === src && !shuttingDown) src.start(); }, 3000).unref();
    }
}

function clusterSummary() {
    const list = [...sources.values()].map(s => s.status());
    const up = list.filter(s => s.connected);
    const main = up[0] || list[0];
    // All sources down since the most recent disconnection (or since startup)
    const downSince = up.length ? null : Math.max(startedAt, ...list.map(s => s.disconnectedSince || 0));
    return { list, up, main, downSince };
}

// --- VALIDATION ---
const HOST_RE = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
const CALL_RE = /^[A-Za-z0-9/-]{3,20}$/;

function parsePort(v) {
    const n = parseInt(v, 10);
    return n >= 1 && n <= 65535 ? n : null;
}

// Validates a source payload from the admin panel; returns { value } or { error }
function validateSource(body) {
    const name = String(body.name || '').trim();
    const host = String(body.host || '').trim();
    const port = parsePort(body.port);
    const callsign = String(body.callsign || '').trim().toUpperCase();
    const loginCommands = String(body.login_commands ?? 'set/skim').replace(/\r/g, '').trim();
    if (!name || name.length > 40) return { error: 'Name is required (max 40 characters)' };
    if (!HOST_RE.test(host)) return { error: 'Invalid host' };
    if (!port) return { error: 'Invalid port' };
    if (!CALL_RE.test(callsign)) return { error: 'Invalid callsign' };
    if (loginCommands.length > 500 || /[\x00-\x09\x0B-\x1F\x7F]/.test(loginCommands)) return { error: 'Invalid login commands' };

    const rawBackups = Array.isArray(body.backups) ? body.backups : [];
    if (rawBackups.length > 10) return { error: 'Max 10 backup nodes' };
    const backups = [];
    for (const b of rawBackups) {
        const [bh, bp] = typeof b === 'string' ? b.trim().split(':') : [b.host, b.port];
        const bport = bp === undefined || bp === '' ? port : parsePort(bp);
        if (!HOST_RE.test(String(bh || '').trim()) || !bport) return { error: `Invalid backup node: ${typeof b === 'string' ? b : `${b.host}:${b.port}`}` };
        backups.push({ host: String(bh).trim(), port: bport });
    }
    return { value: { name, host, port, callsign, login_commands: loginCommands, backups, enabled: body.enabled !== false } };
}

// --- FASTIFY SETUP ---
db.open();
db.seedSourcesFromEnv();
auth.ensureInitialAdmin();

fastify.register(jwt, { secret: db.getJwtSecret(), sign: { expiresIn: TOKEN_TTL } });
fastify.register(fp(async (instance) => { instance.register(websocket); }));

fastify.register(require('@fastify/static'), {
    root: path.join(__dirname, 'assets/'),
    prefix: '/',
    decorateReply: true
});

// --- ERROR PAGES ---
// Browsers get a styled HTML page; API clients keep getting JSON
const ERROR_TEMPLATE=fs.readFileSync(path.join(__dirname, 'assets', 'error.html'), 'utf8');
const JSON_PATHS=/^\/(api|login|health|ws)(\/|$|\?)/;

function wantsHtml(request) {
    if (JSON_PATHS.test(request.url)) return false;
    return (request.headers.accept || '').includes('text/html');
}

function sendError(request, reply, status, message) {
    reply.code(status);
    if (wantsHtml(request)) {
        return reply.type('text/html; charset=utf-8').send(ERROR_TEMPLATE.replaceAll('{{STATUS}}', String(status)));
    }
    return reply.send({ error: message });
}

fastify.setNotFoundHandler((request, reply) => sendError(request, reply, 404, 'Not Found'));

fastify.setErrorHandler((error, request, reply) => {
    const status = error.statusCode >= 400 && error.statusCode < 600 ? error.statusCode : 500;
    if (status >= 500) console.error(`[HTTP ${status}] ${request.method} ${request.url}:`, error);
    // Client errors (e.g. malformed JSON) keep their message; server errors never leak internals
    return sendError(request, reply, status, status >= 500 ? 'Internal Server Error' : error.message);
});

// Valid token for a user that still exists; the role is read from the database
// so role changes and deleted users take effect immediately
fastify.decorate("authenticate", async (request, reply) => {
    try {
        await request.jwtVerify();
    } catch (err) {
        return reply.code(401).send({ error: 'Unauthorized' });
    }
    if (request.user.legacy) return; // Token from the old API_PASSWORD login (read-only API access)
    const user = db.getUser(request.user.sub);
    if (!user) return reply.code(401).send({ error: 'Unauthorized' });
    request.user = { sub: user.id, username: user.username, role: user.role };
});

fastify.decorate("requireAdmin", async (request, reply) => {
    if (request.user?.role !== 'admin') return reply.code(403).send({ error: 'Forbidden' });
});

// --- API & WS INSTANCE ---
fastify.register(async (instance) => {

    // Old monitor page, replaced by the main page
    instance.get('/monitor', (req, reply) => reply.redirect('/', 301));

    instance.get('/activity', (req, reply) => {
        return reply.sendFile('activity.html');
    });

    instance.get('/admin', (req, reply) => {
        return reply.sendFile('admin.html');
    });

    // WebSocket Channel
    instance.get('/ws', { websocket: true }, async (connection, req) => {
        clients.add(connection);
        connection.isAlive = true;
        connection.on('pong', () => { connection.isAlive = true; });
        connection.send(JSON.stringify({ status: "ok", message: "Connected" }));
        // Recent history so clients recover spots missed while disconnected
        connection.send(JSON.stringify({ type: 'history', spots: recentSpots }));

        connection.on('close', () => clients.delete(connection));
        connection.on('error', (err) => console.error(`[WS Error]:`, err.message));

        await new Promise((resolve) => {
            connection.on('close', resolve);
            connection.on('error', resolve);
        });
    });

    // Login with username/password (users stored in SQLite).
    // Legacy: { password } alone matching API_PASSWORD still returns a read-only API token.
    instance.post('/login', async (req, reply) => {
        const ip = req.ip;
        if (auth.isRateLimited(ip)) return reply.code(429).send({ error: 'Too many failed attempts, try again later' });
        const { username, password } = req.body || {};
        if (typeof password !== 'string' || !password) return reply.code(400).send({ error: 'Missing credentials' });

        if (!username) {
            if (API_PASSWORD && password === API_PASSWORD) {
                return { token: instance.jwt.sign({ user: 'api', role: 'user', legacy: true }) };
            }
            auth.registerFailedLogin(ip);
            return reply.code(401).send({ error: 'Invalid credentials' });
        }

        const user = db.getUserWithHash(String(username));
        if (!user || !auth.verifyPassword(password, user.password_hash)) {
            auth.registerFailedLogin(ip);
            return reply.code(401).send({ error: 'Invalid credentials' });
        }
        auth.clearFailedLogins(ip);
        db.touchLogin(user.id);
        return {
            token: instance.jwt.sign({ sub: user.id, username: user.username, role: user.role }),
            user: { id: user.id, username: user.username, role: user.role }
        };
    });

    instance.get('/api/me', { onRequest: [instance.authenticate] }, async (req) => req.user);

    instance.post('/api/me/password', { onRequest: [instance.authenticate] }, async (req, reply) => {
        if (req.user.legacy) return reply.code(403).send({ error: 'Forbidden' });
        const { currentPassword, newPassword } = req.body || {};
        const user = db.getUserWithHash(req.user.username);
        if (!user || !auth.verifyPassword(String(currentPassword || ''), user.password_hash)) {
            return reply.code(400).send({ error: 'Current password is incorrect' });
        }
        const err = auth.validateCredentials(null, String(newPassword || ''), { requireUsername: false });
        if (err) return reply.code(400).send({ error: err });
        db.updateUser(user.id, { passwordHash: auth.hashPassword(String(newPassword)) });
        return { ok: true };
    });

    instance.get('/health', async (_req, reply) => {
        const { list, up, main, downSince } = clusterSummary();
        // Unhealthy if every cluster source has been down longer than the grace period
        const clusterDown = !up.length && Date.now() - downSince > HEALTH_GRACE_MS;
        if (clusterDown) reply.code(503);
        return {
            ok: !clusterDown,
            dxCluster: {
                connected: up.length > 0,
                source: main?.name || null,
                node: main?.node || null,
                host: main?.host || null,
                port: main?.port || null
            },
            sources: list.map(s => ({ name: s.name, connected: s.connected, node: s.node, host: s.host, port: s.port })),
            buffer: { length: buffer.length, lastSpot: lastSpotTimestamp },
            wsClients: clients.size,
            uptime: Math.round(process.uptime())
        };
    });

    // Solar indices and propagation conditions (cached from open data sources)
    instance.get('/api/space-weather', async () => getSpaceWeather());

    // Spot activity over the last ACTIVITY_WINDOW_MIN minutes, computed from stored spots
    // ?detail=1 adds time series, band/time heatmap, continent paths and unique counts
    // for the /activity page; ?minutes= selects the window (15, 60, 360 or 1440)
    instance.get('/api/activity', async (req) => {
        const minutes = parseInt(req.query.minutes, 10);
        if (req.query.detail) return getActivityDetail(ACTIVITY_WINDOWS[minutes] ? minutes : 60);
        return getActivity();
    });

    // Historical API
    const spotsAuth = DISABLE_TOKEN_AUTH ? [] : [instance.authenticate];
    instance.get('/api/spots', { onRequest: spotsAuth }, async (req) => {
        const { mode, band, limit }=req.query;
        let query={};
        if (mode) query.mode=String(mode).toUpperCase();
        if (band) query.band=String(band);
        return await spotsCollection.find(query).sort({ timestamp: -1 }).limit(Math.min(parseInt(limit)||100, 1000)).toArray();
    });

    // --- ADMIN API ---
    instance.register(async (admin) => {
        admin.addHook('onRequest', instance.authenticate);
        admin.addHook('onRequest', instance.requireAdmin);

        admin.get('/status', async () => getSystemStatus());

        // Reference data (CTY, LoTW, eQSL, Club Log): force an update now
        admin.post('/reference/update', async (req, reply) => {
            referenceData.updateAll({ force: true }).catch(err => console.error('Reference update failed:', err.message));
            return reply.code(202).send({ ok: true });
        });

        // Sources
        admin.get('/sources', async () => {
            const running = new Map([...sources].map(([id, s]) => [id, s.status()]));
            return db.listSources().map(s => ({ ...s, status: running.get(s.id) || null }));
        });

        admin.post('/sources', async (req, reply) => {
            const { value, error } = validateSource(req.body || {});
            if (error) return reply.code(400).send({ error });
            const created = db.createSource(value);
            syncSources();
            return reply.code(201).send(created);
        });

        admin.put('/sources/:id', async (req, reply) => {
            const id = parseInt(req.params.id, 10);
            if (!db.getSource(id)) return reply.code(404).send({ error: 'Not found' });
            const { value, error } = validateSource(req.body || {});
            if (error) return reply.code(400).send({ error });
            const updated = db.updateSource(id, value);
            syncSources();
            return updated;
        });

        admin.delete('/sources/:id', async (req, reply) => {
            const id = parseInt(req.params.id, 10);
            if (!db.deleteSource(id)) return reply.code(404).send({ error: 'Not found' });
            syncSources();
            return { ok: true };
        });

        admin.post('/sources/:id/reconnect', async (req, reply) => {
            const src = sources.get(parseInt(req.params.id, 10));
            if (!src) return reply.code(404).send({ error: 'Source is not running' });
            src.reconnect();
            return { ok: true };
        });

        // Users
        admin.get('/users', async () => db.listUsers());

        admin.post('/users', async (req, reply) => {
            const { username, password, role } = req.body || {};
            const err = auth.validateCredentials(username, String(password || ''));
            if (err) return reply.code(400).send({ error: err });
            if (!['admin', 'user'].includes(role)) return reply.code(400).send({ error: 'Invalid role' });
            if (db.getUserWithHash(username)) return reply.code(409).send({ error: 'Username already exists' });
            return reply.code(201).send(db.createUser({ username, passwordHash: auth.hashPassword(String(password)), role }));
        });

        admin.put('/users/:id', async (req, reply) => {
            const id = parseInt(req.params.id, 10);
            const user = db.getUser(id);
            if (!user) return reply.code(404).send({ error: 'Not found' });
            const { role, password } = req.body || {};
            if (role !== undefined && !['admin', 'user'].includes(role)) return reply.code(400).send({ error: 'Invalid role' });
            // Never leave the system without an administrator
            if (role === 'user' && user.role === 'admin' && db.countAdmins() <= 1) {
                return reply.code(400).send({ error: 'Cannot remove the last administrator' });
            }
            if (password) {
                const err = auth.validateCredentials(null, String(password), { requireUsername: false });
                if (err) return reply.code(400).send({ error: err });
            }
            return db.updateUser(id, { role, passwordHash: password ? auth.hashPassword(String(password)) : null });
        });

        admin.delete('/users/:id', async (req, reply) => {
            const id = parseInt(req.params.id, 10);
            const user = db.getUser(id);
            if (!user) return reply.code(404).send({ error: 'Not found' });
            if (id === req.user.sub) return reply.code(400).send({ error: 'You cannot delete your own user' });
            if (user.role === 'admin' && db.countAdmins() <= 1) return reply.code(400).send({ error: 'Cannot remove the last administrator' });
            db.deleteUser(id);
            return { ok: true };
        });
    }, { prefix: '/api/admin' });
});

const ACTIVITY_WINDOW_MIN=60;
const ACTIVITY_CACHE_MS=60 * 1000;
let activityCache={ at: 0, data: null };

async function getActivity() {
    if (activityCache.data && Date.now() - activityCache.at < ACTIVITY_CACHE_MS) return activityCache.data;
    const since=new Date(Date.now() - ACTIVITY_WINDOW_MIN * 60 * 1000);
    const top=(field, limit) => [
        { $group: { _id: field, count: { $sum: 1 } } },
        { $match: { _id: { $ne: null } } },
        { $sort: { count: -1 } },
        { $limit: limit }
    ];
    const [result]=await spotsCollection.aggregate([
        { $match: { timestamp: { $gte: since } } },
        { $facet: {
            total: [{ $count: 'count' }],
            bands: top('$band', 20),
            modes: top('$mode', 10),
            countries: top('$cty.spotted.data.Country', 10),
            calls: top('$spotted', 10),
            sources: top('$source', 20)
        } }
    ]).toArray();
    const toList=(rows) => rows.map(r => ({ name: r._id, count: r.count }));
    activityCache={
        at: Date.now(),
        data: {
            windowMinutes: ACTIVITY_WINDOW_MIN,
            total: result.total[0]?.count || 0,
            bands: toList(result.bands),
            modes: toList(result.modes),
            countries: toList(result.countries),
            calls: toList(result.calls),
            sources: toList(result.sources)
        }
    };
    return activityCache.data;
}

// Window (minutes) -> time bucket size (minutes) for the /activity charts
const ACTIVITY_WINDOWS={ 15: 1, 60: 2, 360: 10, 1440: 30 };
const activityDetailCache=new Map();
const activityDetailInflight=new Map();

// Stale-while-revalidate: the 24 h aggregation can take several seconds on a Raspberry Pi,
// so cached data is returned at once and refreshed in the background (one run per window)
async function getActivityDetail(minutes) {
    const cached=activityDetailCache.get(minutes);
    // Short windows refresh every minute; long ones every 5 minutes (heavier aggregation)
    const ttl=minutes <= 60 ? 60 * 1000 : 5 * 60 * 1000;
    if (cached && Date.now() - cached.at < ttl) return cached.data;
    const run=refreshActivityDetail(minutes);
    if (cached) {
        run.catch(err => console.error(`Activity ${minutes} min refresh failed:`, err.message));
        return cached.data;
    }
    return run;
}

function refreshActivityDetail(minutes) {
    if (!activityDetailInflight.has(minutes)) {
        const run=computeActivityDetail(minutes).finally(() => activityDetailInflight.delete(minutes));
        activityDetailInflight.set(minutes, run);
    }
    return activityDetailInflight.get(minutes);
}

// Keep the heavy windows warm so /activity never waits for them
function startActivityWarmup() {
    const warm=() => [360, 1440].reduce((p, m) => p.then(() => refreshActivityDetail(m)).catch(() => {}), Promise.resolve());
    setTimeout(warm, 30 * 1000).unref();
    setInterval(warm, 5 * 60 * 1000).unref();
}

async function computeActivityDetail(minutes) {
    const now=Date.now();
    const bucketMs=ACTIVITY_WINDOWS[minutes] * 60 * 1000;
    const since=new Date(now - minutes * 60 * 1000);
    const tsLong={ $toLong: '$timestamp' };
    const bucket={ $subtract: [tsLong, { $mod: [tsLong, bucketMs] }] };
    const count=(id) => [{ $group: { _id: id, count: { $sum: 1 } } }];
    const top=(id, limit, extra={}) => [
        { $group: { _id: id, count: { $sum: 1 }, ...extra } },
        { $match: { _id: { $ne: null } } },
        { $sort: { count: -1 } },
        { $limit: limit }
    ];
    const distinct=(field) => [{ $group: { _id: field } }, { $count: 'n' }];
    // Spots grouped by position: the station locator from Club Log when known (rounded to 1°),
    // otherwise the CTY coordinates of the entity or prefix area (CTY longitudes are positive to the west)
    const points=(who) => [
        { $group: {
            _id: {
                lat: { $ifNull: [{ $round: [`$cty.${who}.grid.lat`, 0] }, `$cty.${who}.data.Latitude`] },
                lon: { $ifNull: [{ $round: [`$cty.${who}.grid.lon`, 0] }, { $multiply: [-1, `$cty.${who}.data.Longitude`] }] }
            },
            count: { $sum: 1 },
            country: { $first: `$cty.${who}.data.Country` },
            prefix: { $first: `$cty.${who}.matchedCallsign` }
        } },
        { $match: { '_id.lat': { $ne: null }, '_id.lon': { $ne: null } } }
    ];

    const [r]=await spotsCollection.aggregate([
        { $match: { timestamp: { $gte: since } } },
        { $facet: {
            total: [{ $count: 'n' }],
            uniqueCalls: distinct('$spotted'),
            uniqueCountries: distinct('$cty.spotted.data.Country'),
            uniqueSpotters: distinct('$spotter'),
            rbn: count('$rbn'),
            timeline: count(bucket),
            bandTime: count({ band: '$band', t: bucket }),
            modeTime: count({ mode: '$mode', t: bucket }),
            bands: top('$band', 20),
            modes: top('$mode', 12),
            continents: count({ from: '$cty.spotter.data.Continent', to: '$cty.spotted.data.Continent' }),
            countries: top('$cty.spotted.data.Country', 15, { adif: { $first: '$cty.spotted.data.ADIF' }, continent: { $first: '$cty.spotted.data.Continent' } }),
            calls: top('$spotted', 15, { country: { $first: '$cty.spotted.data.Country' }, adif: { $first: '$cty.spotted.data.ADIF' }, bands: { $addToSet: '$band' } }),
            spotters: top('$spotter', 10, { country: { $first: '$cty.spotter.data.Country' }, adif: { $first: '$cty.spotter.data.ADIF' } }),
            sources: top('$source', 20),
            mapSpotted: points('spotted'),
            mapSpotters: points('spotter')
        } }
    ], { allowDiskUse: true }).toArray();
    const toPoints=(rows) => rows.map(x => ({ lat: x._id.lat, lon: x._id.lon, count: x.count, country: x.country, prefix: x.prefix }));

    const n=(arr) => arr[0]?.n || 0;
    const data={
        minutes,
        bucketMinutes: ACTIVITY_WINDOWS[minutes],
        from: since.getTime(),
        to: now,
        generatedAt: now,
        total: n(r.total),
        uniqueCalls: n(r.uniqueCalls),
        uniqueCountries: n(r.uniqueCountries),
        uniqueSpotters: n(r.uniqueSpotters),
        rbn: r.rbn.find(x => x._id === true)?.count || 0,
        manual: r.rbn.find(x => x._id !== true)?.count || 0,
        timeline: r.timeline.map(x => ({ t: x._id, count: x.count })).sort((a, b) => a.t - b.t),
        bandTime: r.bandTime.map(x => ({ band: x._id.band, t: x._id.t, count: x.count })),
        modeTime: r.modeTime.map(x => ({ mode: x._id.mode, t: x._id.t, count: x.count })),
        bands: r.bands.map(x => ({ name: x._id, count: x.count })),
        modes: r.modes.map(x => ({ name: x._id, count: x.count })),
        continents: r.continents.filter(x => x._id.from && x._id.to).map(x => ({ from: x._id.from, to: x._id.to, count: x.count })),
        countries: r.countries.map(x => ({ name: x._id, count: x.count, adif: x.adif, continent: x.continent })),
        calls: r.calls.map(x => ({ name: x._id, count: x.count, country: x.country, adif: x.adif, bands: x.bands })),
        spotters: r.spotters.map(x => ({ name: x._id, count: x.count, country: x.country, adif: x.adif })),
        sources: r.sources.map(x => ({ name: x._id, count: x.count })),
        map: { spotted: toPoints(r.mapSpotted), spotters: toPoints(r.mapSpotters) }
    };
    activityDetailCache.set(minutes, { at: Date.now(), data });
    return data;
}

// System status and statistics for /admin
async function getSystemStatus() {
    const mem = process.memoryUsage();
    const nowMinute = Math.floor(Date.now() / 60000);
    const rate = [];
    for (let m = nowMinute - 59; m <= nowMinute; m++) rate.push({ t: m * 60000, count: spotsPerMinute.get(m) || 0 });

    let mongo = { ok: false };
    try {
        const stats = await mongoClient.db(DB_NAME).stats();
        mongo = {
            ok: true,
            spots: await spotsCollection.estimatedDocumentCount(),
            dataSize: stats.dataSize,
            storageSize: stats.storageSize,
            indexSize: stats.indexSize
        };
    } catch (err) {
        mongo = { ok: false, error: err.message };
    }

    let sqliteSize = null;
    try { sqliteSize = fs.statSync(db.DB_FILE).size; } catch (_) { /* ignore */ }

    const activity = await getActivity().catch(() => null);
    const sw = getSpaceWeather();

    return {
        system: {
            startedAt,
            uptime: Math.round(process.uptime()),
            node: process.version,
            platform: `${os.type()} ${os.release()} (${os.arch()})`,
            hostname: os.hostname(),
            cpus: os.cpus().length,
            loadavg: os.loadavg(),
            memTotal: os.totalmem(),
            memFree: os.freemem(),
            processRss: mem.rss,
            processHeap: mem.heapUsed
        },
        spots: {
            lastSpot: lastSpotTimestamp,
            buffer: buffer.length,
            recent: recentSpots.length,
            lastHour: activity?.total ?? null,
            bySourceLastHour: activity?.sources || [],
            perMinute: rate
        },
        mongo,
        sqlite: { file: db.DB_FILE, size: sqliteSize, users: db.countUsers() },
        websocket: { clients: clients.size },
        sources: [...sources.values()].map(s => s.status()),
        spaceWeather: sw.sources || {},
        reference: referenceData.getReferenceStatus(referenceCounts())
    };
}

// WebSocket heartbeat: ping frames detect dead clients; the JSON ping keeps
// proxies from closing idle connections and lets browsers detect silent drops
function startWsHeartbeat() {
    setInterval(() => {
        const ping = JSON.stringify({ type: 'ping', t: Date.now() });
        for (const c of clients) {
            if (!c.isAlive) {
                clients.delete(c);
                c.terminate();
                continue;
            }
            c.isAlive = false;
            try { c.ping(); } catch (_) { /* ignore */ }
            if (c.readyState === 1) c.send(ping);
        }
    }, WS_HEARTBEAT_MS).unref();
}

// MongoDB may still be starting (e.g. after a reboot): retry until it answers
async function connectMongo() {
    for (;;) {
        mongoClient=new MongoClient(MONGO_URL, { serverSelectionTimeoutMS: 10000 });
        try {
            await mongoClient.connect();
            return;
        } catch (err) {
            console.error(`MongoDB not available (${err.message}), retrying in ${MONGO_RETRY_MS / 1000}s...`);
            await mongoClient.close().catch(() => {});
            await new Promise(r => setTimeout(r, MONGO_RETRY_MS));
        }
    }
}

// --- START ---
async function start() {
    await connectMongo();
    spotsCollection=mongoClient.db(DB_NAME).collection(COLLECTION_NAME);
    await spotsCollection.createIndex({ timestamp: -1 });
    await spotsCollection.createIndex({ timestamp: 1 }, { expireAfterSeconds: TTL_SECONDS });

    scheduleBufferFlush();
    await fastify.listen({ port: SERVER_PORT, host: SERVER_HOST });
    console.log(`🚀 Server running on ${SERVER_HOST}:${SERVER_PORT}`);
    startWsHeartbeat();
    startSpaceWeather();
    startActivityWarmup();
    // Weekly refresh of CTY, LoTW, eQSL and Club Log data; reload right after each update
    preloadReferenceData();
    referenceData.startReferenceUpdates((key) => {
        reloadReferenceData(key);
        preloadReferenceData();
    });
    syncSources();
}

// Clean shutdown (docker stop/restart): notify the clusters to avoid stale sessions
async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} recibido, cerrando...`);
    for (const s of sources.values()) s.stop();
    try { await flushBuffer(); } catch (_) { /* ignore */ }
    setTimeout(() => process.exit(0), 1000);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start().catch((err) => {
    // Exit so Docker restarts the container instead of leaving it half started
    console.error('Startup failed:', err);
    process.exit(1);
});
