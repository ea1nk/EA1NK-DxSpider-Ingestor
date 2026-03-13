/**
 * RBN & TRADITIONAL INGESTOR + API + WEBSOCKETS
*/

require('dotenv').config();

const net=require('net');
const { MongoClient }=require('mongodb');
const fastify=require('fastify')({ logger: false });
const websocket=require('@fastify/websocket');
const jwt=require('@fastify/jwt');
const { lookupCallsignInfo }=require('./callsignLookup');

// --- CONFIGURATION ---
const MONGO_URL=process.env.MONGO_URL||'mongodb://db:27017';
const DB_NAME=process.env.DB_NAME||'rbn_radio';
const COLLECTION_NAME=process.env.COLLECTION_NAME||'spots';
const DX_HOST=process.env.DX_HOST||'localhost';
const DX_PORT=parseInt(process.env.DX_PORT, 10)||7300;
const CALLSIGN=process.env.CALLSIGN||'YOUR_CALLSIGN';
const SECRET_KEY=process.env.SECRET_KEY||'YOUR_SUPERSECRET_KEY';
const API_PASSWORD=process.env.API_PASSWORD||'radio_password';
const SERVER_HOST=process.env.SERVER_HOST||'0.0.0.0';
const SERVER_PORT=parseInt(process.env.SERVER_PORT, 10)||3000;
const BUFFER_LIMIT=parseInt(process.env.BUFFER_LIMIT, 10)||15;
const TTL_SECONDS=parseInt(process.env.TTL_SECONDS, 10)||604800;
const RECONNECT_DELAY_MS=parseInt(process.env.RECONNECT_DELAY_MS, 10)||10000;

let spotsCollection;
let buffer=[];
const clients=new Set(); // For WebSockets

// --- UTILITIES ---
const getBand=(f) => {
    // DX clusters may provide frequency in kHz (e.g. 14074) or MHz (e.g. 14.074).
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
    // Conservative HF split: returns only when segment is typically unambiguous.
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

    // Priority 1: explicit mode hints in comment.
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

    // Priority 2: common activity frequencies when comment is ambiguous.
    const ft8Freqs=[1.84, 3.573, 5.357, 7.074, 10.136, 14.074, 18.1, 21.074, 24.915, 28.074, 50.313, 70.154, 144.174, 432.174];
    if (ft8Freqs.some((f) => isNear(mhz, f))) return "FT8";

    const ft4Freqs=[3.575, 7.0475, 10.14, 14.08, 18.104, 21.14, 24.919, 28.18, 50.318, 144.17];
    if (ft4Freqs.some((f) => isNear(mhz, f))) return "FT4";

    // RBN spots are usually CW when no explicit mode is provided.
    if (/\bDB\b/.test(text)) return "CW";

    const subbandMode=inferModeByHFSubband(mhz);
    if (subbandMode) return subbandMode;

    return "UNK";
}

function extractExplicitMode(payload) {
    const text=(payload||"").toUpperCase().trim();
    const match=text.match(/^(CW|SSB|USB|LSB|AM|FM|FT8|FT4|JT65|JT9|WSPR|RTTY|PSK31|PSK63|PSK|PHONE)\b/);
    if (!match) return null;
    if (match[1]==="PHONE") return "SSB";
    return match[1];
}

function normalizeMode(mode) {
    const text=(mode||"").toString().toUpperCase().trim();
    if (!text) return "UNK";
    if (text==="PHONE"||text==="USB"||text==="LSB") return "SSB";

    const validModes=new Set([
        "CW", "SSB", "AM", "FM", "FT8", "FT4", "JT65", "JT9", "WSPR", "RTTY", "PSK31", "PSK63", "PSK", "UNK",
    ]);
    if (validModes.has(text)) return text;
    return "UNK";
}

function parseSpot(data) {
    const cleanLine=data.replace(/[\x00-\x1F\x7F-\x9F]/g, "").trim();
    const regex=/^DX de\s+([^:]+):\s+([\d.]+)\s+(\S+)\s+(.+?)\s+(\d{4})Z$/i;
    const match=cleanLine.match(regex);

    if (match) {
        const freq=parseFloat(match[2]);
        const spotterCallsign=match[1].toUpperCase();
        const spottedCallsign=match[3].toUpperCase();
        const payload=(match[4]||"").trim();
        const explicitMode=extractExplicitMode(payload);
        const inferredMode=explicitMode||inferMode(freq, payload);
        let mode=normalizeMode(inferredMode);
        // Never store callsigns in mode, even if malformed upstream data appears.
        if (mode===spotterCallsign||mode===spottedCallsign) mode="UNK";
        const snrMatch=payload.match(/([+-]?\d+)\s*dB\b/i);
        const snr=snrMatch? parseInt(snrMatch[1], 10):null;
        const isRbn=/\bdB\b|\bWPM\b|\bBPS\b/i.test(payload);
        const spotterCty=lookupCallsignInfo(spotterCallsign);
        const spottedCty=lookupCallsignInfo(spottedCallsign);

        return {
            spotter: spotterCallsign,
            spotted: spottedCallsign,
            freq: freq,
            band: getBand(freq),
            mode,
            comment: payload,
            snr,
            rbn: isRbn,
            time_z: match[5],
            timestamp: new Date(),
            cty: {
                spotter: spotterCty,
                spotted: spottedCty,
            },
        };
    }
    return null;
}

// --- PLUGIN REGISTRATION ---
fastify.register(jwt, { secret: SECRET_KEY });
fastify.register(websocket);

