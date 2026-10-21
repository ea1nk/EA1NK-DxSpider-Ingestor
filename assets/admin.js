// admin.js
// Panel de administración: login JWT, estado del sistema, orígenes de spots y usuarios

const TOKEN_KEY = 'dxadmin-token';
const STATUS_REFRESH_MS = 10000;

const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let token = null;
let me = null;
let statusTimer = null;
let currentTab = 'status';
try { token = localStorage.getItem(TOKEN_KEY); } catch (_) { /* ignore */ }

// --- Formato ---
function fmtNum(n) {
    return n === null || n === undefined ? '—' : Number(n).toLocaleString(LOCALE);
}

function fmtBytes(b) {
    if (b === null || b === undefined) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (b >= 1024 && i < units.length - 1) { b /= 1024; i++; }
    return `${b.toLocaleString(LOCALE, { maximumFractionDigits: i ? 1 : 0 })} ${units[i]}`;
}

function fmtDuration(sec) {
    sec = Math.max(0, Math.round(sec));
    const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60);
    if (d) return `${d} d ${h} h`;
    if (h) return `${h} h ${m} min`;
    if (m) return `${m} min`;
    return `${sec} s`;
}

const fmtAgo = (ms) => ms ? t('adm.ago', { t: fmtDuration((Date.now() - ms) / 1000) }) : t('adm.never');

// SQLite guarda "YYYY-MM-DD HH:MM:SS" en UTC
function parseSqlDate(s) {
    return s ? new Date(`${s.replace(' ', 'T')}Z`) : null;
}

function fmtDate(d) {
    if (!d) return t('adm.never');
    return d.toLocaleString(LOCALE, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

const chip = (level, text) => `<span class="chip st-${level}"><i></i>${esc(text)}</span>`;

function toast(text, isError = false) {
    const el = $('toast');
    el.textContent = text;
    el.className = `toast${isError ? ' error' : ''}`;
    el.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { el.hidden = true; }, 3500);
}

function showMsg(el, text, ok = false) {
    el.textContent = text;
    el.className = `msg ${ok ? 'ok' : 'error'}`;
    el.hidden = !text;
}

// --- API ---
async function api(method, url, body) {
    const res = await fetch(url, {
        method,
        headers: {
            ...(body ? { 'Content-Type': 'application/json' } : {}),
            ...(token ? { Authorization: `Bearer ${token}` } : {})
        },
        body: body ? JSON.stringify(body) : undefined
    });
    if (res.status === 401 && url !== '/login') {
        logout(t('adm.sessionExpired'));
        throw new Error(t('adm.sessionExpired'));
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        const err = new Error(data.error || `HTTP ${res.status}`);
        err.status = res.status;
        throw err;
    }
    return data;
}

// --- Vistas y sesión ---
function showView(name) {
    ['login', 'forbidden', 'admin'].forEach(v => { $(`view-${v}`).hidden = v !== name; });
    $('user-box').hidden = name === 'login';
}

function setToken(tk) {
    token = tk;
    try {
        if (tk) localStorage.setItem(TOKEN_KEY, tk);
        else localStorage.removeItem(TOKEN_KEY);
    } catch (_) { /* ignore */ }
}

function logout(message) {
    setToken(null);
    me = null;
    clearInterval(statusTimer);
    showView('login');
    showMsg($('login-msg'), message || '');
}

async function enter() {
    try {
        me = await api('GET', '/api/me');
    } catch (_) {
        if (!me) showView('login');
        return;
    }
    $('user-name').textContent = me.username;
    $('user-role').textContent = t(`usr.role.${me.role}`);
    if (me.role !== 'admin') return showView('forbidden');
    showView('admin');
    const fromHash = location.hash.slice(1);
    selectTab(['status', 'reports', 'sources', 'users', 'account'].includes(fromHash) ? fromHash : 'status');
}

$('login-form').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
        const r = await api('POST', '/login', { username: f.username.value.trim(), password: f.password.value });
        setToken(r.token);
        f.password.value = '';
        showMsg($('login-msg'), '');
        enter();
    } catch (err) {
        showMsg($('login-msg'), err.status === 429 ? t('adm.tooMany') : t('adm.badLogin'));
    }
};
$('logout').onclick = () => logout();
$('forbidden-logout').onclick = () => logout();

// --- Pestañas ---
function selectTab(tab) {
    currentTab = tab;
    document.querySelectorAll('.tab').forEach(b => b.setAttribute('aria-selected', b.dataset.tab === tab ? 'true' : 'false'));
    ['status', 'reports', 'sources', 'users', 'account'].forEach(x => { $(`tab-${x}`).hidden = x !== tab; });
    history.replaceState(null, '', `#${tab}`);
    clearInterval(statusTimer);
    $('tab-meta').textContent = '';
    if (tab === 'status') {
        loadStatus();
        statusTimer = setInterval(loadStatus, STATUS_REFRESH_MS);
        $('tab-meta').textContent = t('adm.refresh', { s: STATUS_REFRESH_MS / 1000 });
    }
    if (tab === 'sources') {
        loadSources();
        statusTimer = setInterval(loadSources, STATUS_REFRESH_MS);
    }
    if (tab === 'users') loadUsers();
    if (tab === 'reports') initReports();
}
document.querySelectorAll('.tab').forEach(b => { b.onclick = () => selectTab(b.dataset.tab); });

// --- Estado ---
function setMeter(id, ratio) {
    const m = $(id);
    const r = Math.max(0, Math.min(1, ratio || 0));
    m.querySelector('i').style.width = `${(r * 100).toFixed(1)}%`;
    m.className = `meter${r > 0.9 ? ' crit' : r > 0.7 ? ' warn' : ''}`;
}

async function loadStatus() {
    let s;
    try { s = await api('GET', '/api/admin/status'); } catch (err) { return; }
    const sys = s.system;
    $('t-uptime').textContent = fmtDuration(sys.uptime);
    $('t-started').textContent = `${t('st.started')}: ${fmtDate(new Date(sys.startedAt))}`;
    $('t-hour').textContent = fmtNum(s.spots.lastHour);
    $('t-last').textContent = s.spots.lastSpot ? `${t('st.col.lastSpot')}: ${fmtAgo(new Date(s.spots.lastSpot).getTime())}` : '';
    const last5 = s.spots.perMinute.slice(-6, -1); // minutos completos
    $('t-rate').textContent = (last5.reduce((a, b) => a + b.count, 0) / Math.max(1, last5.length)).toLocaleString(LOCALE, { maximumFractionDigits: 1 });
    $('t-docs').textContent = s.mongo.ok ? fmtNum(s.mongo.spots) : '—';
    $('t-buffer').textContent = `Buffer: ${fmtNum(s.spots.buffer)}`;
    $('t-ws').textContent = fmtNum(s.websocket.clients);
    $('t-load').textContent = sys.loadavg[0].toLocaleString(LOCALE, { maximumFractionDigits: 2 });
    $('t-load-sub').textContent = `${t('st.loadSub', { cpus: sys.cpus })}: ${sys.loadavg.map(l => l.toFixed(2)).join(' / ')}`;
    setMeter('m-load', sys.loadavg[0] / sys.cpus);
    const used = sys.memTotal - sys.memFree;
    $('t-mem').textContent = `${Math.round(used / sys.memTotal * 100)}%`;
    $('t-mem-sub').textContent = `${fmtBytes(used)} / ${fmtBytes(sys.memTotal)}`;
    setMeter('m-mem', used / sys.memTotal);
    $('t-rss').textContent = fmtBytes(sys.processRss);
    $('t-heap').textContent = `Heap: ${fmtBytes(sys.processHeap)}`;

    renderRateChart(s.spots.perMinute);
    renderStatusSources(s.sources, s.spots.bySourceLastHour);
    renderStatusData(s.spaceWeather);
    renderReference(s.reference);
    renderDatabase(s.mongo);
    $('status-system').innerHTML = [
        [t('st.host'), sys.hostname],
        [t('st.platform'), sys.platform],
        [t('st.nodeVersion'), sys.node],
        [t('st.mongo'), s.mongo.ok ? t('st.mongoData', { d: fmtBytes(s.mongo.dataSize), s: fmtBytes(s.mongo.storageSize), i: fmtBytes(s.mongo.indexSize) }) : `${t('st.failing')}: ${s.mongo.error || ''}`],
        [t('st.sqlite'), t('st.sqliteSub', { size: fmtBytes(s.sqlite.size), users: s.sqlite.users })]
    ].map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
}

