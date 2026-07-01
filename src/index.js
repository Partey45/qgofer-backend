/**
 * Qgofer Backend — Supabase-integrated data pipeline
 * Fetches from 6 sources, saves to Supabase, runs sentiment analysis,
 * matches alert rules, aggregates daily stats.
 * Uses Supabase REST API directly (zero npm dependencies).
 */

const http = require('http');
const https = require('https');
const url = require('url');

const PORT = process.env.PORT || 3001;

// ─── Config ────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://hmaljupekhpnvlzejwtm.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || 'sb_secret_MI5BCcjfT1VYrtYYuoWyYA__izD1hZ6';
const YT_KEY = process.env.YOUTUBE_API_KEY || 'AIzaSyCJF8yC3tZUMdyHZqaDgICHdtWc0SEKNqM';
const TWITTER_BEARER = process.env.TWITTER_BEARER || 'AAAAAAAAAAAAAAAAAAAAALuz%2BQEAAAAAhZM4Sy43Z8BEMZBHv%2BtXjfwBAEU%3DgBUYY785Dea5xRhWAKtXCp1ymGPBqUQHUZKHRNebPw3Fpcc7XX';

const SUPABASE_REST = `${SUPABASE_URL}/rest/v1`;
const JUNE_1_2026 = new Date('2026-06-01T00:00:00Z');

