// monitor.js
// Lógica de spots y filtros para DX Monitor Live

// --- Configuración de filtros y persistencia ---
const FILTERS_KEY = 'dxmonitor-filtros';

const BANDAS = [
    '160m','80m','60m','40m','30m','20m','17m','15m','12m','10m','6m'
];

const MODOS = [
    'CW', 'SSB', 'FT8', 'FT4', 'RTTY', 'PSK', 'DIGI'
];
const TIPOS = ['RBN', 'TRAD'];
const QSL_FILTERS = ['LoTW', 'eQSL'];

let filtros = {
    bandas: [...BANDAS],
    modos: [...MODOS],
    tipos: [...TIPOS],
    qsl: [],
    indicativos: []
};

function guardarFiltros() {
    localStorage.setItem(FILTERS_KEY, JSON.stringify(filtros));
}
function cargarFiltros() {
    const data = localStorage.getItem(FILTERS_KEY);
    if (data) {
        try {
            const loaded = JSON.parse(data);
            const loadedQsl = Array.isArray(loaded.qsl)
                ? loaded.qsl.filter((q) => QSL_FILTERS.includes(q))
                : [];
            filtros = {
                bandas: loaded.bandas || [...BANDAS],
                modos: loaded.modos || [...MODOS],
                tipos: loaded.tipos || [...TIPOS],
                qsl: loadedQsl,
                indicativos: loaded.indicativos || []
            };
        } catch {}
    }
}

function isTruthyQsl(value) {
    if (typeof value === 'string') {
        return value.toLowerCase() === 'true';
    }
    return !!value;
}

function getNormalizedActiveQslFilters() {
    const raw = Array.isArray(filtros.qsl) ? filtros.qsl : [];
    const valid = raw.filter((q) => QSL_FILTERS.includes(q));
    return [...new Set(valid)];
}

function getSpotQslFlags(spot) {
    return {
        hasLotw: isTruthyQsl(spot?.cty?.spotted?.lotw),
        hasEqsl: isTruthyQsl(spot?.cty?.spotted?.eqsl),
    };
}

// --- Lógica de buffer y renderizado de spots ---
const MAX_SPOTS = 30;
const SPOT_BUFFER = 200;
let spotBuffer = [];

function filtrarSpots() {
    return spotBuffer.filter(spot => {
        const bandMatch = filtros.bandas.length === 0 || filtros.bandas.includes(spot.band);
        let modeMatch = true;
        if (filtros.modos.length > 0) {
            const DIGI_MODES = ['FT8', 'FT4', 'RTTY', 'PSK', 'WSPR', 'JT65', 'JT9', 'OLIVIA', 'FSK', 'MFSK', 'PSK31', 'PSK63', 'ROS', 'PACKET', 'HELL', 'DOMINO', 'THOR', 'THROB', 'MT63', 'SSTV', 'FAX', 'FSK441', 'MSK144', 'FT8CALL', 'JS8', 'Q65', 'QRA64', 'T10', 'DIGI'];
            if (filtros.modos.includes('DIGI')) {
                if (DIGI_MODES.includes(spot.mode) && !filtros.modos.includes(spot.mode)) {
                    modeMatch = true;
                } else if (filtros.modos.includes(spot.mode)) {
                    modeMatch = true;
                } else {
                    modeMatch = false;
                }
            } else {
                modeMatch = filtros.modos.includes(spot.mode);
            }
        }
        // Filtro de origen RBN/TRAD
        let tipoMatch = true;
        if (filtros.tipos && filtros.tipos.length > 0 && filtros.tipos.length < 2) {
            if (filtros.tipos.includes('RBN')) {
                tipoMatch = !!spot.rbn;
            } else if (filtros.tipos.includes('TRAD')) {
                tipoMatch = !spot.rbn;
            }
        }
        // Filtro LoTW/eQSL
        let qslMatch = true;
        const activeQsl = getNormalizedActiveQslFilters();
        if (activeQsl.length > 0) {
            const { hasLotw, hasEqsl } = getSpotQslFlags(spot);

            if (activeQsl.length === 1) {
                qslMatch = activeQsl[0] === 'LoTW' ? hasLotw : hasEqsl;
            } else {
                qslMatch = hasLotw || hasEqsl;
            }
        }
        const callMatch = filtros.indicativos.length === 0 || filtros.indicativos.some(call => spot.spotted.toLowerCase().includes(call.toLowerCase()));
        return bandMatch && modeMatch && tipoMatch && qslMatch && callMatch;
    });
}


