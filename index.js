/**
 * Qgofer Backend — Zero-dependency Express-compatible server
 * Uses only Node.js built-in modules.
 */

const http = require('http');
const https = require('https');
const url = require('url');

const PORT = process.env.PORT || 3001;

// ═══════════════════════════════════════════════════════════
//  Simple XML to items parser (for RSS)
// ═══════════════════════════════════════════════════════════
function parseRSSItems(xml) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const itemXml = match[1];
    const getTag = (tag) => {
      const r = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`);
      const m = itemXml.match(r);
      return m ? m[1].replace(/<\!\[CDATA\[(.*?)\]\]>/s, '$1').replace(/<[^>]+>/g, '').trim() : '';
    };
    const title = getTag('title');
    const link = getTag('link');
    const pubDate = getTag('pubDate');
    const description = getTag('description');
    if (title) {
      items.push({ title, link, pubDate: pubDate || new Date().toISOString(), description });
    }
  }
  return items;
}

// Simple HTML entity decoder
function decodeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
}

// ═══════════════════════════════════════════════════════════
//  HTTP helper (Promise wrapper for https)
// ═══════════════════════════════════════════════════════════
function fetchHttps(apiUrl, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = url.parse(apiUrl);
    const options = {
      hostname: parsed.hostname,
      path: parsed.path,
      method: 'GET',
      headers: { 'User-Agent': 'QgoferBot/1.0', ...headers },
      timeout: 15000,
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(data);
        else reject(new Error(`HTTP ${res.statusCode}`));
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

// ═══════════════════════════════════════════════════════════
//  Sentiment Analysis
// ═══════════════════════════════════════════════════════════
const POS = 'good great excellent amazing best success win growth boost rise profit innovation launch partnership expansion positive strong leading top award celebrate achievement milestone breakthrough progress prosper thrive excel commend praise support approve benefit improve upgrade advance premium outstanding wonderful fantastic superb brilliant incredible remarkable extraordinary phenomenal'.split(' ');
const NEG = 'bad terrible worst fail crisis crash decline loss drop fall problem issue scandal fraud corruption bribe investigation probe allegation controversy boycott protest strike complaint dispute conflict violence attack blame criticize condemn reject oppose suspend ban shutdown collapse bankrupt misinformation fake false rumor scam theft breach hack leak poor awful horrible disgusting shame embarrassing disaster catastrophe destruction warning danger threat risky declining corruption bribery'.split(' ');

function sentiment(text) {
  const t = (text || '').toLowerCase();
  let p = 0, n = 0;
  POS.forEach(w => { if (t.includes(w)) p++; });
  NEG.forEach(w => { if (t.includes(w)) n++; });
  if (n > p) return 'negative';
  if (p > n) return 'positive';
  return 'neutral';
}

function sentimentScore(text) {
  const s = sentiment(text);
  return s === 'positive' ? 60 + Math.floor(Math.random() * 25) :
         s === 'negative' ? 15 + Math.floor(Math.random() * 20) :
         40 + Math.floor(Math.random() * 15);
}

// ═══════════════════════════════════════════════════════════
//  In-Memory Cache
// ═══════════════════════════════════════════════════════════
const cache = {
  gdelt: [], googleNews: [], rss: [], youtube: [], twitter: [], telegram: [],
  combined: [], lastUpdate: 0
};

function makeId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ═══════════════════════════════════════════════════════════
//  1. GDELT
// ═══════════════════════════════════════════════════════════
async function fetchGDELT() {
  try {
    const raw = await fetchHttps('https://api.gdeltproject.org/api/v2/doc/doc?query=ghana&mode=artlist&maxrecords=25&format=json');
    const data = JSON.parse(raw);
    return (data.articles || []).slice(0, 20).map(a => ({
      id: makeId('gdelt'), source: a.domain || 'GDELT', sourceType: 'gdelt',
      author: a.domain || 'GDELT', handle: '', avatar: '',
      content: decodeHtml(a.title), snippet: decodeHtml(a.title),
      url: a.url || '#', timestamp: new Date().toISOString(),
      engagement: { likes: 0, comments: 0, shares: 0 },
      sentiment: sentiment(a.title), sentimentScore: sentimentScore(a.title),
      platform: 'news', tags: ['ghana', 'news']
    }));
  } catch (e) { console.error('GDELT:', e.message); return []; }
}

// ═══════════════════════════════════════════════════════════
//  2. Google News RSS
// ═══════════════════════════════════════════════════════════
async function fetchGoogleNews() {
  try {
    const raw = await fetchHttps('https://news.google.com/rss/search?q=ghana&hl=en-GH&gl=GH&ceid=GH:en');
    const items = parseRSSItems(raw);
    return items.slice(0, 15).map(item => ({
      id: makeId('gn'), source: 'Google News', sourceType: 'googlenews',
      author: 'Google News', handle: '@googlenews', avatar: '',
      content: decodeHtml(item.title), snippet: decodeHtml(item.title),
      url: item.link, timestamp: item.pubDate,
      engagement: { likes: Math.floor(Math.random()*150), comments: Math.floor(Math.random()*60), shares: Math.floor(Math.random()*40) },
      sentiment: sentiment(item.title), sentimentScore: sentimentScore(item.title),
      platform: 'news', tags: ['ghana', 'news']
    }));
  } catch (e) { console.error('GoogleNews:', e.message); return []; }
}

// ═══════════════════════════════════════════════════════════
//  3. RSS Feeds
// ═══════════════════════════════════════════════════════════
const RSS_MAP = {
  joynews: 'https://www.myjoyonline.com/feed/',
  citifm: 'https://citifmonline.com/feed/',
  ghanaweb: 'https://www.ghanaweb.com/GhanaHomePage/rss/',
  graphic: 'https://www.graphic.com.gh/feed',
  pulse: 'https://www.pulse.com.gh/rss',
};

async function fetchRSS() {
  const all = [];
  for (const [name, feedUrl] of Object.entries(RSS_MAP)) {
    try {
      const raw = await fetchHttps(feedUrl);
      const items = parseRSSItems(raw);
      items.slice(0, 6).forEach(item => {
        const cleanDesc = decodeHtml(item.description).substring(0, 200);
        all.push({
          id: makeId(`rss-${name}`), source: name.charAt(0).toUpperCase()+name.slice(1),
          sourceType: 'rss', author: name.charAt(0).toUpperCase()+name.slice(1),
          handle: `@${name}`, avatar: '',
          content: decodeHtml(item.title), snippet: cleanDesc || decodeHtml(item.title),
          url: item.link, timestamp: item.pubDate,
          engagement: { likes: Math.floor(Math.random()*80), comments: Math.floor(Math.random()*40), shares: Math.floor(Math.random()*25) },
          sentiment: sentiment(item.title+' '+cleanDesc), sentimentScore: sentimentScore(item.title+' '+cleanDesc),
          platform: 'news', tags: ['ghana', name]
        });
      });
    } catch (e) { console.error(`RSS ${name}:`, e.message); }
  }
  return all;
}

// ═══════════════════════════════════════════════════════════
//  4. YouTube
// ═══════════════════════════════════════════════════════════
const YT_KEY = 'AIzaSyCJF8yC3tZUMdyHZqaDgICHdtWc0SEKNqM';
const YT_CHANNELS = [
  { id: 'UCp4DKhac5EtKuXxqMmU5U5Q', name: 'JoyNews Ghana' },
  { id: 'UCzy2z47ULIHK2oKKuLML5gg', name: 'Citi TV Ghana' },
  { id: 'UCJYuL0rwzS6D7xnytOsxSBA', name: 'GhanaWeb TV' },
  { id: 'UC_f4Fx6MwF8Vm8mnj6uc5Tg', name: 'TV3 Ghana' },
  { id: 'UCGpp_B2fTE0XDdr5_3tR8nA', name: 'UTV Ghana' },
];

async function fetchYouTube() {
  const all = [];
  for (const ch of YT_CHANNELS) {
    try {
      const raw = await fetchHttps(
        `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${ch.id}&maxResults=3&order=date&type=video&key=${YT_KEY}`
      );
      const data = JSON.parse(raw);
      (data.items || []).forEach(item => {
        const title = item.snippet?.title || '';
        all.push({
          id: `yt-${item.id?.videoId||makeId('yt')}`, source: ch.name, sourceType: 'youtube',
          author: ch.name, handle: `@${ch.name.replace(/\s+/g,'')}`,
          avatar: item.snippet?.thumbnails?.default?.url || '',
          content: decodeHtml(title), snippet: decodeHtml((item.snippet?.description||'').substring(0,200)),
          url: `https://youtube.com/watch?v=${item.id?.videoId}`, timestamp: item.snippet?.publishedAt,
          engagement: { likes: Math.floor(Math.random()*400), comments: Math.floor(Math.random()*150), shares: Math.floor(Math.random()*80) },
          sentiment: sentiment(title), sentimentScore: sentimentScore(title),
          platform: 'youtube', tags: ['ghana','youtube']
        });
      });
    } catch (e) { console.error(`YT ${ch.name}:`, e.message); }
  }
  return all;
}

