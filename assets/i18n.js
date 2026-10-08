// i18n.js
// Textos de la interfaz en castellano (por defecto) e inglés.
// Debe cargarse antes que monitor.js y dashboard.js.

const LANG_KEY = 'dxmonitor-lang';
const LANGS = ['es', 'en'];

// Prioridad: ?lang=xx en la URL > idioma guardado > castellano
const LANG = (() => {
    const fromUrl = new URLSearchParams(location.search).get('lang');
    if (LANGS.includes(fromUrl)) {
        try { localStorage.setItem(LANG_KEY, fromUrl); } catch (_) { /* ignore */ }
        return fromUrl;
    }
    try {
        const saved = localStorage.getItem(LANG_KEY);
        if (LANGS.includes(saved)) return saved;
    } catch (_) { /* ignore */ }
    return 'es';
})();
const LOCALE = LANG === 'en' ? 'en-GB' : 'es-ES';

const STRINGS = {
    es: {
        'lang.label': 'Idioma',
        'local': 'Local',
        'loading': 'Cargando…',
        'noData': 'Sin datos',
        'sw.error': 'No se pudieron cargar los datos de propagación. Se reintentará automáticamente.',

        // Tiles
        'tile.a': 'Índice A',
        'tile.k': 'Índice K',
        'tile.xray': 'Rayos X',
        'tile.wind': 'Viento solar',
        'tile.bz': 'Campo IMF',
        'tile.noise': 'Ruido HF',
        'tile.sfiSub': 'Flujo solar 10,7 cm · 30 días',
        'tile.ssnSub': 'Manchas solares · 30 días',
        'tile.aSub': 'Índice A',
        'tile.kSub': 'Índice Kp (NOAA)',
        'tile.xraySub': 'Rayos X (GOES)',
        'tile.xrayMax': 'Máx. 6 h: {cls}',
        'tile.windSub': 'Viento solar · km/s',
        'tile.noiseSub': 'Ruido · Geomag.: {geo}',

        // Estados
        'st.quiet': 'Quieto',
        'st.unsettled': 'Inestable',
        'st.active': 'Activo',
        'st.storm': 'Tormenta',
        'st.stormG': 'Tormenta G{g}',
        'st.normal': 'Normal',
        'st.flareX': 'Fulguración X (R3+)',
        'st.flareM2': 'Fulguración M (R2)',
        'st.flareM1': 'Fulguración M (R1)',
        'st.elevated': 'Elevado',
        'st.veryHigh': 'Muy alto',
        'st.north': 'Norte',
        'st.southWeak': 'Sur débil',
        'st.south': 'Sur',
        'st.southStrong': 'Sur intenso',
        'cond.Good': 'Buena',
        'cond.Fair': 'Regular',
        'cond.Poor': 'Mala',
        'vhf.closed': 'Cerrada',

        // Escalas NOAA
        'scales.title': 'Escalas NOAA',
        'scale.r': 'Radio blackout',
        'scale.s': 'Tormenta de radiación',
        'scale.g': 'Tormenta geomagnética',
        'forecast.rProb': 'Probabilidad de blackout de radio R1-R2 / R3+',

        // Filtros
        'f.title': 'Filtros',
        'f.reset': 'Restablecer',
        'f.resetAria': 'Restablecer filtros',
        'f.bands': 'Bandas',
        'f.modes': 'Modos',
        'f.origin': 'Origen',
        'f.originQsl': 'Origen y QSL',
        'f.calls': 'Indicativos',
        'f.only': 'solo {x}',
        'f.or': ' o ',
        'f.showingAll': 'Mostrando todos los spots',
        'f.removeFilter': 'Quitar filtro de {x}',
        'f.allF': 'Todas',
        'f.allM': 'Todos',
        'f.removeAll': 'Quitar todos',
        'f.qslHint': 'QSL: solo estaciones que usan LoTW / eQSL.',
        'f.addCallsAria': 'Añadir indicativos',
        'f.add': 'Añadir',
        'f.noCalls': 'Sin indicativos: se muestran todos.',
        'f.remove': 'Quitar {x}',
        'f.count': '<b>{n}</b> de {total} spots',
        'f.countTitle': 'Se muestran los {max} más recientes que cumplen los filtros',

        // Tabla
        'th.freq': 'Frecuencia',
        'th.dx': 'DX / Entidad',
        'th.mode': 'Modo',
        'qrz.title': 'Doble clic para abrir en QRZ',

        // Panel lateral
        'card.hf': 'Condiciones HF',
        'card.activity': 'Actividad por banda',
        'card.top': 'Más activos',
        'card.kp': 'Índice Kp',
        'card.kpSub': '3 días · previsión NOAA',
        'card.xray': 'Rayos X (GOES)',
        'card.xraySub': '6 horas',
        'card.sun': 'El Sol ahora',
        'lastHour': 'última hora',
        'top.dxcc': 'Entidades DXCC',
        'top.calls': 'Indicativos',
        'hf.bands': 'Bandas',
        'hf.day': 'Día',
        'hf.night': 'Noche',
        'hf.now': 'ahora',
        'hf.protons': 'Protones',
        'kp.none': 'Sin datos de Kp',
        'kp.aria': 'Índice Kp planetario, últimos 3 días',
        'xray.none': 'Sin datos de rayos X',
        'xray.aria': 'Flujo de rayos X GOES, últimas 6 horas',
        'xray.class': 'Clase {cls}',
        'act.spots': '{n} spots',
        'act.tip': '{n} spots · {pct}% del total',
        'act.none': 'Sin spots en la última hora',
        'act.other': 'Otras',
        'vhf.aurora': 'Aurora VHF (hem. norte)',
        'vhf.eu2': 'Es Europa 2 m',
        'vhf.eu6': 'Es Europa 6 m',
        'vhf.eu4': 'Es Europa 4 m',
        'vhf.na2': 'Es Norteamérica 2 m',
        'sun.alt': 'Imagen actual del Sol',
        'sun.altView': 'Sol en {view}',
        'sun.0171': 'AIA 171 Å (corona)',
        'sun.HMIIC': 'HMI (manchas)',
        'sun.0304': 'AIA 304 Å (cromosfera)',

        // Cluster
        'cluster.connected': 'Cluster: {node} · {host}',
        'cluster.down': 'Cluster desconectado ({node})',
        'cluster.reconnecting': 'Reconectando…',
        'node.primary': 'principal',
        'node.backup': 'respaldo {n}',

        'footer.sources': 'Fuentes:'
    },
    en: {
        'lang.label': 'Language',
        'local': 'Local',
        'loading': 'Loading…',
        'noData': 'No data',
        'sw.error': 'Could not load propagation data. Retrying automatically.',

        'tile.a': 'A index',
        'tile.k': 'K index',
        'tile.xray': 'X-ray',
        'tile.wind': 'Solar wind',
        'tile.bz': 'IMF',
        'tile.noise': 'HF noise',
        'tile.sfiSub': 'Solar flux 10.7 cm · 30 days',
        'tile.ssnSub': 'Sunspot number · 30 days',
        'tile.aSub': 'A index',
        'tile.kSub': 'Kp index (NOAA)',
        'tile.xraySub': 'X-ray (GOES)',
        'tile.xrayMax': '6 h max: {cls}',
        'tile.windSub': 'Solar wind · km/s',
        'tile.noiseSub': 'Noise · Geomag.: {geo}',

        'st.quiet': 'Quiet',
        'st.unsettled': 'Unsettled',
        'st.active': 'Active',
        'st.storm': 'Storm',
        'st.stormG': 'Storm G{g}',
        'st.normal': 'Normal',
        'st.flareX': 'X flare (R3+)',
        'st.flareM2': 'M flare (R2)',
        'st.flareM1': 'M flare (R1)',
        'st.elevated': 'Elevated',
        'st.veryHigh': 'Very high',
        'st.north': 'North',
        'st.southWeak': 'Weak south',
        'st.south': 'South',
        'st.southStrong': 'Strong south',
        'cond.Good': 'Good',
        'cond.Fair': 'Fair',
        'cond.Poor': 'Poor',
        'vhf.closed': 'Closed',

        'scales.title': 'NOAA scales',
        'scale.r': 'Radio blackout',
        'scale.s': 'Radiation storm',
        'scale.g': 'Geomagnetic storm',
        'forecast.rProb': 'Radio blackout probability R1-R2 / R3+',

        'f.title': 'Filters',
        'f.reset': 'Reset',
        'f.resetAria': 'Reset filters',
        'f.bands': 'Bands',
        'f.modes': 'Modes',
        'f.origin': 'Source',
        'f.originQsl': 'Source & QSL',
        'f.calls': 'Callsigns',
        'f.only': '{x} only',
        'f.or': ' or ',
        'f.showingAll': 'Showing all spots',
        'f.removeFilter': 'Remove {x} filter',
        'f.allF': 'All',
        'f.allM': 'All',
        'f.removeAll': 'Remove all',
        'f.qslHint': 'QSL: only stations using LoTW / eQSL.',
        'f.addCallsAria': 'Add callsigns',
        'f.add': 'Add',
        'f.noCalls': 'No callsigns: showing all.',
        'f.remove': 'Remove {x}',
        'f.count': '<b>{n}</b> of {total} spots',
        'f.countTitle': 'Showing the {max} most recent spots matching the filters',

        'th.freq': 'Frequency',
        'th.dx': 'DX / Entity',
        'th.mode': 'Mode',
        'qrz.title': 'Double-click to open on QRZ',

        'card.hf': 'HF conditions',
        'card.activity': 'Band activity',
        'card.top': 'Most active',
        'card.kp': 'Kp index',
        'card.kpSub': '3 days · NOAA forecast',
        'card.xray': 'X-ray (GOES)',
        'card.xraySub': '6 hours',
        'card.sun': 'The Sun now',
        'lastHour': 'last hour',
        'top.dxcc': 'DXCC entities',
        'top.calls': 'Callsigns',
        'hf.bands': 'Bands',
        'hf.day': 'Day',
        'hf.night': 'Night',
        'hf.now': 'now',
        'hf.protons': 'Protons',
        'kp.none': 'No Kp data',
        'kp.aria': 'Planetary Kp index, last 3 days',
        'xray.none': 'No X-ray data',
        'xray.aria': 'GOES X-ray flux, last 6 hours',
        'xray.class': 'Class {cls}',
        'act.spots': '{n} spots',
        'act.tip': '{n} spots · {pct}% of total',
        'act.none': 'No spots in the last hour',
        'act.other': 'Other',
        'vhf.aurora': 'VHF aurora (north. hemisphere)',
        'vhf.eu2': 'Es Europe 2 m',
        'vhf.eu6': 'Es Europe 6 m',
        'vhf.eu4': 'Es Europe 4 m',
        'vhf.na2': 'Es North America 2 m',
        'sun.alt': 'Current image of the Sun',
        'sun.altView': 'The Sun in {view}',
        'sun.0171': 'AIA 171 Å (corona)',
        'sun.HMIIC': 'HMI (sunspots)',
        'sun.0304': 'AIA 304 Å (chromosphere)',

        'cluster.connected': 'Cluster: {node} · {host}',
        'cluster.down': 'Cluster disconnected ({node})',
        'cluster.reconnecting': 'Reconnecting…',
        'node.primary': 'primary',
        'node.backup': 'backup {n}',

        'footer.sources': 'Sources:'
    }
};

