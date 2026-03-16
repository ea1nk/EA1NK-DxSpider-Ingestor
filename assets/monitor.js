// monitor.js
// Lógica de spots y filtros para DX Monitor Live

// --- Configuración de filtros y persistencia ---
const FILTERS_KEY = 'dxmonitor-filtros';

const BANDAS = [
    '160m','80m','40m','30m','20m','17m','15m','12m','10m','6m'
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

// --- Lógica de buffer y renderizado de spots ---
const MAX_SPOTS = 15;
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
        if (filtros.qsl && filtros.qsl.length > 0) {
            const hasLotw = isTruthyQsl(spot.cty?.spotted?.lotw);
            const hasEqsl = isTruthyQsl(spot.cty?.spotted?.eqsl);

            if (filtros.qsl.length === 1) {
                qslMatch = filtros.qsl.includes('LoTW') ? hasLotw : hasEqsl;
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
    filtrarSpots().slice(0, MAX_SPOTS).forEach(spot => {
        spotList.appendChild(crearSpotRow(spot));
    });
}

function crearSpotRow(spot) {
    const row = document.createElement('tr');
    row.dataset.band = spot.band;
    row.dataset.mode = spot.mode;
    row.dataset.type = spot.rbn ? 'rbn' : 'trad';
    row.dataset.call = spot.spotted.toLowerCase();
    const adif = spot.cty?.spotted?.data?.ADIF;
    const flagImg = adif ? `<img src="/flags/${adif}.svg" class="flag" onerror="this.style.display='none'">` : '<div style="width:35px"></div>';
    row.innerHTML = `
        <td><span class="freq">${spot.freq.toFixed(1)}</span><br><span class="band">${spot.band}</span></td>
        <td><div style="display:flex; align-items:center; gap:15px">${flagImg}<div><span class="badge ${spot.rbn ? 'rbn-type':'trad-type'}">${spot.rbn ? 'RBN':'TRAD'}</span><span class="callsign" title="Doble clic para abrir en QRZ" style="cursor:pointer;">${spot.spotted}</span><br><span class="country">${spot.cty?.spotted?.data?.Country || 'Unknown'}</span></div></div></td>
        <td><span class="mode-label mode-${spot.mode}">${spot.mode}</span></td>
        <td>
            <span class="qsl-label ${isTruthyQsl(spot.cty?.spotted?.lotw) ? 'selected' : 'desactivado'}">LoTW</span>
            <span class="qsl-label ${isTruthyQsl(spot.cty?.spotted?.eqsl) ? 'selected' : 'desactivado'}">eQSL</span></td>
        <td><strong>${spot.spotter}</strong><br><small style="color:#666">${spot.cty?.spotter?.data?.Country || ''}</small></td>
        <td style="color:#ccc; font-size:0.9rem">${spot.snr ? '<b style="color:#00ff7f">'+spot.snr+' dB</b>' : '<i>'+spot.comment+'</i>'}</td>
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
function conectarWS() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    const status = document.getElementById('status');
    let socket = new WebSocket(wsUrl);
    socket.onopen = () => { status.innerText = 'ONLINE'; status.className = 'online'; };
    socket.onclose = () => { status.innerText = 'OFFLINE'; status.className = 'offline'; setTimeout(conectarWS, 2000); };
    socket.onmessage = (event) => {
        const spot = JSON.parse(event.data);
        if (!spot.spotted) return;
        spotBuffer.unshift(spot);
        if (spotBuffer.length > SPOT_BUFFER) spotBuffer.pop();
        renderSpots();
    };
}

// --- UI de filtros ---
function crearBotonFiltro(texto, activo, onClick, claseExtra = '', tipo = 'modo') {
    const btn = document.createElement('button');
    if (tipo === 'banda') {
        btn.className = 'banda-label' + (activo ? ' selected' : ' desactivado');
        btn.style.opacity = activo ? '1' : '0.3';
    } else {
        btn.className = `mode-label ${claseExtra}`;
        btn.style.opacity = activo ? '1' : '0.3';
    }
    btn.textContent = texto;
    btn.onclick = onClick;
    return btn;
}

function renderPanelFiltros() {
    const panel = document.getElementById('filtros-panel');
    panel.innerHTML = '';
    const row = document.createElement('div');
    row.className = 'filtros-row';
    // Bandas
    const bandasDiv = document.createElement('div');
    bandasDiv.innerHTML = '<b>Bandas:</b> ';
    BANDAS.forEach(banda => {
        bandasDiv.appendChild(
            crearBotonFiltro(
                banda,
                filtros.bandas.includes(banda),
                () => {
                    if (filtros.bandas.includes(banda)) filtros.bandas = filtros.bandas.filter(b => b !== banda);
                    else filtros.bandas.push(banda);
                    guardarFiltros();
                    renderPanelFiltros();
                    renderSpots();
                },
                '',
                'banda'
            )
        );
    });
    row.appendChild(bandasDiv);
    // Modos
    const modosDiv = document.createElement('div');
    modosDiv.innerHTML = '<b>Modos:</b> ';
    MODOS.forEach(modo => {
        modosDiv.appendChild(
            crearBotonFiltro(
                modo,
                filtros.modos.includes(modo),
                () => {
                    if (filtros.modos.includes(modo)) filtros.modos = filtros.modos.filter(m => m !== modo);
                    else filtros.modos.push(modo);
                    guardarFiltros();
                    renderPanelFiltros();
                    renderSpots();
                },
                `mode-${modo}`
            )
        );
    });
    row.appendChild(modosDiv);
    // Tipos (RBN/TRAD)
    const tiposDiv = document.createElement('div');
    tiposDiv.innerHTML = '<b>Origen:</b> ';
    TIPOS.forEach(tipo => {
        tiposDiv.appendChild(
            crearBotonFiltro(
                tipo,
                filtros.tipos.includes(tipo),
                () => {
                    if (filtros.tipos.includes(tipo)) filtros.tipos = filtros.tipos.filter(t => t !== tipo);
                    else filtros.tipos.push(tipo);
                    guardarFiltros();
                    renderPanelFiltros();
                    renderSpots();
                },
                '', // sin clase extra
                'banda' // usar estilo banda-label
            )
        );
    });
    row.appendChild(tiposDiv);
    // QSL (LoTW/eQSL)
    const qslDiv = document.createElement('div');
    qslDiv.innerHTML = '<b>QSL:</b> ';
    QSL_FILTERS.forEach(qsl => {
        qslDiv.appendChild(
            crearBotonFiltro(
                qsl,
                filtros.qsl.includes(qsl),
                () => {
                    if (filtros.qsl.includes(qsl)) filtros.qsl = filtros.qsl.filter(q => q !== qsl);
                    else filtros.qsl.push(qsl);
                    guardarFiltros();
                    renderPanelFiltros();
                    renderSpots();
                },
                '',
                'banda'
            )
        );
    });
    row.appendChild(qslDiv);
    // Indicativos
    const indicativosDiv = document.createElement('div');
    indicativosDiv.innerHTML = '<b>Indicativos:</b> ';
    // Input para añadir
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Añadir indicativo...';
    input.id = 'input-indicativo';
    indicativosDiv.appendChild(input);
    const addBtn = document.createElement('button');
    addBtn.textContent = 'Monitorizar';
    addBtn.style.marginLeft = '5px';
    addBtn.className = 'banda-label';
    addBtn.onclick = () => {
        const val = input.value.trim().toUpperCase();
        if (val && !filtros.indicativos.includes(val)) {
            filtros.indicativos.push(val);
            guardarFiltros();
            renderPanelFiltros();
            renderSpots();
        }
        input.value = '';
    };
    indicativosDiv.appendChild(addBtn);
    // Botones de indicativos ahora van en el contenedor externo
    row.appendChild(indicativosDiv);
    panel.appendChild(row);

    // Renderizar los indicativos en el nuevo contenedor externo
    const contenedor = document.getElementById('indicativos-contenedor');
    if (contenedor) {
        contenedor.innerHTML = '';
        if (filtros.indicativos.length === 0) {
            contenedor.innerHTML = '<span style="color:#888;">No hay indicativos monitorizados.</span>';
        } else {
            filtros.indicativos.forEach(call => {
                contenedor.appendChild(
                    crearBotonFiltro(
                        call,
                        true,
                        () => {
                            filtros.indicativos = filtros.indicativos.filter(c => c !== call);
                            guardarFiltros();
                            renderPanelFiltros();
                            renderSpots();
                        },
                        'mode-CW'
                    )
                );
            });
        }
    }
}

// --- Panel colapsable ---
function setupColapsable() {
    const toggle = document.getElementById('filtros-toggle');
    const panel = document.getElementById('filtros-panel');
    const text = document.getElementById('filtros-toggle-text');
    const icon = document.getElementById('filtros-toggle-icon');
    let abierto = false;
    const contenedor = document.getElementById('indicativos-contenedor');
    toggle.onclick = () => {
        abierto = !abierto;
        panel.style.display = abierto ? 'block' : 'none';
        if (contenedor) contenedor.style.display = abierto ? 'block' : 'none';
        text.textContent = abierto ? 'Ocultar filtros' : 'Mostrar filtros';
        icon.textContent = abierto ? '▲' : '▼';
    };
    panel.style.display = 'none';
    if (contenedor) contenedor.style.display = 'none';
    text.textContent = 'Mostrar filtros';
    icon.textContent = '▼';
}

// --- Inicialización ---
document.addEventListener('DOMContentLoaded', () => {
    cargarFiltros();
    renderPanelFiltros();
    setupColapsable();
    conectarWS();
    renderSpots();
});
