/**
 * AUTHENTICATION HELPERS
 * scrypt password hashing (no native dependencies) and a simple login rate limiter.
 */

const crypto = require('crypto');
const db = require('./db');

const SCRYPT_N = 16384;
const KEY_LEN = 64;

function hashPassword(password) {
    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync(password, salt, KEY_LEN, { N: SCRYPT_N });
    return `scrypt$${SCRYPT_N}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
    const [algo, n, salt, hash] = String(stored || '').split('$');
    if (algo !== 'scrypt' || !salt || !hash) return false;
    const expected = Buffer.from(hash, 'base64');
    const actual = crypto.scryptSync(password, Buffer.from(salt, 'base64'), expected.length, { N: parseInt(n, 10) });
    return crypto.timingSafeEqual(actual, expected);
}

const USERNAME_RE = /^[A-Za-z0-9._-]{3,32}$/;
const MIN_PASSWORD = 8;

function validateCredentials(username, password, { requireUsername = true } = {}) {
    if (requireUsername && !USERNAME_RE.test(username || '')) return 'Username must be 3-32 characters: letters, digits, . _ -';
    if (password !== undefined && String(password).length < MIN_PASSWORD) return `Password must be at least ${MIN_PASSWORD} characters`;
    return null;
}

// First run: create the initial admin from ADMIN_USERNAME / ADMIN_PASSWORD,
// or with a random password printed once to the log
function ensureInitialAdmin() {
    if (db.countUsers() > 0) return;
    const username = process.env.ADMIN_USERNAME || 'admin';
    let password = process.env.ADMIN_PASSWORD;
    const generated = !password;
    if (generated) password = crypto.randomBytes(9).toString('base64url');
    db.createUser({ username, passwordHash: hashPassword(password), role: 'admin' });
    if (generated) {
        console.log('==========================================================');
        console.log(` Initial admin user created: ${username} / ${password}`);
        console.log(' Log in at /admin and change this password.');
        console.log('==========================================================');
    } else {
        console.log(`Initial admin user created: ${username} (password from ADMIN_PASSWORD)`);
    }
}

// Max 10 failed logins per IP every 15 minutes
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS = 10;
const failures = new Map();

function isRateLimited(ip) {
    const f = failures.get(ip);
    if (!f) return false;
    if (Date.now() - f.first > FAIL_WINDOW_MS) { failures.delete(ip); return false; }
    return f.count >= MAX_FAILS;
}

function registerFailedLogin(ip) {
    const f = failures.get(ip);
    if (!f || Date.now() - f.first > FAIL_WINDOW_MS) failures.set(ip, { first: Date.now(), count: 1 });
    else f.count++;
}

const clearFailedLogins = (ip) => failures.delete(ip);

module.exports = {
    hashPassword, verifyPassword, validateCredentials, ensureInitialAdmin,
    isRateLimited, registerFailedLogin, clearFailedLogins
};