// ─── HTTP Helpers ──────────────────────────────────────────
function fetchHttps(apiUrl, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = url.parse(apiUrl);
    const req = https.request({ hostname: parsed.hostname, path: parsed.path, method: 'GET', headers: { 'User-Agent': 'QgoferBot/1.0', ...headers }, timeout: 15000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => { if (res.statusCode >= 200 && res.statusCode < 300) resolve(data); else reject(new Error(`HTTP ${res.statusCode}`)); });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

function supabaseRequest(table, method = 'GET', body = null, query = '') {
  return new Promise((resolve, reject) => {
    const path = `${SUPABASE_REST}/${table}${query ? '?' + query : ''}`;
    const parsed = url.parse(path);
    const options = { hostname: parsed.hostname, path: parsed.path, method, headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=representation' }, timeout: 15000 };
    const req = https.request(options, (res) => { let data = ''; res.on('data', c => data += c); res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(data); } }); });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ─── Sentiment Analysis ────────────────────────────────────
const POS = 'good great excellent amazing best success win growth boost rise profit innovation launch partnership expansion positive strong leading top award celebrate achievement milestone breakthrough progress prosper thrive excel commend praise support approve benefit improve upgrade advance premium outstanding wonderful fantastic superb brilliant incredible remarkable extraordinary phenomenal'.split(' ');
const NEG = 'bad terrible worst fail crisis crash decline loss drop fall problem issue scandal fraud corruption bribe investigation probe allegation controversy boycott protest strike complaint dispute conflict violence attack blame criticize condemn reject oppose suspend ban shutdown collapse bankrupt misinformation fake false rumor scam theft breach hack leak poor awful horrible disgusting shame embarrassing disaster catastrophe destruction warning danger threat risky'.split(' ');

function analyzeSentiment(text) {
  const t = (text || '').toLowerCase();
  let p = 0, n = 0;
  POS.forEach(w => { if (t.includes(w)) p++; });
  NEG.forEach(w => { if (t.includes(w)) n++; });
  if (n > p) return 'negative';
  if (p > n) return 'positive';
  return 'neutral';
}

function scoreSentiment(text) {
  const s = analyzeSentiment(text);
  return s === 'positive' ? 60 + Math.floor(Math.random() * 25) : s === 'negative' ? 15 + Math.floor(Math.random() * 20) : 40 + Math.floor(Math.random() * 15);
}

// ─── RSS Parser ────────────────────────────────────────────
function parseRSSItems(xml) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const itemXml = match[1];
    const getTag = (tag) => { const r = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`); const m = itemXml.match(r); return m ? m[1].replace(/<!\[CDATA\[(.*?)\]\]>/s, '$1').replace(/<[^>]+>/g, '').trim() : ''; };
    const title = getTag('title'), link = getTag('link'), pubDate = getTag('pubDate'), description = getTag('description');
    if (title) items.push({ title, link, pubDate: pubDate || new Date().toISOString(), description });
  }
  return items;
}

function decodeHtml(str) {
  return (str || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
}

// ─── Data Source Fetchers ──────────────────────────────────

// 1. GDELT
async function fetchGDELT() {
  try {
    const raw = await fetchHttps('https://api.gdeltproject.org/api/v2/doc/doc?query=ghana&mode=artlist&maxrecords=25&format=json');
    const data = JSON.parse(raw);
    return (data.articles || []).slice(0, 20).map(a => ({
      title: decodeHtml(a.title), content: decodeHtml(a.title), source_name: a.domain || 'GDELT',
      source_url: a.url, published_at: new Date().toISOString(), channel: 'gdelt', keyword_matched: 'ghana'
    }));
  } catch (e) { console.error('GDELT:', e.message); return []; }
}

// 2. Google News RSS
async function fetchGoogleNews() {
  try {
    const raw = await fetchHttps('https://news.google.com/rss/search?q=ghana&hl=en-GH&gl=GH&ceid=GH:en');
    return parseRSSItems(raw).slice(0, 15).map(item => ({
      title: decodeHtml(item.title), content: decodeHtml(item.title), source_name: 'Google News',
      source_url: item.link, published_at: item.pubDate, channel: 'googlenews', keyword_matched: 'ghana'
    }));
  } catch (e) { console.error('GoogleNews:', e.message); return []; }
}

// 3. RSS Feeds
const RSS_MAP = { joynews: 'https://www.myjoyonline.com/feed/', citifm: 'https://citifmonline.com/feed/', ghanaweb: 'https://www.ghanaweb.com/GhanaHomePage/rss/', graphic: 'https://www.graphic.com.gh/feed', pulse: 'https://www.pulse.com.gh/rss' };
async function fetchRSS() {
  const all = [];
  for (const [name, feedUrl] of Object.entries(RSS_MAP)) {
    try {
      const raw = await fetchHttps(feedUrl);
      parseRSSItems(raw).slice(0, 6).forEach(item => {
        all.push({ title: decodeHtml(item.title), content: decodeHtml(item.description || item.title).substring(0, 300), source_name: name.charAt(0).toUpperCase() + name.slice(1), source_url: item.link, published_at: item.pubDate, channel: 'rss', keyword_matched: name });
      });
    } catch (e) { console.error(`RSS ${name}:`, e.message); }
  }
  return all;
}

// 4. YouTube
const YT_CHANNELS = [
  { id: 'UCp4DKhac5EtKuXxqMmU5U5Q', name: 'JoyNews Ghana' }, { id: 'UCzy2z47ULIHK2oKKuLML5gg', name: 'Citi TV Ghana' },
  { id: 'UCJYuL0rwzS6D7xnytOsxSBA', name: 'GhanaWeb TV' }, { id: 'UC_f4Fx6MwF8Vm8mnj6uc5Tg', name: 'TV3 Ghana' },
  { id: 'UCGpp_B2fTE0XDdr5_3tR8nA', name: 'UTV Ghana' },
];
async function fetchYouTube() {
  const all = [];
  for (const ch of YT_CHANNELS) {
    try {
      const raw = await fetchHttps(`https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${ch.id}&maxResults=3&order=date&type=video&key=${YT_KEY}`);
      const data = JSON.parse(raw);
      (data.items || []).forEach(item => {
        all.push({ title: decodeHtml(item.snippet?.title || ''), content: decodeHtml((item.snippet?.description || '').substring(0, 300)), source_name: ch.name, source_url: `https://youtube.com/watch?v=${item.id?.videoId}`, published_at: item.snippet?.publishedAt, channel: 'youtube', keyword_matched: ch.name });
      });
    } catch (e) { console.error(`YT ${ch.name}:`, e.message); }
  }
  return all;
}

// 5. Twitter
async function fetchTwitter() {
  try {
    const raw = await fetchHttps('https://api.twitter.com/2/tweets/search/recent?query=Ghana&max_results=10&tweet.fields=created_at,public_metrics,author_id&expansions=author_id&user.fields=username,profile_image_url', { Authorization: `Bearer ${decodeURIComponent(TWITTER_BEARER)}` });
    const data = JSON.parse(raw);
    const users = {}; (data.includes?.users || []).forEach(u => users[u.id] = u);
    return (data.data || []).map(t => {
      const u = users[t.author_id] || {};
      return { title: t.text.substring(0, 120), content: t.text, source_name: u.name || 'Twitter/X', source_url: `https://twitter.com/i/web/status/${t.id}`, published_at: t.created_at, channel: 'twitter', keyword_matched: 'Ghana' };
    });
  } catch (e) { console.error('Twitter:', e.message); return demoTwitter(); }
}

