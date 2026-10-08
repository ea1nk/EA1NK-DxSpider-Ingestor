// dashboard.js
// Paneles de propagación, meteorología espacial y actividad para DX Monitor Live

const SPACE_WEATHER_POLL_MS = 5 * 60 * 1000;
const ACTIVITY_POLL_MS = 60 * 1000;
const HEALTH_POLL_MS = 30 * 1000;
const SUN_REFRESH_MS = 15 * 60 * 1000;

const BAND_ORDER = ['160m', '80m', '60m', '40m', '30m', '20m', '17m', '15m', '12m', '10m', '6m', '4m', '2m', '70cm'];

// --- Utilidades ---
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (v, digits = 0) => (v === null || v === undefined || Number.isNaN(v)) ? '—' : Number(v).toFixed(digits);
const $ = (id) => document.getElementById(id);

function fmtUtc(iso, withDate = true) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const mm = String(d.getUTCMinutes()).padStart(2, '0');
    if (!withDate) return `${hh}:${mm}`;
    const day = d.toLocaleDateString('es-ES', { day: '2-digit', month: 'short', timeZone: 'UTC' });
    return `${day} ${hh}:${mm} UTC`;
}

async function getJson(url) {
    const res = await fetch(url, { cache: 'no-store' });
    // /health answers 503 with a valid body when the cluster is down
    if (!res.ok && res.status !== 503) throw new Error(`HTTP ${res.status}`);
    return res.json();
}

// Estado → clase CSS y etiqueta (el color nunca va solo: siempre con texto)
const statusChip = (level, text) => `<span class="chip st-${level}"><i></i>${esc(text)}</span>`;

function kpStatus(kp) {
    if (kp === null || kp === undefined) return ['muted', 'Sin datos'];
    if (kp < 3) return ['good', 'Quieto'];
    if (kp < 4) return ['warning', 'Inestable'];
    if (kp < 5) return ['serious', 'Activo'];
    return ['critical', `Tormenta G${Math.min(5, Math.floor(kp) - 4)}`];
}

function aStatus(a) {
    if (a === null || a === undefined) return ['muted', 'Sin datos'];
    if (a < 8) return ['good', 'Quieto'];
    if (a < 16) return ['warning', 'Inestable'];
    if (a < 30) return ['serious', 'Activo'];
    return ['critical', 'Tormenta'];
}

function xrayStatus(cls) {
    if (!cls) return ['muted', 'Sin datos'];
    const letter = cls[0];
    const value = parseFloat(cls.slice(1));
    if (letter === 'X') return ['critical', 'Fulguración X (R3+)'];
    if (letter === 'M' && value >= 5) return ['serious', 'Fulguración M (R2)'];
    if (letter === 'M') return ['warning', 'Fulguración M (R1)'];
    return ['good', 'Normal'];
}

function windStatus(speed) {
    if (speed === null || speed === undefined) return ['muted', 'Sin datos'];
    if (speed < 500) return ['good', 'Normal'];
    if (speed < 700) return ['warning', 'Elevado'];
    return ['serious', 'Muy alto'];
}

function bzStatus(bz) {
    if (bz === null || bz === undefined) return ['muted', 'Sin datos'];
    if (bz > -5) return ['good', bz >= 0 ? 'Norte' : 'Sur débil'];
    if (bz > -10) return ['warning', 'Sur'];
    return ['serious', 'Sur intenso'];
}

function scaleLevel(v) {
    if (v === null || v === undefined) return 'muted';
    if (v === 0) return 'good';
    if (v <= 2) return 'warning';
    if (v === 3) return 'serious';
    return 'critical';
}

const COND_ES = { Good: ['good', 'Buena'], Fair: ['warning', 'Regular'], Poor: ['critical', 'Mala'] };

// --- Tooltip compartido ---
const tip = document.createElement('div');
tip.className = 'viz-tip';
tip.hidden = true;
document.addEventListener('DOMContentLoaded', () => document.body.appendChild(tip));