function renderSpots() {
    const spotList = document.getElementById('spot-list');
    spotList.innerHTML = '';
    const filtrados = filtrarSpots();
    filtrados.slice(0, MAX_SPOTS).forEach(spot => {
        spotList.appendChild(crearSpotRow(spot));
    });
    const count = document.getElementById('spots-count');
    if (count) {
        count.textContent = `${filtrados.length} de ${spotBuffer.length} spots`;
        count.title = `Se muestran los ${MAX_SPOTS} más recientes que cumplen los filtros`;
    }
}

// Los textos vienen del cluster: escapar siempre antes de insertarlos como HTML
const escHtml = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function crearSpotRow(spot) {
    const row = document.createElement('tr');
    row.dataset.band = spot.band;
    row.dataset.mode = spot.mode;
    row.dataset.type = spot.rbn ? 'rbn' : 'trad';
    row.dataset.call = spot.spotted.toLowerCase();
    const adif = spot.cty?.spotted?.data?.ADIF;
    const flagImg = adif ? `<img src="/flags/${encodeURIComponent(adif)}.svg" class="flag" alt="" onerror="this.style.visibility='hidden'">` : '<span class="flag-empty"></span>';
    const { hasLotw, hasEqsl } = getSpotQslFlags(spot);
    const timeZ = spot.time_z ? `${spot.time_z.slice(0, 2)}:${spot.time_z.slice(2, 4)}` : '';
    const country = spot.cty?.spotted?.data?.Country || 'Unknown';
    const info = spot.snr ? `<span class="snr">${escHtml(spot.snr)} dB</span>` : `<i>${escHtml(spot.comment)}</i>`;
    row.innerHTML = `
        <td class="time-col">${escHtml(timeZ)}</td>
        <td><span class="freq">${spot.freq.toFixed(1)}</span><span class="band">${escHtml(spot.band)}</span></td>
        <td><div class="dx">${flagImg}<span class="badge ${spot.rbn ? 'rbn-type':'trad-type'}">${spot.rbn ? 'RBN':'TRAD'}</span><span class="callsign" title="Doble clic para abrir en QRZ" style="cursor:pointer;">${escHtml(spot.spotted)}</span><span class="country" title="${escHtml(country)}">${escHtml(country)}</span></div></td>
        <td><span class="mode-label mode-${escHtml(spot.mode)}">${escHtml(spot.mode)}</span></td>
        <td><span class="qsl-label ${hasLotw ? 'selected' : 'desactivado'}">LoTW</span><span class="qsl-label ${hasEqsl ? 'selected' : 'desactivado'}">eQSL</span></td>
        <td><span class="spotter">${escHtml(spot.spotter)}</span><span class="spotter-country">${escHtml(spot.cty?.spotter?.data?.Country || '')}</span></td>
        <td class="info" title="${escHtml(spot.comment)}">${info}</td>
    `;

    const callsignEl = row.querySelector('.callsign');
    if (callsignEl) {
        callsignEl.addEventListener('dblclick', () => {
            const targetCall = encodeURIComponent((spot.spotted || '').toUpperCase());
            if (!targetCall) return;
            window.open(`https://www.qrz.com/db/${targetCall}`, '_blank', 'noopener,noreferrer');
        });
    }

    return row;
}

// --- WebSocket y actualización de spots ---
// The server sends a heartbeat every 30s; silence longer than this means a dead connection
const WS_WATCHDOG_MS = 75000;
const spotKey = s => `${s.spotter}|${s.spotted}|${s.freq}|${s.timestamp}`;

// Merge the server's recent history, skipping spots already on screen
function mergeHistory(spots) {
    const known = new Set(spotBuffer.map(spotKey));
    const nuevos = spots.filter(s => s.spotted && !known.has(spotKey(s)));
    if (!nuevos.length) return;
    spotBuffer = spotBuffer.concat(nuevos)
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
        .slice(0, SPOT_BUFFER);
    renderSpots();
}