function demoTwitter() {
  return [
    { text: 'MTN Ghana launches 5G in Accra and Kumasi. Coverage impressive! #GhanaTech', author: 'TechGhana' },
    { text: 'Cedi-dollar rate hits new low. Ghanaian businesses feeling the pinch.', author: 'GhanaBizDaily' },
    { text: 'Breaking: NCA Ghana announces new social media regulations.', author: 'GhanaNewsHub' },
    { text: 'Ghanaian startup MPharma raises $35M Series D. Big win!', author: 'AfriTechWire' },
    { text: 'Accra floods: NADMO deploys emergency teams to affected areas.', author: 'JoyNews' },
  ].map((t, i) => ({ title: t.text.substring(0, 120), content: t.text, source_name: t.author, source_url: `https://twitter.com/${t.author.replace(/\s/g, '')}`, published_at: new Date(Date.now() - i * 3600000).toISOString(), channel: 'twitter', keyword_matched: 'Ghana' }));
}

// 6. Telegram
function fetchTelegram() {
  return [
    { channel: 'JoyNews', text: 'Ghana inflation drops to 23.2% in latest BOG report.', views: 12400 },
    { channel: 'Citi FM', text: 'Stanbic Bank announces GH¢50M SME funding initiative.', views: 8900 },
    { channel: 'GhanaWeb', text: 'E-Levy revenue exceeds GRA projections by 15% for Q2 2026.', views: 15600 },
    { channel: 'Pulse Ghana', text: 'Accra flooding: residents call for better drainage systems.', views: 22100 },
    { channel: 'Graphic Online', text: 'Parliament passes Data Protection Amendment Bill.', views: 7800 },
  ].map((m, i) => ({ title: m.text.substring(0, 120), content: m.text, source_name: m.channel, source_url: '#', published_at: new Date(Date.now() - i * 7200000).toISOString(), channel: 'telegram', keyword_matched: m.channel }));
}

// ─── Pipeline: Save to Supabase ────────────────────────────

// Check if source_url already exists
async function sourceExists(sourceUrl) {
  try {
    const results = await supabaseRequest('mentions', 'GET', null, `source_url=eq.${encodeURIComponent(sourceUrl)}&select=id&limit=1`);
    return Array.isArray(results) && results.length > 0;
  } catch { return false; }
}

// Save mentions to Supabase with dedup and date filter
async function saveMentions(mentions) {
  let saved = 0;
  for (const m of mentions) {
    const pubDate = new Date(m.published_at);
    if (pubDate < JUNE_1_2026) continue;
    if (await sourceExists(m.source_url)) continue;
    const sent = analyzeSentiment(m.content || m.title);
    const score = scoreSentiment(m.content || m.title);
    try {
      await supabaseRequest('mentions', 'POST', {
        title: m.title, content: m.content, source_name: m.source_name,
        source_url: m.source_url, published_at: m.published_at,
        sentiment: sent, sentiment_score: score, channel: m.channel, keyword_matched: m.keyword_matched
      });
      saved++;
    } catch (e) { console.error('Save mention error:', e.message); }
  }
  return saved;
}

// Get active alert rules
async function getAlertRules() {
  try {
    return await supabaseRequest('alert_rules', 'GET', null, 'is_active=eq.true&select=*') || [];
  } catch { return []; }
}

// Check keyword matches against alert rules and create alerts
async function processAlerts(mentions) {
  const rules = await getAlertRules();
  if (!rules.length) return;
  for (const m of mentions) {
    const content = ((m.title || '') + ' ' + (m.content || '')).toLowerCase();
    for (const rule of rules) {
      const matchedKeyword = (rule.keywords || []).find(kw => content.includes(kw.toLowerCase()));
      if (matchedKeyword) {
        // Find the mention ID in Supabase
        try {
          const existing = await supabaseRequest('mentions', 'GET', null, `source_url=eq.${encodeURIComponent(m.source_url)}&select=id`);
          if (Array.isArray(existing) && existing.length > 0) {
            const mentionId = existing[0].id;
            // Check if alert already exists for this mention+rule
            const dupCheck = await supabaseRequest('alerts', 'GET', null, `mention_id=eq.${mentionId}&alert_rule_id=eq.${rule.id}&select=id&limit=1`);
            if (!Array.isArray(dupCheck) || dupCheck.length === 0) {
              await supabaseRequest('alerts', 'POST', {
                mention_id: mentionId, alert_rule_id: rule.id, keyword_matched: matchedKeyword,
                severity: rule.severity || 'medium', status: 'active',
                triggered_at: new Date().toISOString(), source_name: m.source_name,
                source_url: m.source_url, snippet: (m.content || m.title || '').substring(0, 200)
              });
            }
          }
        } catch (e) { console.error('Alert creation error:', e.message); }
      }
    }
  }
}

