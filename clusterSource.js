/**
 * DX CLUSTER SOURCE
 * One telnet session to a DX cluster, with failover across its backup nodes.
 * Several sources can run at the same time; each reports its own status and stats.
 */

const net = require('net');

class ClusterSource {
    /**
     * @param {object} config  Source row: { id, name, host, port, callsign, login_commands, backups: [{host, port}] }
     * @param {object} opts    { reconnectDelayMs, connectTimeoutMs, inactivityTimeoutMs, failoverAttempts, primaryCheckMs }
     * @param {function} onLine  async (line, source) => 'new' | 'dup' | null
     */
    constructor(config, opts, onLine) {
        this.config = config;
        this.opts = opts;
        this.onLine = onLine;
        this.nodes = [
            { name: 'principal', host: config.host, port: config.port },
            ...config.backups.map((b, i) => ({ name: `respaldo ${i + 1}`, host: b.host, port: b.port }))
        ];
        this.activeNode = 0;
        this.failures = 0;
        this.socket = null;
        this.reconnectTimer = null;
        this.primaryTimer = null;
        this.stopped = true;
        this.connected = false;
        this.stats = {
            connectedSince: null,
            disconnectedSince: Date.now(),
            connects: 0,
            spots: 0,
            duplicates: 0,
            lastSpotAt: null,
            lastError: null,
            lastErrorAt: null
        };
    }

    log(msg) { console.log(`[${this.config.name}] ${msg}`); }
    warn(msg) { console.warn(`[${this.config.name}] ${msg}`); }

    start() {
        this.stopped = false;
        this.connect();
        if (this.nodes.length > 1) {
            this.primaryTimer = setInterval(() => this.checkPrimary(), this.opts.primaryCheckMs);
            this.primaryTimer.unref();
        }
    }

    // Graceful stop: send 'bye' so the cluster frees the session
    stop() {
        this.stopped = true;
        clearTimeout(this.reconnectTimer);
        clearInterval(this.primaryTimer);
        this.reconnectTimer = null;
        this.primaryTimer = null;
        const s = this.socket;
        this.socket = null;
        this.setDisconnected();
        ClusterSource.closeSocket(s);
    }

    // Force a new session (e.g. from the admin panel)
    reconnect() {
        if (this.stopped) return;
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
        this.connect();
    }

    static closeSocket(socket) {
        if (!socket || socket.destroyed) return;
        try {
            if (socket.writable) socket.end('bye\n');
        } catch (_) { /* ignore */ }
        setTimeout(() => socket.destroy(), 3000).unref();
    }

    setDisconnected() {
        this.connected = false;
        this.stats.connectedSince = null;
        if (this.stats.disconnectedSince === null) this.stats.disconnectedSince = Date.now();
    }

    setError(msg) {
        this.stats.lastError = msg;
        this.stats.lastErrorAt = Date.now();
    }

