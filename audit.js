/**
 * AUDIT LOG
 * Incidents and changes stored in SQLite (audit_events), so they survive restarts and
 * MongoDB outages: source disconnections and outages, node failovers, reference data and
 * space weather downloads, MongoDB write errors, starts/stops, admin actions and logins.
 *
 * Events that could repeat in a loop (a cluster that stays down, a failing download)
 * are recorded once per incident by their callers, and `throttle` drops repeats of the
 * same key for a while as a last line of defence.
 *
 * report(from, to) returns the events of a period plus the downtime of each source and
 * of the ingestor itself, rebuilt from the down/up events.
 */

const HOUR_MS = 3600000;
const DAY_MS = 86400000;
const HEARTBEAT_MS = 60 * 1000;
const KEEP_DAYS = parseFloat(process.env.AUDIT_KEEP_DAYS) || 400;
const REPORT_LIMIT = 3000;

// Source events that open or close an outage
const SOURCE_DOWN = new Set(['disconnected', 'connectFailed']);
const SOURCE_UP = new Set(['connected', 'reconnected', 'stopped']);

function createAudit(db) {
    const throttled = new Map();

    // Never throws: auditing must not break what it audits
    function record(category, type, level, message, { subject = null, details = null, ts = Date.now(), throttle = null, throttleMs = HOUR_MS } = {}) {
        if (throttle) {
            const key = `${category}|${type}|${throttle}`;
            if (Date.now() - (throttled.get(key) || 0) < throttleMs) return;
            throttled.set(key, Date.now());
            if (throttled.size > 500) for (const [k, at] of throttled) if (Date.now() - at > throttleMs) throttled.delete(k);
        }
        try {
            db.addAuditEvent({ ts, category, type, level, subject, message, details });
        } catch (err) {
            console.error('Audit write failed:', err.message);
        }
    }

    // A heartbeat in SQLite tells, on the next start, whether the process stopped cleanly
    function start() {
        const last = Number(db.getSetting('audit_heartbeat')) || 0;
        if (last > 0) record('system', 'crash', 'error', 'Unexpected stop (no clean shutdown)', { ts: last, details: { lastSeen: last } });
        record('system', 'start', 'info', 'Ingestor started', { details: { node: process.version } });
        const beat = () => { try { db.setSetting('audit_heartbeat', Date.now()); } catch (_) { /* ignore */ } };
        beat();
        setInterval(beat, HEARTBEAT_MS).unref();
        const prune = () => {
            try {
                const n = db.pruneAuditEvents(Date.now() - KEEP_DAYS * DAY_MS);
                if (n) console.log(`Audit: ${n} events older than ${KEEP_DAYS} days removed`);
            } catch (err) { console.error('Audit prune failed:', err.message); }
        };
        prune();
        setInterval(prune, DAY_MS).unref();
    }

    function stop(signal) {
        record('system', 'shutdown', 'info', `Ingestor stopped (${signal})`, { details: { signal } });
        try { db.setSetting('audit_heartbeat', 0); } catch (_) { /* ignore */ }
    }

    // --- Downtime of each source and of the ingestor in [from, to) ---
    function availability(from, to) {
        const end = Math.min(to, Date.now());
        const sources = new Map();
        const system = { stops: 0, downMs: 0, longestMs: 0 };
        const get = (name) => {
            if (!sources.has(name)) sources.set(name, { name, outages: 0, disconnects: 0, failovers: 0, downMs: 0, longestMs: 0, ongoing: false, open: null });
            return sources.get(name);
        };
        // Adds the part of [a, b) inside the period; returns whether it overlaps
        const clip = (acc, a, b) => {
            if (b < from || a >= end) return false;
            const ms = Math.max(0, Math.min(b, end) - Math.max(a, from));
            acc.downMs += ms;
            acc.longestMs = Math.max(acc.longestMs, ms);
            return true;
        };
        const close = (s, at) => {
            if (s.open === null) return;
            if (clip(s, s.open, at)) s.outages++;
            s.open = null;
        };
        let systemDown = null;
        for (const e of db.auditTimeline(to, ['source', 'system'])) {
            if (e.category === 'system') {
                if (e.type === 'shutdown' || e.type === 'crash') {
                    // While the ingestor is stopped the downtime belongs to it, not to its sources
                    for (const s of sources.values()) close(s, e.ts);
                    if (systemDown === null) systemDown = e.ts;
                } else if (e.type === 'start' && systemDown !== null) {
                    if (clip(system, systemDown, e.ts)) system.stops++;
                    systemDown = null;
                }
                continue;
            }
            if (!e.subject) continue;
            const s = get(e.subject);
            const inPeriod = e.ts >= from && e.ts < to;
            if (SOURCE_DOWN.has(e.type)) {
                if (e.type === 'disconnected' && inPeriod) s.disconnects++;
                if (s.open === null) s.open = e.ts;
            } else if (SOURCE_UP.has(e.type)) {
                close(s, e.ts);
            } else if (e.type === 'failover' && inPeriod) {
                s.failovers++;
            }
        }
        for (const s of sources.values()) {
            if (s.open !== null) {
                s.ongoing = to > Date.now();
                close(s, end);
            }
        }
        if (systemDown !== null && clip(system, systemDown, end)) system.stops++;
        const list = [...sources.values()]
            .filter(s => s.outages || s.disconnects || s.failovers)
            .map(({ open, ...s }) => s)
            .sort((a, b) => b.downMs - a.downMs || a.name.localeCompare(b.name));
        return { sources: list, system };
    }

    function report(from, to) {
        const events = db.listAuditEvents(from, to, REPORT_LIMIT);
        const counts = db.countAuditEvents(from, to);
        const total = counts.reduce((a, c) => a + c.n, 0);
        const firstEventAt = db.firstAuditTs();
        return {
            from,
            to: Math.min(to, Date.now()),
            firstEventAt,
            // Availability is only known since the first audit event
            observedFrom: firstEventAt === null ? null : Math.max(from, firstEventAt),
            total,
            truncated: total > events.length,
            counts,
            ...availability(from, to),
            events
        };
    }

    return { record, start, stop, report };
}

module.exports = { createAudit };
