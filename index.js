const fs = require('fs');
const path = require('path');
const express = require('express');
const pino = require('pino');
const readline = require('readline');
const QRCode = require('qrcode'); // We need this to print the QR code cleanly

const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestWaWebVersion,
  delay
} = require('@whiskeysockets/baileys');

const ENV = require('./setting');
const logger = require('./utils/logger');
const botSettings = require('./utils/botSettings');
const { resolveSourceDir } = require('./utils/runtime');
const { clearExpiredSessions, handleMenuReply } = require('./commands/menuHandler');

const externalSourceDir = resolveSourceDir();

function startApplication() {
  if (externalSourceDir) {
    require(path.join(externalSourceDir, 'index.js'));
    return;
  }

  const rootDir = __dirname;
  const authDir = path.join(rootDir, 'session', 'auth_info_baileys');
  const commandsDir = path.join(rootDir, 'commands');
  const sessionStatusPath = path.join(rootDir, 'session_status.json');

  let sock;
  let retryCount = 0;
  let ownerNotified = false;
  let cachedVersion = null;
  const commandMap = new Map();
  const keepAliveApp = express();
  const metrics = { messages: 0, commands: 0, commandFailures: 0, statusReads: 0, autoReacts: 0, reconnects: 0, totalCommandMs: 0 };

  function getBotSettings() { return botSettings.getSettings(); }
  function getActivePrefix() { return getBotSettings().prefix || ENV.PREFIX || '.'; }
  function formatMemoryMB(bytes) { return `${(bytes / 1024 / 1024).toFixed(1)} MB`; }
  function formatUptimeShort(seconds) {
    const total = Math.max(0, Math.floor(seconds));
    return `${Math.floor(total / 3600)}h ${Math.floor((total % 3600) / 60)}m ${total % 60}s`;
  }
  function getCommandNames() { return [...new Set([...commandMap.values()].map((c) => c.name))].sort((a, b) => a.localeCompare(b)); }

  function loadCommands() {
    if (!fs.existsSync(commandsDir)) {
      logger.warn(`Commands directory not found: ${commandsDir}`);
      return;
    }
    
    const files = fs.readdirSync(commandsDir).filter((file) => file.endsWith('.js') && file !== 'menuHandler.js');
    logger.info(`Discovering ${files.length} command module(s) in /commands`);

    for (const file of files) {
      try {
        const command = require(path.join(commandsDir, file));
        if (!command || typeof command.name !== 'string' || typeof command.execute !== 'function') {
          logger.warn(`Skipped invalid command module: ${file}`);
          continue;
        }
        commandMap.set(command.name, command);
        if (Array.isArray(command.aliases)) {
          for (const alias of command.aliases) commandMap.set(alias, command);
        }
      } catch (err) {
        logger.error(`Failed to load command ${file}: ${err.message}`);
      }
    }
    logger.success(`Loaded ${getCommandNames().length} command name(s) and ${commandMap.size} command key(s).`);
  }

  function writeSessionStatus(update) {
    let current = {};
    if (fs.existsSync(sessionStatusPath)) {
      try { current = JSON.parse(fs.readFileSync(sessionStatusPath, 'utf-8')); } catch { current = {}; }
    }
    fs.writeFileSync(sessionStatusPath, JSON.stringify({ ...current, ...update }, null, 2));
  }

  function persistRuntimeMetrics(extra = {}) {
    writeSessionStatus({
      runtime: {
        updatedAt: new Date().toISOString(),
        uptimeSec: Math.floor(process.uptime()),
        messages: metrics.messages,
        commands: metrics.commands,
        commandFailures: metrics.commandFailures,
        statusReads: metrics.statusReads,
        autoReacts: metrics.autoReacts,
        reconnects: metrics.reconnects,
        avgCommandMs: Number(metrics.commands ? (metrics.totalCommandMs / metrics.commands).toFixed(1) : 0)
      },
      ...extra
    });
  }

  function logStartupProfile() {
    const settings = getBotSettings();
    const memory = process.memoryUsage();
    logger.boot(ENV.BOT_NAME, 'Readable bot runtime');
    logger.divider();
    logger.kvBlock('Environment', { node: process.version, platform: `${process.platform}/${process.arch}`, pid: process.pid, uptime: `${Math.floor(process.uptime())}s` });
    logger.kvBlock('Profile', { name: ENV.BOT_NAME, mode: ENV.MODE, prefix: settings.prefix || ENV.PREFIX, owner: ENV.OWNER_NAME || 'Unknown', ownerNumber: ENV.OWNER_NUMBER || 'Unknown', commandKeys: commandMap.size });
    logger.kvBlock('Settings', { autostatus: settings.autostatus, autoreact: settings.autoreact, autotyping: settings.autotyping, autorecording: settings.autorecording, sudoCount: Array.isArray(settings.sudo) ? settings.sudo.length : 0 });
    logger.kvBlock('Memory', { rss: formatMemoryMB(memory.rss), heapTotal: formatMemoryMB(memory.heapTotal), heapUsed: formatMemoryMB(memory.heapUsed), external: formatMemoryMB(memory.external) });
  }

  function startHealthReporter() {
    setInterval(() => {
      const memory = process.memoryUsage();
      const avgCommandMs = metrics.commands ? (metrics.totalCommandMs / metrics.commands).toFixed(1) : '0.0';
      logger.stat(`uptime=${formatUptimeShort(process.uptime())} messages=${metrics.messages} commands=${metrics.commands} failures=${metrics.commandFailures} avg=${avgCommandMs}ms`);
      logger.kvBlock('Runtime', { uptime: formatUptimeShort(process.uptime()), messages: metrics.messages, commands: metrics.commands, commandFailures: metrics.commandFailures, avgCommandMs, statusReads: metrics.statusReads, autoReacts: metrics.autoReacts, reconnects: metrics.reconnects, rss: formatMemoryMB(memory.rss), heapUsed: formatMemoryMB(memory.heapUsed) });
      persistRuntimeMetrics();
    }, 60 * 60 * 1000);
  }

  

  async function ensureAuthFromSession() {
    const credsPath = path.join(authDir, 'creds.json');
    
    // 1. Check if we already have a local session
    if (fs.existsSync(credsPath) && fs.statSync(credsPath).size > 0) {
      logger.info('Existing local session found. Skipping decoding.');
      return;
    }

    // 2. Check if we have a Base64 SESSION env variable
    const sessionData = ENV.SESSION || process.env.SESSION;
    if (!sessionData) {
      logger.warn('No local session or SESSION environment variable found. Bot will require pairing code.');
      return;
    }

    try {
      logger.info('Decoding SESSION variable...');
      // Decode Base64 back to JSON
      const decodedJson = Buffer.from(sessionData, 'base64').toString('utf-8');
      
      // Verify it's valid JSON before writing
      JSON.parse(decodedJson); 

      fs.mkdirSync(authDir, { recursive: true });
      fs.writeFileSync(credsPath, decodedJson, { mode: 0o600 });
      logger.success('Session loaded from SESSION environment variable!');
    } catch (error) {
      logger.error(`Failed to load SESSION variable: ${error.message}`);
      logger.warn('Make sure the SESSION variable is a valid Base64 string.');
    }
  }
  async function sendStatusLike(chatId, text, quoted, options = {}) {
    const settings = getBotSettings();
    const typingMs = options.typingMs ?? 900;
    if (settings.autorecording) await sock.sendPresenceUpdate('recording', chatId);
    else if (settings.autotyping) await sock.sendPresenceUpdate('typing', chatId);
    await delay(typingMs);
    await sock.sendMessage(chatId, { text }, { quoted });
    await sock.sendPresenceUpdate('paused', chatId);
  }

  function getMessageText(message) {
    return message?.conversation || message?.extendedTextMessage?.text || message?.imageMessage?.caption || message?.videoMessage?.caption || message?.buttonsResponseMessage?.selectedButtonId || message?.listResponseMessage?.singleSelectReply?.selectedRowId || '';
  }

  async function notifyOwnerDeployment() {
    if (!ENV.OWNER_NUMBER) return;
    const ownerJid = `${ENV.OWNER_NUMBER}@s.whatsapp.net`;
    const settings = getBotSettings();
    const body = ['Deployment complete', `Bot: ${ENV.BOT_NAME}`, `Owner: ${ENV.OWNER_NAME || 'Unknown'}`, `Prefix: ${settings.prefix || ENV.PREFIX}`, `Mode: ${ENV.MODE}`, `Uptime: ${Math.floor(process.uptime())}s`, `Commands loaded: ${getCommandNames().length}`].join('\n');
    try {
      await sock.sendMessage(ownerJid, { text: body });
      logger.success('Deployment summary delivered to the owner.');
    } catch (error) {
      logger.warn(`Could not deliver deployment summary: ${error?.message || error}`);
    }
  }

  function setupKeepAlive() {
    logger.step(1, 6, 'Starting keep-alive server');
    logger.info(`Keep-alive target port: ${ENV.PORT}`);
    keepAliveApp.get('/', (_req, res) => res.status(200).send('KLAUS MD is running'));
    keepAliveApp.listen(ENV.PORT, () => logger.step(2, 6, `Keep-alive server listening on ${ENV.PORT}`));
  }

  // Serialise outgoing messages with a small randomised gap. Bursts of instant sends are a
  // classic automation signal; tune with SEND_GAP_MS / SEND_JITTER_MS (0 disables).
  function installSendThrottle(s) {
    const gap = Number(process.env.SEND_GAP_MS ?? 1000);
    const jitter = Number(process.env.SEND_JITTER_MS ?? 800);
    if (!(gap > 0)) return;
    const original = s.sendMessage.bind(s);
    let chain = Promise.resolve();
    s.sendMessage = (...args) => {
      const result = chain.then(() => original(...args));
      chain = result.catch(() => {}).then(() => delay(gap + Math.random() * jitter));
      return result;
    };
  }

  async function startBot() {
    logger.step(3, 6, 'Preparing Baileys auth and socket');
    await ensureAuthFromSession();
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    if (!cachedVersion) {
      try { cachedVersion = (await fetchLatestWaWebVersion()).version; }
      catch (e) { logger.warn(`Could not fetch latest WA Web version (${e.message}); using library default.`); }
    }
    const version = cachedVersion || undefined;
    if (version) logger.step(4, 6, `Protocol version ${version.join('.')}`);

    sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      browser: ['KLAUS MD', 'Desktop', '1.0.0']
    });

    installSendThrottle(sock);
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      const statusCode = lastDisconnect?.error?.output?.statusCode;

      // Handle QR Code Generation
      if (qr) {
        console.log('\n=============================================');
        console.log('SCAN THIS QR CODE WITH YOUR WHATSAPP:');
        console.log('WhatsApp > Linked Devices > Link a Device\n');
        try {
          // Prints the QR code in the terminal
          await QRCode.toString(qr, { type: 'terminal', small: true }, (err, string) => {
            if (err) return console.error(err);
            console.log(string);
          });
        } catch (err) {
          console.log('Failed to generate terminal QR. Using raw string:', qr);
        }
        return;
      }

      if (connection === 'connecting') {
        logger.connection('🔄 Connecting to WhatsApp servers...');
        writeSessionStatus({ connection: 'connecting' });
        return;
      }

      if (connection === 'open') {
        logger.success('✅ WhatsApp connected successfully!');
        logger.info(`📱 Logged in as: ${sock.user?.name || 'Unknown'}`);
        logger.info(`🆔 Bot number: ${sock.user?.id.split(':')[0]}`);
        writeSessionStatus({ connection: 'open', connectedNumber: sock.user?.id.split(':')[0], connectedAt: new Date().toISOString() });
        logger.step(5, 6, 'Connection established');
        logger.banner({ botName: ENV.BOT_NAME, prefix: getActivePrefix(), mode: ENV.MODE });
        retryCount = 0;
        if (!ownerNotified) { ownerNotified = true; await notifyOwnerDeployment(); }
        return;
      }

      if (statusCode === DisconnectReason.loggedOut) {
        logger.error('🚪 Session logged out!');
        logger.warn('Delete the session folder and re-pair the bot.');
        return;
      }

      // Do not hammer WhatsApp when it is telling us to stop:
      // 440 = another device replaced this session, 403 = forbidden/banned.
      if (statusCode === DisconnectReason.connectionReplaced || statusCode === 403) {
        logger.error(`Stopped reconnecting (status ${statusCode}). Session replaced or number restricted.`);
        return;
      }

      if (connection === 'close') {
        const wait = Math.min(5000 * 2 ** retryCount, 5 * 60 * 1000);
        retryCount += 1;
        metrics.reconnects += 1;
        logger.warn(`♻️ Reconnecting in ${Math.round(wait / 1000)}s (attempt ${retryCount})...`);
        setTimeout(() => startBot().catch((e) => logger.errorTrace(e, 'reconnect')), wait);
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      const msg = messages[0];
      if (!msg?.message || msg.key?.remoteJid === 'status@broadcast') return;

      const chatId = msg.key.remoteJid;
      const sender = msg.key.participant || msg.key.remoteJid;
      const isGroup = chatId.endsWith('@g.us');
      const text = getMessageText(msg.message).trim();
      const settings = getBotSettings();
      const activePrefix = settings.prefix || ENV.PREFIX || '.';
      const senderNumber = String(sender || '').split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
      const isOwner = Boolean(ENV.OWNER_NUMBER) && senderNumber === ENV.OWNER_NUMBER;
      const isSudoUser = Array.isArray(settings.sudo) && settings.sudo.includes(senderNumber);

      metrics.messages += 1;
      logger.incoming(chatId, sender, isGroup, text.length);

      if (settings.autostatus && chatId === 'status@broadcast') {
        try { await sock.readMessages([msg.key]); metrics.statusReads += 1; } catch {}
      }

      if (settings.autoreact && chatId !== 'status@broadcast') {
        try { await sock.sendMessage(chatId, { react: { text: 'R', key: msg.key } }); metrics.autoReacts += 1; } catch {}
      }

      clearExpiredSessions(logger);
      const handledByMenu = await handleMenuReply({ sock, msg, sender, chatId, sendStatusLike, logger });
      if (handledByMenu) return;
      if (!text.startsWith(activePrefix)) return;

      const [rawCommand, ...args] = text.slice(activePrefix.length).trim().split(/\s+/);
      const invokedAs = rawCommand.toLowerCase();
      const command = commandMap.get(invokedAs);

      if (!command) return;
      if (ENV.MODE === 'private' && !isOwner && !isSudoUser) {
        await sendStatusLike(chatId, 'This command is restricted in private mode.', msg, { typingMs: 500 });
        return;
      }

      logger.command(command.name, sender);
      logger.commandStart(command.name, sender, args);
      metrics.commands += 1;
      const startedAt = Date.now();

      try {
        await command.execute({
          sock, msg, chatId, sender, args, env: { ...ENV, PREFIX: activePrefix }, invokedAs, isOwner, isSudoUser, isGroup,
          commandCount: getCommandNames().length, commandKeyCount: commandMap.size, commandNames: getCommandNames(), botSettings: settings, sendStatusLike, logger
        });
        const elapsed = Date.now() - startedAt;
        metrics.totalCommandMs += elapsed;
        logger.commandEnd(command.name, elapsed);
        persistRuntimeMetrics();
      } catch (error) {
        metrics.commandFailures += 1;
        logger.errorTrace(error, `command ${command.name}`);
        persistRuntimeMetrics();
        await sendStatusLike(chatId, 'Command failed while executing.', msg, { typingMs: 400 });
      }
    });

    writeSessionStatus({ generatedAt: new Date().toISOString(), lastBootAt: new Date().toISOString(), sessionPresent: Boolean(ENV.SESSION || process.env.SESSION) });
    persistRuntimeMetrics();
  }

  async function main() {
    setupKeepAlive();
    loadCommands();
    logStartupProfile();
    startHealthReporter();

    process.on('uncaughtException', (error) => logger.errorTrace(error, 'uncaughtException'));
    process.on('unhandledRejection', (reason) => {
      const error = reason instanceof Error ? reason : new Error(String(reason));
      logger.errorTrace(error, 'unhandledRejection');
    });

    await startBot();
  }

  main().catch((error) => {
    logger.errorTrace(error, 'startup');
    process.exit(1);
  });
}

startApplication();
