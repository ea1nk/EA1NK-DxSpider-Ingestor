/**
 * SPACE WEATHER / PROPAGATION DATA
 * Periodically fetches open data sources and keeps the latest good values in memory,
 * so browsers never hit external services directly (no CORS, no rate limits).
 *
 * Sources:
 *  - N0NBH / HamQSL (https://www.hamqsl.com/solar.html): solar indices and band conditions
 *  - NOAA SWPC (https://www.swpc.noaa.gov): Kp, GOES X-ray, solar wind, NOAA scales, daily indices
 */

const REFRESH_MS = parseInt(process.env.SPACE_WEATHER_REFRESH_MS, 10) || 15 * 60 * 1000;
const FETCH_TIMEOUT_MS = 20000;

const URLS = {
    hamqsl: 'https://www.hamqsl.com/solarxml.php',
    kp: 'https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json',
    xray: 'https://services.swpc.noaa.gov/json/goes/primary/xrays-6-hour.json',
    windSpeed: 'https://services.swpc.noaa.gov/products/summary/solar-wind-speed.json',
    windMag: 'https://services.swpc.noaa.gov/products/summary/solar-wind-mag-field.json',
    scales: 'https://services.swpc.noaa.gov/products/noaa-scales.json',
    daily: 'https://services.swpc.noaa.gov/text/daily-solar-indices.txt'
};

// Latest good value per source; a failing source keeps its previous data
const cache = {};
const status = {};

async function fetchText(url) {
    const res = await fetch(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { 'User-Agent': 'EA1NK-DxSpider-Ingestor' }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
}

const num = (v) => {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
};

// Flux in W/m² -> GOES class string (e.g. 3.6e-5 -> "M3.6")
function xrayClass(flux) {
    if (!flux || flux <= 0) return null;
    const classes = [['X', 1e-4], ['M', 1e-5], ['C', 1e-6], ['B', 1e-7], ['A', 1e-8]];
    for (const [letter, base] of classes) {
        if (flux >= base) return `${letter}${(flux / base).toFixed(1)}`;
    }
    return 'A0.0';
}

const parsers = {
    hamqsl(xml) {
        const tag = (name) => {
            const m = xml.match(new RegExp(`<${name}>([^<]*)</${name}>`));
            return m ? m[1].trim() : null;
        };
        const bands = {};
        for (const m of xml.matchAll(/<band name="([^"]+)" time="(day|night)">([^<]+)<\/band>/g)) {
            bands[m[1]] = bands[m[1]] || {};
            bands[m[1]][m[2]] = m[3].trim();
        }
        const vhf = [];
        for (const m of xml.matchAll(/<phenomenon name="([^"]+)" location="([^"]+)">([^<]+)<\/phenomenon>/g)) {
            vhf.push({ name: m[1], location: m[2], status: m[3].trim() });
        }
        return {
            updated: tag('updated'),
            sfi: num(tag('solarflux')),
            ssn: num(tag('sunspots')),
            aIndex: num(tag('aindex')),
            kIndex: num(tag('kindex')),
            xray: tag('xray'),
            protonFlux: num(tag('protonflux')),
            electronFlux: num(tag('electonflux')),
            aurora: num(tag('aurora')),
            auroraLat: num(tag('latdegree')),
            solarWind: num(tag('solarwind')),
            magField: num(tag('magneticfield')),
            geomagField: tag('geomagfield'),
            signalNoise: tag('signalnoise'),
            muf: tag('muf'),
            bands,
            vhf
        };
    },

    kp(text) {
        const data = JSON.parse(text);
        // Current format: array of objects. Legacy format: header row + arrays.
        const rows = Array.isArray(data[0])
            ? data.slice(1).map(r => ({ time: r[0], kp: num(r[1]) }))
            : data.map(r => ({ time: r.time_tag, kp: num(r.Kp) }));
        return rows
            .filter(r => r.kp !== null)
            .slice(-24) // last 3 days of 3-hour intervals
            .map(r => ({ time: r.time.endsWith('Z') ? r.time : `${r.time.replace(' ', 'T')}Z`, kp: r.kp }));
    },

    xray(text) {
        // Long channel (0.1-0.8 nm) defines the flare class; keep one point every 5 minutes
        const points = JSON.parse(text)
            .filter(p => p.energy === '0.1-0.8nm' && p.flux > 0)
            .map(p => ({ time: p.time_tag, flux: p.flux }));
        const sampled = points.filter((_, i) => i % 5 === 0 || i === points.length - 1);
        const current = points.at(-1)?.flux ?? null;
        const max = points.reduce((m, p) => Math.max(m, p.flux), 0) || null;
        return {
            current,
            currentClass: xrayClass(current),
            max6h: max,
            max6hClass: xrayClass(max),
            series: sampled
        };
    },

    windSpeed(text) {
        const d = JSON.parse(text)[0] || {};
        return { speed: num(d.proton_speed), time: d.time_tag || null };
    },

    windMag(text) {
        const d = JSON.parse(text)[0] || {};
        return { bt: num(d.bt), bz: num(d.bz_gsm), time: d.time_tag || null };
    },

    scales(text) {
        const d = JSON.parse(text);
        const now = d['0'] || {};
        const forecast = ['1', '2', '3'].filter(k => d[k]).map(k => ({
            date: d[k].DateStamp,
            rMinorProb: num(d[k].R?.MinorProb),
            rMajorProb: num(d[k].R?.MajorProb),
            sProb: num(d[k].S?.Prob),
            g: num(d[k].G?.Scale)
        }));
        return {
            r: num(now.R?.Scale), rText: now.R?.Text || null,
            s: num(now.S?.Scale), sText: now.S?.Text || null,
            // The current G scale is sometimes empty; fall back to the last observed day
            g: num(now.G?.Scale) ?? num(d['-1']?.G?.Scale),
            gText: now.G?.Text || d['-1']?.G?.Text || null,
            forecast
        };
    },

    daily(text) {
        // "YYYY MM DD  SFI  SSN  area  new_regions ..." - last 30 days
        return text.split('\n')
            .filter(l => /^\d{4} \d{2} \d{2}/.test(l))
            .map(l => {
                const c = l.trim().split(/\s+/);
                return { date: `${c[0]}-${c[1]}-${c[2]}`, sfi: num(c[3]), ssn: num(c[4]) };
            })
            .filter(r => r.sfi !== null && r.sfi > 0);
    }
};

const RETRY_MS = 60 * 1000;
let retryTimer = null;

async function refreshSources(keys) {
    const failed = [];
    await Promise.all(keys.map(async (key) => {
        try {
            cache[key] = parsers[key](await fetchText(URLS[key]));
            status[key] = { ok: true, updatedAt: new Date().toISOString() };
        } catch (err) {
            failed.push(key);
            status[key] = { ...status[key], ok: false, error: err.message, failedAt: new Date().toISOString() };
            console.error(`Space weather source "${key}" failed: ${err.message}`);
        }
    }));
    // Transient failures (e.g. a truncated response) are retried after a minute instead of waiting a full cycle
    if (failed.length && !retryTimer) {
        retryTimer = setTimeout(() => { retryTimer = null; refreshSources(failed); }, RETRY_MS);
        retryTimer.unref();
    }
}

const refresh = () => refreshSources(Object.keys(URLS));

function startSpaceWeather() {
    refresh();
    setInterval(refresh, REFRESH_MS).unref();
}

function getSpaceWeather() {
    return { ...cache, sources: status, refreshMs: REFRESH_MS };
}

module.exports = { startSpaceWeather, getSpaceWeather };