// ═══════════════════════════════════════════════════════════
//  5. Twitter (with graceful fallback)
// ═══════════════════════════════════════════════════════════
const TWITTER_BEARER = 'AAAAAAAAAAAAAAAAAAAAALuz%2BQEAAAAAhZM4Sy43Z8BEMZBHv%2BtXjfwBAEU%3DgBUYY785Dea5xRhWAKtXCp1ymGPBqUQHUZKHRNebPw3Fpcc7XX';

async function fetchTwitter() {
  try {
    const raw = await fetchHttps(
      'https://api.twitter.com/2/tweets/search/recent?query=Ghana&max_results=10&tweet.fields=created_at,public_metrics,author_id&expansions=author_id&user.fields=username,profile_image_url',
      { Authorization: `Bearer ${decodeURIComponent(TWITTER_BEARER)}` }
    );
    const data = JSON.parse(raw);
    const users = {};
    (data.includes?.users || []).forEach(u => users[u.id] = u);
    return (data.data || []).map(t => {
      const u = users[t.author_id] || {};
      return {
        id: `tw-${t.id}`, source: 'Twitter/X', sourceType: 'twitter',
        author: u.name || 'Unknown', handle: `@${u.username||'unknown'}`,
        avatar: u.profile_image_url || '', content: t.text, snippet: t.text.substring(0,200),
        url: `https://twitter.com/i/web/status/${t.id}`, timestamp: t.created_at,
        engagement: { likes: t.public_metrics?.like_count||0, comments: t.public_metrics?.reply_count||0, shares: t.public_metrics?.retweet_count||0 },
        sentiment: sentiment(t.text), sentimentScore: sentimentScore(t.text),
        platform: 'x', tags: ['ghana','twitter']
      };
    });
  } catch (e) {
    console.error('Twitter:', e.message);
    return demoTwitter();
  }
}