function conectarWS() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    const status = document.getElementById('status');
    let socket = new WebSocket(wsUrl);
    let watchdog;
    let cerrado = false;

    const reconectar = () => {
        if (cerrado) return;
        cerrado = true;
        clearTimeout(watchdog);
        status.innerText = 'OFFLINE'; status.className = 'offline';
        try { socket.close(); } catch (_) { /* ignore */ }
        setTimeout(conectarWS, 2000);
    };
    const resetWatchdog = () => {
        clearTimeout(watchdog);
        watchdog = setTimeout(reconectar, WS_WATCHDOG_MS);
    };

    socket.onopen = () => { status.innerText = 'ONLINE'; status.className = 'online'; resetWatchdog(); };
    socket.onclose = reconectar;
    socket.onmessage = (event) => {
        resetWatchdog();
        const msg = JSON.parse(event.data);
        if (msg.type === 'history') return mergeHistory(msg.spots || []);
        if (!msg.spotted) return;
        spotBuffer.unshift(msg);
        if (spotBuffer.length > SPOT_BUFFER) spotBuffer.pop();
        renderSpots();
    };
}

// --- UI de filtros ---
function crearBotonFiltro(texto, activo, onClick, claseExtra = '', tipo = 'modo') {
    const btn = document.createElement('button');
    if (tipo === 'banda') {
        btn.className = 'banda-label' + (activo ? ' selected' : ' desactivado');
    } else {
        btn.className = `mode-label ${claseExtra}`;
    }
    btn.style.opacity = activo ? '1' : '0.3';
    btn.setAttribute('aria-pressed', activo ? 'true' : 'false');
    btn.textContent = texto;
    btn.onclick = onClick;
    return btn;
}

// Una lista vacía o completa equivale a "sin filtro" en filtrarSpots()
const restringe = (lista, total) => lista.length > 0 && lista.length < total;

function aplicarFiltros() {
    guardarFiltros();
    renderPanelFiltros();
    renderSpots();
}

function toggleEn(lista, valor) {
    return lista.includes(valor) ? lista.filter(v => v !== valor) : [...lista, valor];
}

function crearGrupo(titulo, acciones) {
    const group = document.createElement('div');
    group.className = 'fgroup';
    const head = document.createElement('div');
    head.className = 'fgroup-head';
    head.innerHTML = `<b>${titulo}</b>`;
    if (acciones) {
        const span = document.createElement('span');
        acciones.forEach(([texto, fn]) => {
            const b = document.createElement('button');
            b.className = 'link-btn';
            b.textContent = texto;
            b.onclick = fn;
            span.appendChild(b);
        });
        head.appendChild(span);
    }
    const body = document.createElement('div');
    body.className = 'fgroup-body';
    group.append(head, body);
    return { group, body };
}

// Resumen de los filtros activos en la barra (visible aunque el panel esté cerrado)
function renderResumenFiltros() {
    const resumen = document.getElementById('filtros-resumen');
    const badge = document.getElementById('filtros-badge');
    const reset = document.getElementById('filtros-reset');
    const lista = (items, max = 4) => items.length > max ? `${items.slice(0, max).join(', ')} +${items.length - max}` : items.join(', ');
    const chips = [];
    if (restringe(filtros.bandas, BANDAS.length)) chips.push(`Bandas: <b>${escHtml(lista(BANDAS.filter(b => filtros.bandas.includes(b))))}</b>`);
    if (restringe(filtros.modos, MODOS.length)) chips.push(`Modos: <b>${escHtml(lista(MODOS.filter(m => filtros.modos.includes(m))))}</b>`);
    if (filtros.tipos.length === 1) chips.push(`Solo <b>${escHtml(filtros.tipos[0])}</b>`);
    if (filtros.qsl.length) chips.push(`QSL: <b>${escHtml(filtros.qsl.join(' o '))}</b>`);
    if (filtros.indicativos.length) chips.push(`Indicativos: <b>${escHtml(lista(filtros.indicativos, 3))}</b>`);
    resumen.innerHTML = chips.length
        ? chips.map(c => `<span class="fsum">${c}</span>`).join('')
        : '<span class="fsum none">Sin filtros: se muestra todo</span>';
    badge.hidden = chips.length === 0;
    badge.textContent = chips.length;
    reset.hidden = chips.length === 0;
}

