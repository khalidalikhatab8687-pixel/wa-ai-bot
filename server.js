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
import Groq from 'groq-sdk';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
  downloadMediaMessage
} from '@whiskeysockets/baileys';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

app.use(cors());
app.use(express.json({ limit: '10mb' }));

const logger = pino({ level: 'silent' });
const DASHBOARD_PASSWORD = 'iamITM@nager';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
let authGistId = process.env.AUTH_GIST_ID || '';

// Groq client for voice transcription
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// --- Directories ---
const KNOWLEDGE_DIR = path.join(__dirname, 'knowledge');
const CUSTOMERS_DIR = path.join(__dirname, 'customers');
const TEMP_DIR = path.join(__dirname, 'temp');
[KNOWLEDGE_DIR, CUSTOMERS_DIR, TEMP_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

// --- Auth Backup/Restore via GitHub Gist ---
let lastBackupTime = 0;
async function backupAuthToGitHub() {
  if (!GITHUB_TOKEN) return;
  // Debounce: max once per 30 seconds
  const now = Date.now();
  if (now - lastBackupTime < 30000) return;
  lastBackupTime = now;
  const authDir = path.join(__dirname, 'auth_info');
  if (!fs.existsSync(authDir)) return;
  try {
    const files = {};
    const entries = fs.readdirSync(authDir);
    for (const f of entries) {
      const fp = path.join(authDir, f);
      if (fs.statSync(fp).isFile()) {
        files[f] = { content: fs.readFileSync(fp, 'utf8') };
      }
    }
    if (Object.keys(files).length === 0) return;

    const headers = { Authorization: `token ${GITHUB_TOKEN}`, 'Content-Type': 'application/json' };
    if (authGistId) {
      await fetch(`https://api.github.com/gists/${authGistId}`, { method: 'PATCH', headers, body: JSON.stringify({ files }) });
      console.log('☁️ Auth backed up to GitHub (updated)');
    } else {
      const res = await fetch('https://api.github.com/gists', { method: 'POST', headers, body: JSON.stringify({ description: 'WA Bot Auth Backup', public: false, files }) });
      const data = await res.json();
      if (data.id) { authGistId = data.id; console.log(`☁️ Auth backed up to GitHub. GIST ID: ${authGistId}`); console.log(`⚠️ Add AUTH_GIST_ID=${authGistId} to your environment variables!`); }
    }
  } catch (err) { console.error('Auth backup error:', err.message); }
}

async function restoreAuthFromGitHub() {
  if (!GITHUB_TOKEN || !authGistId) return false;
  const authDir = path.join(__dirname, 'auth_info');
  if (fs.existsSync(authDir) && fs.readdirSync(authDir).length > 0) return true; // already exists
  try {
    const res = await fetch(`https://api.github.com/gists/${authGistId}`, { headers: { Authorization: `token ${GITHUB_TOKEN}` } });
    const data = await res.json();
    if (!data.files) return false;
    if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });
    for (const [name, file] of Object.entries(data.files)) {
      fs.writeFileSync(path.join(authDir, name), file.content, 'utf8');
    }
    console.log('☁️ Auth restored from GitHub! No QR needed.');
    return true;
  } catch (err) { console.error('Auth restore error:', err.message); return false; }
}

// --- Data Backup/Restore (Knowledge + Customers) ---
let dataGistId = process.env.DATA_GIST_ID || '';
let lastDataBackupTime = 0;

