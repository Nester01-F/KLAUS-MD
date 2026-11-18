
const fs = require('fs');
const path = require('path');
const express = require('express');
const pino = require('pino');

const {
  default: makeWASocket,
  fetchLatestBaileysVersion,
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
const pairingLabel = String(process.env.PAIRING_LABEL || 'yupradev').trim() || 'yupradev';

let pairingCode = null;
let socketReady = false;
let activeSocket = null;

// Serialize pairing requests so concurrent clicks don't race.
let pairingLock = Promise.resolve();

/* ------------------------------------------------------------------ */
/* Socket helpers                                                      */
/* ------------------------------------------------------------------ */

function waitForSocketOpen(sock, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      settled = true;
      clearTimeout(timer);
      sock.ev.off('connection.update', onUpdate);
    };

    const timer = setTimeout(() => {
      if (settled) return;
      cleanup();
      reject(new Error('Socket did not open in time. Try again.'));
    }, timeoutMs);

    const onUpdate = ({ connection, lastDisconnect }) => {
      if (settled) return;
      if (connection === 'open') {
        cleanup();
        resolve();
        return;
      }
      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        const reason =
          lastDisconnect?.error?.message ||
          (code ? `status ${code}` : 'connection closed');
        cleanup();
        reject(new Error(`Socket closed before pairing: ${reason}`));
      }
    };

    sock.ev.on('connection.update', onUpdate);
  });
}

function writeStatus(update) {
  let current = {};
  if (fs.existsSync(statusPath)) {
    try {
      current = JSON.parse(fs.readFileSync(statusPath, 'utf-8'));
    } catch {
      current = {};
    }
  }
  fs.writeFileSync(statusPath, JSON.stringify({ ...current, ...update }, null, 2));
}

function ensureFreshAuthState(forceReset = false) {
  if (forceReset && fs.existsSync(sessionRoot)) {
    fs.rmSync(sessionRoot, { recursive: true, force: true });
  }
  if (!fs.existsSync(sessionRoot)) {
    fs.mkdirSync(sessionRoot, { recursive: true });
  }
}

function closeActiveSocket() {
  if (activeSocket?.ws) {
    try {
      activeSocket.ws.close();
    } catch {
      /* ignore */
    }
  }
  activeSocket = null;
  socketReady = false;
}

/* ------------------------------------------------------------------ */
/* Core pairing logic                                                  */
/* ------------------------------------------------------------------ */

async function buildSocket(phoneNumber, { forceReset = false } = {}) {
  ensureFreshAuthState(forceReset);

  // If creds already exist and are valid, skip pairing entirely.
  if (!forceReset && fs.existsSync(credsPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(credsPath, 'utf-8'));
      if (existing?.me?.id) {
        socketReady = true;
        logger.session('Existing session found — no pairing needed.');
        return activeSocket;
      }
    } catch {
      /* corrupt creds → fall through to fresh pairing */
    }
  }

  closeActiveSocket();
  pairingCode = null;

  const { state, saveCreds } = await useMultiFileAuthState(sessionRoot);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: ['KLAUS Session', 'Chrome', '1.0.0'],
    keepAliveIntervalMs: 10_000
  });
  activeSocket = sock;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
    if (connection === 'open') {
      socketReady = true;
      logger.session('Session linked successfully.');
      writeStatus({ linkedAt: new Date().toISOString() });
    }
    if (connection === 'close') {
      socketReady = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        logger.warn('Session logged out — creds are no longer valid.');
        writeStatus({ loggedOut: true });
      }
    }
  });

  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      // Wait for `open` OR proceed after a short delay — Baileys needs
      // the noise handshake to settle before accepting a pairing request.
      await Promise.race([
        waitForSocketOpen(sock, 20_000),
        delay(4_000)
      ]);

      await delay(800 * attempt);
      const code = await sock.requestPairingCode(phoneNumber);
      if (!code) throw new Error('Empty pairing code returned.');
      pairingCode = code;
      lastError = null;
      break;
    } catch (err) {
      lastError = err;
      logger.warn(`Pairing attempt ${attempt}/3 failed: ${err.message}`);
      if (attempt < 3 && err.message.includes('closed')) {
        // Rebuild auth state on transport-level failures.
        closeActiveSocket();
        ensureFreshAuthState(true);
      }
    }
  }

  if (!pairingCode) {
    throw new Error(lastError?.message || 'Unable to generate pairing code. Try again.');
  }

  logger.session(`Pairing session ready for ${phoneNumber} (${pairingLabel})`);
  writeStatus({
    generatedAt: new Date().toISOString(),
    lastPairingCode: pairingCode,
    pairingLabel
  });

  return sock;
}

