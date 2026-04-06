import { useState, useEffect, useCallback, useRef } from 'react';
import { io } from 'socket.io-client';

const SOCKET_URL = window.location.hostname === 'localhost'
  ? 'http://localhost:3000'
  : window.location.origin;

function App() {
  const [socket, setSocket] = useState(null);
  const [status, setStatus] = useState('disconnected');
  const [qrCode, setQrCode] = useState(null);
  const [logs, setLogs] = useState([]);
  const [activeTab, setActiveTab] = useState('logs');
  const [settings, setSettings] = useState({
    botEnabled: true,
    botName: 'WA AI Assistant',
    botPrompt: '',
    ignoredNumbers: [],
    onlyRespondTo: []
  });
  const [sendNumber, setSendNumber] = useState('');
  const [sendMessage, setSendMessage] = useState('');
  const [stats, setStats] = useState({ total: 0, replied: 0, errors: 0, ignored: 0 });
  const logsRef = useRef(null);

  // Connect to Socket.IO
  useEffect(() => {
    const s = io(SOCKET_URL, { transports: ['websocket', 'polling'] });

    s.on('connect', () => console.log('🔌 Socket connected'));
    s.on('disconnect', () => console.log('🔌 Socket disconnected'));

    s.on('status_change', (data) => {
      setStatus(data.status);
      if (data.status === 'connected') setQrCode(null);
    });

    s.on('qr_code', (data) => {
      setQrCode(data.qr);
      setStatus('qr');
    });

    s.on('new_message', (log) => {
      setLogs(prev => [log, ...prev].slice(0, 200));
    });

    s.on('settings_update', (data) => {
      setSettings(prev => ({ ...prev, ...data }));
    });

    s.on('logs_cleared', () => setLogs([]));

    s.on('error', (data) => {
      console.error('Server error:', data.message);
    });

    setSocket(s);

    // Fetch initial data
    fetchLogs();
    fetchStatus();

    return () => s.disconnect();
  }, []);

  // Calculate stats from logs
  useEffect(() => {
    const replied = logs.filter(l => l.type === 'auto_reply').length;
    const errors = logs.filter(l => l.type === 'error').length;
    const ignored = logs.filter(l => l.type === 'ignored' || l.type === 'filtered' || l.type === 'disabled').length;
    setStats({ total: logs.length, replied, errors, ignored });
  }, [logs]);

  const fetchLogs = useCallback(async () => {
    try {
      const res = await fetch(`${SOCKET_URL}/api/logs?limit=200`);
      const data = await res.json();
      setLogs(data.logs || []);
    } catch (err) { console.error('Failed to fetch logs'); }
  }, []);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch(`${SOCKET_URL}/api/status`);
      const data = await res.json();
      setStatus(data.connectionStatus);
      setSettings({
        botEnabled: data.botEnabled,
        botName: data.botName,
        botPrompt: data.botPrompt,
        ignoredNumbers: data.ignoredNumbers || [],
        onlyRespondTo: data.onlyRespondTo || []
      });
    } catch (err) { console.error('Failed to fetch status'); }
  }, []);

  const updateSettings = async (newSettings) => {
    try {
      await fetch(`${SOCKET_URL}/api/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newSettings)
      });
      setSettings(prev => ({ ...prev, ...newSettings }));
    } catch (err) { console.error('Failed to update settings'); }
  };

  const sendMsg = async () => {
    if (!sendNumber || !sendMessage) return;
    try {
      await fetch(`${SOCKET_URL}/api/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ number: sendNumber, message: sendMessage })
      });
      setSendMessage('');
    } catch (err) { console.error('Failed to send'); }
  };

  const handleRestart = async () => {
    try { await fetch(`${SOCKET_URL}/api/restart`, { method: 'POST' }); }
    catch (err) { console.error('Failed to restart'); }
  };

  const handleDisconnect = async () => {
    try { await fetch(`${SOCKET_URL}/api/disconnect`, { method: 'POST' }); }
    catch (err) { console.error('Failed to disconnect'); }
  };

  const clearLogs = async () => {
    try { await fetch(`${SOCKET_URL}/api/clear-logs`, { method: 'POST' }); }
    catch (err) { console.error('Failed to clear logs'); }
  };

  const formatTime = (ts) => {
    try {
      const d = new Date(ts);
      return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    } catch { return ''; }
  };

  const getTypeLabel = (type) => {
    const labels = {
      auto_reply: '🤖 AI Reply',
      error: '❌ Error',
      ignored: '🚫 Ignored',
      filtered: '🔒 Filtered',
      disabled: '⏸️ Disabled',
      outgoing_manual: '📤 Sent'
    };
    return labels[type] || type;
  };

  const getTypeAvatar = (type) => {
    const avatars = { auto_reply: '🤖', error: '❌', ignored: '🚫', filtered: '🔒', disabled: '⏸️', outgoing_manual: '📤' };
    return avatars[type] || '💬';
  };

  const statusLabels = {
    connected: '✅ Connected',
    disconnected: '❌ Disconnected',
    qr: '📱 Scan QR',
    connecting: '⏳ Connecting...'
  };

  return (
    <div className="app">
      {/* Header */}
      <header className="header">
        <div className="header-left">
          <div className="header-logo">🤖</div>
          <div>
            <div className="header-title">WA <span>AI</span> Bot</div>
            <div className="header-subtitle">Powered by OpenRouter • GPT-OSS-120B</div>
          </div>
        </div>
        <div className="header-right">
          <div className={`status-badge ${status}`}>
            <div className="status-dot"></div>
            {statusLabels[status] || status}
          </div>
          {status === 'connected' && (
            <button className="btn btn-danger" onClick={handleDisconnect}>⏏ Disconnect</button>
          )}
          {status === 'disconnected' && (
            <button className="btn btn-primary" onClick={handleRestart}>🔄 Reconnect</button>
          )}
        </div>
      </header>

      {/* Main Content */}
      <div className="main-content">
        {/* QR / Connection Section */}
        <div className="card qr-section">
          <div className="card-header">
            <h2>📱 WhatsApp Connection</h2>
          </div>
          <div className="card-body">
            {status === 'qr' && qrCode && (
              <div className="qr-display">
                <div className="qr-image-wrapper">
                  <img className="qr-image" src={qrCode} alt="QR Code" />
                </div>
                <p className="qr-instruction">
                  1. Open <strong>WhatsApp</strong> on your phone<br />
                  2. Go to <strong>Settings → Linked Devices</strong><br />
                  3. Tap <strong>"Link a Device"</strong><br />
                  4. <strong>Scan this QR Code</strong>
                </p>
              </div>
            )}
            {status === 'connected' && (
              <div className="connected-display">
                <div className="connected-icon">✅</div>
                <h3>WhatsApp Connected!</h3>
                <p>Your AI bot is active and responding to messages</p>
                <div className="btn-group" style={{ marginTop: 10 }}>
                  <button className="btn btn-secondary" onClick={handleRestart}>🔄 Restart</button>
                  <button className="btn btn-danger" onClick={handleDisconnect}>⏏ Disconnect</button>
                </div>
              </div>
            )}
            {status === 'connecting' && (
              <div className="connecting-display">
                <div className="spinner"></div>
                <p>Connecting to WhatsApp...</p>
                <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>This may take a moment</p>
              </div>
            )}
            {status === 'disconnected' && (
              <div className="disconnected-display">
                <div className="disconnected-icon">📵</div>
                <h3 style={{ color: 'var(--accent-red)' }}>Disconnected</h3>
                <p>Click reconnect to start the WhatsApp session</p>
                <button className="btn btn-primary" onClick={handleRestart} style={{ marginTop: 10 }}>
                  🔄 Start Connection
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Stats Row */}
        <div className="stats-row">
          <div className="stat-card green">
            <div className="stat-icon">💬</div>
            <div className="stat-value">{stats.total}</div>
            <div className="stat-label">Total Messages</div>
          </div>
          <div className="stat-card blue">
            <div className="stat-icon">🤖</div>
            <div className="stat-value">{stats.replied}</div>
            <div className="stat-label">AI Replies</div>
          </div>
          <div className="stat-card orange">
            <div className="stat-icon">🚫</div>
            <div className="stat-value">{stats.ignored}</div>
            <div className="stat-label">Ignored</div>
          </div>
          <div className="stat-card purple">
            <div className="stat-icon">❌</div>
            <div className="stat-value">{stats.errors}</div>
            <div className="stat-label">Errors</div>
          </div>
        </div>

        {/* Tabs Section */}
        <div className="card tabs-section">
          <div className="card-header">
            <div className="tabs-nav">
              <button className={`tab-btn ${activeTab === 'logs' ? 'active' : ''}`} onClick={() => setActiveTab('logs')}>
                📋 Message Logs
              </button>
              <button className={`tab-btn ${activeTab === 'settings' ? 'active' : ''}`} onClick={() => setActiveTab('settings')}>
                ⚙️ Settings
              </button>
              <button className={`tab-btn ${activeTab === 'send' ? 'active' : ''}`} onClick={() => setActiveTab('send')}>
                📤 Send Message
              </button>
            </div>
          </div>

          {/* Logs Tab */}
          {activeTab === 'logs' && (
            <>
              <div style={{ padding: '12px 20px', display: 'flex', justifyContent: 'flex-end' }}>
                <button className="btn btn-secondary" onClick={clearLogs}>🗑️ Clear Logs</button>
              </div>
              <div className="logs-container" ref={logsRef}>
                {logs.length === 0 ? (
                  <div className="empty-logs">
                    <span>📭</span>
                    <p>No messages yet</p>
                    <p style={{ fontSize: 12 }}>Messages will appear here in real-time</p>
                  </div>
                ) : (
                  logs.map((log) => (
                    <div key={log.id} className={`log-entry ${log.type}`}>
                      <div className="log-avatar">{getTypeAvatar(log.type)}</div>
                      <div className="log-content">
                        <div className="log-header">
                          <span className="log-phone">{log.from}</span>
                          <span className={`log-type ${log.type}`}>{getTypeLabel(log.type)}</span>
                          <span className="log-time">{formatTime(log.timestamp)}</span>
                        </div>
                        <div className="log-message">📩 {log.body}</div>
                        {log.aiResponse && (
                          <div className="log-ai-response">🤖 {log.aiResponse}</div>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </>
          )}

          {/* Settings Tab */}
          {activeTab === 'settings' && (
            <div className="settings-form">
              <div className="toggle-row">
                <div>
                  <div className="toggle-label">🤖 Bot Enabled</div>
                  <div className="toggle-desc">Toggle bot auto-replies on/off</div>
                </div>
                <label className="toggle-switch">
                  <input
                    type="checkbox"
                    checked={settings.botEnabled}
                    onChange={(e) => updateSettings({ botEnabled: e.target.checked })}
                  />
                  <span className="toggle-slider"></span>
                </label>
              </div>

              <div className="form-group">
                <label>🏷️ Bot Name</label>
                <input
                  type="text"
                  value={settings.botName}
                  onChange={(e) => setSettings(prev => ({ ...prev, botName: e.target.value }))}
                  onBlur={(e) => updateSettings({ botName: e.target.value })}
                  placeholder="Enter bot name..."
                />
              </div>

              <div className="form-group">
                <label>🧠 AI System Prompt</label>
                <textarea
                  value={settings.botPrompt}
                  onChange={(e) => setSettings(prev => ({ ...prev, botPrompt: e.target.value }))}
                  onBlur={(e) => updateSettings({ botPrompt: e.target.value })}
                  placeholder="Define how the AI should behave..."
                />
              </div>

              <div className="form-group">
                <label>🚫 Ignored Numbers (comma-separated)</label>
                <input
                  type="text"
                  value={(settings.ignoredNumbers || []).join(', ')}
                  onChange={(e) => {
                    const nums = e.target.value.split(',').map(n => n.trim()).filter(Boolean);
                    setSettings(prev => ({ ...prev, ignoredNumbers: nums }));
                  }}
                  onBlur={(e) => {
                    const nums = e.target.value.split(',').map(n => n.trim()).filter(Boolean);
                    updateSettings({ ignoredNumbers: nums });
                  }}
                  placeholder="e.g. 201234567890, 201987654321"
                />
              </div>

              <div className="form-group">
                <label>✅ Only Respond To (comma-separated, empty = all)</label>
                <input
                  type="text"
                  value={(settings.onlyRespondTo || []).join(', ')}
                  onChange={(e) => {
                    const nums = e.target.value.split(',').map(n => n.trim()).filter(Boolean);
                    setSettings(prev => ({ ...prev, onlyRespondTo: nums }));
                  }}
                  onBlur={(e) => {
                    const nums = e.target.value.split(',').map(n => n.trim()).filter(Boolean);
                    updateSettings({ onlyRespondTo: nums });
                  }}
                  placeholder="Leave empty to respond to everyone"
                />
              </div>
            </div>
          )}

          {/* Send Message Tab */}
          {activeTab === 'send' && (
            <div className="send-form">
              <p style={{ color: 'var(--text-secondary)', fontSize: 13 }}>
                Send a manual message to any WhatsApp number
              </p>
              <div className="form-group">
                <label>📱 Phone Number (with country code)</label>
                <input
                  type="text"
                  value={sendNumber}
                  onChange={(e) => setSendNumber(e.target.value)}
                  placeholder="e.g. 201234567890"
                />
              </div>
              <div className="form-group">
                <label>💬 Message</label>
                <textarea
                  value={sendMessage}
                  onChange={(e) => setSendMessage(e.target.value)}
                  placeholder="Type your message..."
                  style={{ minHeight: 80 }}
                />
              </div>
              <button
                className="btn btn-primary"
                onClick={sendMsg}
                disabled={status !== 'connected' || !sendNumber || !sendMessage}
                style={{ opacity: (status !== 'connected' || !sendNumber || !sendMessage) ? 0.5 : 1 }}
              >
                📤 Send Message
              </button>
              {status !== 'connected' && (
                <p style={{ color: 'var(--accent-red)', fontSize: 12 }}>
                  ⚠️ WhatsApp must be connected to send messages
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default App;
