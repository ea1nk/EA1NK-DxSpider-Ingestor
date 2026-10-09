/**
 * DAY / MONTH REPORTS
 * Spots expire with the TTL index, so each UTC day is summarised into `stats_daily`
 * (no TTL) with hour-by-hour detail, and its unique stations into `stats_daily_calls`.
 * Day reports read one summary; month reports merge the daily ones.
 * Days still inside the spot retention (including today) are computed from the spots.
 */

const DAY_MS = 86400000;
const SUMMARY_LIMITS = { countries: 400, calls: 200, spotters: 100 };
const LIVE_CACHE_MS = 5 * 60 * 1000;

const dayKey = (d) => new Date(d).toISOString().slice(0, 10);
const dayStart = (key) => new Date(`${key}T00:00:00Z`);

function createReports({ mongoDb, spots, aggregateSpots }) {
    const daily = mongoDb.collection('stats_daily');
    const dailyCalls = mongoDb.collection('stats_daily_calls');
    const liveCache = new Map();
    let running = null;

    // Unique spotted stations of a day with their QSL services (for month-level unique counts)
    async function dayCalls(from, to) {
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

    // Summarise a finished UTC day and store it
    async function summariseDay(key) {
        const from = dayStart(key), to = new Date(from.getTime() + DAY_MS);
        const data = await aggregateSpots({ from, to, bucketMinutes: 60, limits: SUMMARY_LIMITS });
        const { calls, spotters } = await dayCalls(from, to);
        const now = new Date();
        await daily.replaceOne({ _id: key }, { _id: key, ...data, from: from.getTime(), to: to.getTime(), minutes: 1440, summarisedAt: now }, { upsert: true });
        await dailyCalls.replaceOne({ _id: key }, { _id: key, calls, spotters, summarisedAt: now }, { upsert: true });
        console.log(`Daily summary stored for ${key} (${data.total} spots)`);
    }

    // Summarise every finished day that still has spots and no summary yet (one at a time)
    function summarisePending() {
        if (running) return running;
        running = (async () => {
            const oldest = await spots.find({}, { projection: { timestamp: 1 } }).sort({ timestamp: 1 }).limit(1).next();
            if (!oldest) return;
            const today = dayKey(Date.now());
            const done = new Set(await daily.distinct('_id'));
            // The first day is usually partial (retention cut-off): it is summarised anyway
            for (let t = dayStart(dayKey(oldest.timestamp)).getTime(); dayKey(t) < today; t += DAY_MS) {
                const key = dayKey(t);
                if (!done.has(key)) await summariseDay(key);
            }
        })().catch(err => console.error('Daily summary failed:', err.message)).finally(() => { running = null; });
        return running;
    }

    // Check every 15 minutes; a new day is summarised shortly after 00:00 UTC
    function start() {
        setTimeout(() => summarisePending(), 3 * 60 * 1000).unref();
        setInterval(() => summarisePending(), 15 * 60 * 1000).unref();
    }

    // Today (or a day not summarised yet) computed from the spots, cached for a few minutes
    async function liveDay(key) {
        const cached = liveCache.get(key);
        if (cached && Date.now() - cached.at < LIVE_CACHE_MS) return cached.data;
        const from = dayStart(key), to = new Date(Math.min(from.getTime() + DAY_MS, Date.now()));
        const data = await aggregateSpots({ from, to, bucketMinutes: 60, limits: SUMMARY_LIMITS });
        const { calls, spotters } = await dayCalls(from, to);
        const entry = { data: { ...data, from: from.getTime() }, calls, spotters };
        liveCache.set(key, { at: Date.now(), data: entry });
        return entry;
    }

    async function getDay(key) {
        const doc = await daily.findOne({ _id: key });
        if (doc) {
            const { _id, summarisedAt, ...data } = doc;
            return data;
        }
        // Not summarised: today, or a past day still inside the spot retention
        if (key > dayKey(Date.now())) return null;
        return (await liveDay(key)).data;
    }

    // --- Month: merge the daily summaries ---
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

    async function getMonth(month) {
        const first = new Date(`${month}-01T00:00:00Z`);
        if (Number.isNaN(first.getTime())) return null;
        const next = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 1));
        const today = dayKey(Date.now());
        const keys = [];
        for (let t = first.getTime(); t < next.getTime() && dayKey(t) <= today; t += DAY_MS) keys.push(dayKey(t));
        if (!keys.length) return null;

        const stored = new Map((await daily.find({ _id: { $in: keys } }).toArray()).map(d => [d._id, d]));
        const days = [];
        const callLists = [];
        for (const key of keys) {
            if (stored.has(key)) { days.push(stored.get(key)); continue; }
            // Missing summary: compute it from the spots if they are still there
            const live = await liveDay(key);
            if (live.data.total) { days.push({ _id: key, ...live.data }); callLists.push({ _id: key, calls: live.calls, spotters: live.spotters }); }
        }
        if (!days.length) return null;

        // Unique stations / spotters / QSL users over the whole month
        const storedKeys = days.filter(d => stored.has(d._id)).map(d => d._id);
        const [u] = await dailyCalls.aggregate([
            { $match: { _id: { $in: storedKeys } } },
            { $facet: {
                calls: [{ $unwind: '$calls' }, { $group: { _id: '$calls.c', l: { $max: '$calls.l' }, e: { $max: '$calls.e' }, k: { $max: '$calls.k' }, o: { $max: '$calls.o' } } }],
                spotters: [{ $unwind: '$spotters' }, { $group: { _id: '$spotters' } }]
            } }
        ], { allowDiskUse: true }).toArray();
        const callMap = new Map((u?.calls || []).map(c => [c._id, c]));
        for (const list of callLists) for (const c of list.calls) {
            const prev = callMap.get(c.c) || { _id: c.c, l: 0, e: 0, k: 0, o: 0 };
            callMap.set(c.c, { _id: c.c, l: Math.max(prev.l, c.l), e: Math.max(prev.e, c.e), k: Math.max(prev.k, c.k), o: Math.max(prev.o, c.o) });
        }
        const spotterSet = new Set((u?.spotters || []).map(s => s._id));
        for (const list of callLists) for (const s of list.spotters) spotterSet.add(s);
        const allCalls = [...callMap.values()];
        const qslCalls = {
            lotw: allCalls.filter(c => c.l).length,
            eqsl: allCalls.filter(c => c.e).length,
            clublog: allCalls.filter(c => c.k).length,
            oqrs: allCalls.filter(c => c.o).length,
            none: allCalls.filter(c => !c.l && !c.e && !c.k && !c.o).length
        };

        const dayOf = (t) => dayStart(dayKey(t)).getTime();
        const countries = sumBy(days.map(d => d.countries), x => x.name, addCount);
        const total = days.reduce((a, d) => a + d.total, 0);
        const end = Math.min(next.getTime(), Date.now());
        return {
            minutes: Math.round((end - first.getTime()) / 60000),
            bucketMinutes: 1440,
            from: first.getTime(),
            to: end,
            generatedAt: Date.now(),
            total,
            uniqueCalls: allCalls.length,
            uniqueCountries: countries.length,
            uniqueSpotters: spotterSet.size,
            rbn: days.reduce((a, d) => a + d.rbn, 0),
            manual: days.reduce((a, d) => a + d.manual, 0),
            timeline: days.map(d => ({ t: dayStart(d._id).getTime(), count: d.total })),
            bandTime: sumBy(days.map(d => d.bandTime.map(x => ({ ...x, t: dayOf(x.t) }))), x => `${x.band}|${x.t}`, addCount),
            modeTime: sumBy(days.map(d => d.modeTime.map(x => ({ ...x, t: dayOf(x.t) }))), x => `${x.mode}|${x.t}`, addCount),
            bands: top(sumBy(days.map(d => d.bands), x => x.name, addCount), 20),
            modes: top(sumBy(days.map(d => d.modes), x => x.name, addCount), 12),
            continents: sumBy(days.map(d => d.continents), x => `${x.from}|${x.to}`, addCount),
            countries: top(countries, 15),
            calls: top(sumBy(days.map(d => d.calls), x => x.name, (a, b) => ({ ...a, count: a.count + b.count, bands: [...new Set([...(a.bands || []), ...(b.bands || [])])] })), 15),
            spotters: top(sumBy(days.map(d => d.spotters), x => x.name, addCount), 10),
            sources: top(sumBy(days.map(d => d.sources), x => x.name, addCount), 20),
            map: {
                spotted: sumBy(days.map(d => d.map?.spotted), x => `${x.lat}|${x.lon}`, addCount),
                spotters: sumBy(days.map(d => d.map?.spotters), x => `${x.lat}|${x.lon}`, addCount)
            },
            qsl: Object.fromEntries(Object.keys(qslCalls).map(k => [k, {
                calls: qslCalls[k],
                spots: days.reduce((a, d) => a + (d.qsl?.[k]?.spots || 0), 0)
            }]))
        };
    }

    // First day with data (summary or spots) and today, for the report pickers
    async function range() {
        const firstSummary = await daily.find({}, { projection: { _id: 1 } }).sort({ _id: 1 }).limit(1).next();
        const oldest = await spots.find({}, { projection: { timestamp: 1 } }).sort({ timestamp: 1 }).limit(1).next();
        const candidates = [firstSummary?._id, oldest ? dayKey(oldest.timestamp) : null].filter(Boolean).sort();
        return { firstDay: candidates[0] || dayKey(Date.now()), lastDay: dayKey(Date.now()) };
    }

    return { start, summarisePending, getDay, getMonth, range };
}

module.exports = { createReports };
