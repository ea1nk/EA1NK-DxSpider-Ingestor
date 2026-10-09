// activity.js
// Vista /activity: estadísticas de spots a partir de /api/activity?detail=1

const REFRESH_MS = 60 * 1000;
const WINDOWS = [15, 60, 360, 1440];
const BAND_ORDER = ['160m', '80m', '60m', '40m', '30m', '20m', '17m', '15m', '12m', '10m', '6m', '4m', '2m', '70cm', 'OTRO'];
const CONTINENTS = ['EU', 'NA', 'AS', 'SA', 'AF', 'OC', 'AN'];

const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtNum = (n) => Number(n || 0).toLocaleString(LOCALE);
const fmtCompact = (n) => new Intl.NumberFormat(LOCALE, { notation: 'compact', maximumFractionDigits: 1 }).format(n || 0);
const pct = (part, total) => total ? Math.round(part / total * 1000) / 10 : 0;
const hhmm = (ms) => { const d = new Date(ms); return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`; };
const bandLabel = (b) => b === 'OTRO' ? t('act.other') : b;

let minutes = (() => {
    const w = parseInt(new URLSearchParams(location.search).get('w'), 10);
    return WINDOWS.includes(w) ? w : 60;
})();
let data = null;
let loadSeq = 0;

// --- Tooltip compartido ---
const tip = document.createElement('div');
tip.className = 'viz-tip';
tip.hidden = true;
document.addEventListener('DOMContentLoaded', () => document.body.appendChild(tip));

function showTip(evt, html) {
    tip.innerHTML = html;
    tip.hidden = false;
    const r = tip.getBoundingClientRect();
    let x = evt.clientX + 14, y = evt.clientY + 14;
    if (x + r.width > innerWidth - 8) x = evt.clientX - r.width - 14;
    if (y + r.height > innerHeight - 8) y = evt.clientY - r.height - 14;
    tip.style.left = `${x}px`;
    tip.style.top = `${y}px`;
}
const hideTip = () => { tip.hidden = true; };

// --- Escala secuencial de un solo tono (azul): oscuro = pocos, claro = muchos ---
const RAMP = ['#1d2a40', '#24456b', '#2f6aa6', '#4da3ff', '#a9d3ff'];
const hexToRgb = (h) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));

function rampColor(v) {
    const x = Math.max(0, Math.min(1, v)) * (RAMP.length - 1);
    const i = Math.min(RAMP.length - 2, Math.floor(x));
    const f = x - i;
    const a = hexToRgb(RAMP[i]), b = hexToRgb(RAMP[i + 1]);
    return `rgb(${a.map((c, k) => Math.round(c + (b[k] - c) * f)).join(',')})`;
}

// Raíz cuadrada: los recuentos están muy sesgados (20m domina), así se distinguen las bandas flojas
const scale = (count, max) => max ? Math.sqrt(count / max) : 0;
const inkFor = (v) => v > 0.62 ? '#0f111a' : '#e1e1e6';

// --- KPIs ---
function renderKpis(d) {
    $('k-spots').textContent = fmtNum(d.total);
    $('k-spots-sub').textContent = t('av.kpi.spotsSub', { rate: (d.total / d.minutes).toLocaleString(LOCALE, { maximumFractionDigits: 1 }) });
    $('k-calls').textContent = fmtNum(d.uniqueCalls);
    $('k-dxcc').textContent = fmtNum(d.uniqueCountries);
    $('k-spotters').textContent = fmtNum(d.uniqueSpotters);
    const rbnPct = pct(d.rbn, d.total);
    $('k-rbn').textContent = d.total ? `${Math.round(rbnPct)}%` : '—';
    $('k-rbn-sub').textContent = t('av.kpi.rbnSub', { rbn: fmtNum(d.rbn), manual: fmtNum(d.manual) });
    const split = $('k-rbn-split');
    split.querySelector('.a').style.width = `${rbnPct}%`;
    split.querySelector('.b').style.width = `${100 - rbnPct}%`;
    const top = d.bands[0];
    $('k-band').textContent = top ? bandLabel(top.name) : '—';
    $('k-band-sub').textContent = top ? t('av.kpi.topBandSub', { pct: pct(top.count, d.total) }) : '';
}

// Intervalos completos de la ventana (incluye los vacíos)
function buckets(d) {
    const size = d.bucketMinutes * 60000;
    const out = [];
    for (let t0 = Math.floor(d.from / size) * size; t0 <= d.to; t0 += size) out.push(t0);
    return out;
}

function tickEvery(d) {
    return { 15: 5, 60: 15, 360: 60, 1440: 180 }[d.minutes] * 60000;
}

// --- Línea temporal (una serie: el título la nombra, sin leyenda) ---
function renderTimeline(d) {
    const el = $('timeline');
    $('timeline-sub').textContent = t('av.timelineSub', { m: d.bucketMinutes });
    const xs = buckets(d);
    const byT = new Map(d.timeline.map(p => [p.t, p.count]));
    const pts = xs.map(x => ({ t: x, count: byT.get(x) || 0 }));
    if (!d.total) { el.innerHTML = `<p class="empty">${esc(t('av.empty'))}</p>`; return; }

    const W = Math.max(320, Math.round(el.clientWidth || 800)), H = 200, L = 44, R = 12, T = 12, B = 24;
    const pw = W - L - R, ph = H - T - B;
    const rawMax = Math.max(1, ...pts.map(p => p.count));
    const step = Math.pow(10, Math.floor(Math.log10(rawMax)));
    const max = Math.ceil(rawMax / step) * step;
    const x = (i) => L + (pts.length === 1 ? pw / 2 : (i / (pts.length - 1)) * pw);
    const y = (v) => T + ph - (v / max) * ph;

    let grid = '';
    [0, max / 2, max].forEach(v => {
        grid += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${L - 6}" y="${y(v) + 3}" class="axis" text-anchor="end">${fmtCompact(v)}</text>`;
    });
    let ticks = '';
    const every = tickEvery(d);
    pts.forEach((p, i) => { if (p.t % every === 0) ticks += `<text x="${x(i)}" y="${H - 6}" class="axis" text-anchor="middle">${hhmm(p.t)}</text>`; });
    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.count).toFixed(1)}`).join('');
    const area = `${line}L${x(pts.length - 1).toFixed(1)},${T + ph}L${x(0).toFixed(1)},${T + ph}Z`;
    const last = pts.length - 1;
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="${esc(t('av.timelineAria'))}">
        ${grid}${ticks}
        <path d="${area}" class="area"/><path d="${line}" class="line"/>
        <circle cx="${x(last)}" cy="${y(pts[last].count)}" r="4" class="dot"/>
        <line class="cross" y1="${T}" y2="${T + ph}" visibility="hidden"/>
        <circle class="dot hover-dot" r="4" visibility="hidden"/>
        <rect class="hit" x="${L}" y="${T}" width="${pw}" height="${ph}"/>
    </svg>`;
    const svg = el.querySelector('svg');
    const cross = svg.querySelector('.cross'), dot = svg.querySelector('.hover-dot');
    svg.querySelector('.hit').onmousemove = (evt) => {
        const r = svg.getBoundingClientRect();
        const rel = (evt.clientX - r.left) / r.width * W;
        const i = Math.max(0, Math.min(last, Math.round((rel - L) / pw * (pts.length - 1))));
        cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.setAttribute('visibility', 'visible');
        dot.setAttribute('cx', x(i)); dot.setAttribute('cy', y(pts[i].count)); dot.setAttribute('visibility', 'visible');
        showTip(evt, `<b>${hhmm(pts[i].t)}–${hhmm(pts[i].t + d.bucketMinutes * 60000)} UTC</b><br>${fmtNum(pts[i].count)} spots`);
    };
    svg.querySelector('.hit').onmouseleave = () => { cross.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); hideTip(); };
}