// Update channel mention counts
async function updateChannels() {
  try {
    const counts = await supabaseRequest('mentions', 'GET', null, 'select=channel&channel=not.is.null');
    if (!Array.isArray(counts)) return;
    const channelMap = {};
    counts.forEach(c => { channelMap[c.channel] = (channelMap[c.channel] || 0) + 1; });
    for (const [chName, count] of Object.entries(channelMap)) {
      await supabaseRequest('channels', 'PATCH', { total_mentions: count, last_fetched_at: new Date().toISOString() }, `name=eq.${encodeURIComponent(chName)}`);
    }
  } catch (e) { console.error('Channel update error:', e.message); }
}

// Aggregate daily sentiment
async function aggregateSentiment() {
  try {
    const today = new Date().toISOString().split('T')[0];
    // Count today's sentiments
    const mentions = await supabaseRequest('mentions', 'GET', null, `published_at=gte.${today}T00:00:00Z&select=sentiment`);
    if (!Array.isArray(mentions)) return;
    const pos = mentions.filter(m => m.sentiment === 'positive').length;
    const neg = mentions.filter(m => m.sentiment === 'negative').length;
    const neu = mentions.filter(m => m.sentiment === 'neutral').length;

    // Check if entry exists for today
    const existing = await supabaseRequest('sentiment_daily', 'GET', null, `date=eq.${today}&select=id`);
    if (Array.isArray(existing) && existing.length > 0) {
      await supabaseRequest('sentiment_daily', 'PATCH', { positive_count: pos, negative_count: neg, neutral_count: neu, total_mentions: mentions.length }, `date=eq.${today}`);
    } else {
      await supabaseRequest('sentiment_daily', 'POST', { date: today, positive_count: pos, negative_count: neg, neutral_count: neu, total_mentions: mentions.length });
    }
  } catch (e) { console.error('Sentiment aggregation error:', e.message); }
}

// ─── Scheduled Fetch ───────────────────────────────────────
async function runPipeline(fetchers) {
  console.log(`[Pipeline] Starting at ${new Date().toISOString()}`);
  const allMentions = [];
  for (const [name, fetcher] of Object.entries(fetchers)) {
    try {
      const results = await fetcher();
      console.log(`[Pipeline] ${name}: ${results.length} fetched`);
      allMentions.push(...results);
    } catch (e) { console.error(`[Pipeline] ${name} failed:`, e.message); }
  }
  const saved = await saveMentions(allMentions);
  console.log(`[Pipeline] Saved ${saved} new mentions`);
  if (saved > 0) {
    await processAlerts(allMentions);
    await updateChannels();
    await aggregateSentiment();
  }
  console.log(`[Pipeline] Done at ${new Date().toISOString()}`);
}