    scheduleReconnect() {
        if (this.reconnectTimer || this.stopped) return;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, this.opts.reconnectDelayMs);
    }

    // Switch node after failoverAttempts consecutive failures
    registerFailure() {
        this.failures++;
        if (this.nodes.length < 2 || this.failures < this.opts.failoverAttempts) return;
        this.failures = 0;
        this.activeNode = (this.activeNode + 1) % this.nodes.length;
        const node = this.nodes[this.activeNode];
        this.warn(`⚠️ Cambiando al nodo ${node.name} (${node.host}:${node.port})`);
    }

    probe(node) {
        return new Promise((resolve) => {
            const p = net.connect(node.port, node.host);
            const done = (ok) => { p.destroy(); resolve(ok); };
            p.setTimeout(this.opts.connectTimeoutMs, () => done(false));
            p.once('connect', () => done(true));
            p.once('error', () => done(false));
        });
    }

    // While on a backup node, return to the primary as soon as it is available
    async checkPrimary() {
        if (this.activeNode === 0 || this.stopped) return;
        if (!(await this.probe(this.nodes[0]))) return;
        if (this.activeNode === 0 || this.stopped) return;
        this.log(`✅ Nodo principal disponible de nuevo, volviendo a ${this.nodes[0].host}:${this.nodes[0].port}`);
        this.activeNode = 0;
        this.failures = 0;
        this.reconnect();
    }

    connect() {
        if (this.stopped) return;
        // Never more than one live connection per source
        if (this.socket) {
            const old = this.socket;
            this.socket = null;
            ClusterSource.closeSocket(old);
        }

        const telnet = new net.Socket();
        this.socket = telnet;
        const node = this.nodes[this.activeNode];
        const { callsign } = this.config;
        let pending = '';
        let loginLines = 0;
        let connected = false;
        let gotSpot = false;

        telnet.setKeepAlive(true, 60000); // Detect dead connections at TCP level
        telnet.setTimeout(this.opts.connectTimeoutMs); // Connect timeout; becomes inactivity timeout once connected

        telnet.on('timeout', () => {
            const msg = connected
                ? `Sin datos del cluster en ${this.opts.inactivityTimeoutMs / 1000}s, reconectando...`
                : `Timeout conectando a ${node.host}:${node.port}`;
            this.setError(msg);
            this.warn(msg);
            ClusterSource.closeSocket(telnet);
        });

        telnet.on('error', (e) => {
            this.setError(e.message);
            this.warn(`Cluster error: ${e.message}`);
        });

        this.log(`Conectando al nodo ${node.name} ${node.host}:${node.port} como ${callsign}...`);
        telnet.connect(node.port, node.host, () => {
            connected = true;
            this.connected = true;
            this.stats.connects++;
            this.stats.connectedSince = Date.now();
            this.stats.disconnectedSince = null;
            telnet.setTimeout(this.opts.inactivityTimeoutMs);
            this.log(`📡 Conectado al DXSpider (${node.name})`);
            telnet.write(`${callsign}\n`);
            // Commands sent after login, one per line (default: set/skim)
            const commands = (this.config.login_commands || '').split('\n').map(c => c.trim()).filter(Boolean);
            commands.forEach((cmd, i) => {
                setTimeout(() => { if (telnet.writable) telnet.write(`${cmd}\n`); }, 1000 * (i + 1));
            });
        });

        telnet.on('data', async (data) => {
            // Lines may be split across TCP packets
            const lines = (pending + data.toString()).split(/\r?\n/);
            pending = lines.pop();
            if (pending.length > 4096) pending = '';

            for (const line of lines) {
                // Log the first lines after connecting (login, rejections, etc.)
                if (loginLines < 15 && line.trim() && !line.includes('DX de')) {
                    loginLines++;
                    this.log(`[cluster] ${line.trim()}`);
                }
                try {
                    const result = await this.onLine(line, this);
                    if (result === 'new') {
                        gotSpot = true;
                        this.stats.spots++;
                        this.stats.lastSpotAt = Date.now();
                    } else if (result === 'dup') {
                        gotSpot = true;
                        this.stats.duplicates++;
                    }
                } catch (err) {
                    console.error(`[${this.config.name}] Error procesando línea:`, err.message, '|', line);
                }
            }
        });

        telnet.on('close', () => {
            if (this.socket !== telnet) return; // Old socket already replaced
            this.socket = null;
            this.setDisconnected();
            if (this.stopped) return;
            // A session that received spots does not count as a failure
            if (gotSpot) this.failures = 0;
            else this.registerFailure();
            this.warn(`Conexión cerrada, reconectando en ${this.opts.reconnectDelayMs / 1000}s...`);
            this.scheduleReconnect();
        });
    }

    status() {
        const node = this.nodes[this.activeNode];
        return {
            id: this.config.id,
            name: this.config.name,
            callsign: this.config.callsign,
            enabled: !this.stopped,
            connected: this.connected,
            node: node.name,
            host: node.host,
            port: node.port,
            nodes: this.nodes,
            ...this.stats
        };
    }
}

module.exports = ClusterSource;