// Traduce una clave; {x} se sustituye por vars.x. Si falta en inglés, usa el castellano.
function t(key, vars) {
    let s = STRINGS[LANG][key] ?? STRINGS.es[key] ?? key;
    if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] ?? m));
    return s;
}

function setLang(lang) {
    if (!LANGS.includes(lang) || lang === LANG) return;
    try {
        localStorage.setItem(LANG_KEY, lang);
        const url = new URL(location.href);
        url.searchParams.delete('lang');
        location.href = url.toString();
    } catch (_) {
        // Sin localStorage: el idioma viaja en la URL
        const url = new URL(location.href);
        url.searchParams.set('lang', lang);
        location.href = url.toString();
    }
}

// Textos fijos del HTML: data-i18n (texto), data-i18n-title, data-i18n-aria, data-i18n-alt
function applyI18n(root = document) {
    document.documentElement.lang = LANG;
    root.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
    root.querySelectorAll('[data-i18n-title]').forEach(el => { el.title = t(el.dataset.i18nTitle); });
    root.querySelectorAll('[data-i18n-aria]').forEach(el => { el.setAttribute('aria-label', t(el.dataset.i18nAria)); });
    root.querySelectorAll('[data-i18n-alt]').forEach(el => { el.alt = t(el.dataset.i18nAlt); });
    const sw = document.getElementById('lang-switch');
    if (sw) {
        sw.setAttribute('aria-label', t('lang.label'));
        sw.querySelectorAll('button[data-lang]').forEach(b => {
            b.setAttribute('aria-pressed', b.dataset.lang === LANG ? 'true' : 'false');
            b.onclick = () => setLang(b.dataset.lang);
        });
    }
}

document.addEventListener('DOMContentLoaded', () => applyI18n());
