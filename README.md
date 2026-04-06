# 🤖 WA AI Bot - WhatsApp Auto-Responder

AI-powered WhatsApp auto-responder with a beautiful React dashboard.

## Features
- 📱 QR Code scanning (no API key needed)
- 🤖 AI auto-replies powered by OpenRouter (GPT-OSS-120B)
- 💬 Real-time message logs
- ⚙️ Customizable bot settings
- 📤 Manual message sending
- 🔒 Number filtering (ignore/whitelist)

## Quick Start (Local)

```bash
# Install dependencies
npm install
cd client && npm install && cd ..

# Set up environment
# Edit .env with your OpenRouter API key

# Run server
npm start

# In another terminal, run React dev server
cd client && npm run dev
```

## Deploy to Render.com (Free)

1. Push to GitHub
2. Go to [render.com](https://render.com)
3. New → Web Service → Connect GitHub repo
4. Render will auto-detect the Dockerfile
5. Add environment variable: `OPENROUTER_API_KEY`
6. Deploy!

## Keep-Alive Setup (UptimeRobot)

1. Go to [uptimerobot.com](https://uptimerobot.com)
2. Create free account
3. Add New Monitor:
   - Type: HTTP(s)
   - URL: `https://your-app.onrender.com/health`
   - Interval: 5 minutes
4. Done! Your bot stays awake 24/7

## Tech Stack
- **Backend**: Node.js + Express + WPPConnect + Socket.IO
- **Frontend**: React + Vite
- **AI**: OpenRouter API (GPT-OSS-120B Free)
- **Deployment**: Docker + Render.com
