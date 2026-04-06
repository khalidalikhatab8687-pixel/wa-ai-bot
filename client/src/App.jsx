import { useState, useEffect, useCallback, useRef } from 'react';
import { io } from 'socket.io-client';
import './index.css';

const API = window.location.hostname === 'localhost' ? 'http://localhost:3000' : '';

function api(path, opts = {}) {
  const token = localStorage.getItem('wa_token');
  return fetch(`${API}${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'x-auth-token': token || '', ...opts.headers }
  }).then(r => { if (r.status === 401) { localStorage.removeItem('wa_token'); window.location.reload(); } return r.json(); });
}

// ========== LOGIN ==========
function LoginPage({ onLogin }) {
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  const submit = async (e) => {
    e.preventDefault();
    setErr('');
    try {
      const data = await fetch(`${API}/api/auth`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pw }) }).then(r => r.json());
      if (data.success) { localStorage.setItem('wa_token', data.token); onLogin(); }
      else setErr('❌ كلمة مرور خاطئة');
    } catch { setErr('❌ خطأ في الاتصال'); }
  };
  return (
    <div className="login-page">
      <form className="login-box" onSubmit={submit}>
        <div className="login-icon">🛡️</div>
        <h1>WA AI Control Panel</h1>
        <p>Enter password to access the dashboard</p>
        {err && <div className="login-error">{err}</div>}
        <input className="login-input" type="password" placeholder="Password..." value={pw} onChange={e => setPw(e.target.value)} autoFocus />
        <button className="login-btn" type="submit">🔓 Login</button>
      </form>
    </div>
  );
}

// ========== MAIN APP ==========
function App() {
  const [auth, setAuth] = useState(!!localStorage.getItem('wa_token'));
  const [page, setPage] = useState('dashboard');
  const [socket, setSocket] = useState(null);
  const [status, setStatus] = useState('disconnected');
  const [qr, setQr] = useState(null);
  const [logs, setLogs] = useState([]);
  const [settings, setSettings] = useState({ botEnabled: true, voiceTranscriptionEnabled: true });
  const [customers, setCustomers] = useState([]);
  const [selCustomer, setSelCustomer] = useState(null);
  const [customerChat, setCustomerChat] = useState(null);
  const [kb, setKb] = useState({});
  const [kbTab, setKbTab] = useState('instructions');
  const [sendNum, setSendNum] = useState('');
  const [sendMsg, setSendMsg] = useState('');

  useEffect(() => {
    if (!auth) return;
    const s = io(API || window.location.origin, { transports: ['websocket', 'polling'] });
    s.on('status_change', d => { setStatus(d.status); if (d.status === 'connected') setQr(null); });
    s.on('qr_code', d => { setQr(d.qr); setStatus('qr'); });
    s.on('new_message', log => setLogs(prev => [log, ...prev].slice(0, 500)));
    s.on('settings_update', d => setSettings(prev => ({ ...prev, ...d })));
    s.on('logs_cleared', () => setLogs([]));
    setSocket(s);
    fetchLogs(); fetchStatus();
    return () => s.disconnect();
  }, [auth]);

  const fetchLogs = () => api('/api/logs?limit=200').then(d => setLogs(d.logs || [])).catch(() => {});
  const fetchStatus = () => api('/api/status').then(d => { setStatus(d.connectionStatus); setSettings({ botEnabled: d.botEnabled, voiceTranscriptionEnabled: d.voiceTranscriptionEnabled }); }).catch(() => {});
  const fetchCustomers = () => api('/api/customers').then(d => setCustomers(d)).catch(() => {});
  const fetchCustomerChat = (phone) => { setSelCustomer(phone); api(`/api/customers/${phone}`).then(d => setCustomerChat(d)).catch(() => {}); };
  const deleteCustomer = (phone) => { if (confirm('حذف محادثات هذا العميل؟')) api(`/api/customers/${phone}`, { method: 'DELETE' }).then(() => { fetchCustomers(); setSelCustomer(null); setCustomerChat(null); }); };
  const loadKb = (file) => { setKbTab(file); api(`/api/knowledge/${file}`).then(d => setKb(d)).catch(() => {}); };

  const saveKb = () => api(`/api/knowledge/${kbTab}`, { method: 'PUT', body: JSON.stringify(kb) }).then(() => alert('✅ تم الحفظ بنجاح'));
  const updateSetting = (key, val) => api('/api/settings', { method: 'POST', body: JSON.stringify({ [key]: val }) });
  const clearLogs = () => api('/api/clear-logs', { method: 'POST' });
  const restart = () => api('/api/restart', { method: 'POST' });
  const disconnect = () => api('/api/disconnect', { method: 'POST' });
  const sendMessage = () => { if (!sendNum || !sendMsg) return; api('/api/send', { method: 'POST', body: JSON.stringify({ number: sendNum, message: sendMsg }) }).then(() => setSendMsg('')); };

  useEffect(() => { if (auth && page === 'customers') fetchCustomers(); }, [page, auth]);
  useEffect(() => { if (auth && page === 'knowledge') loadKb('instructions'); }, [page, auth]);

  const stats = { total: logs.length, replied: logs.filter(l => l.type === 'auto_reply').length, voice: logs.filter(l => l.type === 'voice_transcribed').length, errors: logs.filter(l => l.type === 'error').length };
  const formatTime = ts => { try { return new Date(ts).toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' }); } catch { return ''; } };

  if (!auth) return <LoginPage onLogin={() => setAuth(true)} />;

  const statusLabel = { connected: '🟢 Connected', disconnected: '🔴 Disconnected', qr: '🟡 Scan QR', connecting: '🟡 Connecting...' };
  const statusClass = { connected: 'online', disconnected: 'offline', qr: 'pending', connecting: 'pending' };

  return (
    <div className="layout">
      {/* SIDEBAR */}
      <aside className="sidebar">
        <div className="sidebar-brand">
          <div className="sidebar-logo">🤖</div>
          <h2>WA <span>AI</span><small>Control Panel</small></h2>
        </div>
        <nav className="sidebar-nav">
          <div className="nav-section">
            <div className="nav-section-title">Main</div>
            {[
              { id: 'dashboard', icon: '📊', label: 'Dashboard' },
              { id: 'connection', icon: '📱', label: 'Connection' },
              { id: 'logs', icon: '📋', label: 'Message Logs', badge: stats.total },
            ].map(n => (
              <div key={n.id} className={`nav-item ${page === n.id ? 'active' : ''}`} onClick={() => setPage(n.id)}>
                <span className="nav-icon">{n.icon}</span>
                <span>{n.label}</span>
                {n.badge > 0 && <span className="nav-badge">{n.badge}</span>}
              </div>
            ))}
          </div>
          <div className="nav-section">
            <div className="nav-section-title">Knowledge Base</div>
            <div className={`nav-item ${page === 'knowledge' ? 'active' : ''}`} onClick={() => setPage('knowledge')}>
              <span className="nav-icon">🧠</span><span>Knowledge Base</span>
            </div>
          </div>
          <div className="nav-section">
            <div className="nav-section-title">CRM</div>
            <div className={`nav-item ${page === 'customers' ? 'active' : ''}`} onClick={() => setPage('customers')}>
              <span className="nav-icon">👥</span><span>Customers</span>
              {customers.length > 0 && <span className="nav-badge">{customers.length}</span>}
            </div>
          </div>
          <div className="nav-section">
            <div className="nav-section-title">Tools</div>
            {[
              { id: 'send', icon: '📤', label: 'Send Message' },
              { id: 'settings', icon: '⚙️', label: 'Settings' },
            ].map(n => (
              <div key={n.id} className={`nav-item ${page === n.id ? 'active' : ''}`} onClick={() => setPage(n.id)}>
                <span className="nav-icon">{n.icon}</span><span>{n.label}</span>
              </div>
            ))}
          </div>
        </nav>
        <div className="sidebar-footer">
          <div className="sidebar-status">
            <div className={`status-dot-sm ${statusClass[status] || 'offline'}`}></div>
            <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>{statusLabel[status] || status}</span>
          </div>
        </div>
      </aside>

      {/* MAIN */}
      <div className="main">
        <div className="topbar">
          <h1>{{ dashboard: '📊 Dashboard', connection: '📱 Connection', logs: '📋 Message Logs', knowledge: '🧠 Knowledge Base', customers: '👥 Customers', send: '📤 Send Message', settings: '⚙️ Settings' }[page]}</h1>
          <div className="topbar-actions">
            {status === 'connected' && <button className="btn btn-danger btn-sm" onClick={disconnect}>⏏ Disconnect</button>}
            {status === 'disconnected' && <button className="btn btn-primary btn-sm" onClick={restart}>🔄 Reconnect</button>}
          </div>
        </div>

        <div className="content">
          {/* ===== DASHBOARD ===== */}
          {page === 'dashboard' && (
            <>
              <div className="stat-grid">
                <div className="stat-box blue"><div className="stat-icon">💬</div><div className="stat-val">{stats.total}</div><div className="stat-label">Total Messages</div></div>
                <div className="stat-box green"><div className="stat-icon">🤖</div><div className="stat-val">{stats.replied}</div><div className="stat-label">AI Replies</div></div>
                <div className="stat-box purple"><div className="stat-icon">🎤</div><div className="stat-val">{stats.voice}</div><div className="stat-label">Voice Messages</div></div>
                <div className="stat-box orange"><div className="stat-icon">❌</div><div className="stat-val">{stats.errors}</div><div className="stat-label">Errors</div></div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                <div className="card">
                  <div className="card-head"><h3>📋 Recent Activity</h3></div>
                  <div className="card-content">
                    <div className="log-list" style={{ maxHeight: 300 }}>
                      {logs.slice(0, 8).map(log => (
                        <div key={log.id} className={`log-row ${log.type}`}>
                          <div className="log-icon">{log.type === 'auto_reply' ? '🤖' : log.type === 'voice_transcribed' ? '🎤' : '📩'}</div>
                          <div className="log-body">
                            <div className="log-head"><span className="log-phone">{log.from}</span><span className="log-time">{formatTime(log.timestamp)}</span></div>
                            <div className="log-msg">{log.body?.substring(0, 80)}</div>
                          </div>
                        </div>
                      ))}
                      {logs.length === 0 && <div className="empty"><span className="empty-icon">📭</span><p>No activity yet</p></div>}
                    </div>
                  </div>
                </div>
                <div className="card">
                  <div className="card-head"><h3>⚡ Quick Status</h3></div>
                  <div className="card-content">
                    <div className="toggle-row"><div className="toggle-info"><div className="toggle-title">🤖 Bot Auto-Reply</div><div className="toggle-desc">AI responds automatically</div></div>
                      <label className="toggle"><input type="checkbox" checked={settings.botEnabled} onChange={e => { setSettings(p => ({...p, botEnabled: e.target.checked})); updateSetting('botEnabled', e.target.checked); }} /><span className="toggle-track"></span></label>
                    </div>
                    <div className="toggle-row"><div className="toggle-info"><div className="toggle-title">🎤 Voice Transcription</div><div className="toggle-desc">Groq Whisper transcription</div></div>
                      <label className="toggle"><input type="checkbox" checked={settings.voiceTranscriptionEnabled} onChange={e => { setSettings(p => ({...p, voiceTranscriptionEnabled: e.target.checked})); updateSetting('voiceTranscriptionEnabled', e.target.checked); }} /><span className="toggle-track"></span></label>
                    </div>
                    <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
                      <button className="btn btn-primary btn-sm" onClick={restart}>🔄 Restart Bot</button>
                      <button className="btn btn-ghost btn-sm" onClick={() => setPage('knowledge')}>🧠 Knowledge Base</button>
                    </div>
                  </div>
                </div>
              </div>
            </>
          )}

          {/* ===== CONNECTION ===== */}
          {page === 'connection' && (
            <div className="card">
              <div className="card-head"><h3>📱 WhatsApp Connection</h3></div>
              <div className="card-content">
                {status === 'qr' && qr && (
                  <div className="qr-container">
                    <div className="qr-wrap"><img src={qr} alt="QR" /></div>
                    <div className="qr-steps">1. Open <strong>WhatsApp</strong> → <strong>Settings → Linked Devices</strong><br/>2. Tap <strong>"Link a Device"</strong> → <strong>Scan this QR</strong></div>
                  </div>
                )}
                {status === 'connected' && (
                  <div className="connected-badge"><div className="con-icon">✅</div><h3>WhatsApp Connected!</h3><p style={{ color: 'var(--text-dim)', fontSize: 13 }}>Bot is active and responding</p>
                    <div style={{ display: 'flex', gap: 8, marginTop: 8 }}><button className="btn btn-ghost" onClick={restart}>🔄 Restart</button><button className="btn btn-danger" onClick={disconnect}>⏏ Disconnect</button></div>
                  </div>
                )}
                {status === 'disconnected' && <div className="connected-badge"><div className="con-icon" style={{ background: 'rgba(239,68,68,.1)', borderColor: 'rgba(239,68,68,.2)' }}>📵</div><h3 style={{ color: 'var(--red)' }}>Disconnected</h3><button className="btn btn-primary" onClick={restart}>🔄 Start Connection</button></div>}
                {status === 'connecting' && <div className="connected-badge"><div className="con-icon" style={{ background: 'rgba(245,158,11,.1)', borderColor: 'rgba(245,158,11,.2)' }}>⏳</div><h3 style={{ color: 'var(--orange)' }}>Connecting...</h3></div>}
              </div>
            </div>
          )}

          {/* ===== LOGS ===== */}
          {page === 'logs' && (
            <div className="card">
              <div className="card-head"><h3>📋 Message Logs ({logs.length})</h3><button className="btn btn-ghost btn-sm" onClick={clearLogs}>🗑️ Clear</button></div>
              <div className="card-content">
                <div className="log-list">
                  {logs.map(log => (
                    <div key={log.id} className={`log-row ${log.type}`}>
                      <div className="log-icon">{log.type === 'auto_reply' ? '🤖' : log.type === 'error' ? '❌' : log.type === 'voice_transcribed' ? '🎤' : '📩'}</div>
                      <div className="log-body">
                        <div className="log-head"><span className="log-phone">{log.from}</span><span className={`log-tag ${log.type}`}>{log.type.replace('_', ' ')}</span><span className="log-time">{formatTime(log.timestamp)}</span></div>
                        <div className="log-msg">{log.body}</div>
                        {log.aiResponse && <div className="log-ai">🤖 {log.aiResponse}</div>}
                      </div>
                    </div>
                  ))}
                  {logs.length === 0 && <div className="empty"><span className="empty-icon">📭</span><p>No messages yet</p></div>}
                </div>
              </div>
            </div>
          )}

          {/* ===== KNOWLEDGE BASE ===== */}
          {page === 'knowledge' && (
            <div className="card">
              <div className="card-head"><h3>🧠 Knowledge Base</h3><button className="btn btn-primary btn-sm" onClick={saveKb}>💾 Save Changes</button></div>
              <div className="card-content">
                <div className="kb-tabs">
                  {[{ id: 'instructions', icon: '🏢', label: 'Instructions' }, { id: 'pricing', icon: '💰', label: 'Pricing' }, { id: 'persona', icon: '🎭', label: 'Persona' }, { id: 'routes', icon: '📞', label: 'Routes' }].map(t => (
                    <button key={t.id} className={`kb-tab ${kbTab === t.id ? 'active' : ''}`} onClick={() => loadKb(t.id)}>{t.icon} {t.label}</button>
                  ))}
                </div>
                <KnowledgeEditor data={kb} onChange={setKb} tab={kbTab} />
              </div>
            </div>
          )}

          {/* ===== CUSTOMERS ===== */}
          {page === 'customers' && (
            <div className="customer-grid">
              <div className="card">
                <div className="card-head"><h3>👥 Customers ({customers.length})</h3><button className="btn btn-ghost btn-sm" onClick={fetchCustomers}>🔄</button></div>
                <div className="card-content customer-list">
                  {customers.map(c => (
                    <div key={c.phone} className={`customer-item ${selCustomer === c.phone ? 'active' : ''}`} onClick={() => fetchCustomerChat(c.phone)}>
                      <div className="customer-avatar">👤</div>
                      <div className="customer-info"><div className="name">{c.phone}</div><div className="meta">{c.messageCount} msgs • {c.lastContact ? formatTime(c.lastContact) : 'N/A'}</div></div>
                    </div>
                  ))}
                  {customers.length === 0 && <div className="empty"><span className="empty-icon">👥</span><p>No customers yet</p></div>}
                </div>
              </div>
              <div className="card">
                <div className="card-head"><h3>💬 {selCustomer || 'Select a customer'}</h3>{selCustomer && <button className="btn btn-danger btn-sm" onClick={() => deleteCustomer(selCustomer)}>🗑️ Delete</button>}</div>
                <div className="card-content" style={{ padding: 0 }}>
                  {customerChat ? (
                    <div className="customer-chat">
                      {customerChat.messages?.map((m, i) => (
                        <div key={i} className={`chat-bubble ${m.role}`}>
                          {m.content}
                          <div className="chat-time">{formatTime(m.timestamp)}</div>
                        </div>
                      ))}
                      {customerChat.messages?.length === 0 && <div className="empty"><p>No messages</p></div>}
                    </div>
                  ) : <div className="empty"><span className="empty-icon">💬</span><p>Select a customer to view chat</p></div>}
                </div>
              </div>
            </div>
          )}

          {/* ===== SEND MESSAGE ===== */}
          {page === 'send' && (
            <div className="card">
              <div className="card-head"><h3>📤 Send Manual Message</h3></div>
              <div className="card-content">
                <div className="form-group"><label>📱 Phone (with country code)</label><input className="form-input" value={sendNum} onChange={e => setSendNum(e.target.value)} placeholder="201234567890" /></div>
                <div className="form-group"><label>💬 Message</label><textarea className="form-textarea" value={sendMsg} onChange={e => setSendMsg(e.target.value)} placeholder="Type message..." /></div>
                <button className="btn btn-primary" onClick={sendMessage} disabled={status !== 'connected'}>📤 Send</button>
                {status !== 'connected' && <p style={{ color: 'var(--red)', fontSize: 11, marginTop: 8 }}>⚠️ WhatsApp must be connected</p>}
              </div>
            </div>
          )}

          {/* ===== SETTINGS ===== */}
          {page === 'settings' && (
            <div className="card">
              <div className="card-head"><h3>⚙️ Bot Settings</h3></div>
              <div className="card-content">
                <div className="toggle-row"><div className="toggle-info"><div className="toggle-title">🤖 Bot Auto-Reply</div><div className="toggle-desc">Enable/disable automatic AI responses</div></div>
                  <label className="toggle"><input type="checkbox" checked={settings.botEnabled} onChange={e => { setSettings(p => ({...p, botEnabled: e.target.checked})); updateSetting('botEnabled', e.target.checked); }} /><span className="toggle-track"></span></label>
                </div>
                <div className="toggle-row"><div className="toggle-info"><div className="toggle-title">🎤 Voice Transcription</div><div className="toggle-desc">Transcribe voice messages with Groq Whisper</div></div>
                  <label className="toggle"><input type="checkbox" checked={settings.voiceTranscriptionEnabled} onChange={e => { setSettings(p => ({...p, voiceTranscriptionEnabled: e.target.checked})); updateSetting('voiceTranscriptionEnabled', e.target.checked); }} /><span className="toggle-track"></span></label>
                </div>
                <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
                  <button className="btn btn-primary" onClick={restart}>🔄 Restart Bot</button>
                  <button className="btn btn-danger" onClick={disconnect}>⏏ Disconnect</button>
                  <button className="btn btn-ghost" onClick={() => { localStorage.removeItem('wa_token'); window.location.reload(); }}>🚪 Logout</button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ========== KNOWLEDGE EDITOR ==========
function KnowledgeEditor({ data, onChange, tab }) {
  const update = (key, val) => onChange({ ...data, [key]: val });
  const updateNested = (arrKey, idx, field, val) => {
    const arr = [...(data[arrKey] || [])];
    arr[idx] = { ...arr[idx], [field]: val };
    onChange({ ...data, [arrKey]: arr });
  };
  const addItem = (arrKey, template) => onChange({ ...data, [arrKey]: [...(data[arrKey] || []), template] });
  const removeItem = (arrKey, idx) => { const arr = [...(data[arrKey] || [])]; arr.splice(idx, 1); onChange({ ...data, [arrKey]: arr }); };

  if (tab === 'instructions') return (
    <div>
      {['companyName', 'description', 'workingHours', 'address', 'email', 'website'].map(k => (
        <div className="form-group" key={k}><label>{k}</label><input className="form-input" value={data[k] || ''} onChange={e => update(k, e.target.value)} /></div>
      ))}
      <div className="form-group"><label>About (detailed)</label><textarea className="form-textarea" value={data.about || ''} onChange={e => update('about', e.target.value)} /></div>
      <div className="form-group"><label>Additional Info</label><textarea className="form-textarea" value={data.additionalInfo || ''} onChange={e => update('additionalInfo', e.target.value)} /></div>
      <h4 style={{ margin: '16px 0 8px', fontSize: 13 }}>❓ FAQ</h4>
      {(data.faq || []).map((f, i) => (
        <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
          <input className="form-input" placeholder="Question" value={f.question} onChange={e => updateNested('faq', i, 'question', e.target.value)} style={{ flex: 1 }} />
          <input className="form-input" placeholder="Answer" value={f.answer} onChange={e => updateNested('faq', i, 'answer', e.target.value)} style={{ flex: 1 }} />
          <button className="btn btn-danger btn-sm" onClick={() => removeItem('faq', i)}>✕</button>
        </div>
      ))}
      <button className="btn btn-ghost btn-sm" onClick={() => addItem('faq', { question: '', answer: '' })}>+ Add FAQ</button>
    </div>
  );

  if (tab === 'pricing') return (
    <div>
      {(data.categories || []).map((cat, ci) => (
        <div key={ci} className="card" style={{ marginBottom: 16 }}>
          <div className="card-head"><input className="form-input" value={cat.name} onChange={e => { const cats = [...(data.categories || [])]; cats[ci] = { ...cats[ci], name: e.target.value }; update('categories', cats); }} style={{ border: 'none', background: 'transparent', fontWeight: 600, fontSize: 14, padding: 0 }} />
            <button className="btn btn-danger btn-sm" onClick={() => removeItem('categories', ci)}>✕</button></div>
          <div className="card-content">
            {(cat.items || []).map((item, ii) => (
              <div key={ii} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 100px auto', gap: 8, marginBottom: 8 }}>
                <input className="form-input" placeholder="Name" value={item.name} onChange={e => { const cats = [...(data.categories || [])]; cats[ci].items[ii] = { ...cats[ci].items[ii], name: e.target.value }; update('categories', cats); }} />
                <input className="form-input" placeholder="Description" value={item.description || ''} onChange={e => { const cats = [...(data.categories || [])]; cats[ci].items[ii] = { ...cats[ci].items[ii], description: e.target.value }; update('categories', cats); }} />
                <input className="form-input" placeholder="Price" value={item.price || ''} onChange={e => { const cats = [...(data.categories || [])]; cats[ci].items[ii] = { ...cats[ci].items[ii], price: e.target.value }; update('categories', cats); }} />
                <button className="btn btn-danger btn-sm" onClick={() => { const cats = [...(data.categories || [])]; cats[ci].items.splice(ii, 1); update('categories', cats); }}>✕</button>
              </div>
            ))}
            <button className="btn btn-ghost btn-sm" onClick={() => { const cats = [...(data.categories || [])]; cats[ci].items = [...(cats[ci].items || []), { name: '', description: '', price: '', available: true }]; update('categories', cats); }}>+ Add Item</button>
          </div>
        </div>
      ))}
      <button className="btn btn-primary btn-sm" onClick={() => addItem('categories', { name: 'New Category', items: [] })}>+ Add Category</button>
      <h4 style={{ margin: '20px 0 8px', fontSize: 13 }}>🏷️ Offers</h4>
      {(data.offers || []).map((o, i) => (
        <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 80px 100px auto', gap: 8, marginBottom: 8 }}>
          <input className="form-input" placeholder="Offer name" value={o.name} onChange={e => updateNested('offers', i, 'name', e.target.value)} />
          <input className="form-input" placeholder="Description" value={o.description || ''} onChange={e => updateNested('offers', i, 'description', e.target.value)} />
          <input className="form-input" placeholder="Discount" value={o.discount || ''} onChange={e => updateNested('offers', i, 'discount', e.target.value)} />
          <input className="form-input" type="date" value={o.validUntil || ''} onChange={e => updateNested('offers', i, 'validUntil', e.target.value)} />
          <button className="btn btn-danger btn-sm" onClick={() => removeItem('offers', i)}>✕</button>
        </div>
      ))}
      <button className="btn btn-ghost btn-sm" onClick={() => addItem('offers', { name: '', description: '', discount: '', validUntil: '', active: true })}>+ Add Offer</button>
    </div>
  );

  if (tab === 'persona') return (
    <div>
      {['name', 'personality', 'tone', 'language', 'greeting', 'farewell'].map(k => (
        <div className="form-group" key={k}><label>{k}</label>{k === 'greeting' || k === 'farewell' ? <textarea className="form-textarea" style={{ minHeight: 60 }} value={data[k] || ''} onChange={e => update(k, e.target.value)} /> : <input className="form-input" value={data[k] || ''} onChange={e => update(k, e.target.value)} />}</div>
      ))}
      <div className="form-group"><label>Rules (one per line)</label><textarea className="form-textarea" value={(data.rules || []).join('\n')} onChange={e => update('rules', e.target.value.split('\n').filter(Boolean))} /></div>
      <div className="form-group"><label>Do NOT discuss (one per line)</label><textarea className="form-textarea" value={(data.doNotDiscuss || []).join('\n')} onChange={e => update('doNotDiscuss', e.target.value.split('\n').filter(Boolean))} /></div>
      <div className="form-group"><label>Custom Instructions</label><textarea className="form-textarea" style={{ minHeight: 120 }} value={data.customInstructions || ''} onChange={e => update('customInstructions', e.target.value)} /></div>
    </div>
  );

  if (tab === 'routes') return (
    <div>
      <div className="form-group"><label>Transfer confirmation message</label><textarea className="form-textarea" value={data.transferMessage || ''} onChange={e => update('transferMessage', e.target.value)} /></div>
      <div className="form-group"><label>Transfer keywords (comma-separated)</label><input className="form-input" value={(data.transferKeywords || []).join(', ')} onChange={e => update('transferKeywords', e.target.value.split(',').map(s => s.trim()).filter(Boolean))} /></div>
      <h4 style={{ margin: '16px 0 8px', fontSize: 13 }}>📞 Departments</h4>
      {(data.departments || []).map((d, i) => (
        <div key={i} className="card" style={{ marginBottom: 12 }}>
          <div className="card-content" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div className="form-group"><label>Name</label><input className="form-input" value={d.name} onChange={e => updateNested('departments', i, 'name', e.target.value)} /></div>
            <div className="form-group"><label>Phone</label><input className="form-input" value={d.phone} onChange={e => updateNested('departments', i, 'phone', e.target.value)} /></div>
            <div className="form-group"><label>Description</label><input className="form-input" value={d.description || ''} onChange={e => updateNested('departments', i, 'description', e.target.value)} /></div>
            <div className="form-group"><label>Keywords (comma)</label><input className="form-input" value={(d.keywords || []).join(', ')} onChange={e => { const deps = [...(data.departments || [])]; deps[i] = { ...deps[i], keywords: e.target.value.split(',').map(s => s.trim()).filter(Boolean) }; onChange({ ...data, departments: deps }); }} /></div>
            <button className="btn btn-danger btn-sm" onClick={() => removeItem('departments', i)}>✕ Remove</button>
          </div>
        </div>
      ))}
      <button className="btn btn-primary btn-sm" onClick={() => addItem('departments', { name: '', phone: '', keywords: [], description: '' })}>+ Add Department</button>
    </div>
  );

  return null;
}

export default App;