async function exportSessionBase64() {
  if (!fs.existsSync(credsPath)) return null;
  const raw = fs.readFileSync(credsPath, 'utf-8');
  const base64 = Buffer.from(raw, 'utf-8').toString('base64');
  writeStatus({ lastSessionLength: base64.length });
  return base64;
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

app.get('/', (_, res) => {
  res.send(buildHtml());
});

app.post('/generate', async (req, res) => {
  const number = String(req.body.number || '').replace(/[^0-9]/g, '');
  const forceReset =
    req.body.reset === '1' ||
    req.body.reset === 'true' ||
    req.query.reset === '1';

  if (!number || number.length < 10 || number.length > 15) {
    res.status(400).json({
      ok: false,
      error: 'Use a valid WhatsApp number with country code (10–15 digits).'
    });
    return;
  }

  const run = async () => {
    try {
      await buildSocket(number, { forceReset });
      res.json({
        ok: true,
        pairingCode,
        info: 'Open WhatsApp → Linked devices → Link with phone number and use this code.'
      });
    } catch (err) {
      logger.error(`Session generation failed: ${err.message}`);
      res.status(500).json({ ok: false, error: err.message });
    }
  };

  // Serialize requests so rapid clicks don't invalidate each other.
  pairingLock = pairingLock.then(run, run);
  await pairingLock;
});

app.get('/status', async (_, res) => {
  const base64 = await exportSessionBase64();
  res.json({
    ok: true,
    linked: socketReady,
    pairingCode,
    hasSession: Boolean(base64)
  });
});

app.get('/export', async (_, res) => {
  const base64 = await exportSessionBase64();
  if (!base64) {
    res.status(404).json({ ok: false, error: 'No creds.json found yet. Pair first.' });
    return;
  }
  res.json({ ok: true, session: base64 });
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
<title>${botName} • Session Pairing</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Fira+Code:wght@400;600;700&family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
<style>
  :root {
    --bg-0: #050a14;
    --bg-1: #0a1424;
    --bg-2: #0f1d33;
    --card: rgba(15, 29, 51, 0.72);
    --stroke: rgba(96, 165, 250, 0.18);
    --stroke-strong: rgba(96, 165, 250, 0.45);
    --text: #e6f0ff;
    --muted: #8aa4c4;
    --accent: #00c2ff;
    --accent-2: #39d353;
    --accent-3: #f97316;
    --danger: #ff5d6c;
    --mono: 'Fira Code', 'Courier New', monospace;
    --sans: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }

  html, body { height: 100%; }

  body {
    font-family: var(--sans);
    color: var(--text);
    background:
      radial-gradient(1200px 600px at 10% -10%, rgba(0, 194, 255, 0.18), transparent 60%),
      radial-gradient(900px 500px at 100% 0%, rgba(57, 211, 83, 0.12), transparent 55%),
      radial-gradient(900px 500px at 50% 120%, rgba(249, 115, 22, 0.10), transparent 60%),
      linear-gradient(180deg, var(--bg-0), var(--bg-1) 40%, var(--bg-2));
    min-height: 100vh;
    padding: 32px 16px 64px;
    -webkit-font-smoothing: antialiased;
    position: relative;
    overflow-x: hidden;
  }

  /* Animated grid background */
  body::before {
    content: '';
    position: fixed;
    inset: 0;
    background-image:
      linear-gradient(rgba(96, 165, 250, 0.06) 1px, transparent 1px),
      linear-gradient(90deg, rgba(96, 165, 250, 0.06) 1px, transparent 1px);
    background-size: 44px 44px;
    mask-image: radial-gradient(circle at 50% 30%, #000 20%, transparent 75%);
    -webkit-mask-image: radial-gradient(circle at 50% 30%, #000 20%, transparent 75%);
    pointer-events: none;
    z-index: 0;
  }

  .wrap {
    position: relative;
    z-index: 1;
    max-width: 720px;
    margin: 0 auto;
  }

  /* Hero card */
  .hero {
    position: relative;
    border-radius: 24px;
    padding: 36px 28px 30px;
    text-align: center;
    background:
      linear-gradient(180deg, rgba(10, 20, 36, 0.4), rgba(10, 20, 36, 0.9)),
      radial-gradient(600px 200px at 50% 0%, rgba(0, 194, 255, 0.28), transparent 70%);
    border: 1px solid var(--stroke);
    box-shadow:
      0 1px 0 rgba(255, 255, 255, 0.04) inset,
      0 30px 80px -20px rgba(0, 0, 0, 0.7),
      0 0 120px -30px rgba(0, 194, 255, 0.35);
    backdrop-filter: blur(14px);
    -webkit-backdrop-filter: blur(14px);
    overflow: hidden;
    margin-bottom: 22px;
  }

  .hero::after {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 1px;
    background: linear-gradient(90deg, transparent, var(--accent), transparent);
    opacity: 0.7;
  }

  .avatar-ring {
    display: inline-block;
    padding: 3px;
    border-radius: 999px;
    background: conic-gradient(from 180deg, var(--accent), var(--accent-2), var(--accent-3), var(--accent));
    animation: spin 8s linear infinite;
    margin-bottom: 14px;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .avatar {
    width: 96px;
    height: 96px;
    border-radius: 999px;
    object-fit: cover;
    display: block;
    border: 3px solid var(--bg-1);
    background: var(--bg-2);
  }

  .brand {
    font-family: var(--mono);
    font-weight: 700;
    font-size: 30px;
    letter-spacing: 0.5px;
    margin-bottom: 6px;
    background: linear-gradient(90deg, #00c2ff, #39d353 60%, #f97316);
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
  }

  .tagline {
    color: var(--muted);
    font-size: 14px;
    margin-bottom: 18px;
  }

  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    justify-content: center;
    margin-bottom: 18px;
  }

  .chip {
    font-family: var(--mono);
    font-size: 12px;
    padding: 6px 12px;
    border-radius: 999px;
    background: rgba(0, 194, 255, 0.08);
    border: 1px solid rgba(0, 194, 255, 0.25);
    color: #9fe8ff;
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }

  .chip .dot {
    width: 6px;
    height: 6px;
    border-radius: 999px;
    background: var(--accent-2);
    box-shadow: 0 0 10px var(--accent-2);
    animation: pulse 1.6s ease-in-out infinite;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.5; transform: scale(0.8); }
  }

  .clock {
    display: inline-block;
    font-family: var(--mono);
    font-size: 12px;
    color: var(--muted);
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid var(--stroke);
    padding: 6px 12px;
    border-radius: 999px;
    margin-bottom: 20px;
  }

  /* Buttons */
  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    width: 100%;
    padding: 14px 18px;
    border-radius: 12px;
    border: none;
    font-family: var(--sans);
    font-size: 15px;
    font-weight: 700;
    letter-spacing: 0.2px;
    cursor: pointer;
    transition: transform 0.15s ease, box-shadow 0.2s ease, filter 0.2s ease;
    color: #041220;
    background: linear-gradient(135deg, #00c2ff, #39d353);
    box-shadow: 0 8px 24px -8px rgba(0, 194, 255, 0.6);
    position: relative;
  }

  .btn:hover { transform: translateY(-2px); filter: brightness(1.05); }
  .btn:active { transform: translateY(0); }
  .btn:disabled { opacity: 0.6; cursor: not-allowed; transform: none; }

  .btn.ghost {
    background: transparent;
    color: var(--text);
    border: 1px solid var(--stroke-strong);
    box-shadow: none;
  }

  .btn.ghost:hover {
    background: rgba(0, 194, 255, 0.06);
    border-color: var(--accent);
  }

  .btn.warn {
    background: linear-gradient(135deg, #f97316, #ff5d6c);
    color: #1a0800;
  }

  .btn .spinner {
    width: 16px;
    height: 16px;
    border-radius: 999px;
    border: 2px solid rgba(4, 18, 32, 0.3);
    border-top-color: #041220;
    animation: spin 0.8s linear infinite;
  }

  /* Panels */
  .panel {
    background: var(--card);
    border: 1px solid var(--stroke);
    border-radius: 20px;
    padding: 26px 24px;
    backdrop-filter: blur(14px);
    -webkit-backdrop-filter: blur(14px);
    box-shadow: 0 20px 60px -30px rgba(0, 0, 0, 0.8);
    animation: rise 0.4s ease;
  }

  @keyframes rise {
    from { opacity: 0; transform: translateY(10px); }
    to { opacity: 1; transform: translateY(0); }
  }

  .step-head {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 16px;
  }

  .step-num {
    width: 30px;
    height: 30px;
    border-radius: 999px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-family: var(--mono);
    font-weight: 700;
    font-size: 13px;
    color: var(--bg-0);
    background: linear-gradient(135deg, var(--accent), var(--accent-2));
    box-shadow: 0 0 20px rgba(0, 194, 255, 0.5);
  }

  .step-title {
    font-size: 16px;
    font-weight: 700;
    letter-spacing: 0.2px;
  }

  .hint {
    font-size: 13px;
    color: var(--muted);
    margin-bottom: 14px;
    padding: 10px 14px;
    border-left: 3px solid var(--accent);
    background: rgba(0, 194, 255, 0.05);
    border-radius: 6px;
    line-height: 1.5;
  }

  .hint strong { color: var(--text); }

  /* Input */
  .field {
    position: relative;
    margin-bottom: 14px;
  }

  .field input {
    width: 100%;
    padding: 16px 18px;
    font-family: var(--mono);
    font-size: 16px;
    color: var(--text);
    background: rgba(5, 10, 20, 0.6);
    border: 1.5px solid var(--stroke-strong);
    border-radius: 12px;
    transition: border-color 0.2s, box-shadow 0.2s;
  }

  .field input:focus {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 4px rgba(0, 194, 255, 0.12);
  }

  .field input::placeholder { color: rgba(138, 164, 196, 0.5); }

  /* Pairing code display */
  .code-card {
    margin-top: 8px;
    padding: 22px;
    border-radius: 16px;
    background:
      radial-gradient(400px 120px at 50% 0%, rgba(57, 211, 83, 0.14), transparent 70%),
      rgba(5, 10, 20, 0.7);
    border: 1px solid rgba(57, 211, 83, 0.4);
    text-align: center;
    box-shadow: 0 0 60px -20px rgba(57, 211, 83, 0.4);
  }

  .code-label {
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 2px;
    color: var(--muted);
    margin-bottom: 12px;
  }

  .code-value {
    font-family: var(--mono);
    font-size: clamp(24px, 6vw, 34px);
    font-weight: 700;
    letter-spacing: 6px;
    color: var(--accent-2);
    text-shadow: 0 0 24px rgba(57, 211, 83, 0.5);
    word-break: break-all;
    margin-bottom: 16px;
    user-select: all;
    cursor: pointer;
    padding: 6px;
    border-radius: 8px;
    transition: background 0.2s;
  }

  .code-value:hover { background: rgba(57, 211, 83, 0.06); }

  .steps-list {
    text-align: left;
    font-size: 13px;
    color: var(--muted);
    line-height: 1.7;
    padding: 14px 16px;
    border-radius: 10px;
    background: rgba(255, 255, 255, 0.02);
    border: 1px solid var(--stroke);
    margin-top: 12px;
  }

  .steps-list strong { color: var(--text); }
  .steps-list code {
    font-family: var(--mono);
    background: rgba(0, 194, 255, 0.1);
    padding: 1px 6px;
    border-radius: 4px;
    color: #9fe8ff;
    font-size: 12px;
  }

  /* Session output */
  .session-box {
    margin-top: 16px;
    border-radius: 12px;
    border: 1px solid rgba(249, 115, 22, 0.35);
    background: rgba(249, 115, 22, 0.05);
    padding: 14px;
    animation: rise 0.3s ease;
  }

  .session-box textarea {
    width: 100%;
    min-height: 110px;
    padding: 12px;
    background: rgba(5, 10, 20, 0.8);
    color: #ffd8b5;
    border: 1px solid rgba(249, 115, 22, 0.3);
    border-radius: 8px;
    font-family: var(--mono);
    font-size: 11px;
    resize: vertical;
    line-height: 1.5;
    margin-bottom: 10px;
  }

  .session-box textarea:focus { outline: none; border-color: var(--accent-3); }

  /* Alerts */
  .alert {
    margin-top: 14px;
    padding: 12px 14px;
    border-radius: 10px;
    font-size: 13px;
    line-height: 1.5;
    display: flex;
    gap: 10px;
    align-items: flex-start;
    animation: rise 0.3s ease;
  }

  .alert.error {
    background: rgba(255, 93, 108, 0.08);
    border: 1px solid rgba(255, 93, 108, 0.3);
    color: #ffb3bb;
  }

  .alert.success {
    background: rgba(57, 211, 83, 0.08);
    border: 1px solid rgba(57, 211, 83, 0.3);
    color: #b6f7c1;
  }

  .alert .ico {
    font-size: 15px;
    flex-shrink: 0;
    margin-top: 1px;
  }

  /* Status pills */
  .status-row {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    margin-top: 16px;
  }

  .status-pill {
    font-family: var(--mono);
    font-size: 11px;
    padding: 5px 10px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid var(--stroke);
    color: var(--muted);
  }

  .status-pill.ok {
    color: var(--accent-2);
    border-color: rgba(57, 211, 83, 0.4);
    background: rgba(57, 211, 83, 0.06);
  }

  /* Utility */
  .hidden { display: none !important; }
  .mt { margin-top: 18px; }
  .mt-sm { margin-top: 10px; }

  .footer {
    text-align: center;
    font-size: 12px;
    color: rgba(138, 164, 196, 0.6);
    margin-top: 24px;
    font-family: var(--mono);
  }

  .footer a { color: var(--accent); text-decoration: none; }
  .footer a:hover { text-decoration: underline; }

  @media (max-width: 480px) {
    .hero { padding: 28px 20px 24px; }
    .brand { font-size: 24px; }
    .panel { padding: 20px 16px; }
    .code-value { letter-spacing: 4px; }
  }
</style>
</head>
<body>
<div class="wrap">

  <!-- HERO -->
  <div class="hero">
    <div class="avatar-ring">
      <img src="/assets/menu.jpg" alt="avatar" class="avatar" onerror="this.style.display='none';this.parentElement.style.display='none'" />
    </div>
    <div class="brand">${botName}</div>
    <div class="tagline">Session Pairing Center</div>
    <div class="chips">
      <span class="chip"><span class="dot"></span>Online</span>
      <span class="chip">Label: ${pairingLabel}</span>
      <span class="chip">Baileys</span>
    </div>
    <div id="clock" class="clock">--:--:--</div>
    <button class="btn" onclick="goToPairing()">
      🔗 Get Session
    </button>
  </div>

  <!-- STEP 1 -->
  <div id="step1" class="panel">
    <div class="step-head">
      <span class="step-num">1</span>
      <span class="step-title">Enter Your WhatsApp Number</span>
    </div>

    <div class="hint">
      Include your country code <strong>without</strong> the <code>+</code> sign.<br/>
      Example: <code>254725391914</code>
    </div>

    <div class="field">
      <input
        type="tel"
        id="phoneInput"
        placeholder="254725391914"
        inputmode="numeric"
        autocomplete="off"
      />
    </div>

    <button class="btn" id="genBtn" onclick="generateCode()">
      ⚡ Generate Pairing Code
    </button>

    <div id="error" class="alert error hidden">
      <span class="ico">⚠️</span>
      <span id="errorText"></span>
    </div>
  </div>

  <!-- STEP 2 -->
  <div id="step2" class="panel hidden">
    <div class="step-head">
      <span class="step-num">2</span>
      <span class="step-title">Link Your Device</span>
    </div>

    <div class="code-card">
      <div class="code-label">Your Pairing Code</div>
      <div class="code-value" id="codeDisplay" onclick="copyPairingCode()" title="Click to copy"></div>
      <button class="btn ghost" onclick="copyPairingCode()">📋 Copy Code</button>

      <div class="steps-list">
        <strong>On your phone:</strong><br/>
        1. Open <strong>WhatsApp</strong><br/>
        2. Go to <strong>Settings → Linked Devices</strong><br/>
        3. Tap <strong>Link a Device → Link with phone number</strong><br/>
        4. Enter the code above
      </div>
    </div>

    <div class="mt">
      <div class="step-head">
        <span class="step-num">3</span>
        <span class="step-title">Export Session String</span>
      </div>

      <div class="hint">
        After linking succeeds on your phone, tap the button below to export your
        session credentials.
      </div>

      <button class="btn warn" id="exportBtn" onclick="exportSession()">
        📤 Export Session String
      </button>

      <div id="sessionResult" class="session-box hidden">
        <div class="code-label" style="text-align:left;">Session String</div>
        <textarea id="sessionValue" readonly></textarea>
        <button class="btn ghost" onclick="copySession()">📋 Copy Session</button>
      </div>
    </div>

    <div class="status-row">
      <button class="btn ghost" onclick="startOver()">🔄 Start Over</button>
      <button class="btn ghost" onclick="refreshStatus()">📡 Check Status</button>
    </div>

    <div id="statusPills" class="status-row">
      <span class="status-pill" id="pillLink">⏳ Waiting for link...</span>
    </div>
  </div>

  <div class="footer">
    Built with 💙 by <a href="https://wa.me/254725391914">Warrior Felix</a>
  </div>
</div>

<script>
  /* ---------- helpers ---------- */
  const $ = (id) => document.getElementById(id);

  function showError(msg) {
    $('errorText').textContent = msg;
    $('error').classList.remove('hidden');
    setTimeout(() => $('error').classList.add('hidden'), 6000);
  }

  function hideError() { $('error').classList.add('hidden'); }

  function setLoading(btn, on, label) {
    if (on) {
      btn.dataset.original = btn.innerHTML;
      btn.innerHTML = '<span class="spinner"></span> ' + (label || 'Working...');
      btn.disabled = true;
    } else {
      btn.innerHTML = btn.dataset.original || label || btn.innerHTML;
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

  /* ---------- clock ---------- */
  function updateClock() {
    const now = new Date();
    $('clock').textContent = now.toLocaleString('en-KE', {
      weekday: 'short', day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
  }
  updateClock();
  setInterval(updateClock, 1000);

  /* ---------- navigation ---------- */
  function goToPairing() {
    $('step1').scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(() => $('phoneInput').focus(), 400);
  }

  /* ---------- pairing code ---------- */
  async function generateCode() {
    hideError();
    const phone = $('phoneInput').value.replace(/[^0-9]/g, '');
    if (!phone || phone.length < 10 || phone.length > 15) {
      showError('Please enter a valid phone number with country code (10–15 digits).');
      return;
    }

    const btn = $('genBtn');
    setLoading(btn, true, 'Generating...');

    try {
      const res = await fetch('/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'number=' + encodeURIComponent(phone)
      });
      const data = await res.json();

      if (data.ok) {
        $('codeDisplay').textContent = data.pairingCode;
        $('step1').classList.add('hidden');
        $('step2').classList.remove('hidden');
        startStatusPolling();
      } else {
        showError(data.error || 'Failed to generate code.');
      }
    } catch (e) {
      showError('Network error: ' + e.message);
    } finally {
      setLoading(btn, false);
    }
  }

  async function copyPairingCode() {
    const code = $('codeDisplay').textContent.trim();
    if (!code) return showError('No pairing code yet.');
    try {
      await copyText(code);
      const btn = event.target.closest('button');
      if (btn) {
        const orig = btn.innerHTML;
        btn.innerHTML = '✅ Copied!';
        setTimeout(() => { btn.innerHTML = orig; }, 1500);
      }
    } catch (e) {
      showError('Copy failed: ' + e.message);
    }
  }

  /* ---------- session export ---------- */
  async function exportSession() {
    const btn = $('exportBtn');
    setLoading(btn, true, 'Exporting...');
    try {
      const res = await fetch('/export');
      const data = await res.json();
      if (data.ok) {
        $('sessionValue').value = data.session;
        $('sessionResult').classList.remove('hidden');
      } else {
        showError(data.error || 'No session available yet. Link first.');
      }
    } catch (e) {
      showError('Network error: ' + e.message);
    } finally {
      setLoading(btn, false);
    }
  }

  async function copySession() {
    const session = $('sessionValue').value;
    if (!session) return showError('No session string to copy.');
    try {
      await copyText(session);
      const btn = event.target.closest('button');
      if (btn) {
        const orig = btn.innerHTML;
        btn.innerHTML = '✅ Copied!';
        setTimeout(() => { btn.innerHTML = orig; }, 1500);
      }
    } catch (e) {
      showError('Copy failed: ' + e.message);
    }
  }

  /* ---------- status polling ---------- */
  let statusTimer = null;

  function startStatusPolling() {
    if (statusTimer) return;
    statusTimer = setInterval(refreshStatus, 4000);
    refreshStatus();
  }

  function stopStatusPolling() {
    if (statusTimer) {
      clearInterval(statusTimer);
      statusTimer = null;
    }
  }

  async function refreshStatus() {
    try {
      const res = await fetch('/status');
      const data = await res.json();
      const pill = $('pillLink');
      if (data.linked) {
        pill.textContent = '✅ Linked';
        pill.classList.add('ok');
        stopStatusPolling();
      } else {
        pill.textContent = '⏳ Waiting for link...';
        pill.classList.remove('ok');
      }
    } catch {
      /* ignore transient errors */
    }
  }

  /* ---------- reset ---------- */
  async function startOver() {
    const phone = $('phoneInput').value.replace(/[^0-9]/g, '');
    if (!phone) {
      resetUi();
      return;
    }

    const btn = event.target.closest('button');
    setLoading(btn, true, 'Resetting...');
    try {
      // Call /generate with reset=1 — wipes auth state and issues a fresh code.
      const res = await fetch('/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'number=' + encodeURIComponent(phone) + '&reset=1'
      });
      const data = await res.json();
      if (data.ok) {
        $('codeDisplay').textContent = data.pairingCode;
        $('sessionResult').classList.add('hidden');
        $('sessionValue').value = '';
        stopStatusPolling();
        startStatusPolling();
      } else {
        showError(data.error || 'Reset failed.');
      }
    } catch (e) {
      showError('Network error: ' + e.message);
    } finally {
      setLoading(btn, false);
    }
  }

  function resetUi() {
    $('phoneInput').value = '';
    hideError();
    $('sessionResult').classList.add('hidden');
    $('sessionValue').value = '';
    $('step1').classList.remove('hidden');
    $('step2').classList.add('hidden');
    stopStatusPolling();
    $('phoneInput').focus();
  }

  /* ---------- init ---------- */
  $('phoneInput').focus();
  $('phoneInput').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') generateCode();
  });
</script>
</body>
</html>`;
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

const port = settings.PORT || settings.SESSION_SERVER_PORT || 3000;
app.listen(port, () => {
  logger.info(`Session server running at http://localhost:${port}`);
});
