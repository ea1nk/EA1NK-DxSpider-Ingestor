/**
 * CONFIGURATION DATABASE (SQLite)
 * Users, DX cluster sources and settings. Spots stay in MongoDB.
 * Uses the built-in node:sqlite module (Node >= 22.13), so no native build is needed.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'ingestor.db');

let db;

function open() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    db = new DatabaseSync(DB_FILE);
    db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA foreign_keys = ON;
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL UNIQUE COLLATE NOCASE,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            last_login TEXT
        );
        CREATE TABLE IF NOT EXISTS sources (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            host TEXT NOT NULL,
            port INTEGER NOT NULL,
            callsign TEXT NOT NULL,
            login_commands TEXT NOT NULL DEFAULT 'set/skim',
            backups TEXT NOT NULL DEFAULT '[]',
            enabled INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
    `);
    return db;
}

// --- Settings ---
function getSetting(key) {
    return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;
}

function setSetting(key, value) {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}

// --- Users ---
const USER_FIELDS = 'id, username, role, created_at, last_login';

const listUsers = () => db.prepare(`SELECT ${USER_FIELDS} FROM users ORDER BY username`).all();
const getUser = (id) => db.prepare(`SELECT ${USER_FIELDS} FROM users WHERE id = ?`).get(id);
const getUserWithHash = (username) => db.prepare('SELECT * FROM users WHERE username = ?').get(username);
const countAdmins = () => db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get().n;
const countUsers = () => db.prepare('SELECT COUNT(*) AS n FROM users').get().n;

function createUser({ username, passwordHash, role }) {
    const r = db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run(username, passwordHash, role);
    return getUser(r.lastInsertRowid);
}

function updateUser(id, { role, passwordHash }) {
    if (role) db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
    if (passwordHash) db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, id);
    return getUser(id);
}

const deleteUser = (id) => db.prepare('DELETE FROM users WHERE id = ?').run(id).changes > 0;
const touchLogin = (id) => db.prepare("UPDATE users SET last_login = datetime('now') WHERE id = ?").run(id);

// --- Sources ---
function rowToSource(r) {
    if (!r) return null;
    let backups = [];
    try { backups = JSON.parse(r.backups); } catch (_) { /* ignore */ }
    return { ...r, enabled: !!r.enabled, backups };
}

const listSources = () => db.prepare('SELECT * FROM sources ORDER BY id').all().map(rowToSource);
const getSource = (id) => rowToSource(db.prepare('SELECT * FROM sources WHERE id = ?').get(id));

function createSource(s) {
    const r = db.prepare(`INSERT INTO sources (name, host, port, callsign, login_commands, backups, enabled)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(s.name, s.host, s.port, s.callsign, s.login_commands, JSON.stringify(s.backups), s.enabled ? 1 : 0);
    return getSource(r.lastInsertRowid);
}

function updateSource(id, s) {
    db.prepare(`UPDATE sources SET name = ?, host = ?, port = ?, callsign = ?, login_commands = ?, backups = ?, enabled = ?
        WHERE id = ?`).run(s.name, s.host, s.port, s.callsign, s.login_commands, JSON.stringify(s.backups), s.enabled ? 1 : 0, id);
    return getSource(id);
}

const deleteSource = (id) => db.prepare('DELETE FROM sources WHERE id = ?').run(id).changes > 0;

// First run: import the cluster configured in .env so existing installs keep working
function seedSourcesFromEnv() {
    if (db.prepare('SELECT COUNT(*) AS n FROM sources').get().n > 0) return;
    const host = process.env.DX_HOST;
    if (!host) return;
    const port = parseInt(process.env.DX_PORT, 10) || 7300;
    const backupPort = parseInt(process.env.DX_PORT_BACKUP, 10) || port;
    const backups = (process.env.DX_HOST_BACKUP || '').split(',').map(h => h.trim()).filter(Boolean).map(entry => {
        const [h, p] = entry.split(':');
        return { host: h, port: parseInt(p, 10) || backupPort };
    });
    createSource({
        name: host,
        host,
        port,
        callsign: process.env.CALLSIGN || 'YOUR_CALLSIGN',
        login_commands: 'set/skim',
        backups,
        enabled: true
    });
    console.log(`Imported DX cluster source from .env: ${host}:${port} (${backups.length} backups)`);
}

// JWT secret: SECRET_KEY from .env, or a random one persisted in the database
function getJwtSecret() {
    const env = process.env.SECRET_KEY;
    if (env && env !== 'YOUR_SUPERSECRET_KEY' && env !== 'CHANGE_THIS_KEY_IN_PRODUCTION') {
        if (env.length < 32) console.warn('⚠️ SECRET_KEY is shorter than 32 characters: tokens could be brute-forced. Use a long random value or remove it to auto-generate one.');
        return env;
    }
    let secret = getSetting('jwt_secret');
    if (!secret) {
        secret = crypto.randomBytes(48).toString('base64url');
        setSetting('jwt_secret', secret);
    }
    return secret;
}

module.exports = {
    DB_FILE, open, getSetting, setSetting, getJwtSecret,
    listUsers, getUser, getUserWithHash, countAdmins, countUsers, createUser, updateUser, deleteUser, touchLogin,
    listSources, getSource, createSource, updateSource, deleteSource, seedSourcesFromEnv
};