const nodeLabel = (name) => name === 'principal' ? t('node.primary') : (/^respaldo (\d+)$/.test(name) ? t('node.backup', { n: name.split(' ')[1] }) : name);

function renderStatusSources(list, byHour) {
    if (!list.length) { $('status-sources').innerHTML = `<p class="muted">${esc(t('st.noSources'))}</p>`; return; }
    const hour = new Map((byHour || []).map(x => [x.name, x.count]));
    $('status-sources').innerHTML = `<table>
        <thead><tr><th>${esc(t('st.col.source'))}</th><th>${esc(t('st.col.status'))}</th><th>${esc(t('st.col.node'))}</th><th>${esc(t('st.col.since'))}</th>
        <th class="num">${esc(t('st.col.spots'))}</th><th class="num">${esc(t('st.spotsHour'))}</th><th class="num">${esc(t('st.col.dups'))}</th><th>${esc(t('st.col.lastSpot'))}</th><th>${esc(t('st.col.lastError'))}</th></tr></thead>
        <tbody>${list.map(s => `<tr>
            <td><b>${esc(s.name)}</b><br><span class="muted mono">${esc(s.callsign)}</span></td>
            <td>${s.connected ? chip('good', t('st.connected')) : chip('critical', t('st.disconnected'))}</td>
            <td>${esc(nodeLabel(s.node))}<br><span class="muted mono">${esc(s.host)}:${s.port}</span></td>
            <td>${s.connected ? esc(fmtAgo(s.connectedSince)) : esc(fmtAgo(s.disconnectedSince))}</td>
            <td class="num">${fmtNum(s.spots)}</td>
            <td class="num">${fmtNum(hour.get(s.name) ?? 0)}</td>
            <td class="num">${fmtNum(s.duplicates)}</td>
            <td>${esc(fmtAgo(s.lastSpotAt))}</td>
            <td>${s.lastError ? `<span class="err-text" title="${esc(s.lastError)}">${esc(s.lastError)}</span><br><span class="muted">${esc(fmtAgo(s.lastErrorAt))}</span>` : '<span class="muted">—</span>'}</td>
        </tr>`).join('')}</tbody></table>`;
}

function renderStatusData(sources) {
    const names = SW_NAMES;
    const rows = Object.entries(sources || {});
    $('status-data').innerHTML = rows.length ? `<table>
        <thead><tr><th>${esc(t('st.col.source'))}</th><th>${esc(t('st.col.status'))}</th><th>${esc(t('st.col.updated'))}</th></tr></thead>
        <tbody>${rows.map(([k, v]) => `<tr>
            <td>${esc(names[k] || k)}</td>
            <td>${v.ok ? chip('good', t('st.ok')) : `${chip('critical', t('st.failing'))} <span class="err-text" title="${esc(v.error)}">${esc(v.error)}</span>`}</td>
            <td>${esc(fmtAgo(v.updatedAt ? new Date(v.updatedAt).getTime() : null))}</td>
        </tr>`).join('')}</tbody></table>` : `<p class="muted">${esc(t('loading'))}</p>`;
}

// --- Base de datos: tamaño actual y estimación según la retención ---
let lastMongo = null;
let dbDays = 30;
try { dbDays = parseInt(localStorage.getItem('dxadmin-db-days'), 10) || 30; } catch (_) { /* ignore */ }

function renderDatabase(m) {
    lastMongo = m;
    const el = $('db-stats');
    if (!m || !m.ok) { el.innerHTML = `<dt>${esc(t('st.mongo'))}</dt><dd>${esc(t('st.failing'))}${m?.error ? `: ${esc(m.error)}` : ''}</dd>`; $('db-sim').innerHTML = ''; return; }
    const disk = m.storageSize + m.indexSize;
    const ttlDays = m.ttlSeconds ? m.ttlSeconds / 86400 : null;
    const oldestDays = m.oldest ? (Date.now() - new Date(m.oldest).getTime()) / 86400000 : null;
    const fmtDays = (d) => d.toLocaleString(LOCALE, { maximumFractionDigits: d < 10 ? 1 : 0 });
    const rows = [
        [t('db.disk'), `<b>${esc(fmtBytes(disk))}</b> · ${esc(t('db.diskDetail', { data: fmtBytes(m.storageSize), raw: fmtBytes(m.dataSize), idx: fmtBytes(m.indexSize), n: m.indexCount }))}`],
        [t('db.spots'), `<b>${fmtNum(m.spots)}</b>${m.oldest ? ` · ${esc(t('db.since', { date: fmtDate(new Date(m.oldest)), days: fmtDays(oldestDays) }))}` : ''}`],
        [t('db.rate'), `<b>${fmtNum(m.last24h)}</b> ${esc(t('db.rateDetail', { b: Math.round(m.bytesPerSpot || 0) }))}`],
        [t('db.ttl'), ttlDays ? `<b>${fmtDays(ttlDays)} ${esc(t('db.days'))}</b> · ${esc(t('db.estimate', { size: fmtBytes(estimate(m, ttlDays)) }))} <span class="muted">(${esc(t(m.ttlSource === 'admin' ? 'db.srcAdmin' : 'db.srcEnv'))})</span>` : esc(t('db.noTtl'))]
    ];
    if (m.fsTotalSize) {
        // fsUsedSize de MongoDB incluye los bloques reservados del sistema de archivos (ext4 reserva un 5 % para root),
        // así que se muestra el espacio libre disponible, que es la cifra útil
        rows.push([t('db.volume'), `<b>${esc(t('db.free', { size: fmtBytes(m.fsTotalSize - m.fsUsedSize) }))}</b> ${esc(t('db.of', { total: fmtBytes(m.fsTotalSize) }))}`]);
    }
    el.innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('');
    renderDbSim();
}

// Estimación lineal: spots de las últimas 24 h × días × bytes en disco por spot
const estimate = (m, days) => (m.last24h || 0) * days * (m.bytesPerSpot || 0);

function renderDbSim() {
    const m = lastMongo;
    if (!m || !m.ok) return;
    const days = Math.max(1, Math.min(3650, dbDays));
    const size = estimate(m, days);
    const free = m.fsTotalSize ? m.fsTotalSize - m.fsUsedSize + (m.storageSize + m.indexSize) : null;
    const ratio = free ? size / free : null;
    $('db-sim').innerHTML = `
        <div class="db-big">${esc(fmtBytes(size))}</div>
        <div class="db-line">${esc(t('db.simSpots', { n: fmtNum(Math.round((m.last24h || 0) * days)) }))}</div>
        ${ratio !== null ? `<div class="meter${ratio > 0.9 ? ' crit' : ratio > 0.7 ? ' warn' : ''}"><i style="width:${Math.min(100, ratio * 100).toFixed(1)}%"></i></div>
        <div class="db-line">${esc(t('db.simDisk', { pct: (ratio * 100).toLocaleString(LOCALE, { maximumFractionDigits: ratio < 0.01 ? 2 : 1 }) }))}</div>` : ''}
        ${ratio !== null && ratio > 0.9 ? `<div class="db-warn">${esc(t('db.simTooBig'))}</div>` : ''}
        <div class="db-apply" id="db-apply"></div>`;
    renderTtlApply();
}

// --- Aplicar la retención desde el panel (con confirmación) ---
let ttlConfirm = null; // { days, toDelete } mientras se pide confirmación

function renderTtlApply() {
    const el = $('db-apply');
    const m = lastMongo;
    if (!el || !m) return;
    const days = Math.max(1, Math.min(3650, dbDays));
    const currentDays = m.ttlSeconds ? m.ttlSeconds / 86400 : null;
    if (currentDays && Math.abs(currentDays - days) < 1e-9) {
        el.innerHTML = `<span class="db-line">${esc(t('db.isCurrent'))}</span>`;
        return;
    }
    if (ttlConfirm && ttlConfirm.days === days) {
        const shorter = currentDays && days < currentDays;
        el.innerHTML = `<div class="${shorter ? 'db-warn' : 'db-line'}">${esc(shorter
            ? t('db.confirmShorter', { days, n: fmtNum(ttlConfirm.toDelete) })
            : t('db.confirmLonger', { days }))}</div>
            <div class="actions"><button class="btn small ${shorter ? 'danger' : 'primary'}" id="ttl-yes">${esc(t('db.apply', { days }))}</button><button class="btn small" id="ttl-no">${esc(t('adm.cancel'))}</button></div>`;
        $('ttl-no').onclick = () => { ttlConfirm = null; renderTtlApply(); };
        $('ttl-yes').onclick = async () => {
            try {
                await api('PUT', '/api/admin/settings/ttl', { days });
                toast(t('db.applied', { days }));
                ttlConfirm = null;
                loadStatus();
            } catch (err) {
                toast(t('adm.error', { msg: err.message }), true);
            }
        };
        return;
    }
    el.innerHTML = `<button class="btn small primary" id="ttl-apply">${esc(t('db.apply', { days }))}</button>`;
    $('ttl-apply').onclick = async () => {
        try {
            const r = await api('GET', `/api/admin/settings/ttl/preview?days=${days}`);
            ttlConfirm = { days, toDelete: r.toDelete };
            renderTtlApply();
        } catch (err) {
            toast(t('adm.error', { msg: err.message }), true);
        }
    };
}