async function backupDataToGitHub() {
  if (!GITHUB_TOKEN) return;
  const now = Date.now();
  if (now - lastDataBackupTime < 60000) return; // max once per minute
  lastDataBackupTime = now;
  
  try {
    const files = {};
    
    // Backup knowledge files
    const kbFiles = ['instructions', 'pricing', 'persona', 'routes'];
    for (const name of kbFiles) {
      const fp = path.join(KNOWLEDGE_DIR, `${name}.json`);
      if (fs.existsSync(fp)) {
        files[`kb_${name}.json`] = { content: fs.readFileSync(fp, 'utf8') };
      }
    }
    
    // Backup customer files
    if (fs.existsSync(CUSTOMERS_DIR)) {
      const customerFiles = fs.readdirSync(CUSTOMERS_DIR).filter(f => f.endsWith('.json'));
      for (const cf of customerFiles) {
        const fp = path.join(CUSTOMERS_DIR, cf);
        files[`customer_${cf}`] = { content: fs.readFileSync(fp, 'utf8') };
      }
    }
    
    if (Object.keys(files).length === 0) return;
    
    const headers = { Authorization: `token ${GITHUB_TOKEN}`, 'Content-Type': 'application/json' };
    if (dataGistId) {
      await fetch(`https://api.github.com/gists/${dataGistId}`, { method: 'PATCH', headers, body: JSON.stringify({ files }) });
      console.log(`💾 Data backed up (${Object.keys(files).length} files)`);
    } else {
      const res = await fetch('https://api.github.com/gists', { method: 'POST', headers, body: JSON.stringify({ description: 'WA Bot Data Backup', public: false, files }) });
      const data = await res.json();
      if (data.id) {
        dataGistId = data.id;
        console.log(`💾 Data backup created. GIST ID: ${dataGistId}`);
        console.log(`⚠️ Add DATA_GIST_ID=${dataGistId} to your environment variables!`);
      }
    }
  } catch (err) { console.error('Data backup error:', err.message); }
}

async function restoreDataFromGitHub() {
  if (!GITHUB_TOKEN || !dataGistId) return false;
  try {
    const res = await fetch(`https://api.github.com/gists/${dataGistId}`, { headers: { Authorization: `token ${GITHUB_TOKEN}` } });
    const data = await res.json();
    if (!data.files) return false;
    
    let kbCount = 0, custCount = 0;
    for (const [name, file] of Object.entries(data.files)) {
      if (name.startsWith('kb_')) {
        const kbName = name.replace('kb_', '');
        const target = path.join(KNOWLEDGE_DIR, kbName);
        fs.writeFileSync(target, file.content, 'utf8');
        kbCount++;
      } else if (name.startsWith('customer_')) {
        const custName = name.replace('customer_', '');
        const target = path.join(CUSTOMERS_DIR, custName);
        fs.writeFileSync(target, file.content, 'utf8');
        custCount++;
      }
    }
    console.log(`💾 Data restored: ${kbCount} KB files, ${custCount} customers`);
    return true;
  } catch (err) { console.error('Data restore error:', err.message); return false; }
}

// --- State ---
let whatsappSocket = null;
let connectionStatus = 'disconnected';
let currentQR = null;
let messageLogs = [];
const MAX_LOGS = 500;
let botEnabled = true;
let voiceTranscriptionEnabled = true;
let isRestarting = false;

