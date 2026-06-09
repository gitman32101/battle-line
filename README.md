# ⚔️ Battle Line — Multiplayer

Real-time two-player card game. No accounts, no config, no database setup.

---

## Deploy in 5 minutes (free)

### Option A — Railway (recommended)

1. Go to [github.com](https://github.com) → New repository → name it `battle-line` → Create
2. Upload all these files (drag & drop the folder contents onto GitHub)
3. Go to [railway.app](https://railway.app) → Sign up with GitHub (free)
4. New Project → Deploy from GitHub repo → select `battle-line`
5. Wait ~60 seconds → Railway gives you a URL like `battle-line-production.up.railway.app`
6. Done. Share that URL with anyone.

### Option B — Render (also free)

1. Same GitHub setup as above
2. Go to [render.com](https://render.com) → New → Web Service → connect your repo
3. Build Command: `npm install`
4. Start Command: `node server.js`
5. Plan: Free → Create
6. Render gives you a URL like `battle-line.onrender.com`

> **Note:** Render free tier spins down after 15 min of inactivity (first load takes ~30s to wake).  
> Railway free tier stays awake. Railway is recommended.

---

## How to play

- Both players go to your deployed URL
- Player 1 clicks **Create Room** → gets a 6-character code like `WOLF42`
- Player 1 can also copy the invite link and send it directly
- Player 2 enters the code and clicks **Join Room**
- Game starts immediately — moves sync in real time

---

## Admin panel

Visit `/admin` on your deployed URL (e.g. `yourapp.railway.app/admin`).

Default password: `admin`

**To change the password:** Set the `ADMIN_PASSWORD` environment variable in Railway:
- Railway dashboard → your project → Variables → Add variable
- Name: `ADMIN_PASSWORD`, Value: whatever you want
- Railway redeploys automatically

The admin panel shows:
- Live room count, players online, games completed
- Every active room with player names, flag scores, whose turn it is
- Activity log (rooms created, joined, games won, rooms closed)
- Force-close any room
- Auto-refreshes every 5 seconds

---

## File structure

```
battle-line/
├── server.js          # WebSocket server + admin API (game logic lives here)
├── package.json
├── railway.json       # Railway deploy config
└── public/
    ├── index.html     # Game client (served to both players)
    └── admin.html     # Admin dashboard (/admin)
```

## Local development

```bash
npm install
npm start
# Open http://localhost:3000 in two browser tabs
```