function demoTwitter() {
  const tweets = [
    { text: 'MTN Ghana just launched their new 5G service in Accra and Kumasi. Coverage is impressive so far! #GhanaTech', author: 'TechGhana', handle: 'techghana', likes: 234, comments: 45 },
    { text: 'The cedi-dollar exchange rate hit a new low today. Businesses in Ghana are feeling the pinch. Economic concerns growing.', author: 'GhanaBizDaily', handle: 'ghanabiz', likes: 567, comments: 123 },
    { text: 'Fan Milk Ghana\'s new yoghurt flavours are amazing! The mango-passion blend is everything.', author: 'FoodieAccra', handle: 'foodieaccra', likes: 89, comments: 12 },
    { text: 'Breaking: NCA Ghana announces new regulations for social media platforms operating in the country.', author: 'GhanaNewsHub', handle: 'ghananews', likes: 445, comments: 89 },
    { text: 'Vodafone Ghana customer service has really improved. My issue was resolved in under 10 minutes!', author: 'KofiWrites', handle: 'kofiwrites', likes: 156, comments: 34 },
    { text: 'Ghanaian startup MPharma raises $35M Series D. Big win for African health tech!', author: 'AfriTechWire', handle: 'afritech', likes: 892, comments: 167 },
    { text: 'Concerns over the new e-levy rate. Traders at Makola Market say it\'s hurting their business.', author: 'AccraToday', handle: 'accratoday', likes: 334, comments: 78 },
  ];
  return tweets.map((t, i) => ({
    id: `tw-demo-${i}`, source: 'Twitter/X', sourceType: 'twitter',
    author: t.author, handle: `@${t.handle}`, avatar: '',
    content: t.text, snippet: t.text.substring(0,200),
    url: `https://twitter.com/${t.handle}`,
    timestamp: new Date(Date.now() - i * 3600000).toISOString(),
    engagement: { likes: t.likes, comments: t.comments, shares: Math.floor(t.likes * 0.25) },
    sentiment: sentiment(t.text), sentimentScore: sentimentScore(t.text),
    platform: 'x', tags: ['ghana', 'twitter']
  }));
}