// --- Mapa de calor banda × tiempo ---
function presentBands(d) {
    const set = new Set(d.bands.map(b => b.name));
    return BAND_ORDER.filter(b => set.has(b)).concat([...set].filter(b => !BAND_ORDER.includes(b)));
}

function renderHeatmap(d) {
    const el = $('heatmap');
    const bands = presentBands(d);
    if (!bands.length) { el.innerHTML = `<p class="empty">${esc(t('av.empty'))}</p>`; $('heatmap-table').innerHTML = ''; return; }
    const xs = buckets(d);
    const col = new Map(xs.map((x, i) => [x, i]));
    const grid = new Map();
    d.bandTime.forEach(c => grid.set(`${c.band}|${c.t}`, c.count));
    const max = Math.max(1, ...d.bandTime.map(c => c.count));
    const totals = new Map(d.bands.map(b => [b.name, b.count]));

    const W = Math.max(640, Math.round(el.clientWidth || 800));
    const L = 50, R = 56, T = 6, B = 22, rowH = 22;
    const H = T + bands.length * rowH + B;
    const cw = (W - L - R) / xs.length;
    let cells = '', labels = '', ticks = '';
    const every = tickEvery(d);
    bands.forEach((band, r) => {
        const yy = T + r * rowH;
        labels += `<text x="${L - 8}" y="${yy + rowH / 2 + 4}" class="axis band" text-anchor="end">${esc(bandLabel(band))}</text>`;
        labels += `<text x="${W - R + 8}" y="${yy + rowH / 2 + 4}" class="axis">${fmtCompact(totals.get(band))}</text>`;
        xs.forEach((x, c) => {
            const v = grid.get(`${band}|${x}`) || 0;
            const fill = v ? rampColor(scale(v, max)) : '#181b24';
            cells += `<rect class="cell" data-b="${esc(band)}" data-c="${c}" x="${(L + c * cw).toFixed(1)}" y="${yy}" width="${cw.toFixed(1)}" height="${rowH}" rx="2" fill="${fill}"/>`;
        });
    });
    xs.forEach((x, c) => { if (x % every === 0) ticks += `<text x="${(L + c * cw + cw / 2).toFixed(1)}" y="${H - 6}" class="axis" text-anchor="middle">${hhmm(x)}</text>`; });
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" class="chart" style="min-width:${W}px" role="img" aria-label="${esc(t('av.heatmapAria'))}">${cells}${labels}${ticks}</svg>`;
    $('ramp').style.background = `linear-gradient(90deg, ${RAMP.join(',')})`;

    const svg = el.querySelector('svg');
    svg.onmousemove = (evt) => {
        const cell = evt.target.closest('.cell');
        svg.querySelectorAll('.cell.hover').forEach(c => c.classList.remove('hover'));
        if (!cell) return hideTip();
        cell.classList.add('hover');
        const x0 = xs[cell.dataset.c];
        const v = grid.get(`${cell.dataset.b}|${x0}`) || 0;
        showTip(evt, `<b>${esc(bandLabel(cell.dataset.b))}</b> · ${hhmm(x0)}–${hhmm(x0 + d.bucketMinutes * 60000)} UTC<br>${fmtNum(v)} spots`);
    };
    svg.onmouseleave = () => { svg.querySelectorAll('.cell.hover').forEach(c => c.classList.remove('hover')); hideTip(); };

    // Vista de tabla (los mismos datos, accesibles sin color)
    $('heatmap-table').innerHTML = `<table class="data"><thead><tr><th>${esc(t('av.band'))}</th>${xs.map(x => `<th>${hhmm(x)}</th>`).join('')}<th>${esc(t('av.total'))}</th></tr></thead>
        <tbody>${bands.map(b => `<tr><td>${esc(bandLabel(b))}</td>${xs.map(x => `<td>${grid.get(`${b}|${x}`) || ''}</td>`).join('')}<td><b>${fmtNum(totals.get(b))}</b></td></tr>`).join('')}</tbody></table>`;
}