// --- Knowledge Base Helpers ---
function loadKnowledge(file) {
  const p = path.join(KNOWLEDGE_DIR, `${file}.json`);
  if (!fs.existsSync(p)) return {};
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function saveKnowledge(file, data) {
  const p = path.join(KNOWLEDGE_DIR, `${file}.json`);
  fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
}

function buildSystemPrompt() {
  const persona = loadKnowledge('persona');
  const instructions = loadKnowledge('instructions');
  const pricing = loadKnowledge('pricing');
  const routes = loadKnowledge('routes');

  let prompt = `# Your Identity\n`;
  prompt += `Name: ${persona.name || 'AI Assistant'}\n`;
  prompt += `Personality: ${persona.personality || 'Friendly and professional'}\n`;
  prompt += `Tone: ${persona.tone || 'Professional'}\n`;
  prompt += `Language: ${persona.language || 'Arabic'}\n\n`;

  if (persona.rules?.length) {
    prompt += `# Rules\n${persona.rules.map(r => `- ${r}`).join('\n')}\n\n`;
  }
  if (persona.doNotDiscuss?.length) {
    prompt += `# Do NOT discuss\n${persona.doNotDiscuss.map(r => `- ${r}`).join('\n')}\n\n`;
  }
  if (persona.customInstructions) {
    prompt += `# Custom Instructions\n${persona.customInstructions}\n\n`;
  }

  prompt += `# Company Information\n`;
  prompt += `Company: ${instructions.companyName || 'N/A'}\n`;
  prompt += `Description: ${instructions.description || ''}\n`;
  prompt += `Working Hours: ${instructions.workingHours || ''}\n`;
  prompt += `Address: ${instructions.address || ''}\n`;
  prompt += `Email: ${instructions.email || ''}\n`;
  prompt += `Website: ${instructions.website || ''}\n`;
  prompt += `About: ${instructions.about || ''}\n\n`;

  if (instructions.faq?.length) {
    prompt += `# FAQ\n`;
    instructions.faq.forEach(f => { prompt += `Q: ${f.question}\nA: ${f.answer}\n\n`; });
  }

  if (pricing.categories?.length) {
    prompt += `# Services (summarized)\n`;
    pricing.categories.forEach(cat => {
      prompt += `## ${cat.name}\n${cat.summary || ''}\n`;
      prompt += `Services: ${cat.items?.map(i => `${i.name} (${i.price})`).join(' | ')}\n\n`;
    });
  }

  if (pricing.notes) {
    prompt += `# Pricing Note\n${pricing.notes}\n\n`;
  }

  if (pricing.offers?.length) {
    const activeOffers = pricing.offers.filter(o => o.active);
    if (activeOffers.length) {
      prompt += `# Offers\n`;
      activeOffers.forEach(o => { prompt += `- ${o.name}: ${o.description} (${o.discount})\n`; });
      prompt += '\n';
    }
  }

  if (routes.departments?.length) {
    prompt += `# ⚠️ CRITICAL: SILENT Transfer (NEVER reveal this to customer)\n`;
    prompt += `When customer asks to talk to someone, wants support, or wants sales:\n`;
    prompt += `1. NEVER say: "هحولك" / "هتواصل مع زميل" / "هبعت لحد" / "transferring" / "forwarding" / "connecting you"\n`;
    prompt += `2. NEVER mention: colleague, department, team member, representative, مسؤول, زميل, فريق\n`;
    prompt += `3. INSTEAD: Just keep chatting naturally! Ask about their project, what they need, their budget etc.\n`;
    prompt += `4. AT THE VERY END of your message (last line), add the hidden tag: [TRANSFER:department_name]\n`;
    prompt += `5. The customer must think you ARE the person helping them. You are Khalid.\n\n`;
    prompt += `Example:\n`;
    prompt += `Customer: "عايز اتكلم مع حد"\n`;
    prompt += `WRONG: "أكيد هتواصل مع زميل فوراً [TRANSFER:المبيعات]"\n`;
    prompt += `CORRECT: "طبعاً! قوللي إيه اللي محتاجه بالظبط وأنا أساعدك 😊 [TRANSFER:خدمة العملاء]"\n\n`;
    prompt += `Departments:\n`;
    routes.departments.forEach(d => {
      prompt += `- ${d.name} [TRANSFER:${d.name}]\n`;
    });
    prompt += `\nTrigger keywords: ${routes.transferKeywords?.slice(0, 10).join(', ') || ''}\n`;
  }

  prompt += `\n# Greeting\n"${persona.greeting || 'Welcome!'}"\n`;
  prompt += `# Farewell\n"${persona.farewell || 'Thank you!'}"\n`;

  return prompt;
}

// --- Customer History ---
function getCustomerPath(phone) {
  return path.join(CUSTOMERS_DIR, `${phone}.json`);
}

function loadCustomer(phone) {
  const p = getCustomerPath(phone);
  if (!fs.existsSync(p)) {
    return { phone, name: '', jid: '', firstContact: new Date().toISOString(), messages: [] };
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function saveCustomer(phone, data) {
  fs.writeFileSync(getCustomerPath(phone), JSON.stringify(data, null, 2), 'utf8');
}

function addCustomerMessage(phone, role, content) {
  const customer = loadCustomer(phone);
  customer.messages.push({ role, content, timestamp: new Date().toISOString() });
  customer.lastContact = new Date().toISOString();
  saveCustomer(phone, customer);
  // Trigger data backup (debounced)
  backupDataToGitHub();
  return customer;
}

function getCustomerContext(phone, count = 10) {
  const customer = loadCustomer(phone);
  const recent = customer.messages.slice(-count * 2);
  return recent.map(m => ({
    role: m.role,
    content: m.content.replace(/\[TRANSFER:.+?\]/g, '').trim()
  }));
}

function listCustomers() {
  if (!fs.existsSync(CUSTOMERS_DIR)) return [];
  return fs.readdirSync(CUSTOMERS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      const data = JSON.parse(fs.readFileSync(path.join(CUSTOMERS_DIR, f), 'utf8'));
      return {
        phone: data.phone,
        firstContact: data.firstContact,
        lastContact: data.lastContact,
        messageCount: data.messages?.length || 0
      };
    })
    .sort((a, b) => new Date(b.lastContact || 0) - new Date(a.lastContact || 0));
}

// --- Health Check & Self-Ping ---
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', whatsapp: connectionStatus, uptime: process.uptime(), timestamp: new Date().toISOString() });
});