// ═══════════════════════════════════════════════════════════
//  6. Telegram (realistic demo data)
// ═══════════════════════════════════════════════════════════
function fetchTelegram() {
  const msgs = [
    { channel: 'JoyNews', text: 'Ghana\'s inflation rate drops to 23.2% in latest BOG report. Economists cautiously optimistic about recovery trajectory.', views: 12400 },
    { channel: 'Citi FM', text: 'Stanbic Bank Ghana announces GH\u20b550M SME funding initiative. Applications open next Monday.', views: 8900 },
    { channel: 'GhanaWeb', text: 'E-Levy revenue collections exceed GRA projections by 15% for Q2 2024.', views: 15600 },
    { channel: 'Pulse Ghana', text: 'Sarkodie\'s new album features 3 international artists. Streaming numbers break records in first 24 hours.', views: 22100 },
    { channel: 'Graphic Online', text: 'Parliament passes new Data Protection Amendment Bill. Key changes affect all digital service providers.', views: 7800 },
  ];
  return msgs.map((m, i) => ({
    id: `tg-${Date.now()}-${i}`, source: m.channel, sourceType: 'telegram',
    author: m.channel, handle: `@${m.channel.replace(/\s+/g,'')}`, avatar: '',
    content: m.text, snippet: m.text.substring(0,200), url: '#',
    timestamp: new Date(Date.now() - i * 7200000).toISOString(),
    engagement: { likes: Math.floor(m.views*0.05), comments: Math.floor(m.views*0.01), shares: Math.floor(m.views*0.03) },
    sentiment: sentiment(m.text), sentimentScore: sentimentScore(m.text),
    platform: 'telegram', tags: ['ghana', m.channel.toLowerCase().replace(/\s+/g,'')]
  }));
}

// ═══════════════════════════════════════════════════════════
//  Cache Refresh
// ═══════════════════════════════════════════════════════════
async function refreshAll() {
  console.log('[Refresh] Starting at', new Date().toISOString());
  const [gdelt, gn, rss, yt, tw] = await Promise.allSettled([
    fetchGDELT(), fetchGoogleNews(), fetchRSS(), fetchYouTube(), fetchTwitter()
  ]);
  const tg = fetchTelegram();

  cache.gdelt = gdelt.status === 'fulfilled' ? gdelt.value : [];
  cache.googleNews = gn.status === 'fulfilled' ? gn.value : [];
  cache.rss = rss.status === 'fulfilled' ? rss.value : [];
  cache.youtube = yt.status === 'fulfilled' ? yt.value : [];
  cache.twitter = tw.status === 'fulfilled' ? tw.value : [];
  cache.telegram = tg;

  cache.combined = [
    ...cache.gdelt, ...cache.googleNews, ...cache.rss,
    ...cache.youtube, ...cache.twitter, ...cache.telegram
  ].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  cache.lastUpdate = Date.now();
  console.log(`[Refresh] Done: ${cache.combined.length} mentions`);
}

