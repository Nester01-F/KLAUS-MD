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
const ADMIN_TOKEN = String(process.env.SESSION_ADMIN_TOKEN || '');
const PAIRING_COOLDOWN_MS = Number(process.env.PAIRING_COOLDOWN_MS || 30_000);
const PAIRING_MAX_PER_HOUR = Number(process.env.PAIRING_MAX_PER_HOUR || 6);
const PAIRING_CODE_TTL_SEC = 120; // WhatsApp codes are short-lived; shown to the user as a hint
const pairingHits = new Map(); // ip -> [timestamps]

function isLoopback(req) {
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
  const key = String(req.socket?.remoteAddress || 'unknown');
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

function normalizePhone(raw) {
  // digits only, drop leading zeros (local format) - WhatsApp needs country code + number
  return String(raw || '').replace(/[^0-9]/g, '').replace(/^0+/, '');
}

let pairingCode = null;
let pairingCodeAt = 0;
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

function ensureFreshAuthState(forceReset = false) {
  if (forceReset && fs.existsSync(sessionRoot)) {
    fs.rmSync(sessionRoot, { recursive: true, force: true });
    debugLog('auth state wiped (forceReset)');
  }
  if (!fs.existsSync(sessionRoot)) {
    fs.mkdirSync(sessionRoot, { recursive: true });
  }
}

// FIX: mark the socket as intentionally closed so the auto-reconnect logic ignores it
function closeActiveSocket() {
  if (activeSocket) {
    activeSocket.intentionalClose = true;
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

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
    debugLog('global update →', String(connection));

    if (connection === 'open') {
      socketReady = true;
      logger.session('Session linked successfully.');
      writeStatus({ linkedAt: new Date().toISOString(), lastError: null, loggedOut: false });
    }

    if (connection === 'close') {
      socketReady = false;

      // We closed it ourselves (reset / timeout / replaced) - do not reconnect
      if (sock.intentionalClose) return;

      const code = lastDisconnect?.error?.output?.statusCode;
      debugLog('closed with status', String(code),'|', lastDisconnect?.error?.message);

      if (code === DisconnectReason.loggedOut) {
        logger.warn('Session logged out — creds are no longer valid.');
        writeStatus({ loggedOut: true });
        return;
      }

      // FIX: after the phone accepts the pairing code, WhatsApp closes the socket
      // with 515 (restartRequired). We must open a NEW socket with the saved creds
      // to finish linking. Also reconnect on other drops once the device is registered.
      const shouldReconnect =
        code === DisconnectReason.restartRequired || state.creds.registered;

      if (!shouldReconnect) return;

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
  ensureFreshAuthState(forceReset);

  if (!forceReset && fs.existsSync(credsPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(credsPath, 'utf-8'));
      if (existing?.me?.id) {
        socketReady = true;
        logger.session('Existing session found — no pairing needed.');
        return activeSocket;
      }
    } catch {}
  }

  closeActiveSocket();
  pairingCode = null;
  pairingCodeAt = 0;

  return new Promise((resolve, reject) => {
    const globalTimeout = setTimeout(() => {
      closeActiveSocket();
      reject(new Error('Pairing timed out. WhatsApp may have rate-limited this IP (common on cloud hosts like Render/Heroku/Railway). Run the session server on your own computer/home network, or wait ~30 minutes, then try again.'));
    }, 70000);

    const waitUntilReady = (sock) => new Promise((ready) => {
      // Request the code once the socket is actually connecting, not after a blind sleep.
      const fallback = setTimeout(ready, 8000);
      sock.ev.on('connection.update', (u) => {
        if (u.connection === 'connecting' || u.qr) { clearTimeout(fallback); ready(); }
      });
    });

    const attempt = async (n) => {
      closeActiveSocket();
      const sock = await createSocket();
      activeSocket = sock;
      await waitUntilReady(sock);
      await delay(1500);
      const code = await sock.requestPairingCode(phoneNumber);
      if (!code) throw new Error('Empty pairing code returned.');
      return { sock, code };
    };

    (async () => {
      let lastErr;
      for (let n = 1; n <= 3; n++) {
        try {
          const { sock, code } = await attempt(n);
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

async function exportSessionBase64() {
  if (!fs.existsSync(credsPath)) {
    writeStatus({ lastSessionLength: null, lastExportError: 'creds.json missing' });
    return null;
  }

  try {
    const raw = fs.readFileSync(credsPath, 'utf-8').trim();
    if (!raw) {
      writeStatus({ lastSessionLength: 0, lastExportError: 'creds.json is empty' });
      return null;
    }
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
    return res.status(400).json({ ok: false, error: 'Use your full WhatsApp number with country code, no leading 0 or + (e.g. 2547XXXXXXXX), 10-15 digits.' });
  }
  req.phone = number;
  next();
}

app.post('/generate', requireAuth, validateNumber, rateLimitPairing, async (req, res) => {
  const number = req.phone;
  const forceReset = req.body.reset === '1' || req.body.reset === 'true' || req.query.reset === '1';

  if (!number || number.length < 10 || number.length > 15) {
    res.status(400).json({ ok: false, error: 'Use your full WhatsApp number with country code, no leading 0 or + (e.g. 2547XXXXXXXX), 10-15 digits.' });
    return;
  }

  const run = async () => {
    try {
      await buildSocket(number, { forceReset });
      if (!pairingCode && socketReady) {
        res.json({ ok: true, pairingCode: null, info: 'Existing session found — already linked.' });
        return;
      }
      res.json({ ok: true, pairingCode, info: 'Open WhatsApp → Linked devices → Link with phone number.' });
    } catch (err) {
      logger.error(`Session generation failed: ${err.message}`);
      res.status(500).json({ ok: false, error: err.message });
    }
  };

  pairingLock = pairingLock.then(run, run);
  await pairingLock;
});

app.get('/status', requireAuth, async (_, res) => {
  const base64 = await exportSessionBase64();
  const age = pairingCodeAt ? Math.floor((Date.now() - pairingCodeAt) / 1000) : null;
  res.json({
    ok: true,
    linked: socketReady,
    pairingCode: age !== null && age < PAIRING_CODE_TTL_SEC ? pairingCode : null,
    codeExpiresInSec: age !== null ? Math.max(0, PAIRING_CODE_TTL_SEC - age) : null,
    hasSession: Boolean(base64)
  });
});

app.get('/export', requireAuth, async (_, res) => {
  const base64 = await exportSessionBase64();
  if (!base64) {
    res.status(404).json({ ok: false, error: 'No valid creds.json found. Complete pairing first.' });
    return;
  }
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, session: base64 });
});

/* ------------------------------------------------------------------ */
/* HTML UI                                                             */
/* ------------------------------------------------------------------ */

function buildHtml() {
  const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const botName = esc(settings.BOT_NAME || 'KLAUS-MD');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="light dark" />
<title>${botName} · Link WhatsApp</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:wght@400;600;700&family=JetBrains+Mono:wght@600;800&display=swap" rel="stylesheet" />
<style>
:root{--bg:#ECEFEA;--card:#fff;--ink:#17201B;--muted:#5B675F;--line:#D6DDD6;--accent:#0E6B4E;--on-accent:#fff;--slab:#17201B;--slab-ink:#EAF3EC;--bad:#A32A2A;--bad-bg:#FBECEC;--ok-bg:#E5F3EB;--r:14px}
@media (prefers-color-scheme:dark){:root{--bg:#0F1512;--card:#18211C;--ink:#E8EFE9;--muted:#98A59C;--line:#2A362E;--accent:#4CC38A;--on-accent:#0B1A12;--slab:#070A08;--slab-ink:#E8F3EA;--bad:#FF9C9C;--bad-bg:#3A1D1D;--ok-bg:#16291F}}
*{box-sizing:border-box;margin:0}
html{-webkit-text-size-adjust:100%}
body{font:16px/1.5 'Bricolage Grotesque',system-ui,sans-serif;background:var(--bg);color:var(--ink);min-height:100vh;padding:28px 16px 48px}
.wrap{max-width:480px;margin:0 auto}
.hidden{display:none!important}
.top{display:flex;align-items:center;gap:14px;margin-bottom:22px}
.avatar{width:48px;height:48px;border-radius:50%;object-fit:cover;background:var(--line)}
h1{font-size:22px;font-weight:700;line-height:1.2}
.top p{color:var(--muted);font-size:15px}
.steps{list-style:none;padding:0;display:flex;gap:8px;margin-bottom:18px}
.steps li{flex:1;display:flex;align-items:center;gap:8px;font-size:14px;color:var(--muted);padding-top:10px;border-top:3px solid var(--line)}
.steps li b{width:22px;height:22px;border-radius:50%;display:grid;place-items:center;font-size:12px;border:1.5px solid var(--line);flex:none}
.steps li.on{color:var(--ink);border-color:var(--accent)}
.steps li.on b{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}
.steps li.done{color:var(--ink);border-color:var(--accent)}
.steps li.done b{border-color:var(--accent);color:var(--accent)}
.card{background:var(--card);border:1px solid var(--line);border-radius:var(--r);padding:22px}
.card+.card{margin-top:14px}
label,.lead{display:block;font-weight:600;margin-bottom:6px}
.hint{color:var(--muted);font-size:14px;margin-top:6px}
input,textarea{width:100%;font:inherit;color:var(--ink);background:var(--bg);border:1.5px solid var(--line);border-radius:10px;padding:13px 14px}
input{font-size:18px;letter-spacing:.02em}
textarea{font:600 12px/1.5 'JetBrains Mono',monospace;min-height:96px;resize:vertical;word-break:break-all}
:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
input:focus-visible{outline-offset:0}
.btn{font:inherit;font-weight:600;border-radius:10px;padding:13px 16px;border:1.5px solid var(--accent);background:var(--accent);color:var(--on-accent);cursor:pointer;width:100%;margin-top:14px;display:flex;justify-content:center;align-items:center;gap:8px}
.btn.alt{background:transparent;color:var(--accent)}
.btn:disabled{opacity:.55;cursor:wait}
.row{display:flex;gap:10px}.row .btn{margin-top:14px}
.spin{width:16px;height:16px;border:2.5px solid currentColor;border-right-color:transparent;border-radius:50%;animation:sp .7s linear infinite}
@keyframes sp{to{transform:rotate(360deg)}}
.msg{border-radius:10px;padding:12px 14px;margin-bottom:14px;font-size:15px}
.msg.err{background:var(--bad-bg);color:var(--bad)}
.msg.ok{background:var(--ok-bg);color:var(--ink)}
.code{all:unset;display:flex;justify-content:center;align-items:center;gap:10px;width:100%;background:var(--slab);color:var(--slab-ink);border-radius:12px;padding:22px 8px;cursor:pointer;box-sizing:border-box}
.code:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
.code .g{font:800 clamp(30px,10vw,42px)/1 'JetBrains Mono',monospace;letter-spacing:.08em;display:flex}
.code .g span{display:inline-block;opacity:0;transform:translateY(6px);animation:land .32s forwards}
@keyframes land{to{opacity:1;transform:none}}
.code .d{opacity:.4;font:800 30px 'JetBrains Mono',monospace}
.code.expired{opacity:.35}
.bar{height:5px;background:var(--line);border-radius:3px;margin:14px 0 6px;overflow:hidden}
.bar i{display:block;height:100%;width:100%;background:var(--accent);transition:width .25s linear}
.how{padding-left:20px;margin-top:16px;color:var(--ink)}
.how li{padding:2px 0 2px 4px}
.note{color:var(--muted);font-size:14px;margin-top:12px}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}.code .g span{opacity:1;transform:none}}
</style>
</head>
<body>
<main class="wrap">
  <header class="top">
    <img class="avatar" src="/assets/menu.jpg" alt="" onerror="this.style.visibility='hidden'" />
    <div><h1>${botName}</h1><p>Link a WhatsApp account to this bot</p></div>
  </header>

  <ol class="steps" aria-label="Progress">
    <li id="s1" class="on"><b>1</b>Your number</li>
    <li id="s2"><b>2</b>Pair phone</li>
    <li id="s3"><b>3</b>Save session</li>
  </ol>

  <div id="msg" class="msg hidden" role="status" aria-live="polite"></div>

  <section id="tokenBox" class="card hidden">
    <label for="tokenInput">Access token</label>
    <input id="tokenInput" type="password" autocomplete="off" />
    <p class="hint">This server is protected. Enter the value of SESSION_ADMIN_TOKEN.</p>
    <button class="btn" id="tokenBtn" type="button">Save token</button>
  </section>

  <section id="p1" class="card">
    <label for="phoneInput">WhatsApp number</label>
    <input id="phoneInput" type="tel" inputmode="numeric" placeholder="254712345678" autocomplete="off" />
    <p class="hint" id="phoneHint">Country code first, digits only. No + and no leading 0.</p>
    <button class="btn" id="genBtn" type="button">Get pairing code</button>
  </section>

  <section id="p2" class="card hidden">
    <p class="lead">Enter this code in WhatsApp</p>
    <button class="code" id="codeDisplay" type="button" aria-label="Pairing code. Press to copy."></button>
    <div class="bar" aria-hidden="true"><i id="timerBar"></i></div>
    <p class="hint" id="timerText"></p>
    <ol class="how">
      <li>Open WhatsApp on the phone with this number</li>
      <li>Go to Settings, then Linked devices</li>
      <li>Tap Link a device, then Link with phone number instead</li>
      <li>Type the code. This page moves on by itself once linked.</li>
    </ol>
    <div class="row">
      <button class="btn alt" id="copyCodeBtn" type="button">Copy code</button>
      <button class="btn alt" id="againBtn" type="button">New code</button>
    </div>
  </section>

  <section id="p3" class="card hidden">
    <p class="lead">Account linked</p>
    <p class="hint" style="margin-top:0">Get the session string and paste it into the SESSION variable where your bot runs.</p>
    <button class="btn" id="exportBtn" type="button">Get session string</button>
    <div id="sessionResult" class="hidden">
      <label for="sessionValue" style="margin-top:16px">Session string</label>
      <textarea id="sessionValue" readonly></textarea>
      <button class="btn" id="copySessionBtn" type="button">Copy session string</button>
      <p class="note">Anyone with this string can use your WhatsApp account. Keep it private and never commit it to GitHub.</p>
    </div>
    <button class="btn alt" id="restartBtn" type="button">Link another number</button>
  </section>
</main>

<script>
var $ = function (id) { return document.getElementById(id); };
var TTL = 120, expiresAt = 0, tick = null, poll = null;

function token() { return sessionStorage.getItem('adminToken') || ''; }

function api(path, opts) {
  opts = opts || {};
  opts.headers = Object.assign({ 'x-admin-token': token() }, opts.headers || {});
  return fetch(path, opts).then(function (r) {
    return r.json().then(function (d) {
      if (r.status === 401) { $('tokenBox').classList.remove('hidden'); $('tokenInput').focus(); d.error = 'Enter the access token to continue.'; }
      return d;
    });
  });
}

function say(text, kind) {
  var m = $('msg');
  if (!text) { m.classList.add('hidden'); return; }
  m.textContent = text;
  m.className = 'msg ' + (kind || 'err');
}

function busy(btn, on, label) {
  if (on) { btn.dataset.html = btn.innerHTML; btn.innerHTML = '<span class="spin"></span><span>' + label + '</span>'; btn.disabled = true; }
  else { btn.innerHTML = btn.dataset.html || btn.innerHTML; btn.disabled = false; }
}

function stage(n) {
  ['p1', 'p2', 'p3'].forEach(function (id, i) { $(id).classList.toggle('hidden', i !== n - 1); });
  [1, 2, 3].forEach(function (i) {
    var li = $('s' + i);
    li.className = i < n ? 'done' : i === n ? 'on' : '';
    li.firstChild.textContent = i < n ? '\u2713' : String(i);
  });
  if (n !== 2) { clearInterval(tick); clearInterval(poll); }
}

function copy(text, done) {
  var ok = function () { say(done, 'ok'); };
  if (navigator.clipboard && window.isSecureContext) { navigator.clipboard.writeText(text).then(ok, function () { say('Copy failed. Select the text and copy it manually.'); }); return; }
  var t = document.createElement('textarea'); t.value = text; t.style.cssText = 'position:fixed;opacity:0';
  document.body.appendChild(t); t.select();
  try { document.execCommand('copy'); ok(); } catch (e) { say('Copy failed. Select the text and copy it manually.'); }
  document.body.removeChild(t);
}

function showCode(code) {
  var a = code.slice(0, 4), b = code.slice(4), i = 0;
  var group = function (s) { return '<span class="g">' + s.split('').map(function (c) { return '<span style="animation-delay:' + (i++ * 55) + 'ms">' + c + '</span>'; }).join('') + '</span>'; };
  $('codeDisplay').innerHTML = group(a) + '<span class="d">-</span>' + group(b);
  $('codeDisplay').dataset.code = a + '-' + b;
  $('codeDisplay').classList.remove('expired');
  expiresAt = Date.now() + TTL * 1000;
  clearInterval(tick);
  tick = setInterval(function () {
    var left = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
    $('timerBar').style.width = (left / TTL * 100) + '%';
    if (left > 0) { $('timerText').textContent = 'Code expires in about ' + Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0'); }
    else { $('timerText').textContent = 'This code has probably expired. Press New code.'; $('codeDisplay').classList.add('expired'); clearInterval(tick); }
  }, 250);
  clearInterval(poll);
  poll = setInterval(function () {
    api('/status').then(function (d) { if (d && d.linked) { say('Linked. Your WhatsApp account is connected.', 'ok'); stage(3); } });
  }, 4000);
}

function generate() {
  say('');
  var phone = $('phoneInput').value.replace(/[^0-9]/g, '').replace(/^0+/, '');
  if (phone.length < 10 || phone.length > 15) { say('Enter your full number with country code, for example 254712345678.'); $('phoneInput').focus(); return; }
  var btn = $('genBtn'); busy(btn, true, 'Requesting code');
  api('/generate', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'number=' + encodeURIComponent(phone) + '&reset=1' })
    .then(function (d) {
      if (d.ok && d.pairingCode) { stage(2); showCode(d.pairingCode); }
      else if (d.ok) { say(d.info || 'This session is already linked.', 'ok'); stage(3); }
      else { say(d.error || 'Could not get a code. Try again in a minute.'); }
    })
    .catch(function (e) { say('Could not reach the server: ' + e.message); })
    .then(function () { busy(btn, false); });
}

function exportSession() {
  var btn = $('exportBtn'); busy(btn, true, 'Fetching');
  api('/export').then(function (d) {
    if (d.ok) { $('sessionValue').value = d.session; $('sessionResult').classList.remove('hidden'); btn.classList.add('hidden'); say('Session string ready.', 'ok'); }
    else { say(d.error || 'No session yet. Finish linking on your phone first.'); }
  }).catch(function (e) { say('Could not reach the server: ' + e.message); })
    .then(function () { busy(btn, false); });
}

$('genBtn').onclick = generate;
$('phoneInput').addEventListener('keydown', function (e) { if (e.key === 'Enter') generate(); });
$('phoneInput').addEventListener('input', function () {
  var d = this.value.replace(/[^0-9]/g, '');
  $('phoneHint').textContent = d.charAt(0) === '0' ? 'Replace the leading 0 with your country code, for example 254.' : 'Country code first, digits only. No + and no leading 0.';
});
$('tokenBtn').onclick = function () { sessionStorage.setItem('adminToken', $('tokenInput').value); $('tokenBox').classList.add('hidden'); say('Token saved. Press the button again.', 'ok'); };
$('tokenInput').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('tokenBtn').click(); });
$('codeDisplay').onclick = $('copyCodeBtn').onclick = function () { copy($('codeDisplay').dataset.code.replace('-', ''), 'Code copied.'); };
$('againBtn').onclick = function () { say(''); stage(1); $('phoneInput').focus(); };
$('exportBtn').onclick = exportSession;
$('copySessionBtn').onclick = function () { copy($('sessionValue').value, 'Session string copied.'); };
$('restartBtn').onclick = function () { say(''); $('sessionResult').classList.add('hidden'); $('exportBtn').classList.remove('hidden'); $('sessionValue').value = ''; stage(1); };
</script>
</body>
</html>`;
}

// Hosts like Render inject PORT for web services; locally use SESSION_SERVER_PORT so the
// session server never collides with the bot's keep-alive port.
const port = process.env.PORT ? settings.PORT : settings.SESSION_SERVER_PORT;
app.listen(port, () => {
  logger.info(`Session server running at http://localhost:${port}`);
  if (!ADMIN_TOKEN) logger.warn('SESSION_ADMIN_TOKEN not set: API only accepts requests from this machine.');
});
