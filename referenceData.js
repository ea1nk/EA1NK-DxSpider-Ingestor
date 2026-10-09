/**
 * REFERENCE DATA UPDATER
 * Keeps the CTY dictionary and the LoTW, eQSL and Club Log user lists up to date.
 *
 * Updated files are written to DATA_DIR/reference (a Docker volume), so they survive
 * image rebuilds; the copies bundled in the repository are only used until the first download.
 *
 * Sources:
 *  - CTY (AD1C, country-files.com): cty.plist, converted to cty_dict.json
 *  - LoTW (ARRL): lotw-user-activity.csv
 *  - eQSL: AG member list
 *  - Club Log: clublog-users.json.zip, reduced to clublog-users.csv (callsign,clublog,oqrs,locator)
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const REFERENCE_DIR = path.join(DATA_DIR, 'reference');
const UPDATE_DAYS = parseFloat(process.env.REFERENCE_UPDATE_DAYS) || 7;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DOWNLOAD_TIMEOUT_MS = 180 * 1000;
// Some sources (e.g. country-files.com) reject non-browser User-Agent strings
const USER_AGENT = process.env.DOWNLOAD_USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const DATASETS = {
    cty: {
        file: 'cty_dict.json',
        url: 'https://www.country-files.com/cty/cty.plist',
        convert: (buf) => {
            const dict = parsePlist(buf.toString('utf8'));
            const n = Object.keys(dict).length;
            if (n < 10000 || !dict.EA || !dict.K) throw new Error(`Unexpected CTY content (${n} entries)`);
            return JSON.stringify(dict);
        }
    },
    lotw: {
        file: 'lotw-users.csv',
        url: 'https://lotw.arrl.org/lotw-user-activity.csv',
        convert: (buf) => {
            const text = buf.toString('utf8');
            const lines = text.split('\n').filter(Boolean).length;
            if (lines < 100000 || !/^[A-Z0-9/]+,\d{4}-\d{2}-\d{2}/m.test(text.slice(0, 200))) throw new Error(`Unexpected LoTW content (${lines} lines)`);
            return text;
        }
    },
    eqsl: {
        file: 'eqsl-users.txt',
        url: 'https://www.eqsl.cc/qslcard/DownloadedFiles/AGMemberList.txt',
        convert: (buf) => {
            const text = buf.toString('utf8');
            const lines = text.split('\n').filter(Boolean).length;
            if (lines < 50000 || !/^List of AG members/i.test(text)) throw new Error(`Unexpected eQSL content (${lines} lines)`);
            return text;
        }
    },
    clublog: {
        file: 'clublog-users.csv',
        url: 'https://cdn.clublog.org/clublog-users.json.zip',
        convert: (buf) => {
            const users = JSON.parse(unzipSingle(buf).toString('utf8'));
            const rows = [];
            let uploaders = 0;
            for (const [call, info] of Object.entries(users)) {
                // Keys like "1A0C_14" are per-event logs
                if (call.includes('_')) continue;
                // A Club Log user is a callsign that uploads logs; the locator is kept for any callsign that has one
                const uploads = info.lastupload ? 1 : 0;
                const locator = /^[A-R]{2}\d{2}([A-X]{2})?$/i.test(info.locator || '') ? info.locator.toUpperCase() : '';
                if (!uploads && !locator) continue;
                uploaders += uploads;
                rows.push(`${call},${uploads},${info.oqrs ? 1 : 0},${locator}`);
            }
            if (uploaders < 50000) throw new Error(`Unexpected Club Log content (${uploaders} users)`);
            return `callsign,clublog,oqrs,locator\n${rows.join('\n')}\n`;
        }
    }
};

const status = Object.fromEntries(Object.keys(DATASETS).map(k => [k, { lastError: null, lastErrorAt: null, lastCheck: null, updating: false }]));
let onUpdated = () => {};
let running = null;

// --- Paths ---
// Updated copy in DATA_DIR/reference, or the file bundled with the app as a fallback
function resolvePath(file) {
    const updated = path.join(REFERENCE_DIR, file);
    if (fs.existsSync(updated)) return updated;
    const bundled = path.join(__dirname, file);
    return fs.existsSync(bundled) ? bundled : null;
}

function fileInfo(file) {
    const p = resolvePath(file);
    if (!p) return { path: null, updatedAt: null, size: null, bundled: false };
    const st = fs.statSync(p);
    return { path: p, updatedAt: st.mtimeMs, size: st.size, bundled: !p.startsWith(REFERENCE_DIR) };
}

// --- cty.plist parser (flat dictionary of dictionaries) ---
function decodeXml(s) {
    return s.replace(/&(amp|lt|gt|quot|apos);/g, (m, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e]));
}

function parsePlist(xml) {
    const out = {};
    const entryRe = /<key>([^<]+)<\/key>\s*<dict>([\s\S]*?)<\/dict>/g;
    const fieldRe = /<key>([^<]+)<\/key>\s*(?:<(string|integer|real)>([^<]*)<\/\2>|<(true|false)\/>)/g;
    let m;
    while ((m = entryRe.exec(xml))) {
        const entry = {};
        let f;
        fieldRe.lastIndex = 0;
        while ((f = fieldRe.exec(m[2]))) {
            const [, key, type, value, bool] = f;
            if (bool) entry[key] = bool === 'true';
            else if (type === 'string') entry[key] = decodeXml(value);
            else entry[key] = Number(value);
        }
        out[decodeXml(m[1])] = entry;
    }
    return out;
}

// --- Minimal ZIP reader: first file of the archive (stored or deflated) ---
function unzipSingle(buf) {
    const EOCD = 0x06054b50;
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
        if (buf.readUInt32LE(i) === EOCD) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('Invalid ZIP file');
    const cd = buf.readUInt32LE(eocd + 16);
    if (buf.readUInt32LE(cd) !== 0x02014b50) throw new Error('Invalid ZIP central directory');
    const method = buf.readUInt16LE(cd + 10);
    const compSize = buf.readUInt32LE(cd + 20);
    const localOffset = buf.readUInt32LE(cd + 42);
    const nameLen = buf.readUInt16LE(localOffset + 26);
    const extraLen = buf.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + nameLen + extraLen;
    const data = buf.subarray(start, start + compSize);
    if (method === 0) return data;
    if (method === 8) return zlib.inflateRawSync(data);
    throw new Error(`Unsupported ZIP compression method ${method}`);
}

// --- Download and update ---
async function download(url) {
    const res = await fetch(url, {
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
        headers: { 'User-Agent': USER_AGENT }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
}

async function updateDataset(key) {
    const ds = DATASETS[key];
    const st = status[key];
    st.updating = true;
    st.lastCheck = Date.now();
    try {
        const content = ds.convert(await download(ds.url));
        fs.mkdirSync(REFERENCE_DIR, { recursive: true });
        // Write to a temporary file and rename, so a failed update never leaves a broken file
        const target = path.join(REFERENCE_DIR, ds.file);
        fs.writeFileSync(`${target}.tmp`, content);
        fs.renameSync(`${target}.tmp`, target);
        st.lastError = null;
        st.lastErrorAt = null;
        console.log(`Reference data "${key}" updated (${(content.length / 1048576).toFixed(1)} MB)`);
        onUpdated(key);
        return true;
    } catch (err) {
        st.lastError = err.message;
        st.lastErrorAt = Date.now();
        console.error(`Reference data "${key}" update failed: ${err.message}`);
        return false;
    } finally {
        st.updating = false;
    }
}

const isStale = (key) => {
    const info = fileInfo(DATASETS[key].file);
    return !info.path || info.bundled || Date.now() - info.updatedAt > UPDATE_DAYS * 86400000;
};

// One dataset at a time, to keep memory and CPU low on a Raspberry Pi
function updateAll({ force = false } = {}) {
    if (running) return running;
    running = (async () => {
        for (const key of Object.keys(DATASETS)) {
            if (force || isStale(key)) await updateDataset(key);
        }
    })().finally(() => { running = null; });
    return running;
}

function startReferenceUpdates(callback) {
    if (callback) onUpdated = callback;
    // Short delay so the first download does not slow down startup
    setTimeout(() => updateAll(), 60 * 1000).unref();
    setInterval(() => updateAll(), CHECK_INTERVAL_MS).unref();
}

function getReferenceStatus(counts = {}) {
    return {
        updateDays: UPDATE_DAYS,
        running: !!running,
        datasets: Object.entries(DATASETS).map(([key, ds]) => {
            const info = fileInfo(ds.file);
            return {
                key,
                file: ds.file,
                url: ds.url,
                updatedAt: info.updatedAt,
                size: info.size,
                bundled: info.bundled,
                entries: counts[key] ?? null,
                ...status[key]
            };
        })
    };
}

module.exports = { USER_AGENT, resolvePath, startReferenceUpdates, updateAll, getReferenceStatus, parsePlist, unzipSingle };
