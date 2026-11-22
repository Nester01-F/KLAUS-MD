const fs = require('fs');
const path = require('path');
const express = require('express');
const pino = require('pino');
const crypto = require('crypto');

const {
  default: makeWASocket,
  fetchLatestWaWebVersion,
  useMultiFileAuthState,
  delay,
  DisconnectReason
} = require('@whiskeysockets/baileys');

const settings = require('../setting');
const logger = require('../utils/logger');

const app = express();

// Only enable when you are really behind a reverse proxy (Render, Railway, nginx...).
// Then req.ip is the real visitor IP instead of the proxy's IP.
if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY) || 1);

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use('/assets', express.static(path.join(__dirname, '..', 'lib')));

const sessionRoot = path.join(__dirname, 'auth_info_baileys');
const credsPath = path.join(sessionRoot, 'creds.json');
const statusPath = path.join(__dirname, '..', 'session_status.json');
const debugLogPath = path.join(__dirname, '..', 'pairing_debug.log');

/* ------------------------------------------------------------------ */
/* Security: auth + rate limiting                                      */
/* ------------------------------------------------------------------ */
// If no token is configured and we are on a host (PORT is injected), generate a random
// one at startup and print it in the logs, so the page works without manual setup.
let ADMIN_TOKEN = String(process.env.SESSION_ADMIN_TOKEN || '');
let TOKEN_AUTO_GENERATED = false;
if (!ADMIN_TOKEN && process.env.PORT) {
  ADMIN_TOKEN = crypto.randomBytes(16).toString('hex');
  TOKEN_AUTO_GENERATED = true;
}
const DEFAULT_COUNTRY_CODE = String(process.env.DEFAULT_COUNTRY_CODE || '254'); // Kenya
const PAIRING_COOLDOWN_MS = Number(process.env.PAIRING_COOLDOWN_MS || 30_000);
const PAIRING_MAX_PER_HOUR = Number(process.env.PAIRING_MAX_PER_HOUR || 6);
const PAIRING_CODE_TTL_SEC = 120; // WhatsApp codes are short-lived
const pairingHits = new Map(); // ip -> [timestamps]

function clientIp(req) {
  return String(req.ip || req.socket?.remoteAddress || 'unknown');
}