function showTip(evt, html) {
    tip.innerHTML = html;
    tip.hidden = false;
    const pad = 14;
    const { innerWidth: w, innerHeight: h } = window;
    const rect = tip.getBoundingClientRect();
    let x = evt.clientX + pad;
    let y = evt.clientY + pad;
    if (x + rect.width > w - 8) x = evt.clientX - rect.width - pad;
    if (y + rect.height > h - 8) y = evt.clientY - rect.height - pad;
    tip.style.left = `${x}px`;
    tip.style.top = `${y}px`;
}
const hideTip = () => { tip.hidden = true; };

// --- Sparkline (tiles) ---
function sparkline(el, values, labelFn) {
    if (!el) return;
    const pts = values.filter(v => v.value !== null);
    if (pts.length < 2) { el.innerHTML = ''; return; }
    const W = Math.max(80, Math.round(el.clientWidth || 120)), H = 30, P = 4;
    const min = Math.min(...pts.map(p => p.value));
    const max = Math.max(...pts.map(p => p.value));
    const x = (i) => P + (i / (pts.length - 1)) * (W - 2 * P);
    const y = (v) => H - P - (max === min ? 0.5 : (v - min) / (max - min)) * (H - 2 * P);
    const d = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join('');
    const last = pts.length - 1;
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" class="spark" aria-hidden="true">
        <path d="${d}" class="spark-line"/>
        <line class="spark-cross" y1="0" y2="${H}" hidden/>
        <circle cx="${x(last)}" cy="${y(pts[last].value)}" r="3" class="spark-dot"/>
    </svg>`;
    const svg = el.querySelector('svg');
    const cross = svg.querySelector('.spark-cross');
    svg.onmousemove = (evt) => {
        const r = svg.getBoundingClientRect();
        const rel = (evt.clientX - r.left) / r.width * W;
        const i = Math.max(0, Math.min(last, Math.round((rel - P) / (W - 2 * P) * last)));
        cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.hidden = false;
        showTip(evt, labelFn(pts[i]));
    };
    svg.onmouseleave = () => { cross.hidden = true; hideTip(); };
}

// --- Gráfico Kp (columnas, 3 días) ---
function renderKpChart(kp) {
    const el = $('kp-chart');
    if (!el) return;
    if (!kp || !kp.length) { el.innerHTML = '<p class="empty">Sin datos de Kp</p>'; return; }
    const W = 320, H = 150, L = 22, R = 6, T = 8, B = 22;
    const pw = W - L - R, ph = H - T - B;
    const slot = pw / kp.length;
    const bw = Math.min(24, slot - 2);
    const y = (v) => T + ph - (v / 9) * ph;
    let grid = '';
    for (const g of [0, 3, 5, 9]) {
        grid += `<line x1="${L}" x2="${W - R}" y1="${y(g)}" y2="${y(g)}" class="grid"/><text x="${L - 6}" y="${y(g) + 3}" class="axis" text-anchor="end">${g}</text>`;
    }
    let bars = '', hits = '', days = '';
    kp.forEach((p, i) => {
        const x0 = L + i * slot + (slot - bw) / 2;
        const h = Math.max(1.5, (p.kp / 9) * ph);
        const top = T + ph - h;
        const r = Math.min(3, bw / 2, h);
        const [lvl] = kpStatus(p.kp);
        bars += `<path class="bar st-fill-${lvl}" d="M${x0},${T + ph}V${top + r}Q${x0},${top} ${x0 + r},${top}H${x0 + bw - r}Q${x0 + bw},${top} ${x0 + bw},${top + r}V${T + ph}Z"/>`;
        hits += `<rect class="hit" data-i="${i}" x="${L + i * slot}" y="${T}" width="${slot}" height="${ph}"/>`;
        const d = new Date(p.time);
        if (d.getUTCHours() === 0) {
            const xd = L + i * slot;
            days += `<line x1="${xd}" x2="${xd}" y1="${T + ph}" y2="${T + ph + 4}" class="grid"/><text x="${xd + 2}" y="${H - 6}" class="axis">${d.toLocaleDateString('es-ES', { day: '2-digit', month: 'short', timeZone: 'UTC' })}</text>`;
        }
    });
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Índice Kp planetario, últimos 3 días">${grid}${days}${bars}${hits}</svg>`;
    el.querySelectorAll('.hit').forEach(rect => {
        rect.onmousemove = (evt) => {
            const p = kp[rect.dataset.i];
            const [lvl, txt] = kpStatus(p.kp);
            showTip(evt, `<b>${fmtUtc(p.time)}</b><br>Kp ${fmt(p.kp, 2)} · ${statusChip(lvl, txt)}`);
        };
        rect.onmouseleave = hideTip;
    });
}