fastify.decorate("authenticate", async (request, reply) => {
    try { await request.jwtVerify(); }
    catch (err) { reply.code(401).send({ error: 'Unauthorized' }); }
});

// --- ROUTES AND WEBSOCKET ---
fastify.register(async (instance) => {
    // Real-time WebSocket channel
    instance.get('/ws', { websocket: true }, (connection) => {
        clients.add(connection);
        connection.socket.on('close', () => clients.delete(connection));
    });

    // API Login
    instance.post('/login', async (req) => {
        if (req.body.password===API_PASSWORD) {
            return { token: instance.jwt.sign({ user: 'admin' }) };
        }
        throw new Error('Invalid Password');
    });

    // Historical query API (with filters)
    instance.get('/api/spots', { onRequest: [instance.authenticate] }, async (req) => {
        const {
            rbn,
            mode,
            band,
            callsign,
            spotterCountry,
            spottedCountry,
            country,
            spotterPrefix,
            spottedPrefix,
            prefix,
            spotterContinent,
            spottedContinent,
            continent,
            limit,
        }=req.query;
        let query={};
        const andClauses=[];
        if (rbn!==undefined) query.rbn=rbn==='true';
        if (mode) query.mode=mode.toUpperCase();
        if (band) query.band=band;
        if (callsign) query.spotter={ $regex: callsign, $options: 'i' };
        if (spotterCountry) query['cty.spotter.data.Country']={ $regex: spotterCountry, $options: 'i' };
        if (spottedCountry) query['cty.spotted.data.Country']={ $regex: spottedCountry, $options: 'i' };
        if (spotterPrefix) query['cty.spotter.matchedCallsign']={ $regex: `^${spotterPrefix}`, $options: 'i' };
        if (spottedPrefix) query['cty.spotted.matchedCallsign']={ $regex: `^${spottedPrefix}`, $options: 'i' };
        if (spotterContinent) query['cty.spotter.data.Continent']=spotterContinent.toUpperCase();
        if (spottedContinent) query['cty.spotted.data.Continent']=spottedContinent.toUpperCase();

        if (country) {
            andClauses.push({
                $or: [
                    { 'cty.spotter.data.Country': { $regex: country, $options: 'i' } },
                    { 'cty.spotted.data.Country': { $regex: country, $options: 'i' } },
                ],
            });
        }

        if (prefix) {
            andClauses.push({
                $or: [
                    { 'cty.spotter.matchedCallsign': { $regex: `^${prefix}`, $options: 'i' } },
                    { 'cty.spotted.matchedCallsign': { $regex: `^${prefix}`, $options: 'i' } },
                ],
            });
        }

        if (continent) {
            andClauses.push({
                $or: [
                    { 'cty.spotter.data.Continent': continent.toUpperCase() },
                    { 'cty.spotted.data.Continent': continent.toUpperCase() },
                ],
            });
        }

        if (andClauses.length>0) {
            query.$and=andClauses;
        }

        return await spotsCollection.find(query)
            .sort({ timestamp: -1 })
            .limit(parseInt(limit)||100)
            .toArray();
    });
});

// --- CORE ---
async function start() {
    // 1. Database
    const client=new MongoClient(MONGO_URL);
    await client.connect();
    spotsCollection=client.db(DB_NAME).collection(COLLECTION_NAME);

    // Critical indexes for queries
    await spotsCollection.createIndex({ timestamp: -1 });
    await spotsCollection.createIndex({ rbn: 1, timestamp: -1 });
    await spotsCollection.createIndex({ 'cty.spotter.data.Country': 1, timestamp: -1 });
    await spotsCollection.createIndex({ 'cty.spotted.data.Country': 1, timestamp: -1 });
    await spotsCollection.createIndex({ 'cty.spotter.matchedCallsign': 1, timestamp: -1 });
    await spotsCollection.createIndex({ 'cty.spotted.matchedCallsign': 1, timestamp: -1 });
    await spotsCollection.createIndex({ 'cty.spotter.data.Continent': 1, timestamp: -1 });
    await spotsCollection.createIndex({ 'cty.spotted.data.Continent': 1, timestamp: -1 });
    await spotsCollection.createIndex({ timestamp: 1 }, { expireAfterSeconds: TTL_SECONDS });

    // 2. Web Server
    await fastify.listen({ port: SERVER_PORT, host: SERVER_HOST });
    console.log(`🚀 Server running on ${SERVER_HOST}:${SERVER_PORT}`);

    // 3. Telnet Connection
    const telnet=new net.Socket();
    telnet.connect(DX_PORT, DX_HOST, () => {
        console.log("📡 Connected to DXSpider");
        telnet.write(`${CALLSIGN}\n`);
    });

    telnet.on('data', async (data) => {
        const lines=data.toString().split(/\r?\n/);
        for (let line of lines) {
            if (line.includes('DX de')) {
                const spot=parseSpot(line);
                if (spot) {
                    // Immediate broadcast via WS
                    const msg=JSON.stringify(spot);
                    for (const c of clients) if (c.socket.readyState===1) c.socket.send(msg);

                    // Buffer for decrease writings to disk and extend drive lifespan
                    buffer.push(spot);
                    if (buffer.length>=BUFFER_LIMIT) {
                        const batch=[...buffer];
                        buffer=[];
                        await spotsCollection.insertMany(batch).catch(console.error);
                    }
                }
            }
        }
    });

    telnet.on('close', () => setTimeout(start, RECONNECT_DELAY_MS));
}

start().catch(console.error);