function renderPanelFiltros() {
    renderResumenFiltros();
    const panel = document.getElementById('filtros-panel');
    panel.innerHTML = '';

    // Bandas
    const bandas = crearGrupo('Bandas', [['Todas', () => { filtros.bandas = [...BANDAS]; aplicarFiltros(); }]]);
    BANDAS.forEach(banda => bandas.body.appendChild(crearBotonFiltro(banda, filtros.bandas.includes(banda), () => {
        filtros.bandas = toggleEn(filtros.bandas, banda);
        aplicarFiltros();
    }, '', 'banda')));

    // Modos
    const modos = crearGrupo('Modos', [['Todos', () => { filtros.modos = [...MODOS]; aplicarFiltros(); }]]);
    MODOS.forEach(modo => modos.body.appendChild(crearBotonFiltro(modo, filtros.modos.includes(modo), () => {
        filtros.modos = toggleEn(filtros.modos, modo);
        aplicarFiltros();
    }, `mode-${modo}`)));

    // Origen y QSL en un mismo grupo
    const origen = crearGrupo('Origen y QSL');
    TIPOS.forEach(tipo => origen.body.appendChild(crearBotonFiltro(tipo, filtros.tipos.includes(tipo), () => {
        filtros.tipos = toggleEn(filtros.tipos, tipo);
        aplicarFiltros();
    }, '', 'banda')));
    const sep = document.createElement('span');
    sep.style.width = '10px';
    origen.body.appendChild(sep);
    QSL_FILTERS.forEach(qsl => origen.body.appendChild(crearBotonFiltro(qsl, filtros.qsl.includes(qsl), () => {
        filtros.qsl = toggleEn(filtros.qsl, qsl);
        aplicarFiltros();
    }, '', 'banda')));
    const hint = document.createElement('div');
    hint.className = 'fhint';
    hint.style.width = '100%';
    hint.textContent = 'QSL: muestra solo estaciones que usan LoTW / eQSL.';
    origen.body.appendChild(hint);

    // Indicativos monitorizados
    const calls = crearGrupo('Indicativos', filtros.indicativos.length ? [['Quitar todos', () => { filtros.indicativos = []; aplicarFiltros(); }]] : null);
    const form = document.createElement('form');
    form.className = 'call-input';
    form.innerHTML = '<input type="text" id="input-indicativo" placeholder="Ej. EA1NK, VP8…" autocomplete="off"><button type="submit" class="banda-label">Añadir</button>';
    form.onsubmit = (e) => {
        e.preventDefault();
        const input = form.querySelector('input');
        // Admite varios separados por comas o espacios
        const nuevos = input.value.toUpperCase().split(/[\s,;]+/).filter(Boolean)
            .filter(c => !filtros.indicativos.includes(c));
        if (nuevos.length) {
            filtros.indicativos = [...filtros.indicativos, ...nuevos];
            aplicarFiltros();
            document.getElementById('input-indicativo')?.focus();
        }
        input.value = '';
    };
    calls.body.appendChild(form);
    if (filtros.indicativos.length === 0) {
        const vacio = document.createElement('span');
        vacio.className = 'fhint';
        vacio.textContent = 'Ninguno: se muestran todos los indicativos.';
        calls.body.appendChild(vacio);
    }
    filtros.indicativos.forEach(call => {
        const chip = document.createElement('span');
        chip.className = 'call-chip';
        chip.innerHTML = `${escHtml(call)}<button type="button" aria-label="Quitar ${escHtml(call)}">×</button>`;
        chip.querySelector('button').onclick = () => {
            filtros.indicativos = filtros.indicativos.filter(c => c !== call);
            aplicarFiltros();
        };
        calls.body.appendChild(chip);
    });

    panel.append(bandas.group, modos.group, origen.group, calls.group);
}

// --- Panel desplegable (recuerda si estaba abierto) ---
const FILTERS_OPEN_KEY = 'dxmonitor-filtros-abierto';

function setupColapsable() {
    const toggle = document.getElementById('filtros-toggle');
    const panel = document.getElementById('filtros-panel');
    let abierto = false;
    try { abierto = localStorage.getItem(FILTERS_OPEN_KEY) === '1'; } catch (_) { /* ignore */ }
    const aplicar = () => {
        panel.hidden = !abierto;
        toggle.setAttribute('aria-expanded', abierto ? 'true' : 'false');
        try { localStorage.setItem(FILTERS_OPEN_KEY, abierto ? '1' : '0'); } catch (_) { /* ignore */ }
    };
    toggle.onclick = () => { abierto = !abierto; aplicar(); };
    document.getElementById('filtros-reset').onclick = () => {
        filtros = { bandas: [...BANDAS], modos: [...MODOS], tipos: [...TIPOS], qsl: [], indicativos: [] };
        aplicarFiltros();
    };
    aplicar();
}

// --- Inicialización ---
document.addEventListener('DOMContentLoaded', () => {
    cargarFiltros();
    renderPanelFiltros();
    setupColapsable();
    conectarWS();
    renderSpots();
});