// --- Gráfico de rayos X (línea, escala log, 6 h) ---
function renderXrayChart(xray) {
    const el = $('xray-chart');
    if (!el) return;
    const series = xray?.series || [];
    if (series.length < 2) { el.innerHTML = '<p class="empty">Sin datos de rayos X</p>'; return; }
    const W = 320, H = 150, L = 22, R = 10, T = 8, B = 22;
    const pw = W - L - R, ph = H - T - B;
    const LOG_MIN = -8.5, LOG_MAX = -3.5;
    const t0 = new Date(series[0].time).getTime();
    const t1 = new Date(series.at(-1).time).getTime();
    const x = (t) => L + ((t - t0) / (t1 - t0)) * pw;
    const y = (f) => {
        const l = Math.min(LOG_MAX, Math.max(LOG_MIN, Math.log10(f)));
        return T + ph - ((l - LOG_MIN) / (LOG_MAX - LOG_MIN)) * ph;
    };
    let grid = '';
    [['A', 1e-8], ['B', 1e-7], ['C', 1e-6], ['M', 1e-5], ['X', 1e-4]].forEach(([c, f]) => {
        grid += `<line x1="${L}" x2="${W - R}" y1="${y(f)}" y2="${y(f)}" class="grid"/><text x="${L - 6}" y="${y(f) + 3}" class="axis" text-anchor="end">${c}</text>`;
    });
    let ticks = '';
    const firstHour = Math.ceil(t0 / 3600000) * 3600000;
    for (let t = firstHour; t <= t1; t += 2 * 3600000) {
        ticks += `<text x="${x(t)}" y="${H - 6}" class="axis" text-anchor="middle">${fmtUtc(new Date(t).toISOString(), false)}</text>`;
    }
    const pts = series.map(p => [x(new Date(p.time).getTime()), y(p.flux)]);
    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
    const area = `${line}L${pts.at(-1)[0].toFixed(1)},${T + ph}L${pts[0][0].toFixed(1)},${T + ph}Z`;
    const lastPt = pts.at(-1);
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Flujo de rayos X GOES, últimas 6 horas">
        ${grid}${ticks}
        <path d="${area}" class="series-area"/>
        <path d="${line}" class="series-line"/>
        <circle cx="${lastPt[0]}" cy="${lastPt[1]}" r="4" class="series-dot"/>
        <line class="crosshair" y1="${T}" y2="${T + ph}" hidden/>
        <circle class="series-dot hover-dot" r="4" hidden/>
        <rect class="hit" x="${L}" y="${T}" width="${pw}" height="${ph}"/>
    </svg>`;
    const svg = el.querySelector('svg');
    const cross = svg.querySelector('.crosshair');
    const dot = svg.querySelector('.hover-dot');
    const hit = svg.querySelector('.hit');
    hit.onmousemove = (evt) => {
        const r = svg.getBoundingClientRect();
        const rel = (evt.clientX - r.left) / r.width * W;
        let best = 0;
        pts.forEach((p, i) => { if (Math.abs(p[0] - rel) < Math.abs(pts[best][0] - rel)) best = i; });
        const [px, py] = pts[best];
        cross.setAttribute('x1', px); cross.setAttribute('x2', px); cross.hidden = false;
        dot.setAttribute('cx', px); dot.setAttribute('cy', py); dot.hidden = false;
        const cls = xrayClassOf(series[best].flux);
        showTip(evt, `<b>${fmtUtc(series[best].time)}</b><br>Clase ${cls} · ${series[best].flux.toExponential(2)} W/m²`);
    };
    hit.onmouseleave = () => { cross.hidden = true; dot.hidden = true; hideTip(); };
}

function xrayClassOf(flux) {
    for (const [letter, base] of [['X', 1e-4], ['M', 1e-5], ['C', 1e-6], ['B', 1e-7], ['A', 1e-8]]) {
        if (flux >= base) return `${letter}${(flux / base).toFixed(1)}`;
    }
    return 'A0.0';
}

// --- Tiles de índices ---
function setTile(id, value, sub, status) {
    const tile = $(id);
    if (!tile) return;
    tile.querySelector('.tile-value').textContent = value;
    tile.querySelector('.tile-sub').innerHTML = sub || '';
    const st = tile.querySelector('.tile-status');
    if (st) st.innerHTML = status ? statusChip(status[0], status[1]) : '';
}

function renderSpaceWeather(sw) {
    const h = sw.hamqsl || {};
    const daily = sw.daily || [];
    const kpNow = sw.kp?.length ? sw.kp.at(-1).kp : h.kIndex;

    setTile('tile-sfi', fmt(h.sfi ?? daily.at(-1)?.sfi), 'Flujo solar 10,7 cm · 30 días');
    sparkline($('spark-sfi'), daily.map(d => ({ value: d.sfi, date: d.date })), p => `<b>${esc(p.date)}</b><br>SFI ${p.value}`);

    setTile('tile-ssn', fmt(h.ssn ?? daily.at(-1)?.ssn), 'Manchas solares · 30 días');
    sparkline($('spark-ssn'), daily.map(d => ({ value: d.ssn, date: d.date })), p => `<b>${esc(p.date)}</b><br>SSN ${p.value}`);

    setTile('tile-a', fmt(h.aIndex), 'Índice A', aStatus(h.aIndex));
    setTile('tile-k', fmt(kpNow, kpNow % 1 ? 2 : 0), 'Índice Kp (NOAA)', kpStatus(kpNow));

    const xcls = sw.xray?.currentClass || h.xray;
    setTile('tile-xray', xcls || '—', sw.xray?.max6hClass ? `Máx. 6 h: ${esc(sw.xray.max6hClass)}` : 'Rayos X (GOES)', xrayStatus(xcls));

    const speed = sw.windSpeed?.speed ?? h.solarWind;
    setTile('tile-wind', speed ? `${fmt(speed)}` : '—', 'Viento solar · km/s', windStatus(speed));

    const bz = sw.windMag?.bz ?? h.magField;
    setTile('tile-bz', bz !== null && bz !== undefined ? fmt(bz, 1) : '—', `Bz · nT${sw.windMag?.bt != null ? ` · Bt ${fmt(sw.windMag.bt)}` : ''}`, bzStatus(bz));

    setTile('tile-noise', h.signalNoise || '—', `Ruido · Geomag.: ${esc(h.geomagField || '—')}`);

    // Escalas NOAA
    const sc = sw.scales || {};
    $('noaa-scales').innerHTML = ['r', 's', 'g'].map(k => {
        const v = sc[k];
        const names = { r: 'Radio blackout', s: 'Tormenta de radiación', g: 'Tormenta geomagnética' };
        return `<span class="scale st-${scaleLevel(v)}" title="${names[k]}${sc[k + 'Text'] ? ': ' + esc(sc[k + 'Text']) : ''}"><b>${k.toUpperCase()}${v ?? '–'}</b>${esc(names[k])}</span>`;
    }).join('');

    renderBandConditions(h);
    renderVhf(h);
    renderKpChart(sw.kp);
    renderForecast(sc.forecast || []);
    renderXrayChart(sw.xray);

    const upd = h.updated ? `N0NBH ${esc(h.updated)}` : '';
    $('sources-updated').textContent = upd;
}

function renderBandConditions(h) {
    const el = $('band-conditions');
    const bands = h.bands || {};
    const names = Object.keys(bands);
    if (!names.length) { el.innerHTML = '<p class="empty">Sin datos</p>'; return; }
    const hour = new Date().getHours();
    const now = hour >= 7 && hour < 20 ? 'day' : 'night';
    const cell = (c, isNow) => {
        const [lvl, txt] = COND_ES[c] || ['muted', c || '—'];
        return `<td class="${isNow ? 'now' : ''}">${statusChip(lvl, txt)}</td>`;
    };
    el.innerHTML = `<table class="cond">
        <thead><tr><th>Bandas</th><th class="${now === 'day' ? 'now' : ''}">Día${now === 'day' ? ' · ahora' : ''}</th><th class="${now === 'night' ? 'now' : ''}">Noche${now === 'night' ? ' · ahora' : ''}</th></tr></thead>
        <tbody>${names.map(n => `<tr><td class="band-name">${esc(n)}</td>${cell(bands[n].day, now === 'day')}${cell(bands[n].night, now === 'night')}</tr>`).join('')}</tbody>
    </table>
    <div class="cond-extra">MUF: <b>${esc(h.muf || '—')}</b> · Aurora: <b>${fmt(h.aurora)}</b>${h.auroraLat ? ` (lat. ${fmt(h.auroraLat, 1)}°)` : ''} · Protones: <b>${fmt(h.protonFlux)}</b></div>`;
}

function renderVhf(h) {
    const el = $('vhf-conditions');
    const NAMES = {
        'vhf-aurora|northern_hemi': 'Aurora VHF (hem. norte)',
        'E-Skip|europe': 'Es Europa 2 m',
        'E-Skip|europe_6m': 'Es Europa 6 m',
        'E-Skip|europe_4m': 'Es Europa 4 m',
        'E-Skip|north_america': 'Es Norteamérica 2 m'
    };
    const rows = (h.vhf || []).map(p => {
        const open = !/closed/i.test(p.status);
        const label = NAMES[`${p.name}|${p.location}`] || `${p.name} ${p.location}`;
        return `<li><span>${esc(label)}</span>${open ? statusChip('good', p.status) : statusChip('muted', 'Cerrada')}</li>`;
    });
    el.innerHTML = rows.length ? `<ul class="vhf">${rows.join('')}</ul>` : '<p class="empty">Sin datos</p>';
}

function renderForecast(forecast) {
    const el = $('kp-forecast');
    if (!forecast.length) { el.innerHTML = ''; return; }
    el.innerHTML = `<div class="forecast">${forecast.map(f => {
        const d = new Date(`${f.date}T00:00:00Z`).toLocaleDateString('es-ES', { weekday: 'short', day: '2-digit', timeZone: 'UTC' });
        return `<div class="fc"><span class="fc-day">${esc(d)}</span>
            <span class="scale st-${scaleLevel(f.g)}"><b>G${f.g ?? '–'}</b></span>
            <span class="fc-prob" title="Probabilidad de blackout de radio R1-R2 / R3+">R ${fmt(f.rMinorProb)}% / ${fmt(f.rMajorProb)}%</span></div>`;
    }).join('')}</div>`;
}

// --- Actividad (últimos 60 min) ---
function renderActivity(act) {
    const el = $('band-activity');
    const counts = new Map(act.bands.map(b => [b.name, b.count]));
    const bands = BAND_ORDER.filter(b => counts.has(b)).concat(act.bands.map(b => b.name).filter(b => !BAND_ORDER.includes(b)));
    const max = Math.max(1, ...act.bands.map(b => b.count));
    $('activity-total').textContent = `${act.total} spots`;
    el.innerHTML = bands.length ? bands.map(b => {
        const c = counts.get(b);
        const pct = act.total ? Math.round(c / act.total * 100) : 0;
        const label = b === 'OTRO' ? 'Otras' : b;
        return `<div class="hbar" data-tip="<b>${esc(label)}</b><br>${c} spots · ${pct}% del total">
            <span class="hbar-label">${esc(label)}</span>
            <span class="hbar-track"><span class="hbar-fill" style="width:${(c / max * 100).toFixed(1)}%"></span></span>
            <span class="hbar-value">${c}</span></div>`;
    }).join('') : '<p class="empty">Sin spots en la última hora</p>';
    el.querySelectorAll('.hbar').forEach(row => {
        row.onmousemove = (evt) => showTip(evt, row.dataset.tip);
        row.onmouseleave = hideTip;
    });

    const list = (items, isCall) => items.length ? `<ol class="toplist">${items.map(i => `<li>
        ${isCall ? `<a href="https://www.qrz.com/db/${encodeURIComponent(i.name)}" target="_blank" rel="noopener noreferrer">${esc(i.name)}</a>` : `<span>${esc(i.name)}</span>`}
        <b>${i.count}</b></li>`).join('')}</ol>` : '<p class="empty">—</p>';
    $('top-countries').innerHTML = list(act.countries.slice(0, 8), false);
    $('top-calls').innerHTML = list(act.calls.slice(0, 8), true);
}

// --- Estado del cluster ---
function renderHealth(h) {
    const el = $('cluster-status');
    const c = h.dxCluster || {};
    el.className = `pill ${c.connected ? 'online' : 'offline'}`;
    el.textContent = c.connected ? `Cluster: ${c.node} · ${c.host}` : `Cluster desconectado (${c.node})`;
    el.title = c.connected ? `${c.host}:${c.port}` : 'Reconectando…';
}

// --- Relojes ---
function tickClocks() {
    const now = new Date();
    $('clock-utc').textContent = now.toISOString().slice(11, 19);
    $('clock-local').textContent = now.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
    $('clock-date').textContent = now.toLocaleDateString('es-ES', { weekday: 'short', day: '2-digit', month: 'short', timeZone: 'UTC' });
}

// --- Imagen del Sol (NASA SDO) ---
const SUN_IMAGES = {
    '0171': 'AIA 171 Å (corona)',
    'HMIIC': 'HMI (manchas)',
    '0304': 'AIA 304 Å (cromosfera)'
};
let sunImage = '0171';
try { sunImage = localStorage.getItem('dxmonitor-sun') || sunImage; } catch (_) { /* ignore */ }

function renderSun() {
    const img = $('sun-img');
    if (!SUN_IMAGES[sunImage]) sunImage = '0171';
    const slot = Math.floor(Date.now() / SUN_REFRESH_MS);
    img.src = `https://sdo.gsfc.nasa.gov/assets/img/latest/latest_512_${sunImage}.jpg?t=${slot}`;
    img.alt = `Sol en ${SUN_IMAGES[sunImage]}`;
    $('sun-tabs').innerHTML = Object.entries(SUN_IMAGES).map(([k, v]) =>
        `<button class="tab ${k === sunImage ? 'selected' : ''}" data-k="${k}">${esc(v)}</button>`).join('');
    $('sun-tabs').querySelectorAll('button').forEach(b => {
        b.onclick = () => {
            sunImage = b.dataset.k;
            try { localStorage.setItem('dxmonitor-sun', sunImage); } catch (_) { /* ignore */ }
            renderSun();
        };
    });
}

// --- Bucles de actualización ---
function poll(url, render, ms, errEl) {
    const run = async () => {
        try {
            render(await getJson(url));
            if (errEl) $(errEl).hidden = true;
        } catch (err) {
            console.warn(`${url}: ${err.message}`);
            if (errEl) $(errEl).hidden = false;
        }
    };
    run();
    setInterval(run, ms);
}

document.addEventListener('DOMContentLoaded', () => {
    tickClocks();
    setInterval(tickClocks, 1000);
    renderSun();
    setInterval(renderSun, SUN_REFRESH_MS);
    poll('/api/space-weather', renderSpaceWeather, SPACE_WEATHER_POLL_MS, 'sw-error');
    poll('/api/activity', renderActivity, ACTIVITY_POLL_MS);
    poll('/health', renderHealth, HEALTH_POLL_MS);
});
