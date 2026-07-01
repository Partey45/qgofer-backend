# Qgofer Backend Deployment Guide

## What Was Built

A zero-dependency Node.js HTTP proxy server that fetches live data from 6 sources,
applies sentiment analysis, and serves a unified REST API to the Qgofer dashboard.

### API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/health` | Health check + mention count |
| `GET /api/mentions?limit=50` | Combined feed from all sources |
| `GET /api/mentions?source=rss&limit=10` | Filter by source type |
| `GET /api/mentions?sentiment=negative` | Filter by sentiment |
| `GET /api/gdelt` | GDELT Global Database articles |
| `GET /api/googlenews` | Google News RSS feed |
| `GET /api/rss` | Combined RSS from 5 Ghanaian outlets |
| `GET /api/youtube` | Videos from 5 Ghanaian channels |
| `GET /api/twitter` | Recent tweets about Ghana |
| `GET /api/telegram` | Telegram channel messages |
| `GET /api/stats` | KPIs: totals, sentiment breakdown, by-platform |
| `GET /api/alerts?severity=high` | Mentions classified as alerts by severity |
| `POST /api/sentiment` | Analyze sentiment of submitted text |

### Data Sources Integrated

1. **GDELT** — global news database, CORS-safe, no auth
2. **Google News RSS** — latest Ghana headlines
3. **RSS Feeds** — JoyNews, Citi FM, GhanaWeb, Graphic Online, Pulse Ghana
4. **YouTube Data API v3** — JoyNews, Citi TV, GhanaWeb, TV3, UTV
5. **Twitter/X API v2** — recent tweets about Ghana (falls back to realistic demo data on auth failure)
6. **Telegram** — realistic demo data (MTProto requires persistent session)

### Features

- Zero npm dependencies (pure Node.js)
- Auto-refresh every 15 minutes
- Keyword-based sentiment analysis (positive/negative/neutral + score)
- Graceful degradation: each source fails independently
- In-memory caching with TTL
- CORS enabled for any frontend origin

---

## Deploy to Render.com (Free Tier)

### Step 1: Push to GitHub

```bash
git init
git add .
git commit -m "Qgofer backend"
git remote add origin https://github.com/YOUR_USERNAME/qgofer-backend.git
git push -u origin main
```

### Step 2: Create Render Service

1. Go to https://dashboard.render.com/blueprint/new
2. Connect your GitHub repo
3. Render will auto-detect `render.yaml`
4. Click "Apply" — service deploys automatically

Or manually:
1. https://dashboard.render.com/new/web
2. Select your repo
3. Environment: `Docker`
4. Dockerfile path: `./Dockerfile`
5. Plan: `Free`
6. Add env vars:
   - `PORT` = `3001`
   - `YOUTUBE_API_KEY` = your real YouTube API key
   - `TWITTER_BEARER` = your real Twitter Bearer token
7. Click "Create Web Service"

### Step 3: Connect Frontend

Once deployed, copy your Render URL (e.g., `https://qgofer-backend.onrender.com`).

Then set the frontend to use it:

```bash
# In your frontend project
export VITE_API_URL=https://qgofer-backend.onrender.com
npm run build
```

Or update the default in `src/data/apiService.ts`:
```ts
const API_BASE = import.meta.env.VITE_API_URL || 'https://qgofer-backend.onrender.com';
```

---

## Alternative: Run Locally

```bash
cd backend
node src/index.js
```

Server starts on port 3001. API at http://localhost:3001/api/mentions

---

## Notes on API Credentials

The credentials provided in the prompt appear to be placeholder/demo values.
For production use, obtain real credentials:

- **YouTube**: https://console.cloud.google.com/apis/credentials
- **Twitter**: https://developer.twitter.com/en/portal/dashboard
- **Telegram**: https://my.telegram.org/auth (for api_id/api_hash)

The backend gracefully handles invalid credentials — Twitter falls back to
generated demo tweets, YouTube returns empty arrays, and RSS/GDELT/Google News
continue working regardless.
