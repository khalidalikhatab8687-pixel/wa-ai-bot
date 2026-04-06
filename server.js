import 'dotenv/config';
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';
import QRCode from 'qrcode';
import pino from 'pino';
import fs from 'fs';
import makeWASocket, { useMultiFileAuthState, DisconnectReason, makeCacheableSignalKeyStore, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.use(cors());
app.use(express.json());

const logger = pino({ level: 'silent' });

// --- State ---
let whatsappSocket = null;
let connectionStatus = 'disconnected';
let currentQR = null;
let messageLogs = [];
const MAX_LOGS = 200;
let botEnabled = true;
let botPrompt = process.env.BOT_PROMPT || 'You are a helpful AI assistant.';
let botName = process.env.BOT_NAME || 'WA AI Assistant';
let ignoredNumbers = [];
let onlyRespondTo = [];
let conversationHistory = new Map();
const MAX_HISTORY = 10;

// --- Health Check (for UptimeRobot) ---
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    whatsapp: connectionStatus,
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// --- API Routes ---
app.get('/api/status', (req, res) => {
  res.json({
    connectionStatus,
    botEnabled,
    botName,
    botPrompt,
    totalMessages: messageLogs.length,
    ignoredNumbers,
    onlyRespondTo
  });
});

app.get('/api/qr', (req, res) => {
  res.json({ qr: currentQR, status: connectionStatus });
});

app.get('/api/logs', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const offset = parseInt(req.query.offset) || 0;
  res.json({
    logs: messageLogs.slice(offset, offset + limit),
    total: messageLogs.length
  });
});

app.post('/api/settings', (req, res) => {
  const { botEnabled: enabled, botPrompt: prompt, botName: name, ignoredNumbers: ignored, onlyRespondTo: only } = req.body;
  if (enabled !== undefined) botEnabled = enabled;
  if (prompt) botPrompt = prompt;
  if (name) botName = name;
  if (ignored) ignoredNumbers = ignored;
  if (only) onlyRespondTo = only;
  io.emit('settings_update', { botEnabled, botPrompt, botName, ignoredNumbers, onlyRespondTo });
  res.json({ success: true });
});

app.post('/api/send', async (req, res) => {
  const { number, message } = req.body;
  if (!whatsappSocket || connectionStatus !== 'connected') {
    return res.status(400).json({ error: 'WhatsApp not connected' });
  }
  try {
    const jid = number.includes('@') ? number : `${number}@s.whatsapp.net`;
    await whatsappSocket.sendMessage(jid, { text: message });
    addLog('outgoing_manual', number, message, null);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/disconnect', async (req, res) => {
  try {
    if (whatsappSocket) {
      await whatsappSocket.logout();
      whatsappSocket = null;
    }
    connectionStatus = 'disconnected';
    currentQR = null;
    io.emit('status_change', { status: connectionStatus });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/restart', async (req, res) => {
  try {
    if (whatsappSocket) {
      try { whatsappSocket.end(); } catch(e) {}
      whatsappSocket = null;
    }
    connectionStatus = 'disconnected';
    currentQR = null;
    io.emit('status_change', { status: connectionStatus });
    startWhatsApp();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/clear-logs', (req, res) => {
  messageLogs = [];
  io.emit('logs_cleared');
  res.json({ success: true });
});

// --- Serve React build in production ---
const clientBuildPath = path.join(__dirname, 'client', 'dist');
app.use(express.static(clientBuildPath));
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api') && !req.path.startsWith('/socket.io') && !req.path.startsWith('/health')) {
    res.sendFile(path.join(clientBuildPath, 'index.html'));
  }
});

// --- Helpers ---
function addLog(type, from, body, aiResponse) {
  const log = {
    id: Date.now() + Math.random(),
    type,
    from,
    body,
    aiResponse,
    timestamp: new Date().toISOString()
  };
  messageLogs.unshift(log);
  if (messageLogs.length > MAX_LOGS) messageLogs.pop();
  io.emit('new_message', log);
}

function getConversationHistory(phone) {
  if (!conversationHistory.has(phone)) {
    conversationHistory.set(phone, []);
  }
  return conversationHistory.get(phone);
}

function addToConversation(phone, role, content) {
  const history = getConversationHistory(phone);
  history.push({ role, content });
  if (history.length > MAX_HISTORY) {
    history.splice(0, history.length - MAX_HISTORY);
  }
}

// --- OpenRouter AI ---
async function getAIResponse(userMessage, phone) {
  try {
    const history = getConversationHistory(phone);
    const messages = [
      { role: 'system', content: botPrompt },
      ...history,
      { role: 'user', content: userMessage }
    ];

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://wa-ai-bot.onrender.com',
        'X-Title': 'WA AI Bot'
      },
      body: JSON.stringify({
        model: process.env.OPENROUTER_MODEL || 'openai/gpt-oss-120b:free',
        messages,
        max_tokens: 500,
        temperature: 0.7
      })
    });

    const data = await response.json();

    if (data.error) {
      console.error('OpenRouter Error:', data.error);
      return `⚠️ AI Error: ${data.error.message || 'Unknown error'}`;
    }

    const aiReply = data.choices?.[0]?.message?.content || 'Sorry, I could not generate a response.';

    addToConversation(phone, 'user', userMessage);
    addToConversation(phone, 'assistant', aiReply);

    return aiReply;
  } catch (err) {
    console.error('AI Request Error:', err.message);
    return '⚠️ Sorry, AI service is temporarily unavailable.';
  }
}