$('db-days').value = dbDays;
$('db-days').oninput = () => {
    dbDays = parseInt($('db-days').value, 10) || 30;
    ttlConfirm = null;
    try { localStorage.setItem('dxadmin-db-days', dbDays); } catch (_) { /* ignore */ }
    renderDbSim();
};

// --- Datos de referencia (CTY, LoTW, eQSL, Club Log) ---
const REF_NAMES = { cty: 'CTY (AD1C)', lotw: 'LoTW', eqsl: 'eQSL (AG)', clublog: 'Club Log' };

function renderReference(ref) {
    if (!ref) return;
    $('ref-sub').textContent = t('ref.sub', { d: ref.updateDays });
    $('ref-update').disabled = ref.running;
    $('ref-update').textContent = t(ref.running ? 'ref.updating' : 'ref.update');
    $('status-reference').innerHTML = `<table>
        <thead><tr><th>${esc(t('ref.dataset'))}</th><th>${esc(t('st.col.status'))}</th><th>${esc(t('st.col.updated'))}</th><th class="num">${esc(t('ref.entries'))}</th><th class="num">${esc(t('ref.size'))}</th><th>${esc(t('st.col.lastError'))}</th></tr></thead>
        <tbody>${ref.datasets.map(d => {
            const state = d.updating ? chip('warning', t('ref.updating'))
                : d.lastError ? chip('critical', t('st.failing'))
                : d.bundled ? chip('warning', t('ref.bundled'))
                : chip('good', t('st.ok'));
            return `<tr>
                <td><b>${esc(REF_NAMES[d.key] || d.key)}</b><br><span class="muted mono">${esc(d.file)}</span></td>
                <td>${state}</td>
                <td>${d.updatedAt ? `${esc(fmtDate(new Date(d.updatedAt)))}<br><span class="muted">${esc(fmtAgo(d.updatedAt))}</span>` : esc(t('adm.never'))}</td>
                <td class="num">${d.entries == null ? '—' : fmtNum(d.entries)}</td>
                <td class="num">${d.size == null ? '—' : esc(fmtBytes(d.size))}</td>
                <td>${d.lastError ? `<span class="err-text" title="${esc(d.lastError)}">${esc(d.lastError)}</span><br><span class="muted">${esc(fmtAgo(d.lastErrorAt))}</span>` : '<span class="muted">—</span>'}</td>
            </tr>`;
        }).join('')}</tbody></table>`;
}

$('ref-update').onclick = async () => {
    try {
        await api('POST', '/api/admin/reference/update');
        toast(t('ref.started'));
        $('ref-update').disabled = true;
        $('ref-update').textContent = t('ref.updating');
    } catch (err) {
        toast(t('adm.error', { msg: err.message }), true);
    }
};

// Columnas de spots/minuto (una serie: sin leyenda, el título la nombra)
const tip = document.createElement('div');
tip.className = 'viz-tip';
tip.hidden = true;
document.body.appendChild(tip);

