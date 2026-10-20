/**
 * SUMMARIES AND REPORTS
 * Spots expire with the TTL index, and aggregating a whole day of spots is slow on a
 * Raspberry Pi, so statistics are built from summaries:
 *
 *  - stats_hourly / stats_hourly_calls: every finished UTC hour, in 10-minute buckets,
 *    with its unique stations. Kept HOURLY_KEEP_DAYS days. They feed the 6 h / 24 h
 *    live windows and today's report (plus the current hour, computed from the spots).
 *  - stats_daily / stats_daily_calls: every finished UTC day, in hourly buckets, kept
 *    forever. They feed the day reports and the month reports (merged day by day).
 */

const HOUR_MS = 3600000;
const DAY_MS = 86400000;
const HOUR_BUCKET_MINUTES = 10;
const HOURLY_KEEP_DAYS = 9;
const SUMMARY_LIMITS = { countries: 400, calls: 200, spotters: 100 };
const LIVE_CACHE_MS = 2 * 60 * 1000;
const BACKFILL_PAUSE_MS = 1500;

const dayKey = (t) => new Date(t).toISOString().slice(0, 10);
const dayStart = (key) => new Date(`${key}T00:00:00Z`);
const hourKey = (t) => new Date(t).toISOString().slice(0, 13);
const hourStart = (key) => new Date(`${key}:00:00Z`);
const floorHour = (t) => Math.floor(t / HOUR_MS) * HOUR_MS;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function createReports({ mongoDb, spots, aggregateSpots }) {
    const daily = mongoDb.collection('stats_daily');
    const dailyCalls = mongoDb.collection('stats_daily_calls');
    const hourly = mongoDb.collection('stats_hourly');
    const hourlyCalls = mongoDb.collection('stats_hourly_calls');
    const liveCache = new Map();
    let runningDays = null;
    let runningHours = null;

    // --- Unique stations of a period, with their QSL services ---
    async function callsOf(from, to) {
        const rows = await spots.aggregate([
            { $match: { timestamp: { $gte: from, $lt: to } } },
            { $group: {
                _id: '$spotted',
                l: { $max: { $cond: ['$cty.spotted.lotw', 1, 0] } },
                e: { $max: { $cond: ['$cty.spotted.eqsl', 1, 0] } },
                k: { $max: { $cond: ['$cty.spotted.clublog', 1, 0] } },
                o: { $max: { $cond: ['$cty.spotted.oqrs', 1, 0] } }
            } }
        ], { allowDiskUse: true }).toArray();
        const spotters = await spots.distinct('spotter', { timestamp: { $gte: from, $lt: to } });
        return { calls: rows.map(r => ({ c: r._id, l: r.l, e: r.e, k: r.k, o: r.o })), spotters };
    }

    // Union of the stored unique-station lists of some summaries (+ lists computed live)
    async function unionCalls(collection, ids, extraLists = []) {
        const calls = new Map();
        const spotters = new Set();
        const add = (c) => {
            const p = calls.get(c.c);
            calls.set(c.c, p ? { c: c.c, l: Math.max(p.l, c.l), e: Math.max(p.e, c.e), k: Math.max(p.k, c.k), o: Math.max(p.o, c.o) } : { ...c });
        };
        if (ids.length) {
            const [u] = await collection.aggregate([
                { $match: { _id: { $in: ids } } },
                { $facet: {
                    calls: [{ $unwind: '$calls' }, { $group: { _id: '$calls.c', l: { $max: '$calls.l' }, e: { $max: '$calls.e' }, k: { $max: '$calls.k' }, o: { $max: '$calls.o' } } }],
                    spotters: [{ $unwind: '$spotters' }, { $group: { _id: '$spotters' } }]
                } }
            ], { allowDiskUse: true }).toArray();
            for (const c of u?.calls || []) add({ c: c._id, l: c.l, e: c.e, k: c.k, o: c.o });
            for (const s of u?.spotters || []) spotters.add(s._id);
        }
        for (const list of extraLists) {
            for (const c of list.calls) add(c);
            for (const s of list.spotters) spotters.add(s);
        }
        return { calls: [...calls.values()], spotters: [...spotters] };
    }

    // --- Merge summaries (hours, days or live parts) into one result ---
    const sumBy = (lists, keyOf, merge) => {
        const map = new Map();
        for (const list of lists) for (const item of list || []) {
            const k = keyOf(item);
            const prev = map.get(k);
            map.set(k, prev ? merge(prev, item) : { ...item });
        }
        return [...map.values()];
    };
    const addCount = (a, b) => ({ ...a, count: a.count + b.count });
    const top = (list, n) => list.sort((a, b) => b.count - a.count).slice(0, n);

    function mergeParts(parts, uniq, { from, to, bucketMinutes, limits = {} }) {
        const L = { countries: 15, calls: 15, spotters: 10, ...limits };
        const bucketMs = bucketMinutes * 60000;
        const rebucket = (t) => Math.floor(t / bucketMs) * bucketMs;
        const countries = sumBy(parts.map(p => p.countries), x => x.name, addCount);
        const qslCalls = {
            lotw: uniq.calls.filter(c => c.l).length,
            eqsl: uniq.calls.filter(c => c.e).length,
            clublog: uniq.calls.filter(c => c.k).length,
            oqrs: uniq.calls.filter(c => c.o).length,
            none: uniq.calls.filter(c => !c.l && !c.e && !c.k && !c.o).length
        };
        return {
            minutes: Math.round((to - from) / 60000),
            bucketMinutes,
            from,
            to,
            generatedAt: Date.now(),
            total: parts.reduce((a, p) => a + p.total, 0),
            uniqueCalls: uniq.calls.length,
            uniqueCountries: countries.length,
            uniqueSpotters: uniq.spotters.length,
            rbn: parts.reduce((a, p) => a + p.rbn, 0),
            manual: parts.reduce((a, p) => a + p.manual, 0),
            timeline: sumBy(parts.map(p => p.timeline.map(x => ({ ...x, t: rebucket(x.t) }))), x => x.t, addCount).sort((a, b) => a.t - b.t),
            bandTime: sumBy(parts.map(p => p.bandTime.map(x => ({ ...x, t: rebucket(x.t) }))), x => `${x.band}|${x.t}`, addCount),
            modeTime: sumBy(parts.map(p => p.modeTime.map(x => ({ ...x, t: rebucket(x.t) }))), x => `${x.mode}|${x.t}`, addCount),
            bands: top(sumBy(parts.map(p => p.bands), x => x.name, addCount), 20),
            modes: top(sumBy(parts.map(p => p.modes), x => x.name, addCount), 12),
            continents: sumBy(parts.map(p => p.continents), x => `${x.from}|${x.to}`, addCount),
            countries: top(countries, L.countries),
            calls: top(sumBy(parts.map(p => p.calls), x => x.name, (a, b) => ({ ...a, count: a.count + b.count, bands: [...new Set([...(a.bands || []), ...(b.bands || [])])] })), L.calls),
            spotters: top(sumBy(parts.map(p => p.spotters), x => x.name, addCount), L.spotters),
            sources: top(sumBy(parts.map(p => p.sources), x => x.name, addCount), 20),
            map: {
                spotted: sumBy(parts.map(p => p.map?.spotted), x => `${x.lat}|${x.lon}`, addCount),
                spotters: sumBy(parts.map(p => p.map?.spotters), x => `${x.lat}|${x.lon}`, addCount)
            },
            qsl: Object.fromEntries(Object.keys(qslCalls).map(k => [k, {
                calls: qslCalls[k],
                spots: parts.reduce((a, p) => a + (p.qsl?.[k]?.spots || 0), 0)
            }]))
        };
    }

    // --- Spots not summarised yet (current hour, gaps), cached for a short while ---
    async function livePart(from, to) {
        const key = `${from}|${to}`;
        const cached = liveCache.get(key);
        if (cached && Date.now() - cached.at < LIVE_CACHE_MS) return cached.data;
        const [data, list] = await Promise.all([
            aggregateSpots({ from: new Date(from), to: new Date(to), bucketMinutes: HOUR_BUCKET_MINUTES, limits: SUMMARY_LIMITS }),
            callsOf(new Date(from), new Date(to))
        ]);
        const entry = { data, list };
        liveCache.set(key, { at: Date.now(), data: entry });
        for (const [k, v] of liveCache) if (Date.now() - v.at > LIVE_CACHE_MS) liveCache.delete(k);
        return entry;
    }

    // Parts covering [from, to): stored hourly summaries + live parts for what is missing
    async function hourParts(from, to) {
        const keys = [];
        for (let t = from; t + HOUR_MS <= to; t += HOUR_MS) keys.push(hourKey(t));
        const stored = new Map((await hourly.find({ _id: { $in: keys } }).toArray()).map(d => [d._id, d]));
        const parts = [], ids = [], extra = [];
        let missing = 0;
        for (const key of keys) {
            if (stored.has(key)) { parts.push(stored.get(key)); ids.push(key); } else missing++;
        }
        // Several hours not summarised yet (e.g. during the first backfill): let the caller fall back
        if (missing > 2) return null;
        for (const key of keys) {
            if (stored.has(key)) continue;
            const t = hourStart(key).getTime();
            const p = await livePart(t, t + HOUR_MS);
            parts.push(p.data); extra.push(p.list);
        }
        // Unfinished last hour
        const lastFull = from + keys.length * HOUR_MS;
        if (lastFull < to) {
            const p = await livePart(lastFull, to);
            parts.push(p.data); extra.push(p.list);
        }
        return { parts, ids, extra };
    }

    // --- Hourly summaries ---
    async function summariseHour(key) {
        const from = hourStart(key), to = new Date(from.getTime() + HOUR_MS);
        const [data, list] = await Promise.all([
            aggregateSpots({ from, to, bucketMinutes: HOUR_BUCKET_MINUTES, limits: SUMMARY_LIMITS }),
            callsOf(from, to)
        ]);
        await hourly.replaceOne({ _id: key }, { _id: key, at: from, ...data, from: from.getTime(), to: to.getTime(), minutes: 60 }, { upsert: true });
        await hourlyCalls.replaceOne({ _id: key }, { _id: key, at: from, ...list }, { upsert: true });
    }

    // Every finished hour with spots and no summary (oldest first, one at a time)
    function summarisePendingHours() {
        if (runningHours) return runningHours;
        runningHours = (async () => {
            const oldest = await spots.find({}, { projection: { timestamp: 1 } }).sort({ timestamp: 1 }).limit(1).next();
            if (!oldest) return;
            const start = Math.max(floorHour(oldest.timestamp.getTime()), floorHour(Date.now()) - HOURLY_KEEP_DAYS * DAY_MS);
            const done = new Set(await hourly.distinct('_id', { at: { $gte: new Date(start) } }));
            let count = 0;
            for (let t = start; t + HOUR_MS <= floorHour(Date.now()); t += HOUR_MS) {
                const key = hourKey(t);
                if (done.has(key)) continue;
                await summariseHour(key);
                count++;
                // Spread the first backfill so the Raspberry Pi stays responsive
                await sleep(BACKFILL_PAUSE_MS);
            }
            if (count) console.log(`Hourly summaries stored: ${count}`);
        })().catch(err => console.error('Hourly summary failed:', err.message)).finally(() => { runningHours = null; });
        return runningHours;
    }

    // --- Daily summaries ---
    async function summariseDay(key) {
        const from = dayStart(key).getTime(), to = from + DAY_MS;
        let data, list;
        const hp = await hourParts(from, to);
        if (hp) {
            // Built from the 24 hourly summaries instead of re-reading a whole day of spots
            const uniq = await unionCalls(hourlyCalls, hp.ids, hp.extra);
            data = mergeParts(hp.parts, uniq, { from, to, bucketMinutes: 60, limits: SUMMARY_LIMITS });
            list = uniq;
        } else {
            [data, list] = await Promise.all([
                aggregateSpots({ from: new Date(from), to: new Date(to), bucketMinutes: 60, limits: SUMMARY_LIMITS }),
                callsOf(new Date(from), new Date(to))
            ]);
        }
        const now = new Date();
        const { generatedAt, ...stored } = data;
        await daily.replaceOne({ _id: key }, { _id: key, ...stored, from, to, minutes: 1440, generatedAt, summarisedAt: now }, { upsert: true });
        await dailyCalls.replaceOne({ _id: key }, { _id: key, calls: list.calls, spotters: list.spotters, summarisedAt: now }, { upsert: true });
        console.log(`Daily summary stored for ${key} (${data.total} spots)`);
    }

    // Every finished day with spots and no summary yet (one at a time)
    function summarisePendingDays() {
        if (runningDays) return runningDays;
        runningDays = (async () => {
            const oldest = await spots.find({}, { projection: { timestamp: 1 } }).sort({ timestamp: 1 }).limit(1).next();
            if (!oldest) return;
            const today = dayKey(Date.now());
            const done = new Set(await daily.distinct('_id'));
            // The first day is usually partial (retention cut-off): it is summarised anyway
            for (let t = dayStart(dayKey(oldest.timestamp)).getTime(); dayKey(t) < today; t += DAY_MS) {
                const key = dayKey(t);
                if (!done.has(key)) await summariseDay(key);
            }
        })().catch(err => console.error('Daily summary failed:', err.message)).finally(() => { runningDays = null; });
        return runningDays;
    }

    async function tick() {
        await summarisePendingHours();
        await summarisePendingDays();
    }

    function start() {
        // Hourly summaries expire with their own TTL; daily summaries are kept
        hourly.createIndex({ at: 1 }, { expireAfterSeconds: HOURLY_KEEP_DAYS * 86400 }).catch(err => console.error('stats_hourly index:', err.message));
        hourlyCalls.createIndex({ at: 1 }, { expireAfterSeconds: HOURLY_KEEP_DAYS * 86400 }).catch(err => console.error('stats_hourly_calls index:', err.message));
        setTimeout(() => tick(), 60 * 1000).unref();
        // A finished hour is summarised within 5 minutes; a finished day right after its last hour
        setInterval(() => tick(), 5 * 60 * 1000).unref();
    }

    // --- Live windows (6 h, 24 h): last full hours + current hour ---
    // The window starts on an hour boundary, so it spans between N and N+1 hours.
    async function getWindow(hours, bucketMinutes) {
        const now = Date.now();
        const from = floorHour(now) - hours * HOUR_MS;
        const hp = await hourParts(from, now);
        if (!hp) return null;
        const uniq = await unionCalls(hourlyCalls, hp.ids, hp.extra);
        return mergeParts(hp.parts, uniq, { from, to: now, bucketMinutes });
    }

    // --- Day report ---
    async function dayData(key) {
        const doc = await daily.findOne({ _id: key });
        if (doc) {
            const { _id, summarisedAt, ...data } = doc;
            return { data, ids: [key], extra: [] };
        }
        if (key > dayKey(Date.now())) return null;
        const from = dayStart(key).getTime(), to = Math.min(from + DAY_MS, Date.now());
        const hp = await hourParts(from, to);
        let data, extra;
        if (hp) {
            const uniq = await unionCalls(hourlyCalls, hp.ids, hp.extra);
            data = mergeParts(hp.parts, uniq, { from, to, bucketMinutes: 60, limits: SUMMARY_LIMITS });
            extra = [uniq];
        } else {
            // Not covered by hourly summaries (first backfill still running)
            const p = await livePart(from, to);
            data = mergeParts([p.data], p.list, { from, to, bucketMinutes: 60, limits: SUMMARY_LIMITS });
            extra = [p.list];
        }
        return { data, ids: [], extra };
    }

    async function getDay(key) {
        const d = await dayData(key);
        if (!d || !d.data.total) return d ? d.data : null;
        // Reports show at most 15 / 15 / 10 entries in the top lists
        return { ...d.data, countries: d.data.countries.slice(0, 15), calls: d.data.calls.slice(0, 15), spotters: d.data.spotters.slice(0, 10) };
    }

    // --- Month report: merge its days ---
    async function getMonth(month) {
        const first = new Date(`${month}-01T00:00:00Z`);
        if (Number.isNaN(first.getTime())) return null;
        const next = Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 1);
        const today = dayKey(Date.now());
        const parts = [], storedIds = [], extra = [];
        for (let t = first.getTime(); t < next && dayKey(t) <= today; t += DAY_MS) {
            const d = await dayData(dayKey(t));
            if (!d || !d.data.total) continue;
            parts.push(d.data);
            storedIds.push(...d.ids);
            extra.push(...d.extra);
        }
        if (!parts.length) return null;
        const uniq = await unionCalls(dailyCalls, storedIds, extra);
        return mergeParts(parts, uniq, { from: first.getTime(), to: Math.min(next, Date.now()), bucketMinutes: 1440 });
    }

    // First day with data (summary or spots) and today, for the report pickers
    async function range() {
        const firstSummary = await daily.find({}, { projection: { _id: 1 } }).sort({ _id: 1 }).limit(1).next();
        const oldest = await spots.find({}, { projection: { timestamp: 1 } }).sort({ timestamp: 1 }).limit(1).next();
        const candidates = [firstSummary?._id, oldest ? dayKey(oldest.timestamp) : null].filter(Boolean).sort();
        return { firstDay: candidates[0] || dayKey(Date.now()), lastDay: dayKey(Date.now()) };
    }

    return { start, getWindow, getDay, getMonth, range };
}

module.exports = { createReports };