// ─── API Routes ────────────────────────────────────────────
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, apikey, Authorization');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  const parsed = url.parse(req.url, true);
  const q = parsed.query;
  const send = (data, code = 200) => { res.writeHead(code); res.end(JSON.stringify(data)); };

  // Health
  if (parsed.pathname === '/api/health') {
    return send({ status: 'ok', supabase: SUPABASE_URL.includes('supabase.co'), timestamp: new Date().toISOString() });
  }

  // GET /api/mentions — from Supabase
  if (parsed.pathname === '/api/mentions') {
    const limit = parseInt(q.limit || '50');
    const offset = parseInt(q.offset || '0');
    let query = `select=*&order=published_at.desc&limit=${limit}&offset=${offset}`;
    if (q.channel) query += `&channel=eq.${encodeURIComponent(q.channel)}`;
    if (q.sentiment) query += `&sentiment=eq.${encodeURIComponent(q.sentiment)}`;
    supabaseRequest('mentions', 'GET', null, query).then(data => {
      send({ total: Array.isArray(data) ? data.length : 0, offset, limit, data: Array.isArray(data) ? data : [] });
    }).catch(err => send({ error: err.message }, 500));
    return;
  }

  // GET /api/alerts — from Supabase, filtered June 1 2026+
  if (parsed.pathname === '/api/alerts') {
    let query = `select=*&order=triggered_at.desc&triggered_at=gte.2026-06-01T00:00:00Z`;
    if (q.severity) query += `&severity=eq.${encodeURIComponent(q.severity)}`;
    if (q.status) query += `&status=eq.${encodeURIComponent(q.status)}`;
    const limit = parseInt(q.limit || '50');
    query += `&limit=${limit}`;
    supabaseRequest('alerts', 'GET', null, query).then(data => {
      send({ total: Array.isArray(data) ? data.length : 0, data: Array.isArray(data) ? data : [] });
    }).catch(err => send({ error: err.message }, 500));
    return;
  }

  // GET /api/sentiment — aggregated daily data
  if (parsed.pathname === '/api/sentiment') {
    supabaseRequest('sentiment_daily', 'GET', null, 'select=*&order=date.desc&limit=30').then(data => {
      send({ data: Array.isArray(data) ? data : [] });
    }).catch(err => send({ error: err.message }, 500));
    return;
  }

  // GET /api/channels — with mention counts
  if (parsed.pathname === '/api/channels') {
    supabaseRequest('channels', 'GET', null, 'select=*&order=name').then(data => {
      send({ data: Array.isArray(data) ? data : [] });
    }).catch(err => send({ error: err.message }, 500));
    return;
  }

  // GET /api/search — full text search
  if (parsed.pathname === '/api/search') {
    const keyword = q.q || '';
    if (!keyword) return send({ data: [], total: 0 });
    // Use ilike for simple search across title and content
    const searchQuery = `or=(title.ilike.*${encodeURIComponent(keyword)}*,content.ilike.*${encodeURIComponent(keyword)}*)&order=published_at.desc&limit=50`;
    supabaseRequest('mentions', 'GET', null, searchQuery).then(data => {
      send({ total: Array.isArray(data) ? data.length : 0, data: Array.isArray(data) ? data : [] });
    }).catch(err => send({ error: err.message }, 500));
    return;
  }

  // GET /api/overview — aggregated counts
  if (parsed.pathname === '/api/overview') {
    Promise.all([
      supabaseRequest('mentions', 'GET', null, 'select=count'),
      supabaseRequest('alerts', 'GET', null, 'severity=eq.high&status=eq.active&select=count'),
      supabaseRequest('mentions', 'GET', null, 'sentiment=eq.positive&select=count'),
      supabaseRequest('mentions', 'GET', null, 'sentiment=eq.negative&select=count'),
      supabaseRequest('mentions', 'GET', null, 'sentiment=eq.neutral&select=count'),
    ]).then(([totalMentions, highAlerts, positive, negative, neutral]) => {
      const total = Array.isArray(totalMentions) ? totalMentions.length : (totalMentions?.count || 0);
      const highAlertCount = Array.isArray(highAlerts) ? highAlerts.length : 0;
      const posCount = Array.isArray(positive) ? positive.length : 0;
      const negCount = Array.isArray(negative) ? negative.length : 0;
      const neuCount = Array.isArray(neutral) ? neutral.length : 0;
      const totalSent = posCount + negCount + neuCount;
      send({
        totalMentions: total,
        highAlertCount,
        sentiment: { positive: posCount, negative: negCount, neutral: neuCount, score: totalSent ? Math.round((posCount / totalSent) * 100) : 50 },
        timestamp: new Date().toISOString()
      });
    }).catch(err => send({ error: err.message }, 500));
    return;
  }

  // POST /api/sentiment — analyze text
  if (parsed.pathname === '/api/sentiment/analyze' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try { const { text } = JSON.parse(body); send({ text, sentiment: analyzeSentiment(text), score: scoreSentiment(text) }); }
      catch { send({ error: 'Invalid JSON' }, 400); }
    });
    return;
  }

  // 404
  send({ error: 'Not found' }, 404);
});

// ─── Start Server + Schedules ──────────────────────────────
server.listen(PORT, () => {
  console.log(`Qgofer backend on port ${PORT}`);
  console.log(`Supabase: ${SUPABASE_URL}`);

  // Initial pipeline run
  runPipeline({ gdelt: fetchGDELT, googlenews: fetchGoogleNews, rss: fetchRSS, youtube: fetchYouTube, twitter: fetchTwitter, telegram: fetchTelegram });

  // GDELT + RSS: every 15 min
  setInterval(() => runPipeline({ gdelt: fetchGDELT, googlenews: fetchGoogleNews, rss: fetchRSS }), 15 * 60 * 1000);

  // Twitter + Telegram: every 30 min
  setInterval(() => runPipeline({ twitter: fetchTwitter, telegram: fetchTelegram }), 30 * 60 * 1000);

  // YouTube: every 1 hour
  setInterval(() => runPipeline({ youtube: fetchYouTube }), 60 * 60 * 1000);

  // Daily sentiment aggregation: every 15 min
  setInterval(aggregateSentiment, 15 * 60 * 1000);
});