// --- Barras horizontales (bandas y modos) ---
function renderBars(elId, items, total, labelFn = (n) => n) {
    const el = $(elId);
    if (!items.length) { el.innerHTML = `<p class="empty">${esc(t('av.empty'))}</p>`; return; }
    const max = Math.max(...items.map(i => i.count));
    el.innerHTML = items.map(i => `<div class="hbar" data-tip="<b>${esc(labelFn(i.name))}</b><br>${fmtNum(i.count)} spots · ${esc(t('av.share', { pct: pct(i.count, total) }))}">
        <span class="hbar-label">${esc(labelFn(i.name))}</span>
        <span class="hbar-track"><span class="hbar-fill" style="width:${(i.count / max * 100).toFixed(1)}%"></span></span>
        <span class="hbar-value">${fmtCompact(i.count)}<small>${pct(i.count, total)}%</small></span>
    </div>`).join('');
    el.querySelectorAll('.hbar').forEach(row => {
        row.onmousemove = (evt) => showTip(evt, row.dataset.tip);
        row.onmouseleave = hideTip;
    });
}

// --- Matriz de continentes ---
function renderPaths(d) {
    const el = $('paths');
    if (!d.continents.length) { el.innerHTML = `<p class="empty">${esc(t('av.empty'))}</p>`; return; }
    const present = new Set(d.continents.flatMap(c => [c.from, c.to]));
    const conts = CONTINENTS.filter(c => present.has(c));
    const val = new Map(d.continents.map(c => [`${c.from}|${c.to}`, c.count]));
    const max = Math.max(...d.continents.map(c => c.count));
    el.innerHTML = `<table class="matrix">
        <thead><tr><th class="corner">${esc(t('av.pathsFrom'))} ↓ · ${esc(t('av.pathsTo'))} →</th>${conts.map(c => `<th title="${esc(t(`cont.${c}`))}">${c}</th>`).join('')}</tr></thead>
        <tbody>${conts.map(from => `<tr><th class="row" title="${esc(t(`cont.${from}`))}">${from}</th>${conts.map(to => {
            const v = val.get(`${from}|${to}`) || 0;
            const s = scale(v, max);
            return `<td data-from="${from}" data-to="${to}" data-v="${v}" style="background:${v ? rampColor(s) : '#181b24'};color:${v ? inkFor(s) : '#555'}">${v ? fmtCompact(v) : '·'}</td>`;
        }).join('')}</tr>`).join('')}</tbody></table>`;
    el.querySelectorAll('td[data-from]').forEach(td => {
        td.onmousemove = (evt) => showTip(evt, `<b>${esc(t('av.pathsTip', { from: t(`cont.${td.dataset.from}`), to: t(`cont.${td.dataset.to}`) }))}</b><br>${fmtNum(td.dataset.v)} spots · ${esc(t('av.share', { pct: pct(+td.dataset.v, d.total) }))}`);
        td.onmouseleave = hideTip;
    });
}