// --- WhatsApp with Baileys ---
async function startWhatsApp() {
  console.log('🚀 Starting WhatsApp connection...');
  connectionStatus = 'connecting';
  io.emit('status_change', { status: connectionStatus });

  try {
    const authDir = path.join(__dirname, 'auth_info');
    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    // Fetch latest WhatsApp Web version to avoid 405 errors
    let version;
    try {
      const versionInfo = await fetchLatestBaileysVersion();
      version = versionInfo.version;
      console.log(`📋 Using WA version: ${version}`);
    } catch (e) {
      console.log('⚠️ Could not fetch version, using default');
      version = [2, 3000, 1015901307];
    }

    const createSocket = makeWASocket.default || makeWASocket;
    const sock = createSocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger)
      },
      version,
      printQRInTerminal: false,
      logger,
      browser: ['Ubuntu', 'Chrome', '120.0.6099.119'],
      generateHighQualityLinkPreview: false,
      syncFullHistory: false,
      markOnlineOnConnect: true
    });

    whatsappSocket = sock;

    // Connection update handler
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log('📱 QR Code generated');
        try {
          const qrDataUrl = await QRCode.toDataURL(qr, {
            width: 300,
            margin: 2,
            color: { dark: '#000000', light: '#ffffff' }
          });
          currentQR = qrDataUrl;
          connectionStatus = 'qr';
          io.emit('qr_code', { qr: qrDataUrl });
          io.emit('status_change', { status: 'qr' });
        } catch (err) {
          console.error('QR generation error:', err);
        }
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        console.log(`❌ Connection closed. Status: ${statusCode}`);

        currentQR = null;
        whatsappSocket = null;

        if (statusCode === DisconnectReason.loggedOut) {
          connectionStatus = 'disconnected';
          io.emit('status_change', { status: 'disconnected' });
          console.log('📵 Logged out. Need to scan QR again.');
          const authPath = path.join(__dirname, 'auth_info');
          if (fs.existsSync(authPath)) {
            fs.rmSync(authPath, { recursive: true, force: true });
          }
          setTimeout(startWhatsApp, 5000);
        } else {
          connectionStatus = 'disconnected';
          io.emit('status_change', { status: 'disconnected' });
          console.log('🔄 Reconnecting in 5 seconds...');
          setTimeout(startWhatsApp, 5000);
        }
      }

      if (connection === 'open') {
        console.log('✅ WhatsApp Connected!');
        connectionStatus = 'connected';
        currentQR = null;
        io.emit('status_change', { status: 'connected' });
      }
    });

    // Save credentials on update
    sock.ev.on('creds.update', saveCreds);

    // Message handler
    sock.ev.on('messages.upsert', async (m) => {
      if (m.type !== 'notify') return;

      for (const msg of m.messages) {
        if (!msg.message) continue;
        if (msg.key.remoteJid === 'status@broadcast') continue;
        if (msg.key.remoteJid?.endsWith('@g.us')) continue;
        if (msg.key.fromMe) continue;

        const text = msg.message.conversation
          || msg.message.extendedTextMessage?.text
          || msg.message.imageMessage?.caption
          || msg.message.videoMessage?.caption
          || '';

        if (!text || text.trim() === '') continue;

        const phone = msg.key.remoteJid?.replace('@s.whatsapp.net', '') || 'unknown';
        console.log(`📩 Message from ${phone}: ${text}`);

        if (ignoredNumbers.includes(phone)) {
          addLog('ignored', phone, text, null);
          continue;
        }

        if (onlyRespondTo.length > 0 && !onlyRespondTo.includes(phone)) {
          addLog('filtered', phone, text, null);
          continue;
        }

        if (!botEnabled) {
          addLog('disabled', phone, text, null);
          continue;
        }

        try {
          await sock.presenceSubscribe(msg.key.remoteJid);
          await sock.sendPresenceUpdate('composing', msg.key.remoteJid);

          const aiResponse = await getAIResponse(text, phone);

          await sock.sendPresenceUpdate('paused', msg.key.remoteJid);
          await sock.sendMessage(msg.key.remoteJid, { text: aiResponse });

          addLog('auto_reply', phone, text, aiResponse);
          console.log(`🤖 Replied to ${phone}: ${aiResponse.substring(0, 80)}...`);
        } catch (err) {
          console.error(`❌ Error replying to ${phone}:`, err.message);
          addLog('error', phone, text, err.message);
        }
      }
    });

  } catch (err) {
    console.error('❌ WhatsApp connection error:', err.message);
    connectionStatus = 'disconnected';
    io.emit('status_change', { status: 'disconnected' });
    console.log('🔄 Retrying in 10 seconds...');
    setTimeout(startWhatsApp, 10000);
  }
}

// --- Socket.IO ---
io.on('connection', (socket) => {
  console.log('🔌 Dashboard connected');
  socket.emit('status_change', { status: connectionStatus });
  if (currentQR) {
    socket.emit('qr_code', { qr: currentQR });
  }
  socket.emit('settings_update', { botEnabled, botPrompt, botName, ignoredNumbers, onlyRespondTo });
});

// --- Start Server ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🌐 Server running on http://localhost:${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/health`);
  console.log(`🤖 AI Model: ${process.env.OPENROUTER_MODEL}`);
  console.log('');
  startWhatsApp();
});
