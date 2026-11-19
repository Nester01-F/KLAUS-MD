const fs = require('fs');
const path = require('path');
const express = require('express');
const pino = require('pino');

const {
  default: makeWASocket,
  fetchLatestWaWebVersion, // FIXED: Gets the live accepted version
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
const pairingLabel = String(process.env.PAIRING_LABEL || 'yupradev').trim() || 'yupradev';

let pairingCode = null;
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

function closeActiveSocket() {
  if (activeSocket?.ws) {
    try { activeSocket.ws.close(); } catch {}
  }
  activeSocket = null;
  socketReady = false;
}

async function createSocket() {
  const { state, saveCreds } = await useMultiFileAuthState(sessionRoot);
  
  // FIXED: Fetches the exact WhatsApp Web version right now, preventing rejection
  const { version } = await fetchLatestWaWebVersion({});

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: ['KLAUS Session', 'Chrome', '1.0.0'],
    keepAliveIntervalMs: 60_000,
    markOnlineOnConnect: false,
    syncFullHistory: false
  });

  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
    debugLog(`[${new Date().toISOString()}] global update → ${connection}`);
    if (connection === 'open') {
      socketReady = true;
      logger.session('Session linked successfully.');
      writeStatus({ linkedAt: new Date().toISOString(), lastError: null });
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

  return new Promise((resolve, reject) => {
    const globalTimeout = setTimeout(() => {
      closeActiveSocket();
      reject(new Error('Pairing timed out. WhatsApp may have rate-limited your IP. Wait 30 mins and try again.'));
    }, 45000);

    createSocket().then((sock) => {
      activeSocket = sock;
      
      const onUpdate = async (update) => {
        const { connection, lastDisconnect } = update;
        
        if (connection === 'connecting') {
          debugLog('Socket is connecting. Waiting 3 seconds for stabilization...');
          await delay(3000);
          
          try {
            const code = await activeSocket.requestPairingCode(phoneNumber);
            if (!code) throw new Error('Empty pairing code returned.');

            pairingCode = code;
            clearTimeout(globalTimeout);
            activeSocket.ev.off('connection.update', onUpdate);

            logger.session(`Pairing session ready for ${phoneNumber}`);
            writeStatus({ generatedAt: new Date().toISOString(), lastPairingCode: pairingCode, lastError: null });
            resolve(activeSocket);
          } catch (err) {
            clearTimeout(globalTimeout);
            activeSocket.ev.off('connection.update', onUpdate);
            closeActiveSocket();
            reject(err);
          }
        }

        if (connection === 'close') {
          const code = lastDisconnect?.error?.output?.statusCode;
          clearTimeout(globalTimeout);
          activeSocket.ev.off('connection.update', onUpdate);
          closeActiveSocket();
          reject(new Error(`Socket closed before pairing: status ${code}`));
        }
      };

      activeSocket.ev.on('connection.update', onUpdate);
    }).catch((err) => {
      clearTimeout(globalTimeout);
      reject(err);
    });
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

app.post('/generate', async (req, res) => {
  const number = String(req.body.number || '').replace(/[^0-9]/g, '');
  const forceReset = req.body.reset === '1' || req.body.reset === 'true' || req.query.reset === '1';

  if (!number || number.length < 10 || number.length > 15) {
    res.status(400).json({ ok: false, error: 'Use a valid WhatsApp number with country code (10–15 digits).' });
    return;
  }

  const run = async () => {
    try {
      await buildSocket(number, { forceReset });
      res.json({ ok: true, pairingCode, info: 'Open WhatsApp → Linked devices → Link with phone number.' });
    } catch (err) {
      logger.error(`Session generation failed: ${err.message}`);
      res.status(500).json({ ok: false, error: err.message });
    }
  };

  pairingLock = pairingLock.then(run, run);
  await pairingLock;
});

app.get('/status', async (_, res) => {
  const base64 = await exportSessionBase64();
  res.json({ ok: true, linked: socketReady, pairingCode, hasSession: Boolean(base64) });
});

app.get('/export', async (_, res) => {
  const base64 = await exportSessionBase64();
  if (!base64) {
    res.status(404).json({ ok: false, error: 'No valid creds.json found. Complete pairing first.' });
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
    <div class="code-display">
      <div class="code-label">Pairing Code Generated</div>
      <div class="code-value" id="codeDisplay" onclick="copyCode()" title="Click to copy"></div>
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

  function showError(msg) {
    $('errorText').textContent = msg;
    $('errorBox').classList.remove('hidden');
    setTimeout(() => $('errorBox').classList.add('hidden'), 6000);
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

const port = settings.PORT || settings.SESSION_SERVER_PORT || 3000;
app.listen(port, () => {
  logger.info(`Session server running at http://localhost:${port}`);
});
