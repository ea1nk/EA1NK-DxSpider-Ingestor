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

let spotsCollection;
let mongoClient;
let buffer=[];
const clients=new Set(); 
let flushTimer;
let dxConnected=false;
let lastSpotTimestamp=null;

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

function inferModeByHFSubband(mhz) {
    if (mhz>=1.8&&mhz<1.838) return "CW";
    if (mhz>=1.84&&mhz<=2.0) return "SSB";
    if (mhz>=3.5&&mhz<3.58) return "CW";
    if (mhz>=3.6&&mhz<=3.8) return "SSB";
    if (mhz>=7.0&&mhz<7.04) return "CW";
    if (mhz>=7.125&&mhz<=7.2) return "SSB";
    if (mhz>=10.1&&mhz<=10.15) return "CW";
    if (mhz>=14.0&&mhz<14.07) return "CW";
    if (mhz>=14.112&&mhz<=14.35) return "SSB";
    if (mhz>=18.068&&mhz<18.11) return "CW";
    if (mhz>=18.111&&mhz<=18.168) return "SSB";
    if (mhz>=21.0&&mhz<21.07) return "CW";
    if (mhz>=21.151&&mhz<=21.45) return "SSB";
    if (mhz>=24.89&&mhz<24.93) return "CW";
    if (mhz>=24.931&&mhz<=24.99) return "SSB";
    if (mhz>=28.0&&mhz<28.07) return "CW";
    if (mhz>=28.3&&mhz<=29.7) return "SSB";
    return null;
}

function inferMode(freq, comment) {
    const mhz=toMHz(freq);
    const text=(comment||"").toUpperCase();
    if (/\bFT8\b/.test(text)) return "FT8";
    if (/\bFT4\b/.test(text)) return "FT4";
    if (/\bJT65\b/.test(text)) return "JT65";
    if (/\bJT9\b/.test(text)) return "JT9";
    if (/\bWSPR\b/.test(text)) return "WSPR";
    if (/\bRTTY\b|\bFSK\b/.test(text)) return "RTTY";
    if (/\bPSK31\b/.test(text)) return "PSK31";
    if (/\bPSK63\b/.test(text)) return "PSK63";
    if (/\bPSK\b/.test(text)) return "PSK";
    if (/\bCW\b|\bWPM\b/.test(text)) return "CW";
    if (/\bSSB\b|\bUSB\b|\bLSB\b|\bPHONE\b/.test(text)) return "SSB";
    if (/\bAM\b/.test(text)) return "AM";
    if (/\bFM\b/.test(text)) return "FM";

    const ft8Freqs=[1.84, 3.573, 7.074, 10.136, 14.074, 18.1, 21.074, 24.915, 28.074, 50.313];
    if (ft8Freqs.some((f) => isNear(mhz, f))) return "FT8";

    if (/\bDB\b/.test(text)) return "CW";
    return inferModeByHFSubband(mhz) || "UNK";
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
    // 1. Clean network noise and control characters
    const cleanData = data.toString().replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "").trim();
    
    // 2. Regex: Note that the fourth group (payload) captures EVERYTHING between the callsign and the time
    const regex = /^DX de\s+([\w\d/-]+(?:-#)?):\s+([\d.]+)\s+([\w\d/]+)\s+(.*?)\s+(\d{4})Z$/i;
    const match = cleanData.match(regex);

    if (!match) return null;

    const [, rawSpotter, rawFreq, rawSpotted, payload, timeZ] = match;
    const freq = parseFloat(rawFreq);
    const spotter = rawSpotter.toUpperCase();
    const spotted = rawSpotted.toUpperCase();
    
    // KEEP THE FULL COMMENT
    const comment = payload.trim(); 
    
    const mode = normalizeMode(inferMode(freq, comment));

    // 3. SNR extraction without "deleting" the comment
    const snrMatch = comment.match(/([+-]?\d+)\s*dB/i);
    const snr = snrMatch ? parseInt(snrMatch[1], 10) : null;

    // 4. Optimized RBN vs TRAD logic
    const hasRbnSuffix = spotter.endsWith('-#');
    const hasWpm = /\d+\s*WPM/i.test(comment);
    
    // A spot is RBN if it has the suffix, or if it has SNR+WPM
    // But if it has a lot of text (like "DAG HOLLAND"), it is likely TRAD even if it includes dB
    let isRbn = hasRbnSuffix || (snr !== null && hasWpm);
    
    // Refinement: If it does not have the RBN suffix and the comment is long (> 15 characters),
    // we treat it as TRAD (human who wrote the report)
    if (!hasRbnSuffix && comment.length > 15) {
        isRbn = false;
    }

    const timestamp = new Date();
    timestamp.setUTCHours(timeZ.substring(0, 2), timeZ.substring(2, 4), 0, 0);

    return {
        spotter,
        spotted,
        freq,
        band: getBand(freq),
        mode,
        comment, // Here you will now have the full "FT8 +26 dB DAG HOLLAND"
        snr,     // Here you will have 26 (numeric)
        rbn: isRbn,
        time_z: timeZ,
        timestamp,
        cty: { 
            spotter: lookupCallsignInfo(spotter), 
            spotted: lookupCallsignInfo(spotted) 
        }
    };
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

function connectToDxCluster() {
    const telnet=new net.Socket();
    telnet.on('error', (e) => { dxConnected=false; console.error(`Cluster error: ${e.message}`); });
    telnet.connect(DX_PORT, DX_HOST, () => {
        dxConnected=true;
        console.log("📡 Connected to DXSpider");
        telnet.write(`${CALLSIGN}\n`);
        setTimeout(() => telnet.write('set/skim\n'), 1000);
    });

    telnet.on('data', async (data) => {
    // 1. Clean control characters (such as bell/beeps \x07)
    const cleanData = data.toString().replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
    const lines = cleanData.split(/\r?\n/);

    for (let line of lines) {
        // Only process lines that have the standard spot format
        if (line.startsWith('DX de')) {
            const spot = parseSpot(line);
            
            if (spot) {
                // Refine the RBN mark before sending
                // A TRAD spot can become RBN if we detect automated patterns
                const isAutomated = spot.rbn || detectAutomatedPatterns(spot.comment, spot.mode);
                spot.rbn = isAutomated;

                const label = isAutomated ? 'RBN' : 'TRAD';
                console.log(`[${label}]: ${spot.freq.toFixed(1)} ${spot.spotted} by ${spot.spotter}`);

                lastSpotTimestamp = spot.timestamp;
                const msg = JSON.stringify(spot);
                
                for (const c of clients) {
                    if (c.readyState === 1) c.send(msg);
                }

                buffer.push(spot);
                if (buffer.length >= BUFFER_LIMIT) await flushBuffer();
            } else {
                console.warn('[NOT PARSED]:', line);
            }
        }
    }
});

    telnet.on('close', () => { dxConnected=false; setTimeout(connectToDxCluster, RECONNECT_DELAY_MS); });
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
            dxCluster: { connected: dxConnected, host: DX_HOST },
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
}

start().catch(console.error);