function isLoopback(req) {
  // If a proxy forwarded this request, it is NOT a genuine local request.
  if (req.get('x-forwarded-for') || req.get('forwarded')) return false;
  const ip = String(req.socket?.remoteAddress || '');
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function tokenMatches(given) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(ADMIN_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// With SESSION_ADMIN_TOKEN set: every API call needs the token (x-admin-token header).
// Without it: only requests from this machine (localhost) are accepted, so a public
// deploy can never leak creds.json by accident.
function requireAuth(req, res, next) {
  if (ADMIN_TOKEN) {
    if (tokenMatches(req.get('x-admin-token'))) return next();
    return res.status(401).json({ ok: false, error: 'Missing or wrong access token.' });
  }
  if (isLoopback(req)) return next();
  return res.status(403).json({
    ok: false,
    error: 'Session server is locked. Set SESSION_ADMIN_TOKEN on the server, or run it locally.'
  });
}

function rateLimitPairing(req, res, next) {
  const key = clientIp(req);
  const now = Date.now();
  const hits = (pairingHits.get(key) || []).filter((t) => now - t < 60 * 60 * 1000);
  const last = hits[hits.length - 1];

  if (last && now - last < PAIRING_COOLDOWN_MS) {
    const wait = Math.ceil((PAIRING_COOLDOWN_MS - (now - last)) / 1000);
    return res.status(429).json({ ok: false, error: `Slow down. Wait ${wait}s before requesting another code (repeated requests get your IP rate-limited by WhatsApp).` });
  }
  if (hits.length >= PAIRING_MAX_PER_HOUR) {
    return res.status(429).json({ ok: false, error: 'Too many pairing attempts this hour. Wait and try again later.' });
  }
  hits.push(now);
  pairingHits.set(key, hits);
  next();
}

// FIX: local format (0712345678) is converted to international (254712345678)
// instead of just stripping the zero, which produced a 9-digit invalid number.
function normalizePhone(raw) {
  let n = String(raw || '').replace(/[^0-9]/g, '');
  if (n.startsWith('00')) n = n.slice(2);                          // 00254... -> 254...
  else if (n.startsWith('0')) n = DEFAULT_COUNTRY_CODE + n.replace(/^0+/, ''); // 07... -> 2547...
  return n;
}

let pairingCode = null;
let pairingCodeAt = 0;
let lastPairError = null;
let socketReady = false;
let activeSocket = null;
let pairingLock = Promise.resolve();

function debugLog(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}\n`;
  try { fs.appendFileSync(debugLogPath, line); } catch {}
  logger.info('[pairing]', ...args);
}

function writeStatus(update) {
  let current = {};
  if (fs.existsSync(statusPath)) {
    try { current = JSON.parse(fs.readFileSync(statusPath, 'utf-8')); } catch { current = {}; }
  }
  fs.writeFileSync(statusPath, JSON.stringify({ ...current, ...update }, null, 2));
  debugLog('status.json →', JSON.stringify(update));
}

// True only when creds.json exists AND the device finished linking (me.id is set).
function readLinkedCreds() {
  try {
    if (!fs.existsSync(credsPath)) return null;
    const raw = fs.readFileSync(credsPath, 'utf-8').trim();
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed?.me?.id ? raw : null;
  } catch {
    return null;
  }
}

function ensureFreshAuthState(forceReset = false) {
  if (forceReset && fs.existsSync(sessionRoot)) {
    fs.rmSync(sessionRoot, { recursive: true, force: true });
    debugLog('auth state wiped (forceReset)');
  }
  if (!fs.existsSync(sessionRoot)) {
    fs.mkdirSync(sessionRoot, { recursive: true });
  }
}

// Mark the socket as intentionally closed so the auto-reconnect logic ignores it
function closeActiveSocket() {
  if (activeSocket) {
    activeSocket.intentionalClose = true;
    try { activeSocket.ev.removeAllListeners('connection.update'); } catch {}
    try { activeSocket.ws.close(); } catch {}
  }
  activeSocket = null;
  socketReady = false;
}

async function createSocket() {
  const { state, saveCreds } = await useMultiFileAuthState(sessionRoot);
  const { version } = await fetchLatestWaWebVersion({});

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: ['Ubuntu', 'Chrome', '122.0.0.0'],
    keepAliveIntervalMs: 60_000,
    markOnlineOnConnect: false,
    syncFullHistory: false
  });

  // FIX: the "ready" listener is attached right here, synchronously after the socket
  // is created, so the 'connecting' event can no longer be missed.
  sock.readyPromise = new Promise((resolve) => {
    const fallback = setTimeout(resolve, 6000);
    sock.ev.on('connection.update', (u) => {
      if (u.connection === 'connecting' || u.qr) {
        clearTimeout(fallback);
        resolve();
      }
    });
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
    debugLog('global update →', String(connection));

    if (connection === 'open') {
      socketReady = true;
      pairingCode = null;
      lastPairError = null;
      logger.session('Session linked successfully.');
      writeStatus({ linkedAt: new Date().toISOString(), lastError: null, loggedOut: false });
    }

    if (connection === 'close') {
      socketReady = false;

      // We closed it ourselves (reset / timeout / replaced / export) - do not reconnect
      if (sock.intentionalClose) return;

      const code = lastDisconnect?.error?.output?.statusCode;
      debugLog('closed with status', String(code), '|', lastDisconnect?.error?.message);

      if (code === DisconnectReason.loggedOut) {
        logger.warn('Session logged out — creds are no longer valid.');
        pairingCode = null;
        lastPairError = 'Logged out from WhatsApp. Generate a new code.';
        writeStatus({ loggedOut: true });
        return;
      }

      // FIX: another instance (e.g. your bot) connected with the same creds.
      // Reconnecting here would start a tug-of-war, so stand down.
      if (code === DisconnectReason.connectionReplaced) {
        logger.warn('Connection replaced by another instance — not reconnecting.');
        writeStatus({ lastError: 'connection replaced by another instance' });
        return;
      }

      // After the phone accepts the pairing code, WhatsApp closes the socket with 515
      // (restartRequired). We must open a NEW socket with the saved creds to finish
      // linking. Also reconnect on other drops once the device is registered.
      const shouldReconnect =
        code === DisconnectReason.restartRequired || state.creds.registered;

      // FIX: socket died before the phone entered the code -> the code is dead,
      // so tell the UI instead of leaving a useless code on screen.
      if (!shouldReconnect) {
        pairingCode = null;
        lastPairError = `Connection closed before pairing finished (status ${code}). Generate a new code.`;
        writeStatus({ lastError: lastPairError });
        return;
      }

      await delay(1500);
      if (sock.intentionalClose) return;

      try {
        debugLog('reconnecting with saved creds...');
        activeSocket = await createSocket();
      } catch (e) {
        debugLog('reconnect failed:', e.message);
        writeStatus({ lastError: `reconnect failed: ${e.message}` });
      }
    }
  });

  return sock;
}

async function buildSocket(phoneNumber, { forceReset = false } = {}) {
  // FIX: close the old socket BEFORE wiping the auth folder, so it cannot
  // write stale creds into the fresh folder.
  if (forceReset) closeActiveSocket();
  ensureFreshAuthState(forceReset);

  if (!forceReset && readLinkedCreds()) {
    socketReady = true;
    logger.session('Existing session found — no pairing needed.');
    return activeSocket;
  }

  closeActiveSocket();
  pairingCode = null;
  pairingCodeAt = 0;
  lastPairError = null;

  return new Promise((resolve, reject) => {
    const globalTimeout = setTimeout(() => {
      closeActiveSocket();
      reject(new Error('Pairing timed out. WhatsApp may have rate-limited this IP (common on cloud hosts like Render/Heroku/Railway). Run the session server on your own computer/home network, or wait ~30 minutes, then try again.'));
    }, 70000);

    const attempt = async () => {
      closeActiveSocket();
      const sock = await createSocket();
      activeSocket = sock;
      await sock.readyPromise;
      await delay(1500);
      const code = await sock.requestPairingCode(phoneNumber);
      if (!code) throw new Error('Empty pairing code returned.');
      return { sock, code };
    };

    (async () => {
      let lastErr;
      for (let n = 1; n <= 3; n++) {
        try {
          const { sock, code } = await attempt();
          pairingCode = code;
          pairingCodeAt = Date.now();
          clearTimeout(globalTimeout);
          logger.session(`Pairing session ready for ${phoneNumber} (attempt ${n})`);
          writeStatus({ generatedAt: new Date().toISOString(), lastError: null, pairingAttempt: n });
          return resolve(sock);
        } catch (err) {
          lastErr = err;
          debugLog(`pairing attempt ${n} failed:`, err.message);
          closeActiveSocket();
          if (n < 3) await delay(3000 * n);
        }
      }
      clearTimeout(globalTimeout);
      writeStatus({ lastError: lastErr?.message || 'pairing failed' });
      reject(new Error(`${lastErr?.message || 'Pairing failed'}. Check the number includes the country code and is registered on WhatsApp; if it keeps failing, your host IP is probably rate-limited - run this locally.`));
    })();
  });
}

// FIX: only exports when linking is complete (me.id present), never a half-finished creds.json.
async function exportSessionBase64() {
  const raw = readLinkedCreds();
  if (!raw) {
    writeStatus({ lastSessionLength: null, lastExportError: 'no completed session (creds.json missing or not linked yet)' });
    return null;
  }
  try {
    const base64 = Buffer.from(raw, 'utf-8').toString('base64');
    writeStatus({ lastSessionLength: base64.length, lastExportError: null });
    return base64;
  } catch (err) {
    writeStatus({ lastExportError: err.message });
    return null;
  }
}

app.get('/', (_, res) => { res.send(buildHtml()); });

function validateNumber(req, res, next) {
  const number = normalizePhone(req.body.number);
  if (!/^\d{10,15}$/.test(number)) {
    return res.status(400).json({ ok: false, error: 'Use your full WhatsApp number, e.g. 2547XXXXXXXX or 07XXXXXXXX (10-15 digits).' });
  }
  req.phone = number;
  next();
}

app.post('/generate', requireAuth, validateNumber, rateLimitPairing, async (req, res) => {
  const number = req.phone;
  const forceReset = req.body.reset === '1' || req.body.reset === 'true' || req.query.reset === '1';

  const run = async () => {
    try {
      await buildSocket(number, { forceReset });
      if (!pairingCode && socketReady) {
        res.json({ ok: true, pairingCode: null, info: 'Existing session found — already linked.' });
        return;
      }
      res.json({
        ok: true,
        pairingCode,
        expiresInSec: PAIRING_CODE_TTL_SEC,
        info: 'Open WhatsApp → Linked devices → Link with phone number.'
      });
    } catch (err) {
      logger.error(`Session generation failed: ${err.message}`);
      res.status(500).json({ ok: false, error: err.message });
    }
  };

  pairingLock = pairingLock.then(run, run);
  await pairingLock;
});

app.get('/status', requireAuth, (_, res) => {
  const age = pairingCodeAt ? Math.floor((Date.now() - pairingCodeAt) / 1000) : null;
  const codeAlive = age !== null && age < PAIRING_CODE_TTL_SEC && pairingCode;
  res.json({
    ok: true,
    linked: socketReady,
    pairingCode: codeAlive ? pairingCode : null,
    codeExpiresInSec: age !== null ? Math.max(0, PAIRING_CODE_TTL_SEC - age) : null,
    hasSession: Boolean(readLinkedCreds()),
    error: lastPairError
  });
});

app.get('/export', requireAuth, async (_, res) => {
  const base64 = await exportSessionBase64();
  if (!base64) {
    res.status(404).json({ ok: false, error: 'No completed session found. Finish pairing first (the phone must accept the code).' });
    return;
  }
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, session: base64 });

  // FIX: release the session so your bot can use the same creds without a
  // "connection replaced" (440) fight. Safe: this does not log the device out.
  setTimeout(() => {
    debugLog('closing pairing socket after export');
    closeActiveSocket();
  }, 1000);
});

/* ------------------------------------------------------------------ */
/* HTML UI                                                             */
/* ------------------------------------------------------------------ */

function buildHtml() {
  const botName = settings.BOT_NAME || 'KLAUS-MD';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${botName} • Neural Link</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Fira+Code:wght@400;600&family=Orbitron:wght@500;700;900&family=Inter:wght@300;400;600&display=swap" rel="stylesheet" />
<style>
  :root {
    --bg-base: #030305;
    --bg-panel: rgba(15, 15, 20, 0.75);
    --border-glow: rgba(0, 194, 255, 0.25);
    --text-main: #ffffff;
    --text-muted: #8b8b99;
    --accent-cyan: #00c2ff;
    --accent-green: #10b981;
    --accent-orange: #f97316;
    --font-heading: 'Orbitron', sans-serif;
    --font-mono: 'Fira Code', monospace;
    --font-body: 'Inter', sans-serif;
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { height: 100%; overflow-x: hidden; }

  body {
    font-family: var(--font-body);
    color: var(--text-main);
    background-color: var(--bg-base);
    background-image: 
      radial-gradient(circle at 15% 50%, rgba(0, 194, 255, 0.08), transparent 40%),
      radial-gradient(circle at 85% 30%, rgba(16, 185, 129, 0.06), transparent 40%);
    display: flex; align-items: center; justify-content: center;
    min-height: 100vh; padding: 20px;
  }

  body::before {
    content: ''; position: fixed; inset: 0;
    background-image: linear-gradient(rgba(255,255,255,0.03) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.03) 1px, transparent 1px);
    background-size: 30px 30px; z-index: 0; pointer-events: none;
    mask-image: radial-gradient(circle at 50% 50%, black 20%, transparent 80%);
    -webkit-mask-image: radial-gradient(circle at 50% 50%, black 20%, transparent 80%);
  }

  .cyber-container {
    width: 100%; max-width: 420px; 
    position: relative; z-index: 10;
    animation: fadeUp 0.6s cubic-bezier(0.16, 1, 0.3, 1) forwards;
  }

  @keyframes fadeUp {
    from { opacity: 0; transform: translateY(20px) scale(0.98); }
    to { opacity: 1; transform: translateY(0) scale(1); }
  }

  .header { text-align: center; margin-bottom: 24px; position: relative; }

  .logo-ring {
    width: 90px; height: 90px; margin: 0 auto 15px;
    border-radius: 50%; padding: 3px;
    background: linear-gradient(135deg, var(--accent-cyan), var(--accent-green));
    box-shadow: 0 0 40px rgba(0, 194, 255, 0.3), inset 0 0 20px rgba(0, 194, 255, 0.5);
    animation: pulse-glow 3s infinite alternate;
  }

  @keyframes pulse-glow {
    0% { box-shadow: 0 0 20px rgba(0, 194, 255, 0.2); }
    100% { box-shadow: 0 0 60px rgba(0, 194, 255, 0.6), inset 0 0 20px rgba(16, 185, 129, 0.4); }
  }

  .logo-inner {
    width: 100%; height: 100%; border-radius: 50%;
    background-color: var(--bg-base); background-image: url('/assets/menu.jpg');
    background-size: cover; background-position: center; border: 2px solid #000;
  }

  .title {
    font-family: var(--font-heading); font-size: 24px; font-weight: 900;
    letter-spacing: 3px; text-transform: uppercase; color: #fff;
    text-shadow: 0 0 20px rgba(0, 194, 255, 0.6); margin-bottom: 6px;
  }

  .subtitle {
    font-family: var(--font-mono); font-size: 10px; color: var(--accent-cyan);
    letter-spacing: 5px; text-transform: uppercase;
  }

  .glass-panel {
    background: var(--bg-panel); border: 1px solid var(--border-glow);
    border-radius: 16px; padding: 28px;
    backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
    box-shadow: 0 0 50px rgba(0, 194, 255, 0.1), 0 20px 40px rgba(0,0,0,0.8), inset 0 1px 0 rgba(255,255,255,0.05);
    position: relative; overflow: hidden;
  }

  .glass-panel::before {
    content: ''; position: absolute; top: 0; left: 0; width: 100%; height: 2px;
    background: linear-gradient(90deg, transparent, var(--accent-cyan), transparent); opacity: 0.5;
  }

  .input-group { margin-bottom: 20px; position: relative; }
  
  .input-label {
    display: block; font-family: var(--font-mono); font-size: 10px;
    color: var(--text-muted); margin-bottom: 8px; text-transform: uppercase; letter-spacing: 1.5px;
  }

  .cyber-input {
    width: 100%; background: rgba(0,0,0,0.6); border: 1px solid rgba(255,255,255,0.08);
    border-radius: 10px; padding: 15px 16px; color: var(--text-main);
    font-family: var(--font-mono); font-size: 16px; letter-spacing: 1px;
    outline: none; transition: all 0.3s ease;
  }

  .cyber-input:focus {
    border-color: var(--accent-cyan);
    box-shadow: 0 0 20px rgba(0, 194, 255, 0.25), inset 0 0 10px rgba(0, 194, 255, 0.1);
    background: rgba(0, 194, 255, 0.02);
  }

  .cyber-input::placeholder { color: rgba(255,255,255,0.2); }

  .cyber-btn {
    width: 100%; padding: 15px; background: transparent; border: 1px solid var(--accent-cyan);
    border-radius: 10px; color: var(--accent-cyan); font-family: var(--font-heading);
    font-size: 13px; font-weight: 700; letter-spacing: 2px; text-transform: uppercase;
    cursor: pointer; transition: all 0.3s ease;
    box-shadow: 0 0 20px rgba(0, 194, 255, 0.15), inset 0 0 10px rgba(0, 194, 255, 0.1);
    display: flex; justify-content: center; align-items: center; gap: 10px; position: relative; overflow: hidden;
  }

  .cyber-btn:hover {
    background: rgba(0, 194, 255, 0.1);
    box-shadow: 0 0 30px rgba(0, 194, 255, 0.4), inset 0 0 20px rgba(0, 194, 255, 0.2);
    text-shadow: 0 0 10px rgba(0, 194, 255, 0.8);
  }

  .cyber-btn:disabled { opacity: 0.5; cursor: not-allowed; border-color: var(--text-muted); color: var(--text-muted); box-shadow: none; }

  .code-display {
    background: rgba(0,0,0,0.6); border: 1px solid rgba(16, 185, 129, 0.3);
    border-radius: 10px; padding: 24px 16px; text-align: center; margin-bottom: 20px;
    box-shadow: inset 0 0 30px rgba(16, 185, 129, 0.05), 0 0 20px rgba(16, 185, 129, 0.1);
    position: relative; animation: slideDown 0.5s ease-out forwards;
  }

  @keyframes slideDown {
    from { opacity: 0; transform: translateY(-20px); }
    to { opacity: 1; transform: translateY(0); }
  }

  .code-label { font-family: var(--font-mono); font-size: 10px; color: var(--accent-green); margin-bottom: 12px; text-transform: uppercase; letter-spacing: 2px; }
  
  .code-value {
    font-family: var(--font-mono); font-size: 28px; font-weight: 600;
    letter-spacing: 8px; color: #fff; text-shadow: 0 0 20px rgba(16, 185, 129, 0.8); user-select: all; cursor: pointer;
  }

  .code-timer { font-family: var(--font-mono); font-size: 11px; color: var(--text-muted); margin-top: 12px; }

  .instructions {
    font-size: 12px; color: var(--text-muted); line-height: 1.8;
    margin-bottom: 24px; padding-left: 15px; border-left: 2px solid rgba(16, 185, 129, 0.3);
  }

  .instructions strong { color: var(--text-main); font-weight: 600; }

  .alert {
    padding: 12px 16px; border-radius: 8px; font-size: 12px; margin-top: 15px;
    display: flex; align-items: center; gap: 10px; font-family: var(--font-mono); animation: slideIn 0.3s ease;
  }
  .alert.error { background: rgba(239, 68, 68, 0.05); border: 1px solid rgba(239, 68, 68, 0.3); color: #fca5a5; box-shadow: 0 0 15px rgba(239, 68, 68, 0.1); }
  .alert.success { background: rgba(16, 185, 129, 0.08); border: 1px solid rgba(16, 185, 129, 0.4); color: #6ee7b7; margin-top: 0; margin-bottom: 15px; }
  
  @keyframes slideIn { from { opacity: 0; transform: translateY(-10px); } to { opacity: 1; transform: translateY(0); } }

  .hidden { display: none !important; }

  .spinner { width: 14px; height: 14px; border: 2px solid rgba(0, 194, 255, 0.2); border-top-color: var(--accent-cyan); border-radius: 50%; animation: spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
</head>
<body>

<div class="cyber-container">
  
  <div class="header">
    <div class="logo-ring">
      <div class="logo-inner"></div>
    </div>
    <h1 class="title">${botName}</h1>
    <p class="subtitle">Neural Link Protocol</p>
  </div>

  <div id="step1" class="glass-panel">
    <div class="input-group">
      <label class="input-label">WhatsApp Number (With Country Code)</label>
      <input type="tel" id="phoneInput" class="cyber-input" placeholder="254712345678" autocomplete="off" />
    </div>

    <button class="cyber-btn" id="genBtn" onclick="generateCode()">
      <span>Initialize Connection</span>
    </button>
    
    <div id="errorBox" class="alert error hidden">
      <span id="errorText"></span>
    </div>
  </div>

  <div id="step2" class="glass-panel hidden">
    <div id="linkedBox" class="alert success hidden">
      <span>Device linked successfully. You can export the session string now.</span>
    </div>

    <div class="code-display" id="codeBox">
      <div class="code-label">Pairing Code Generated</div>
      <div class="code-value" id="codeDisplay" onclick="copyCode()" title="Click to copy"></div>
      <div class="code-timer" id="codeTimer"></div>
    </div>

    <div class="instructions">
      <strong>01.</strong> Open WhatsApp on your phone<br/>
      <strong>02.</strong> Go to Linked Devices<br/>
      <strong>03.</strong> Tap "Link with Phone Number"<br/>
      <strong>04.</strong> Enter the code above
    </div>

    <button class="cyber-btn" onclick="copyCode()" style="border-color: var(--accent-green); color: var(--accent-green); box-shadow: 0 0 20px rgba(16, 185, 129, 0.15); margin-bottom: 15px;">
      <span>Copy Code</span>
    </button>

    <button class="cyber-btn" onclick="exportSession()" style="border-color: var(--accent-orange); color: var(--accent-orange); box-shadow: 0 0 20px rgba(249, 115, 22, 0.15); margin-bottom: 15px;">
      <span>Export Session String</span>
    </button>

    <button class="cyber-btn" onclick="resetUi()" style="border-color: var(--text-muted); color: var(--text-muted); box-shadow: none; margin-bottom: 15px;">
      <span>Start Over</span>
    </button>

    <div id="errorBox2" class="alert error hidden">
      <span id="errorText2"></span>
    </div>

    <div id="sessionResult" class="hidden" style="margin-top: 15px;">
      <label class="input-label">Session String</label>
      <textarea id="sessionValue" readonly style="width: 100%; min-height: 80px; background: rgba(0,0,0,0.6); border: 1px solid rgba(249, 115, 22, 0.3); border-radius: 10px; padding: 10px; color: #fff; font-family: var(--font-mono); font-size: 11px; margin-bottom: 10px; resize: vertical;"></textarea>
      <button class="cyber-btn" onclick="copySession()" style="border-color: var(--accent-orange); color: var(--accent-orange); box-shadow: 0 0 20px rgba(249, 115, 22, 0.15);">
        <span>Copy Session String</span>
      </button>
    </div>
  </div>

</div>

<script>
  const $ = (id) => document.getElementById(id);
  let pollTimer = null;

  function showError(msg) {
    // show in whichever panel is currently visible
    const onStep2 = !$('step2').classList.contains('hidden');
    const box = onStep2 ? $('errorBox2') : $('errorBox');
    const txt = onStep2 ? $('errorText2') : $('errorText');
    txt.textContent = msg;
    box.classList.remove('hidden');
    setTimeout(() => box.classList.add('hidden'), 8000);
  }

  function setLoading(btn, on, label) {
    if (on) {
      btn.dataset.original = btn.innerHTML;
      btn.innerHTML = '<div class="spinner"></div><span>' + (label || 'Working...') + '</span>';
      btn.disabled = true;
    } else {
      btn.innerHTML = btn.dataset.original;
      btn.disabled = false;
    }
  }

  async function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return;
    }
    const el = document.createElement('textarea');
    el.value = text;
    el.style.position = 'fixed';
    el.style.opacity = '0';
    document.body.appendChild(el);
    el.focus();
    el.select();
    document.execCommand('copy');
    document.body.removeChild(el);
  }

  function getToken() {
    let t = null;
    try { t = sessionStorage.getItem('adminToken'); } catch (e) {}
    if (t === null) {
      t = prompt('Access token (find it in the server logs, or SESSION_ADMIN_TOKEN; leave empty if running locally):') || '';
      try { sessionStorage.setItem('adminToken', t); } catch (e) {}
    }
    return t;
  }

  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  function resetUi() {
    stopPolling();
    $('step2').classList.add('hidden');
    $('step1').classList.remove('hidden');
    $('sessionResult').classList.add('hidden');
    $('linkedBox').classList.add('hidden');
    $('codeBox').classList.remove('hidden');
  }

  // Watch the server so the page knows when the code expired, died, or got linked.
  function startPolling() {
    stopPolling();
    pollTimer = setInterval(async () => {
      try {
        const res = await fetch('/status', { headers: { 'x-admin-token': getToken() } });
        const s = await res.json();
        if (!s.ok) return;

        if (s.linked || s.hasSession) {
          $('linkedBox').classList.remove('hidden');
          $('codeBox').classList.add('hidden');
          stopPolling();
          return;
        }
        if (s.error) {
          showError(s.error);
          $('codeTimer').textContent = 'Code is no longer valid. Press Start Over.';
          stopPolling();
          return;
        }
        if (s.pairingCode) {
          $('codeTimer').textContent = 'Expires in ' + s.codeExpiresInSec + 's';
        } else {
          $('codeTimer').textContent = 'Code expired. Press Start Over and generate a new one.';
          stopPolling();
        }
      } catch (e) { /* ignore transient network errors */ }
    }, 3000);
  }

  async function generateCode() {
    $('errorBox').classList.add('hidden');
    const phone = $('phoneInput').value.replace(/[^0-9]/g, '');
    
    if (!phone || phone.length < 10) {
      showError('Please enter a valid number with country code.');
      return;
    }

    const btn = $('genBtn');
    setLoading(btn, true, 'Connecting...');

    try {
      // always send reset=1 so every attempt starts from clean auth state
      const res = await fetch('/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'x-admin-token': getToken() },
        body: 'number=' + encodeURIComponent(phone) + '&reset=1'
      });
      
      if (res.status === 401 || res.status === 403) { try { sessionStorage.removeItem('adminToken'); } catch (e) {} }
      const data = await res.json();

      if (data.ok && data.pairingCode) {
        $('codeDisplay').textContent = data.pairingCode;
        $('codeTimer').textContent = 'Expires in ' + (data.expiresInSec || 120) + 's';
        $('linkedBox').classList.add('hidden');
        $('codeBox').classList.remove('hidden');
        $('step1').classList.add('hidden');
        $('step2').classList.remove('hidden');
        startPolling();
      } else if (data.ok) {
        showError(data.info || 'Already linked.');
      } else {
        showError(data.error || 'Connection failed.');
      }
    } catch (e) {
      showError('Network error: ' + e.message);
    } finally {
      setLoading(btn, false);
    }
  }

  async function copyCode() {
    const code = $('codeDisplay').textContent;
    if (!code) return showError('No code generated yet.');
    try {
      await copyText(code);
      alert('Pairing code copied!');
    } catch (e) {
      showError('Copy failed: ' + e.message);
    }
  }

  async function exportSession() {
    try {
      const res = await fetch('/export', { headers: { 'x-admin-token': getToken() } });
      const data = await res.json();
      if (data.ok) {
        $('sessionValue').value = data.session;
        $('sessionResult').classList.remove('hidden');
        stopPolling();
      } else {
        showError(data.error || 'No session available yet. Link first.');
      }
    } catch (e) {
      showError('Network error: ' + e.message);
    }
  }

  async function copySession() {
    const session = $('sessionValue').value;
    if (!session) return showError('No session string to copy.');
    try {
      await copyText(session);
      alert('Session string copied!');
    } catch (e) {
      showError('Copy failed: ' + e.message);
    }
  }
</script>

</body>
</html>`;
}

// FIX: use the port the host injects (Render/Railway/Heroku set PORT).
// Locally use SESSION_SERVER_PORT so it never collides with the bot's keep-alive port.
const port = process.env.PORT || settings.SESSION_SERVER_PORT;
app.listen(port, () => {
  logger.info(`Session server running at http://localhost:${port}`);
  if (TOKEN_AUTO_GENERATED) {
    logger.warn(`SESSION_ADMIN_TOKEN was not set, so a temporary one was generated: ${ADMIN_TOKEN}`);
    logger.warn('Enter it when the page asks for the access token. It changes on every restart; set SESSION_ADMIN_TOKEN to keep one.');
  } else if (!ADMIN_TOKEN) {
    logger.warn('SESSION_ADMIN_TOKEN not set: API only accepts requests from this machine.');
  }
});