// --- Rankings ---
const flag = (adif) => adif ? `<img class="flag" src="/flags/${encodeURIComponent(adif)}.svg" alt="" onerror="this.style.visibility='hidden'">` : '<span class="flag"></span>';

function renderRank(elId, items, render) {
    const el = $(elId);
    if (!items.length) { el.innerHTML = `<li class="empty">${esc(t('av.empty'))}</li>`; return; }
    const max = items[0].count;
    el.innerHTML = items.map((it, i) => `<li>
        <span class="pos">${i + 1}</span>${flag(it.adif)}
        <span class="name">${render(it)}<span class="bar"><i style="width:${(it.count / max * 100).toFixed(1)}%"></i></span></span>
        <span class="count">${fmtNum(it.count)}</span>
    </li>`).join('');
}

const qrz = (call) => `<a href="https://www.qrz.com/db/${encodeURIComponent(call.replace(/-#$/, ''))}" target="_blank" rel="noopener noreferrer">${esc(call)}</a>`;
const BAND_INDEX = new Map(BAND_ORDER.map((b, i) => [b, i]));

function renderLists(d) {
    renderRank('countries', d.countries, it => `<b>${esc(it.name)}</b><span class="sub">${esc(t(`cont.${it.continent}`))} · ${esc(t('av.share', { pct: pct(it.count, d.total) }))}</span>`);
    renderRank('calls', d.calls, it => `<b>${qrz(it.name)}</b><span class="sub">${esc(it.country || '')} ${(it.bands || []).sort((a, b) => (BAND_INDEX.get(a) ?? 99) - (BAND_INDEX.get(b) ?? 99)).map(b => `<span class="bchip">${esc(bandLabel(b))}</span>`).join('')}</span>`);
    renderRank('spotters', d.spotters, it => `<b>${qrz(it.name)}</b><span class="sub">${esc(it.country || '')}${it.name.endsWith('-#') ? ' · RBN' : ''}</span>`);
    $('sources-card').hidden = d.sources.length < 2;
    if (d.sources.length >= 2) renderBars('sources', d.sources, d.total);
}

// --- Carga y estado ---
function renderAll() {
    if (!data) return;
    renderKpis(data);
    renderTimeline(data);
    renderHeatmap(data);
    renderBars('bands', presentBands(data).map(b => data.bands.find(x => x.name === b)), data.total, bandLabel);
    renderBars('modes', data.modes, data.total);
    renderPaths(data);
    renderLists(data);
    const ago = Math.max(0, Math.round((Date.now() - data.generatedAt) / 1000));
    $('meta-text').textContent = `${t('av.updated', { t: ago < 60 ? `${ago} s` : `${Math.round(ago / 60)} min` })} · ${t('av.refresh', { s: REFRESH_MS / 1000 })}`;
}

async function load() {
    const seq = ++loadSeq;
    $('meta').classList.add('loading');
    try {
        const res = await fetch(`/api/activity?detail=1&minutes=${minutes}`, { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const d = await res.json();
        if (seq !== loadSeq) return; // Llegó tarde: el usuario ya cambió de periodo
        data = d;
        $('error').hidden = true;
        renderAll();
    } catch (err) {
        if (seq === loadSeq) $('error').hidden = false;
    } finally {
        if (seq === loadSeq) $('meta').classList.remove('loading');
    }
}

function setWindow(m) {
    minutes = m;
    document.querySelectorAll('#window-switch button').forEach(b => b.setAttribute('aria-pressed', +b.dataset.min === m ? 'true' : 'false'));
    const url = new URL(location.href);
    url.searchParams.set('w', m);
    history.replaceState(null, '', url);
    $('meta-text').textContent = t('av.loading');
    load();
}

document.addEventListener('DOMContentLoaded', () => {
    $('window-switch').setAttribute('aria-label', t('av.window'));
    document.querySelectorAll('#window-switch button').forEach(b => { b.onclick = () => setWindow(+b.dataset.min); });
    setWindow(minutes);
    setInterval(load, REFRESH_MS);
    // Redibujar al cambiar el ancho (los gráficos se dibujan al tamaño real)
    let rt;
    addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(renderAll, 200); });
});