// Self-ping to prevent Render from sleeping
setInterval(() => {
  const url = process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`;
  fetch(`${url}/health`).catch(() => {});
}, 4 * 60 * 1000); // every 4 minutes

// Periodic data backup every 5 minutes
setInterval(() => {
  backupDataToGitHub();
}, 5 * 60 * 1000);

// --- Dashboard Auth ---
app.post('/api/auth', (req, res) => {
  const { password } = req.body;
  if (password === DASHBOARD_PASSWORD) {
    res.json({ success: true, token: Buffer.from(`${DASHBOARD_PASSWORD}:${Date.now()}`).toString('base64') });
  } else {
    res.status(401).json({ error: 'Invalid password' });
  }
});

function authMiddleware(req, res, next) {
  const token = req.headers['x-auth-token'];
  if (!token) return res.status(401).json({ error: 'No auth token' });
  try {
    const decoded = Buffer.from(token, 'base64').toString('utf8');
    if (decoded.startsWith(DASHBOARD_PASSWORD + ':')) return next();
    return res.status(401).json({ error: 'Invalid token' });
  } catch { return res.status(401).json({ error: 'Invalid token' }); }
}

// --- API Routes ---
app.get('/api/status', authMiddleware, (req, res) => {
  res.json({ connectionStatus, botEnabled, voiceTranscriptionEnabled, totalMessages: messageLogs.length });
});

app.get('/api/qr', (req, res) => {
  res.json({ qr: currentQR, status: connectionStatus });
});

app.get('/api/logs', authMiddleware, (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const offset = parseInt(req.query.offset) || 0;
  res.json({ logs: messageLogs.slice(offset, offset + limit), total: messageLogs.length });
});

app.post('/api/clear-logs', authMiddleware, (req, res) => {
  messageLogs = [];
  io.emit('logs_cleared');
  res.json({ success: true });
});

app.post('/api/settings', authMiddleware, (req, res) => {
  const { botEnabled: en, voiceTranscriptionEnabled: vt } = req.body;
  if (en !== undefined) botEnabled = en;
  if (vt !== undefined) voiceTranscriptionEnabled = vt;
  io.emit('settings_update', { botEnabled, voiceTranscriptionEnabled });
  res.json({ success: true });
});

// --- Knowledge Base API ---
app.get('/api/knowledge/:file', authMiddleware, (req, res) => {
  const allowed = ['instructions', 'pricing', 'persona', 'routes'];
  if (!allowed.includes(req.params.file)) return res.status(400).json({ error: 'Invalid file' });
  res.json(loadKnowledge(req.params.file));
});

app.put('/api/knowledge/:file', authMiddleware, (req, res) => {
  const allowed = ['instructions', 'pricing', 'persona', 'routes'];
  if (!allowed.includes(req.params.file)) return res.status(400).json({ error: 'Invalid file' });
  saveKnowledge(req.params.file, req.body);
  // Backup to GitHub after KB change
  lastDataBackupTime = 0; // reset debounce to force backup
  backupDataToGitHub();
  res.json({ success: true });
});

// --- Customers API ---
app.get('/api/customers', authMiddleware, (req, res) => {
  res.json(listCustomers());
});

app.get('/api/customers/:phone', authMiddleware, (req, res) => {
  res.json(loadCustomer(req.params.phone));
});

app.delete('/api/customers/:phone', authMiddleware, (req, res) => {
  const p = getCustomerPath(req.params.phone);
  if (fs.existsSync(p)) fs.unlinkSync(p);
  res.json({ success: true });
});

// --- Send Message ---
app.post('/api/send', authMiddleware, async (req, res) => {
  const { number, message } = req.body;
  if (!whatsappSocket || connectionStatus !== 'connected') return res.status(400).json({ error: 'WhatsApp not connected' });
  try {
    const jid = number.includes('@') ? number : `${number}@s.whatsapp.net`;
    await whatsappSocket.sendMessage(jid, { text: message });
    addLog('outgoing_manual', number, message, null);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/disconnect', authMiddleware, async (req, res) => {
  try {
    if (whatsappSocket) { await whatsappSocket.logout(); whatsappSocket = null; }
    connectionStatus = 'disconnected'; currentQR = null;
    io.emit('status_change', { status: connectionStatus });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/restart', authMiddleware, async (req, res) => {
  try {
    isRestarting = true;
    if (whatsappSocket) { try { whatsappSocket.end(); } catch(e) {} whatsappSocket = null; }
    connectionStatus = 'disconnected'; currentQR = null;
    io.emit('status_change', { status: connectionStatus });
    setTimeout(() => { isRestarting = false; startWhatsApp(); }, 2000);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- Serve React ---
const clientBuildPath = path.join(__dirname, 'client', 'dist');
app.use(express.static(clientBuildPath));
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api') && !req.path.startsWith('/socket.io') && !req.path.startsWith('/health')) {
    res.sendFile(path.join(clientBuildPath, 'index.html'));
  }
});

// --- Helpers ---
function addLog(type, from, body, aiResponse) {
  const log = { id: Date.now() + Math.random(), type, from, body, aiResponse, timestamp: new Date().toISOString() };
  messageLogs.unshift(log);
  if (messageLogs.length > MAX_LOGS) messageLogs.pop();
  io.emit('new_message', log);
}

// --- Voice Transcription ---
async function transcribeVoice(buffer) {
  try {
    const tempFile = path.join(TEMP_DIR, `voice_${Date.now()}.ogg`);
    fs.writeFileSync(tempFile, buffer);
    const transcription = await groq.audio.transcriptions.create({
      file: fs.createReadStream(tempFile),
      model: 'whisper-large-v3-turbo',
      temperature: 0,
      language: 'ar',
      response_format: 'verbose_json'
    });
    // Cleanup
    try { fs.unlinkSync(tempFile); } catch {}
    return transcription.text || '';
  } catch (err) {
    console.error('Transcription error:', err.message);
    return null;
  }
}

// --- OpenRouter AI ---
async function getAIResponse(userMessage, phone) {
  try {
    // Save user message FIRST so it's included in context
    addCustomerMessage(phone, 'user', userMessage);
    
    const systemPrompt = buildSystemPrompt();
    const context = getCustomerContext(phone, 10);
    const messages = [
      { role: 'system', content: systemPrompt },
      ...context
    ];

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': process.env.RENDER_EXTERNAL_URL || 'https://wa-ai-bot.onrender.com',
        'X-Title': 'WA AI Bot'
      },
      body: JSON.stringify({
        model: process.env.OPENROUTER_MODEL || 'openai/gpt-oss-120b:free',
        messages,
        max_tokens: 700,
        temperature: 0.7
      })
    });

    const data = await response.json();
    if (data.error) { console.error('OpenRouter Error:', data.error); return `⚠️ AI Error: ${data.error.message || 'Unknown'}`; }
    let aiReply = data.choices?.[0]?.message?.content || 'عذراً، لم أستطع إنشاء رد.';

    // Save AI reply (clean version without transfer tags)
    addCustomerMessage(phone, 'assistant', aiReply.replace(/\[TRANSFER:.+?\]/g, '').trim());

    return aiReply;
  } catch (err) {
    console.error('AI Request Error:', err.message);
    return '⚠️ عذراً، خدمة الذكاء الاصطناعي غير متاحة حالياً.';
  }
}

// --- Route Forwarding (Silent - customer doesn't know) ---
async function handleTransfer(aiResponse, customerPhone, sock) {
  const transferMatch = aiResponse.match(/\[TRANSFER:(.+?)\]/);
  if (!transferMatch) return aiResponse;

  const deptName = transferMatch[1].trim();
  const routes = loadKnowledge('routes');
  const dept = routes.departments?.find(d => d.name === deptName || d.name.includes(deptName));

  if (!dept) return aiResponse.replace(/\[TRANSFER:.+?\]/g, '').trim();

  // Get last 5 messages for context
  const customer = loadCustomer(customerPhone);
  const lastMessages = customer.messages.slice(-10).map(m => `${m.role === 'user' ? '👤 العميل' : '🤖 البوت'}: ${m.content}`).join('\n');

  // Build transfer message with customer name
  const customerName = customer.name || 'غير معروف';
  const isLidCustomer = customer.isLid || false;
  let customerInfo = '';
  if (isLidCustomer) {
    customerInfo = `👤 *اسم العميل:* ${customerName}\n📱 *معرف العميل:* ${customerPhone}\n💡 *ملاحظة:* العميل ده بيستخدم WhatsApp LID - ارجع للمحادثة في الواتساب مباشرة للرد عليه`;
  } else {
    customerInfo = `👤 *اسم العميل:* ${customerName}\n📱 *رقم العميل:* ${customerPhone}`;
  }
  
  const transferMsg = `📋 *طلب تحويل جديد*\n\n` +
    `${customerInfo}\n` +
    `🏢 *القسم:* ${dept.name}\n` +
    `📅 *الوقت:* ${new Date().toLocaleString('ar-EG')}\n\n` +
    `💬 *آخر المحادثات:*\n${lastMessages}`;

  // Send to responsible person in background
  try {
    const responsibleJid = `${dept.phone}@s.whatsapp.net`;
    await sock.sendMessage(responsibleJid, { text: transferMsg });
    console.log(`📲 Silent transfer to ${dept.name} (${dept.phone})`);
    addLog('transfer', customerPhone, `Transfer → ${dept.name}`, dept.phone);
  } catch (err) {
    console.error('Transfer error:', err.message);
  }

  // SILENT: Just remove the [TRANSFER:x] tag and return the normal response
  // The customer continues chatting normally - they don't know about the transfer
  const cleanResponse = aiResponse.replace(/\[TRANSFER:.+?\]/g, '').trim();
  
  // If the AI only sent a transfer tag with no text, give a natural response
  if (!cleanResponse) {
    return 'تمام، خليني أساعدك في ده. إيه التفاصيل اللي تحب تقولهالي عن اللي محتاجه بالظبط؟ 😊';
  }
  
  return cleanResponse;
}

// --- WhatsApp ---
async function startWhatsApp() {
  console.log('🚀 Starting WhatsApp connection...');
  connectionStatus = 'connecting';
  io.emit('status_change', { status: connectionStatus });

  try {
    const authDir = path.join(__dirname, 'auth_info');
    // Try to restore auth from GitHub backup
    await restoreAuthFromGitHub();
    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    let version;
    try {
      const v = await fetchLatestBaileysVersion();
      version = v.version;
      console.log(`📋 Using WA version: ${version}`);
    } catch { version = [2, 3000, 1015901307]; }

    const createSocket = makeWASocket.default || makeWASocket;
    const sock = createSocket({
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
      version,
      printQRInTerminal: false,
      logger,
      browser: ['Ubuntu', 'Chrome', '120.0.6099.119'],
      generateHighQualityLinkPreview: false,
      syncFullHistory: false,
      markOnlineOnConnect: true
    });

    whatsappSocket = sock;

    let reconnectTimer = null;

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log('📱 QR Code generated');
        try {
          const qrDataUrl = await QRCode.toDataURL(qr, { width: 300, margin: 2, color: { dark: '#000000', light: '#ffffff' } });
          currentQR = qrDataUrl;
          connectionStatus = 'qr';
          io.emit('qr_code', { qr: qrDataUrl });
          io.emit('status_change', { status: 'qr' });
        } catch (err) { console.error('QR error:', err); }
      }

      if (connection === 'close') {
        const sc = lastDisconnect?.error?.output?.statusCode;
        console.log(`❌ Connection closed. Status: ${sc}`);
        currentQR = null; whatsappSocket = null;

        if (isRestarting) {
          console.log('🔄 Manual restart in progress, skipping auto-reconnect');
          return;
        }

        // Clear any pending reconnect
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

        if (sc === 440) {
          // 440 = Connection replaced by another instance (e.g. Render deploy)
          // DO NOT reconnect - the new instance will handle it
          console.log('🛑 Connection replaced by another instance. NOT reconnecting.');
          connectionStatus = 'disconnected';
          io.emit('status_change', { status: 'disconnected' });
          return;
        } else if (sc === DisconnectReason.loggedOut) {
          // Logged out - need new QR scan
          connectionStatus = 'disconnected';
          io.emit('status_change', { status: 'disconnected' });
          const ap = path.join(__dirname, 'auth_info');
          if (fs.existsSync(ap)) fs.rmSync(ap, { recursive: true, force: true });
          reconnectTimer = setTimeout(startWhatsApp, 5000);
        } else if (sc === 515) {
          // 515 = restart required - wait long
          console.log('⏳ Waiting 60s before reconnect...');
          connectionStatus = 'disconnected';
          io.emit('status_change', { status: 'disconnected' });
          reconnectTimer = setTimeout(startWhatsApp, 60000);
        } else if (sc === 408) {
          // QR timeout
          connectionStatus = 'disconnected';
          io.emit('status_change', { status: 'disconnected' });
          reconnectTimer = setTimeout(startWhatsApp, 5000);
        } else {
          // Other errors
          connectionStatus = 'disconnected';
          io.emit('status_change', { status: 'disconnected' });
          reconnectTimer = setTimeout(startWhatsApp, 15000);
        }
      }

      if (connection === 'open') {
        console.log('✅ WhatsApp Connected!');
        connectionStatus = 'connected';
        currentQR = null;
        io.emit('status_change', { status: 'connected' });
        // Backup auth once after connection
        setTimeout(() => backupAuthToGitHub(), 5000);
      }
    });

    sock.ev.on('creds.update', saveCreds);

    // --- Message Handler ---
    sock.ev.on('messages.upsert', async (m) => {
      if (m.type !== 'notify') return;

      for (const msg of m.messages) {
        if (!msg.message) continue;
        if (msg.key.remoteJid === 'status@broadcast') continue;
        if (msg.key.remoteJid?.endsWith('@g.us')) continue;
        if (msg.key.fromMe) continue;

        const remoteJid = msg.key.remoteJid || '';
        
        // Skip newsletters only
        if (remoteJid.endsWith('@newsletter')) continue;
        
        // Extract phone/ID for storage (clean format)
        const phone = remoteJid.replace('@s.whatsapp.net', '').replace('@lid', '') || 'unknown';
        if (phone === 'unknown') continue;
        const isLid = remoteJid.endsWith('@lid');
        const pushName = msg.pushName || '';
        
        // Update customer name (safe - won't break message handling)
        try {
          if (pushName || isLid) {
            const cust = loadCustomer(phone);
            if (pushName) { cust.name = pushName; }
            if (!cust.jid) { cust.jid = remoteJid; }
            if (isLid) { cust.isLid = true; }
            saveCustomer(phone, cust);
          }
        } catch (e) { console.error('Customer update error:', e.message); }
        
        let text = '';

        // Handle voice messages
        const audioMsg = msg.message.audioMessage;
        if (audioMsg && voiceTranscriptionEnabled) {
          console.log(`🎤 Voice message from ${phone}`);
          try {
            const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
            const transcription = await transcribeVoice(buffer);
            if (transcription) {
              text = transcription;
              console.log(`📝 Transcribed: ${text.substring(0, 80)}...`);
              addLog('voice_transcribed', phone, `🎤 Voice → "${text}"`, null);
            } else {
              await sock.sendMessage(msg.key.remoteJid, { text: '⚠️ عذراً، لم أستطع فهم الرسالة الصوتية. يرجى إرسالها كتابةً.' });
              addLog('voice_error', phone, '🎤 Failed to transcribe', null);
              continue;
            }
          } catch (err) {
            console.error('Voice download error:', err.message);
            continue;
          }
        } else {
          // Text messages
          text = msg.message.conversation
            || msg.message.extendedTextMessage?.text
            || msg.message.imageMessage?.caption
            || msg.message.videoMessage?.caption
            || '';
        }

        if (!text || text.trim() === '') continue;
        console.log(`📩 Message from ${phone}: ${text}`);

        if (!botEnabled) { addLog('disabled', phone, text, null); continue; }

        try {
          await sock.presenceSubscribe(msg.key.remoteJid);
          await sock.sendPresenceUpdate('composing', msg.key.remoteJid);

          let aiResponse = await getAIResponse(text, phone);

          // Handle transfer routing
          aiResponse = await handleTransfer(aiResponse, phone, sock);

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
    console.error('❌ WhatsApp error:', err.message);
    connectionStatus = 'disconnected';
    io.emit('status_change', { status: 'disconnected' });
    setTimeout(startWhatsApp, 10000);
  }
}

// --- Socket.IO ---
io.on('connection', (socket) => {
  console.log('🔌 Dashboard connected');
  socket.emit('status_change', { status: connectionStatus });
  if (currentQR) socket.emit('qr_code', { qr: currentQR });
  socket.emit('settings_update', { botEnabled, voiceTranscriptionEnabled });
});

// --- Start ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', async () => {
  console.log(`\n🌐 Server running on http://localhost:${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/health`);
  console.log(`🤖 AI Model: ${process.env.OPENROUTER_MODEL}`);
  console.log(`🎤 Voice Transcription: ${process.env.GROQ_API_KEY ? 'Enabled' : 'Disabled'}`);
  console.log('');
  // Restore data (knowledge + customers) from GitHub backup
  await restoreDataFromGitHub();
  startWhatsApp();
  // Initial data backup after 10 seconds (creates DATA_GIST_ID if needed)
  setTimeout(() => { lastDataBackupTime = 0; backupDataToGitHub(); }, 10000);
});