const hhmm = (d) => `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;

function renderRateChart(points) {
    barChart($('rate-chart'), points, {
        aria: t('st.rateAria'),
        tick: (p) => { const d = new Date(p.t); return d.getUTCMinutes() % 15 === 0 ? hhmm(d) : null; },
        tip: (p) => `${hhmm(new Date(p.t))} UTC`
    });
}

// Columnas de una serie con tooltip; tick(p, i) devuelve la etiqueta del eje o null
function barChart(el, points, { aria, tick, tip: tipLabel }) {
    // Dibujado al ancho real del contenedor para que el texto no se escale
    const W = Math.max(320, Math.round(el.clientWidth || 720)), H = 180, L = 34, R = 8, T = 10, B = 24;
    const pw = W - L - R, ph = H - T - B;
    const rawMax = Math.max(1, ...points.map(p => p.count));
    const step = Math.pow(10, Math.floor(Math.log10(rawMax)));
    const max = Math.ceil(rawMax / step) * step;
    const slot = pw / points.length;
    const bw = Math.min(24, Math.max(1, slot - 2));
    const y = (v) => T + ph - (v / max) * ph;
    let grid = '';
    [0, max / 2, max].forEach(v => {
        grid += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${L - 6}" y="${y(v) + 3}" class="axis" text-anchor="end">${fmtNum(Math.round(v))}</text>`;
    });
    let bars = '', ticks = '';
    points.forEach((p, i) => {
        const x0 = L + i * slot + (slot - bw) / 2;
        const h = p.count ? Math.max(1.5, (p.count / max) * ph) : 0;
        const top = T + ph - h;
        const r = Math.min(3, bw / 2, h);
        if (h) bars += `<path class="bar" data-i="${i}" d="M${x0},${T + ph}V${top + r}Q${x0},${top} ${x0 + r},${top}H${x0 + bw - r}Q${x0 + bw},${top} ${x0 + bw},${top + r}V${T + ph}Z"/>`;
        const label = tick(p, i);
        if (label) ticks += `<text x="${L + i * slot + slot / 2}" y="${H - 6}" class="axis" text-anchor="middle">${esc(label)}</text>`;
    });
    const hits = points.map((p, i) => `<rect class="hit" data-i="${i}" x="${L + i * slot}" y="${T}" width="${slot}" height="${ph}"/>`).join('');
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="${esc(aria)}">${grid}${ticks}${bars}${hits}</svg>`;
    const svg = el.querySelector('svg');
    svg.querySelectorAll('.hit').forEach(rect => {
        rect.onmousemove = (evt) => {
            const i = rect.dataset.i;
            const p = points[i];
            svg.querySelectorAll('.bar').forEach(b => b.classList.toggle('hover', b.dataset.i === i));
            tip.innerHTML = `<b>${esc(tipLabel(p))}</b><br>${fmtNum(p.count)} spots`;
            tip.hidden = false;
            const r = tip.getBoundingClientRect();
            tip.style.left = `${Math.min(evt.clientX + 14, innerWidth - r.width - 8)}px`;
            tip.style.top = `${evt.clientY + 14}px`;
        };
        rect.onmouseleave = () => { tip.hidden = true; svg.querySelectorAll('.bar.hover').forEach(b => b.classList.remove('hover')); };
    });
}

// --- Informes (días UTC completos, desde los resúmenes diarios) ---
const DAY_MS = 86400000;
const REPORT_MAX_DAYS = 366;
const CONTINENTS = ['EU', 'NA', 'SA', 'AS', 'AF', 'OC', 'AN'];
const QSL_NAMES = { lotw: 'LoTW', eqsl: 'eQSL', clublog: 'Club Log', oqrs: 'OQRS' };
let reportType = 'day';
let reportRange = null;
let reportData = null;
let reportTitle = '';
let reportBusy = false;

const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const fmtUtcDay = (key, opts = { day: 'numeric', month: 'long', year: 'numeric' }) => new Date(`${key}T00:00:00Z`).toLocaleDateString(LOCALE, { ...opts, timeZone: 'UTC' });
const fmtPct = (part, total) => total ? (part / total * 100).toLocaleString(LOCALE, { maximumFractionDigits: part / total < 0.1 ? 1 : 0 }) : '0';
const flagImg = (adif) => adif ? `<img class="flag" src="/flags/${encodeURIComponent(adif)}.svg" alt="" onerror="this.style.visibility='hidden'">` : '';

function setReportType(type) {
    reportType = type;
    $('report-type').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', b.dataset.type === type ? 'true' : 'false'));
    $('report-form').querySelectorAll('label[data-for]').forEach(l => { l.hidden = l.dataset.for !== type; });
}

async function initReports() {
    if (!reportRange) {
        try { reportRange = await api('GET', '/api/reports/range'); } catch (_) { reportRange = { firstDay: utcDay(Date.now()), lastDay: utcDay(Date.now()) }; }
        const f = $('report-form');
        const { firstDay, lastDay } = reportRange;
        for (const name of ['day', 'from', 'to']) { f[name].min = firstDay; f[name].max = lastDay; }
        f.month.min = firstDay.slice(0, 7);
        f.month.max = lastDay.slice(0, 7);
        // Por defecto: ayer (último día cerrado), el mes en curso y la última semana
        const yesterday = utcDay(Date.parse(lastDay) - DAY_MS);
        f.day.value = yesterday >= firstDay ? yesterday : lastDay;
        f.month.value = lastDay.slice(0, 7);
        const weekAgo = utcDay(Date.parse(lastDay) - 6 * DAY_MS);
        f.from.value = weekAgo >= firstDay ? weekAgo : firstDay;
        f.to.value = lastDay;
        $('report-hint').textContent = t('rpt.hint', { first: fmtUtcDay(firstDay), max: REPORT_MAX_DAYS });
    }
}

// Periodo pedido como { from, to } (claves de día incluidas) o un mensaje de error
function reportPeriod() {
    const f = $('report-form');
    const isDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v);
    if (reportType === 'day') return isDay(f.day.value) ? { from: f.day.value, to: f.day.value } : { error: t('rpt.badDate') };
    if (reportType === 'month') {
        const m = f.month.value.trim();
        if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(m)) return { error: t('rpt.badMonth') };
        const [y, mo] = m.split('-').map(Number);
        return { from: `${m}-01`, to: utcDay(Date.UTC(y, mo, 0)), month: m };
    }
    if (!isDay(f.from.value) || !isDay(f.to.value)) return { error: t('rpt.badDate') };
    if (f.from.value > f.to.value) return { error: t('rpt.badOrder') };
    if ((Date.parse(f.to.value) - Date.parse(f.from.value)) / DAY_MS + 1 > REPORT_MAX_DAYS) return { error: t('rpt.tooLong', { max: REPORT_MAX_DAYS }) };
    return { from: f.from.value, to: f.to.value };
}

function periodTitle(p) {
    if (p.month) return t('rep.monthTitle', { month: fmtUtcDay(p.from, { month: 'long', year: 'numeric' }) });
    if (p.from === p.to) return t('rep.dayTitle', { date: fmtUtcDay(p.from) });
    return t('rpt.rangeTitle', { from: fmtUtcDay(p.from), to: fmtUtcDay(p.to) });
}

$('report-type').onclick = (e) => {
    const b = e.target.closest('button[data-type]');
    if (b) setReportType(b.dataset.type);
};

// La auditoría se recuerda entre visitas
const AUDIT_KEY = 'dxadmin-report-audit';
try { $('report-audit').checked = localStorage.getItem(AUDIT_KEY) === '1'; } catch (_) { /* ignore */ }
$('report-audit').onchange = () => { try { localStorage.setItem(AUDIT_KEY, $('report-audit').checked ? '1' : '0'); } catch (_) { /* ignore */ } };

$('report-form').onsubmit = async (e) => {
    e.preventDefault();
    if (reportBusy) return;
    const msg = $('report-msg');
    const p = reportPeriod();
    if (p.error) return showMsg(msg, p.error);
    // El mes en curso se recorta a hoy; el servidor también lo hace
    const to = reportRange && p.to > reportRange.lastDay ? reportRange.lastDay : p.to;
    const withAudit = $('report-audit').checked;
    showMsg(msg, '');
    reportBusy = true;
    $('report-go').disabled = true;
    $('report-go').textContent = t('rpt.generating');
    try {
        const qs = `from=${p.from}&to=${to}`;
        const [spots, audit] = await Promise.allSettled([
            api('GET', `/api/admin/reports?${qs}`),
            withAudit ? api('GET', `/api/admin/audit?${qs}`) : Promise.resolve(null)
        ]);
        // Sin spots (404) el informe puede mostrar solo la auditoría
        if (spots.status === 'rejected' && (spots.reason.status !== 404 || !audit.value)) throw spots.reason;
        if (audit.status === 'rejected') throw audit.reason;
        reportData = spots.value || null;
        reportTitle = periodTitle(p);
        await renderReport(reportData, reportTitle, audit.value);
        $('report-print').disabled = false;
    } catch (err) {
        reportData = null;
        $('report-out').hidden = true;
        $('report-print').disabled = true;
        showMsg(msg, err.status === 404 ? t('rep.noData') : t('adm.error', { msg: err.message }));
    } finally {
        reportBusy = false;
        $('report-go').disabled = false;
        $('report-go').textContent = t('rpt.go');
    }
};

// El título del documento da nombre al PDF
$('report-print').onclick = () => {
    const prev = document.title;
    document.title = `DX · ${reportTitle}`;
    addEventListener('afterprint', () => { document.title = prev; }, { once: true });
    print();
};

// Tabla de ranking: cols = [{ label, html(row), num? }], con columna de cuota sobre el total
function rankTable(rows, total, cols) {
    if (!rows?.length) return `<p class="muted">${esc(t('av.empty'))}</p>`;
    const max = Math.max(...rows.map(r => r.count));
    return `<table><thead><tr><th class="num">#</th>${cols.map(c => `<th${c.num ? ' class="num"' : ''}>${esc(c.label)}</th>`).join('')}
        <th class="num">Spots</th><th class="num">%</th><th></th></tr></thead>
        <tbody>${rows.map((r, i) => `<tr><td class="num muted">${i + 1}</td>${cols.map(c => `<td${c.num ? ' class="num"' : ''}>${c.html(r)}</td>`).join('')}
            <td class="num">${fmtNum(r.count)}</td><td class="num">${fmtPct(r.count, total)}</td>
            <td class="share"><span class="share-bar" style="width:${(r.count / max * 100).toFixed(1)}%"></span></td></tr>`).join('')}</tbody></table>`;
}

// Intervalos vacíos incluidos, para que el eje del tiempo sea continuo
function fullTimeline(d) {
    const step = d.bucketMinutes * 60000;
    const counts = new Map(d.timeline.map(x => [x.t, x.count]));
    const out = [];
    for (let t0 = Math.floor(d.from / step) * step; t0 < d.to; t0 += step) out.push({ t: t0, count: counts.get(t0) || 0 });
    return out;
}

// --- Gráficos de anillo (reparto de un total) ---
// Cinco colores categóricos en orden fijo (validados contra el fondo, oscuro y de impresión)
// y el resto agrupado en «Otros» en gris; la leyenda lleva siempre nombre y porcentaje
const DONUT_SLOTS = 5;

function donut(items, { label = (x) => x.name, total: totalIn, aria } = {}) {
    const sorted = [...items].filter(x => x.count > 0).sort((a, b) => b.count - a.count);
    const total = totalIn ?? sorted.reduce((a, x) => a + x.count, 0);
    if (!total || !sorted.length) return '';
    let slices = sorted.slice(0, DONUT_SLOTS).map((x, i) => ({ label: label(x), count: x.count, cls: `s${i + 1}` }));
    const rest = total - slices.reduce((a, s) => a + s.count, 0);
    if (rest > 0) slices.push({ label: t('act.other'), count: rest, cls: 'other' });
    const R = 60, r = 38, C = 64;
    const pt = (a, rad) => `${(C + rad * Math.sin(a)).toFixed(2)},${(C - rad * Math.cos(a)).toFixed(2)}`;
    let a0 = 0;
    const paths = slices.map((s, i) => {
        const frac = s.count / total;
        const tipHtml = `<b>${esc(s.label)}</b><br>${esc(t('av.mapTip', { n: fmtNum(s.count), pct: fmtPct(s.count, total) }))}`;
        if (frac >= 0.9999) return `<circle class="slice ${s.cls}" cx="${C}" cy="${C}" r="${(R + r) / 2}" fill="none" stroke-width="${R - r}" data-tip="${esc(tipHtml)}"/>`;
        const a1 = a0 + frac * 2 * Math.PI;
        const large = a1 - a0 > Math.PI ? 1 : 0;
        const d = `M${pt(a0, R)}A${R},${R} 0 ${large} 1 ${pt(a1, R)}L${pt(a1, r)}A${r},${r} 0 ${large} 0 ${pt(a0, r)}Z`;
        a0 = a1;
        return `<path class="slice ${s.cls}" d="${d}" data-tip="${esc(tipHtml)}" data-i="${i}"/>`;
    }).join('');
    return `<div class="donut-row">
        <svg class="donut" viewBox="0 0 128 128" role="img" aria-label="${esc(aria || '')}">${paths}</svg>
        <ul class="donut-legend">${slices.map(s => `<li><i class="sw ${s.cls}"></i><span class="lg-name">${esc(s.label)}</span><span class="lg-val">${fmtPct(s.count, total)}%</span></li>`).join('')}</ul>
    </div>`;
}

// --- Mapa del mundo (SVG estático, para que también salga al imprimir) ---
// world.json: Natural Earth 1:110m, x = lon + 180, y = 90 - lat; vista 85°N..60°S
const MAP_CENTROID = { EU: [50, 12], NA: [40, -100], SA: [-15, -60], AF: [5, 20], AS: [40, 90], OC: [-25, 135] };
let worldPromise = null;
let reportMapWho = 'spotted';
let reportMapRoutes = true;
try {
    reportMapWho = localStorage.getItem('dxadmin-report-map') === 'spotters' ? 'spotters' : 'spotted';
    reportMapRoutes = localStorage.getItem('dxadmin-report-routes') !== '0';
} catch (_) { /* ignore */ }

const loadWorld = () => worldPromise || (worldPromise = fetch('/world.json').then(r => r.json()).catch(() => { worldPromise = null; return null; }));

async function renderReportMap(d) {
    const el = $('report-map');
    if (!el) return;
    const world = await loadWorld();
    const pts = d.map?.[reportMapWho] || [];
    const total = pts.reduce((a, p) => a + p.count, 0);
    const max = Math.max(1, ...pts.map(p => p.count));
    let grat = '';
    for (let lon = 0; lon <= 360; lon += 30) grat += `M${lon} 0V180`;
    for (let lat = 0; lat <= 180; lat += 30) grat += `M0 ${lat}H360`;
    let routes = '';
    if (reportMapRoutes) {
        const rs = (d.continents || []).filter(c => c.from !== c.to && MAP_CENTROID[c.from] && MAP_CENTROID[c.to]);
        const maxc = Math.max(1, ...rs.map(c => c.count));
        routes = rs.map(c => {
            const [la1, lo1] = MAP_CENTROID[c.from], [la2, lo2] = MAP_CENTROID[c.to];
            const x1 = lo1 + 180, y1 = 90 - la1, x2 = lo2 + 180, y2 = 90 - la2;
            const k = c.count / maxc;
            return `<path class="route" d="M${x1} ${y1}Q${(x1 + x2) / 2} ${Math.min(y1, y2) - Math.abs(x2 - x1) * 0.18 - 4} ${x2} ${y2}" style="stroke-opacity:${(0.15 + 0.45 * k).toFixed(2)};stroke-width:${(0.6 + 3 * Math.sqrt(k)).toFixed(2)}px"/>`;
        }).join('');
    }
    // Los pequeños encima, para que no los tapen los grandes
    const dots = [...pts].sort((a, b) => b.count - a.count).map(p => {
        const tipHtml = `<b>${esc(p.country || '')}</b>${p.prefix ? ` · ${esc(p.prefix)}` : ''}<br>${esc(t('av.mapTip', { n: fmtNum(p.count), pct: fmtPct(p.count, total) }))}`;
        return `<circle class="dot ${reportMapWho}" cx="${(p.lon + 180).toFixed(2)}" cy="${(90 - p.lat).toFixed(2)}" r="${(0.45 + 2.1 * Math.sqrt(p.count / max)).toFixed(2)}" data-tip="${esc(tipHtml)}"/>`;
    }).join('');
    el.innerHTML = `<svg class="world" viewBox="0 5 360 145" role="img" aria-label="${esc(t('av.mapAria'))}">
        <path class="graticule" d="${grat}"/>${world ? `<path class="land" d="${world.land}"/><path class="borders" d="${world.borders}"/>` : ''}
        ${routes}${dots}</svg>`;
    $('report-map-note').textContent = t('av.mapNote', { n: fmtNum(pts.length) });
    $('report-map-who').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', b.dataset.who === reportMapWho ? 'true' : 'false'));
    $('report-map-routes').setAttribute('aria-pressed', reportMapRoutes ? 'true' : 'false');
}

// Tooltips de las tartas, el mapa y las tablas de auditoría (atributo data-tip con HTML ya escapado)
$('report-out').addEventListener('mousemove', (evt) => {
    const el = evt.target.closest('[data-tip]');
    if (!el) { tip.hidden = true; return; }
    tip.innerHTML = el.dataset.tip;
    tip.hidden = false;
    const r = tip.getBoundingClientRect();
    tip.style.left = `${Math.min(evt.clientX + 14, innerWidth - r.width - 8)}px`;
    tip.style.top = `${evt.clientY + 14}px`;
});
$('report-out').addEventListener('mouseleave', () => { tip.hidden = true; });
$('report-out').addEventListener('click', (evt) => {
    const who = evt.target.closest('#report-map-who button');
    const routes = evt.target.closest('#report-map-routes');
    if (!who && !routes) return;
    if (who) reportMapWho = who.dataset.who;
    if (routes) reportMapRoutes = !reportMapRoutes;
    try {
        localStorage.setItem('dxadmin-report-map', reportMapWho);
        localStorage.setItem('dxadmin-report-routes', reportMapRoutes ? '1' : '0');
    } catch (_) { /* ignore */ }
    if (reportData) renderReportMap(reportData);
});

const reportCard = (titleText, body, sub = '') => `<div class="card"><h2><span>${esc(titleText)}</span>${sub ? ` <small>${esc(sub)}</small>` : ''}</h2><div class="table-wrap">${body}</div></div>`;
const reportTile = (label, value, sub) => `<div class="tile"><span class="tile-label">${esc(label)}</span><span class="tile-value">${value}</span><span class="tile-sub">${esc(sub || '')}</span></div>`;

function spotsSection(d) {
    const total = d.total;
    const topBand = d.bands[0];
    const days = Math.max(1, Math.round((d.to - d.from) / DAY_MS));

    const paths = new Map(d.continents.map(x => [`${x.from}|${x.to}`, x.count]));
    const matrix = `<table class="matrix"><thead><tr><th>${esc(t('av.pathsFrom'))} \\ ${esc(t('av.pathsTo'))}</th>${CONTINENTS.map(c => `<th class="num" title="${esc(t(`cont.${c}`))}">${c}</th>`).join('')}</tr></thead>
        <tbody>${CONTINENTS.map(f => `<tr><td title="${esc(t(`cont.${f}`))}"><b>${f}</b> <span class="muted">${esc(t(`cont.${f}`))}</span></td>${CONTINENTS.map(c => {
            const n = paths.get(`${f}|${c}`) || 0;
            return `<td class="num${n ? '' : ' muted'}">${n ? fmtNum(n) : '·'}</td>`;
        }).join('')}</tr>`).join('')}</tbody></table>`;
    // Spots por continente de la estación DX (columnas de la matriz)
    const dxCont = CONTINENTS.map(c => ({ name: c, count: d.continents.filter(x => x.to === c).reduce((a, x) => a + x.count, 0) }));
    const spotterCont = CONTINENTS.map(c => ({ name: c, count: d.continents.filter(x => x.from === c).reduce((a, x) => a + x.count, 0) }));

    const uniq = d.uniqueCalls;
    const qsl = `<table><thead><tr><th>${esc(t('rpt.service'))}</th><th class="num">${esc(t('rpt.stations'))}</th><th class="num">%</th><th class="num">Spots</th><th class="num">%</th></tr></thead>
        <tbody>${[...Object.keys(QSL_NAMES), 'none'].map(k => {
            const q = d.qsl?.[k] || { calls: 0, spots: 0 };
            return `<tr><td>${esc(k === 'none' ? t('rpt.noQsl') : QSL_NAMES[k])}</td><td class="num">${fmtNum(q.calls)}</td><td class="num">${fmtPct(q.calls, uniq)}</td><td class="num">${fmtNum(q.spots)}</td><td class="num">${fmtPct(q.spots, total)}</td></tr>`;
        }).join('')}</tbody></table>`;
    const contLabel = (x) => t(`cont.${x.name}`);

    return `
        <div class="tiles">
            ${reportTile(t('av.kpi.spots'), fmtNum(total), t('rpt.perDay', { n: fmtNum(Math.round(total / days)) }))}
            ${reportTile(t('av.kpi.calls'), fmtNum(d.uniqueCalls), t('av.kpi.callsSub'))}
            ${reportTile(t('av.kpi.dxcc'), fmtNum(d.uniqueCountries), t('av.kpi.dxccSub'))}
            ${reportTile(t('av.kpi.spotters'), fmtNum(d.uniqueSpotters), t('av.kpi.spottersSub'))}
            ${reportTile(t('av.kpi.rbn'), `${fmtPct(d.rbn, total)}%`, t('av.kpi.rbnSub', { rbn: fmtNum(d.rbn), manual: fmtNum(d.manual) }))}
            ${reportTile(t('av.kpi.topBand'), esc(topBand?.name || '—'), topBand ? t('av.kpi.topBandSub', { pct: fmtPct(topBand.count, total) }) : '')}
        </div>
        <div class="card"><h2><span>${esc(t('av.timeline'))}</span> <small>${esc(d.bucketMinutes >= 1440 ? t('rpt.perDayUtc') : t('av.timelineSub', { m: d.bucketMinutes }))}</small></h2><div id="report-chart"></div></div>
        <div class="card"><h2><span>${esc(t('av.map'))}</span>
            <span class="actions">
                <span class="seg" id="report-map-who" role="group"><button type="button" data-who="spotted">${esc(t('av.map.spotted'))}</button><button type="button" data-who="spotters">${esc(t('av.map.spotters'))}</button></span>
                <span class="seg"><button type="button" id="report-map-routes">${esc(t('av.map.routes'))}</button></span>
            </span></h2>
            <div id="report-map" class="report-map"></div>
            <div class="hint" id="report-map-note"></div>
        </div>
        <div class="grid-2">
            ${reportCard(t('av.bands'), donut(d.bands, { total, aria: t('rpt.pieAria', { what: t('av.bands') }) }) + rankTable(d.bands, total, [{ label: t('av.band'), html: r => `<b>${esc(r.name)}</b>` }]))}
            ${reportCard(t('av.modes'), donut(d.modes, { total, aria: t('rpt.pieAria', { what: t('av.modes') }) }) + rankTable(d.modes, total, [{ label: t('rpt.mode'), html: r => `<b>${esc(r.name)}</b>` }]))}
        </div>
        <div class="grid-2">
            ${reportCard(t('rpt.dxContinents'), donut(dxCont, { label: contLabel, aria: t('rpt.dxContinents') }), t('rpt.dxContinentsSub'))}
            ${reportCard(t('rpt.spotterContinents'), donut(spotterCont, { label: contLabel, aria: t('rpt.spotterContinents') }), t('rpt.spotterContinentsSub'))}
        </div>
        ${reportCard(t('av.countries'), rankTable(d.countries, total, [
            { label: t('rpt.entity'), html: r => `${flagImg(r.adif)}<b>${esc(r.name)}</b>` },
            { label: t('rpt.continent'), html: r => esc(r.continent || '') }
        ]))}
        <div class="grid-2">
            ${reportCard(t('av.calls'), rankTable(d.calls, total, [
                { label: t('rpt.call'), html: r => `${flagImg(r.adif)}<b class="mono">${esc(r.name)}</b>` },
                { label: t('av.bands'), html: r => `<span class="muted">${esc((r.bands || []).filter(Boolean).join(' '))}</span>` }
            ]))}
            ${reportCard(t('av.spotters'), rankTable(d.spotters, total, [
                { label: t('rpt.call'), html: r => `${flagImg(r.adif)}<b class="mono">${esc(r.name)}</b>` },
                { label: t('rpt.entity'), html: r => `<span class="muted">${esc(r.country || '')}</span>` }
            ]))}
        </div>
        ${reportCard(t('av.paths'), matrix, t('av.pathsSub'))}
        <div class="grid-2">
            ${reportCard(t('av.qsl'), qsl, t('rpt.qslSub', { n: fmtNum(uniq) }))}
            ${reportCard(t('av.sources'), (d.sources.length > 1 ? donut(d.sources, { total, aria: t('av.sources') }) : '') + rankTable(d.sources, total, [{ label: t('st.col.source'), html: r => `<b>${esc(r.name)}</b>` }]))}
        </div>`;
}

// --- Auditoría ---
const AUDIT_CATEGORIES = ['source', 'system', 'database', 'reference', 'spaceWeather', 'reports', 'admin', 'auth'];
const SW_NAMES = { hamqsl: 'N0NBH / HamQSL', kp: 'NOAA Kp', xray: 'GOES X-ray', windSpeed: 'NOAA solar wind', windMag: 'NOAA IMF', scales: 'NOAA scales', daily: 'NOAA daily indices' };
let auditData = null;
let auditFilter = { category: '', incidents: false };

const fmtMs = (ms) => ms == null ? '—' : fmtDuration(ms / 1000);
const fmtUtc = (ms) => new Date(ms).toLocaleString(LOCALE, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'UTC' });

// Texto del evento en el idioma de la página; si falta la traducción, el mensaje guardado
function auditText(e) {
    const key = `aud.ev.${e.category}.${e.type}`;
    if (!(key in STRINGS.es)) return e.message;
    const d = e.details || {};
    return t(key, {
        ...d,
        node: d.node ? nodeLabel(d.node) : '',
        from: d.from ? nodeLabel(d.from) : '',
        down: fmtMs(d.downMs),
        up: fmtMs(d.upMs),
        reason: d.reason || d.error || t('aud.noReason'),
        size: d.size != null ? fmtBytes(d.size) : '',
        dataset: REF_NAMES[d.dataset] || d.dataset || '',
        source: SW_NAMES[d.source] || d.source || '',
        lastSeen: d.lastSeen ? `${fmtUtc(d.lastSeen)} UTC` : '',
        role: d.role ? t(`usr.role.${d.role}`) : '',
        username: d.username || '?',
        dropped: fmtNum(d.dropped || 0),
        attempts: fmtNum(d.attempts || 0),
        kind: d.kind ? t(`aud.kind.${d.kind}`) : ''
    });
}

function auditSection(a) {
    const count = (pred) => a.counts.filter(pred).reduce((s, c) => s + c.n, 0);
    const errors = count(c => c.level === 'error');
    const warnings = count(c => c.level === 'warning');
    const outages = a.sources.reduce((s, x) => s + x.outages, 0);
    const downMs = a.sources.reduce((s, x) => s + x.downMs, 0);
    const failedDownloads = count(c => (c.category === 'reference' || c.category === 'spaceWeather') && c.level !== 'info');
    const observedMs = a.observedFrom === null ? 0 : Math.max(0, a.to - a.observedFrom);
    const avail = (ms) => observedMs ? `${(Math.max(0, 1 - ms / observedMs) * 100).toLocaleString(LOCALE, { minimumFractionDigits: 1, maximumFractionDigits: ms && ms / observedMs < 0.001 ? 3 : 1 })}%` : '—';
    const byCat = AUDIT_CATEGORIES.map(c => ({ name: c, count: count(x => x.category === c && x.level !== 'info') }));

    const sourceRows = a.sources.map(s => `<tr>
        <td><b>${esc(s.name)}</b>${s.ongoing ? ` ${chip('critical', t('aud.downNow'))}` : ''}</td>
        <td class="num">${fmtNum(s.disconnects)}</td><td class="num">${fmtNum(s.outages)}</td>
        <td class="num">${esc(fmtMs(s.downMs))}</td><td class="num">${esc(fmtMs(s.longestMs))}</td>
        <td class="num">${fmtNum(s.failovers)}</td><td class="num"><b>${avail(s.downMs)}</b></td></tr>`).join('');
    const sys = a.system;
    const sysRow = sys.stops ? `<tr><td><b>${esc(t('aud.ingestor'))}</b></td><td class="num">—</td><td class="num">${fmtNum(sys.stops)}</td>
        <td class="num">${esc(fmtMs(sys.downMs))}</td><td class="num">${esc(fmtMs(sys.longestMs))}</td><td class="num">—</td><td class="num"><b>${avail(sys.downMs)}</b></td></tr>` : '';
    const availability = sourceRows || sysRow ? `<table><thead><tr><th>${esc(t('st.col.source'))}</th><th class="num">${esc(t('aud.disconnects'))}</th><th class="num">${esc(t('aud.outages'))}</th>
        <th class="num">${esc(t('aud.downtime'))}</th><th class="num">${esc(t('aud.longest'))}</th><th class="num">${esc(t('aud.failovers'))}</th><th class="num">${esc(t('aud.availability'))}</th></tr></thead>
        <tbody>${sourceRows}${sysRow}</tbody></table>` : `<p class="muted">${esc(t('aud.noOutages'))}</p>`;

    const since = a.firstEventAt ? t('aud.since', { date: `${fmtUtc(a.firstEventAt)} UTC` }) : t('aud.empty');
    return `
        <div class="card report-head audit-head"><h3>${esc(t('aud.title'))}</h3><span class="sub">${esc(since)}</span></div>
        <div class="tiles">
            ${reportTile(t('aud.incidents'), fmtNum(errors + warnings), t('aud.incidentsSub', { e: fmtNum(errors), w: fmtNum(warnings) }))}
            ${reportTile(t('aud.sourceOutages'), fmtNum(outages), t('aud.sourceOutagesSub', { d: fmtMs(downMs) }))}
            ${reportTile(t('aud.stops'), fmtNum(sys.stops), sys.stops ? t('aud.stopsSub', { d: fmtMs(sys.downMs) }) : '')}
            ${reportTile(t('aud.failedDownloads'), fmtNum(failedDownloads), t('aud.failedDownloadsSub'))}
            ${reportTile(t('aud.events'), fmtNum(a.total), t('aud.eventsSub'))}
        </div>
        <div class="grid-2">
            ${reportCard(t('aud.availabilityTitle'), availability, observedMs ? t('aud.availabilitySub', { d: fmtMs(observedMs) }) : '')}
            ${reportCard(t('aud.byCategory'), donut(byCat, { label: x => t(`aud.cat.${x.name}`), aria: t('aud.byCategory') }) || `<p class="muted">${esc(t('aud.noIncidents'))}</p>`)}
        </div>
        <div class="card">
            <h2><span>${esc(t('aud.log'))}</span>
                <span class="actions audit-filters">
                    <select id="audit-cat" aria-label="${esc(t('aud.category'))}"><option value="">${esc(t('aud.allCategories'))}</option>${AUDIT_CATEGORIES.map(c => `<option value="${c}">${esc(t(`aud.cat.${c}`))}</option>`).join('')}</select>
                    <label class="check"><input type="checkbox" id="audit-incidents"><span>${esc(t('aud.onlyIncidents'))}</span></label>
                </span></h2>
            <div class="table-wrap" id="audit-log"></div>
            ${a.truncated ? `<div class="hint">${esc(t('aud.truncated', { n: fmtNum(a.events.length), total: fmtNum(a.total) }))}</div>` : ''}
        </div>`;
}

const LEVEL_CHIP = { info: 'muted', warning: 'warning', error: 'critical' };

function renderAuditLog() {
    const el = $('audit-log');
    if (!el || !auditData) return;
    const rows = auditData.events.filter(e => (!auditFilter.category || e.category === auditFilter.category) && (!auditFilter.incidents || e.level !== 'info'));
    el.innerHTML = rows.length ? `<table class="audit-table"><thead><tr><th>${esc(t('aud.when'))}</th><th>${esc(t('aud.level'))}</th><th>${esc(t('aud.category'))}</th><th>${esc(t('aud.subject'))}</th><th>${esc(t('aud.detail'))}</th></tr></thead>
        <tbody>${rows.map(e => `<tr class="lv-${e.level}">
            <td class="mono nowrap">${esc(fmtUtc(e.ts))}</td>
            <td>${chip(LEVEL_CHIP[e.level] || 'muted', t(`aud.level.${e.level}`))}</td>
            <td class="nowrap">${esc(t(`aud.cat.${e.category}`))}</td>
            <td>${esc(e.subject || '')}</td>
            <td>${esc(auditText(e))}</td></tr>`).join('')}</tbody></table>` : `<p class="muted">${esc(t('aud.noEvents'))}</p>`;
}

async function renderReport(d, title, audit) {
    const out = $('report-out');
    // Incluye hoy: el último día aún no ha terminado
    const inProgress = (d?.to ?? audit?.to ?? 0) > Date.now() - 60000;
    auditData = audit;
    out.innerHTML = `
        <div class="card report-head">
            <h3>${esc(title)}${inProgress ? `<span class="report-tag">${esc(t('rep.inProgress'))}</span>` : ''}</h3>
            <span class="sub">${esc(t('rpt.generated', { date: new Date(d?.generatedAt || Date.now()).toLocaleString(LOCALE, { dateStyle: 'medium', timeStyle: 'short' }) }))}</span>
        </div>
        ${d ? spotsSection(d) : `<div class="card"><p class="muted">${esc(t('rep.noData'))}</p></div>`}
        ${audit ? auditSection(audit) : ''}`;
    out.hidden = false;

    if (audit) {
        $('audit-cat').value = auditFilter.category;
        $('audit-incidents').checked = auditFilter.incidents;
        $('audit-cat').onchange = () => { auditFilter.category = $('audit-cat').value; renderAuditLog(); };
        $('audit-incidents').onchange = () => { auditFilter.incidents = $('audit-incidents').checked; renderAuditLog(); };
        renderAuditLog();
    }
    if (!d) return;

    const points = fullTimeline(d);
    const multiDay = d.to - d.from > DAY_MS;
    const every = Math.max(1, Math.ceil(points.length / 12));
    barChart($('report-chart'), points, {
        aria: t('av.timelineAria'),
        tick: (pt, i) => {
            if (i % every) return null;
            const dt = new Date(pt.t);
            if (d.bucketMinutes >= 1440) return String(dt.getUTCDate());
            return multiDay ? (dt.getUTCHours() === 0 ? fmtUtcDay(utcDay(pt.t), { day: 'numeric', month: 'short' }) : null) : hhmm(dt);
        },
        tip: (pt) => d.bucketMinutes >= 1440 ? fmtUtcDay(utcDay(pt.t)) : `${multiDay ? `${fmtUtcDay(utcDay(pt.t), { day: 'numeric', month: 'short' })} ` : ''}${hhmm(new Date(pt.t))} UTC`
    });
    await renderReportMap(d);
}

setReportType('day');

// --- Orígenes ---
let sourcesCache = [];
let editingSource = null; // null = cerrado, 0 = nuevo, id = editando
const confirming = new Set();

async function loadSources() {
    try { sourcesCache = await api('GET', '/api/admin/sources'); } catch (err) { return; }
    renderSources();
}

function renderSources() {
    const el = $('source-list');
    if (!sourcesCache.length) { el.innerHTML = `<p class="muted">${esc(t('src.empty'))}</p>`; return; }
    el.innerHTML = sourcesCache.map(s => {
        const st = s.status;
        const activeIdx = st ? st.nodes.findIndex(n => n.host === st.host && n.port === st.port && n.name === st.node) : -1;
        const nodes = [{ host: s.host, port: s.port, label: t('src.primary') }, ...s.backups.map((b, i) => ({ ...b, label: t('node.backup', { n: i + 1 }) }))];
        const state = !s.enabled ? chip('muted', t('src.disabled')) : st?.connected ? chip('good', t('st.connected')) : chip('critical', t('st.disconnected'));
        const confirmDel = confirming.has(s.id)
            ? `<span class="confirm">${esc(t('adm.confirmDelete'))} <button class="btn small danger" data-act="delete-yes" data-id="${s.id}">${esc(t('adm.yes'))}</button><button class="btn small" data-act="delete-no" data-id="${s.id}">${esc(t('adm.no'))}</button></span>`
            : `<button class="btn small danger" data-act="delete" data-id="${s.id}">${esc(t('adm.delete'))}</button>`;
        return `<div class="card source-card${s.enabled ? '' : ' disabled-card'}">
            <div class="source-head">
                <div><h3>${esc(s.name)}</h3><div class="sub mono">${esc(s.callsign)}</div></div>
                ${state}
            </div>
            <ul class="nodes">${nodes.map((n, i) => `<li class="${i === activeIdx && st?.connected ? 'active' : ''}"><span class="mono">${esc(n.host)}:${n.port}</span><span class="tag">${esc(n.label)}${i === activeIdx && st?.connected ? ` · ${esc(t('src.activeNode'))}` : ''}</span></li>`).join('')}</ul>
            ${st ? `<div class="source-stats">
                <span>${esc(t('st.col.spots'))}: <b>${fmtNum(st.spots)}</b></span>
                <span>${esc(t('st.col.dups'))}: <b>${fmtNum(st.duplicates)}</b></span>
                <span>${esc(t('st.col.lastSpot'))}: <b>${esc(fmtAgo(st.lastSpotAt))}</b></span>
            </div>${st.lastError ? `<div class="err-text" title="${esc(st.lastError)}">${esc(st.lastError)}</div>` : ''}` : ''}
            <div class="actions">
                <button class="btn small" data-act="edit" data-id="${s.id}">${esc(t('adm.edit'))}</button>
                ${s.enabled ? `<button class="btn small" data-act="reconnect" data-id="${s.id}">${esc(t('src.reconnect'))}</button>` : ''}
                <button class="btn small" data-act="toggle" data-id="${s.id}">${esc(s.enabled ? t('src.disable') : t('src.enable'))}</button>
                <span class="spacer"></span>
                ${confirmDel}
            </div>
        </div>`;
    }).join('');
}

function sourceToBody(s, overrides = {}) {
    return { name: s.name, host: s.host, port: s.port, callsign: s.callsign, login_commands: s.login_commands, backups: s.backups, enabled: s.enabled, ...overrides };
}

$('source-list').onclick = async (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    const id = parseInt(b.dataset.id, 10);
    const s = sourcesCache.find(x => x.id === id);
    try {
        switch (b.dataset.act) {
            case 'edit': openSourceForm(s); return;
            case 'reconnect':
                await api('POST', `/api/admin/sources/${id}/reconnect`);
                toast(t('src.reconnecting'));
                break;
            case 'toggle':
                await api('PUT', `/api/admin/sources/${id}`, sourceToBody(s, { enabled: !s.enabled }));
                toast(t('adm.saved'));
                break;
            case 'delete': confirming.add(id); renderSources(); return;
            case 'delete-no': confirming.delete(id); renderSources(); return;
            case 'delete-yes':
                confirming.delete(id);
                await api('DELETE', `/api/admin/sources/${id}`);
                toast(t('adm.saved'));
                break;
        }
    } catch (err) {
        toast(t('adm.error', { msg: err.message }), true);
    }
    // Las sesiones arrancan con unos segundos de margen
    loadSources();
    setTimeout(loadSources, 4000);
};

function openSourceForm(s) {
    const f = $('source-form');
    editingSource = s ? s.id : 0;
    $('source-form-title').textContent = t(s ? 'src.editTitle' : 'src.new');
    f.name.value = s?.name || '';
    f.host.value = s?.host || '';
    f.port.value = s?.port || 7300;
    f.callsign.value = s?.callsign || '';
    f.login_commands.value = s ? s.login_commands : 'set/skim';
    f.backups.value = s ? s.backups.map(b => `${b.host}:${b.port}`).join('\n') : '';
    f.enabled.checked = s ? s.enabled : true;
    showMsg($('source-form-msg'), '');
    f.hidden = false;
    f.scrollIntoView({ behavior: 'smooth', block: 'start' });
    f.name.focus();
}

$('source-add').onclick = () => openSourceForm(null);
$('source-cancel').onclick = () => { $('source-form').hidden = true; editingSource = null; };

$('source-form').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    const body = {
        name: f.name.value.trim(),
        host: f.host.value.trim(),
        port: parseInt(f.port.value, 10),
        callsign: f.callsign.value.trim().toUpperCase(),
        login_commands: f.login_commands.value,
        backups: f.backups.value.split('\n').map(l => l.trim()).filter(Boolean),
        enabled: f.enabled.checked
    };
    try {
        if (editingSource) await api('PUT', `/api/admin/sources/${editingSource}`, body);
        else await api('POST', '/api/admin/sources', body);
        f.hidden = true;
        editingSource = null;
        toast(t('adm.saved'));
        loadSources();
        setTimeout(loadSources, 4000);
    } catch (err) {
        showMsg($('source-form-msg'), t('adm.error', { msg: err.message }));
    }
};

// --- Usuarios ---
let usersCache = [];
const userConfirm = new Set();
const userPassOpen = new Set();

async function loadUsers() {
    try { usersCache = await api('GET', '/api/admin/users'); } catch (err) { return; }
    renderUsers();
}

function renderUsers() {
    $('user-list').innerHTML = `<table>
        <thead><tr><th>${esc(t('adm.username'))}</th><th>${esc(t('usr.role'))}</th><th>${esc(t('usr.created'))}</th><th>${esc(t('usr.lastLogin'))}</th><th></th></tr></thead>
        <tbody>${usersCache.map(u => {
            const self = u.id === me?.sub;
            const pass = userPassOpen.has(u.id)
                ? `<span class="inline-pass"><input type="password" data-pass="${u.id}" minlength="8" placeholder="${esc(t('usr.newPassword'))}" autocomplete="new-password"><button class="btn small primary" data-act="pass-save" data-id="${u.id}">${esc(t('adm.save'))}</button><button class="btn small" data-act="pass-cancel" data-id="${u.id}">${esc(t('adm.cancel'))}</button></span>`
                : `<button class="btn small" data-act="pass" data-id="${u.id}">${esc(t('usr.setPassword'))}</button>`;
            const del = self ? '' : userConfirm.has(u.id)
                ? `<span class="confirm">${esc(t('adm.confirmDelete'))} <button class="btn small danger" data-act="del-yes" data-id="${u.id}">${esc(t('adm.yes'))}</button><button class="btn small" data-act="del-no" data-id="${u.id}">${esc(t('adm.no'))}</button></span>`
                : `<button class="btn small danger" data-act="del" data-id="${u.id}">${esc(t('adm.delete'))}</button>`;
            return `<tr>
                <td><b>${esc(u.username)}</b>${self ? ` <span class="muted">(${esc(t('usr.you'))})</span>` : ''}</td>
                <td><select data-role="${u.id}" aria-label="${esc(t('usr.role'))}">
                    <option value="user"${u.role === 'user' ? ' selected' : ''}>${esc(t('usr.role.user'))}</option>
                    <option value="admin"${u.role === 'admin' ? ' selected' : ''}>${esc(t('usr.role.admin'))}</option>
                </select></td>
                <td>${esc(fmtDate(parseSqlDate(u.created_at)))}</td>
                <td>${esc(u.last_login ? fmtDate(parseSqlDate(u.last_login)) : t('adm.never'))}</td>
                <td><div class="actions">${pass}<span class="spacer"></span>${del}</div></td>
            </tr>`;
        }).join('')}</tbody></table>`;
}

$('user-list').onchange = async (e) => {
    const sel = e.target.closest('select[data-role]');
    if (!sel) return;
    try {
        await api('PUT', `/api/admin/users/${sel.dataset.role}`, { role: sel.value });
        toast(t('adm.saved'));
    } catch (err) {
        toast(t('adm.error', { msg: err.message }), true);
    }
    loadUsers();
};

$('user-list').onclick = async (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    const id = parseInt(b.dataset.id, 10);
    try {
        switch (b.dataset.act) {
            case 'pass': userPassOpen.add(id); renderUsers(); document.querySelector(`[data-pass="${id}"]`)?.focus(); return;
            case 'pass-cancel': userPassOpen.delete(id); renderUsers(); return;
            case 'pass-save': {
                const pw = document.querySelector(`[data-pass="${id}"]`).value;
                await api('PUT', `/api/admin/users/${id}`, { password: pw });
                userPassOpen.delete(id);
                toast(t('adm.saved'));
                break;
            }
            case 'del': userConfirm.add(id); renderUsers(); return;
            case 'del-no': userConfirm.delete(id); renderUsers(); return;
            case 'del-yes':
                userConfirm.delete(id);
                await api('DELETE', `/api/admin/users/${id}`);
                toast(t('adm.saved'));
                break;
        }
    } catch (err) {
        toast(t('adm.error', { msg: err.message }), true);
    }
    loadUsers();
};

$('user-form').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
        await api('POST', '/api/admin/users', { username: f.username.value.trim(), password: f.password.value, role: f.role.value });
        f.reset();
        showMsg($('user-form-msg'), '');
        toast(t('adm.saved'));
        loadUsers();
    } catch (err) {
        showMsg($('user-form-msg'), t('adm.error', { msg: err.message }));
    }
};

// --- Mi cuenta ---
$('account-form').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    const msg = $('account-msg');
    if (f.new.value !== f.repeat.value) return showMsg(msg, t('acc.mismatch'));
    try {
        await api('POST', '/api/me/password', { currentPassword: f.current.value, newPassword: f.new.value });
        f.reset();
        showMsg(msg, t('acc.changed'), true);
    } catch (err) {
        showMsg(msg, t('adm.error', { msg: err.message }));
    }
};

// --- Inicio ---
document.addEventListener('DOMContentLoaded', () => {
    if (token) enter();
    else showView('login');
});