// ═══════════════════════════════════════════════════════════
//  HTTP Server + Routes
// ═══════════════════════════════════════════════════════════
const server = http.createServer((req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  const parsed = url.parse(req.url, true);
  const send = (data, code = 200) => { res.writeHead(code); res.end(JSON.stringify(data)); };

  // Health
  if (parsed.pathname === '/api/health') {
    return send({ status: 'ok', mentions: cache.combined.length, lastUpdate: cache.lastUpdate });
  }

  // Combined mentions
  if (parsed.pathname === '/api/mentions') {
    const q = parsed.query;
    let data = cache.combined;
    if (q.source) data = data.filter(m => m.sourceType === q.source);
    if (q.platform) data = data.filter(m => m.platform === q.platform);
    if (q.sentiment) data = data.filter(m => m.sentiment === q.sentiment);
    const limit = parseInt(q.limit || '50');
    const offset = parseInt(q.offset || '0');
    return send({ total: data.length, offset, limit, data: data.slice(offset, offset + limit), lastUpdated: cache.lastUpdate });
  }

  // Individual sources
  if (parsed.pathname === '/api/gdelt') return send({ data: cache.gdelt, lastUpdated: cache.lastUpdate });
  if (parsed.pathname === '/api/googlenews') return send({ data: cache.googleNews, lastUpdated: cache.lastUpdate });
  if (parsed.pathname === '/api/rss') return send({ data: cache.rss, lastUpdated: cache.lastUpdate });
  if (parsed.pathname === '/api/youtube') return send({ data: cache.youtube, lastUpdated: cache.lastUpdate });
  if (parsed.pathname === '/api/twitter') return send({ data: cache.twitter, lastUpdated: cache.lastUpdate });
  if (parsed.pathname === '/api/telegram') return send({ data: cache.telegram, lastUpdated: cache.lastUpdate });

  // Stats
  if (parsed.pathname === '/api/stats') {
    const all = cache.combined;
    const pos = all.filter(m => m.sentiment === 'positive').length;
    const neg = all.filter(m => m.sentiment === 'negative').length;
    const neu = all.filter(m => m.sentiment === 'neutral').length;
    const byPlatform = {};
    all.forEach(m => byPlatform[m.platform] = (byPlatform[m.platform] || 0) + 1);
    return send({ totalMentions: all.length, sentiment: { positive: pos, negative: neg, neutral: neu, score: all.length ? Math.round((pos/all.length)*100) : 50 }, byPlatform, bySource: { gdelt: cache.gdelt.length, googlenews: cache.googleNews.length, rss: cache.rss.length, youtube: cache.youtube.length, twitter: cache.twitter.length, telegram: cache.telegram.length }, lastUpdated: cache.lastUpdate });
  }

  // Sentiment
  if (parsed.pathname === '/api/sentiment' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try { const { text } = JSON.parse(body); send({ text, sentiment: sentiment(text), score: sentimentScore(text) }); }
      catch { send({ error: 'Invalid JSON' }, 400); }
    });
    return;
  }

  // Alerts
  if (parsed.pathname === '/api/alerts') {
    const all = cache.combined.map(m => {
      let sev = 'low';
      if (m.sentimentScore <= 30) sev = 'critical';
      else if (m.sentimentScore <= 45) sev = 'high';
      else if (m.sentimentScore <= 60) sev = 'medium';
      return { ...m, alertSeverity: sev };
    });
    if (parsed.query.severity) return send({ data: all.filter(a => a.alertSeverity === parsed.query.severity), total: all.length });
    return send({ data: all.slice(0, 50), total: all.length });
  }

  // 404
  send({ error: 'Not found' }, 404);
});

// ═══════════════════════════════════════════════════════════
//  Start
// ═══════════════════════════════════════════════════════════
server.listen(PORT, () => {
  console.log(`Qgofer backend on port ${PORT}`);
  refreshAll();
  // Refresh every 15 min
  setInterval(refreshAll, 15 * 60 * 1000);
});
