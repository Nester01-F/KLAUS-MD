
/*
  ──────────────────────────────────────────────
    KLAUS MD — Environment Configuration
  ──────────────────────────────────────────────
*/

// ─── Helper Utilities ────────────────────────
function fromEnv(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === null || value === '' ? fallback : value;
}

function cleanNumber(raw) {
  const digits = String(raw || '').replace(/[^0-9]/g, '');
  // Strip leading 0 (local format) — WhatsApp JIDs never use it
  return digits.replace(/^0+/, '');
}

function validatePhone(name, value) {
  if (!/^\d{10,15}$/.test(value)) {
    console.warn(`⚠️  ${name}="${value}" is not a valid E.164 number (10-15 digits)`);
  }
  return value;
}

function parsePort(value, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 65535) {
    console.warn(`⚠️  Invalid port "${value}", using ${fallback}`);
    return fallback;
  }
  return parsed;
}

function parseBool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

// ─── Validate core settings early ────────────
const port = parsePort(fromEnv('PORT', '3002'), 3002);
const sessionPort = parsePort(fromEnv('SESSION_SERVER_PORT', '3001'), 3001);

if (port === sessionPort) {
  console.error(`❌ PORT and SESSION_SERVER_PORT both = ${port}. They must differ.`);
  process.exit(1);
}

const mode = String(fromEnv('MODE', 'public')).toLowerCase();
if (!['public', 'private'].includes(mode)) {
  console.error(`❌ MODE must be "public" or "private", got "${mode}"`);
  process.exit(1);
}

// ─── Core Bot Settings ───────────────────────
const settings = {
  // 🔑 Session use SESSION=blinder~
  SESSION: fromEnv('SESSION', ''),

  PREFIX: fromEnv('PREFIX', '.'),
  MODE: mode,

  OWNER_NUMBER: validatePhone('OWNER_NUMBER',
    cleanNumber(fromEnv('OWNER_NUMBER', '2340000000000'))),
  OWNER_NAME: fromEnv('OWNER_NAME', 'Klaus Owner'),

  DEVELOPER_NUMBER: validatePhone('DEVELOPER_NUMBER',
    cleanNumber(fromEnv('DEVELOPER_NUMBER', '254725391914'))),
  DEVELOPER_NAME: fromEnv('DEVELOPER_NAME', 'Warrior Felix'),

  PORT: port,
  SESSION_SERVER_PORT: sessionPort,
  KEEP_ALIVE_URL: fromEnv('KEEP_ALIVE_URL', ''),

  BOT_NAME: fromEnv('BOT_NAME', 'KLAUS MD'),
  APP_MODE: fromEnv('APP_MODE', 'bot'),

  BOT_SOURCE_DIR: fromEnv('BOT_SOURCE_DIR', ''),
  BOT_SOURCE_REPO: fromEnv('BOT_SOURCE_REPO', ''),
  BOT_SOURCE_BRANCH: fromEnv('BOT_SOURCE_BRANCH', 'main'),
  BOT_SOURCE_TOKEN: fromEnv('BOT_SOURCE_TOKEN', ''),

  // ─── AI Integrations ──────────────────────
  AI: {
    OPENAI_API_KEY: fromEnv('OPENAI_API_KEY', ''),
    OPENAI_MODEL: fromEnv('OPENAI_MODEL', 'gpt-4o-mini'),
    OPENAI_API_URL: fromEnv('OPENAI_API_URL', 'https://api.openai.com/v1/chat/completions'),

    GEMINI_API_KEY: fromEnv('GEMINI_API_KEY', ''),
    GEMINI_MODEL: fromEnv('GEMINI_MODEL', 'gemini-1.5-flash'),

    COPILOT_API_KEY: fromEnv('COPILOT_API_KEY', ''),
    COPILOT_API_URL: fromEnv('COPILOT_API_URL', ''),
    COPILOT_MODEL: fromEnv('COPILOT_MODEL', 'gpt-4o-mini'),

    get OPENAI_ENABLED() { return this.OPENAI_API_KEY.length > 0; },
    get GEMINI_ENABLED() { return this.GEMINI_API_KEY.length > 0; },
    get COPILOT_ENABLED() { return this.COPILOT_API_KEY.length > 0; }
  },

  // ─── Downloader Module ────────────────────
  DOWNLOADER: (() => {
    const enabled = parseBool(process.env.DOWNLOADER_ENABLED, false);
    const baseUrl = fromEnv('DOWNLOADER_API_BASE_URL', '');
    return {
      ENABLED: enabled && baseUrl.length > 0,
      API_BASE_URL: baseUrl,
      ENDPOINT: fromEnv('DOWNLOADER_ENDPOINT', '/download'),
      API_KEY: fromEnv('DOWNLOADER_API_KEY', ''),
      API_KEY_HEADER: fromEnv('DOWNLOADER_API_KEY_HEADER', 'x-api-key'),
      API_KEY_QUERY_NAME: fromEnv('DOWNLOADER_API_KEY_QUERY_NAME', 'apikey'),
      DEFAULT_QUALITY: fromEnv('DOWNLOADER_DEFAULT_QUALITY', '128')
    };
  })()
};

// Fail fast if SESSION is required but missing
if (!settings.SESSION || settings.SESSION.trim() === '') {
  console.warn('⚠️  SESSION env var is empty. The bot may fail to authenticate.');
}

module.exports = settings;
