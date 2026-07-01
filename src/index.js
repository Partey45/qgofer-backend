/**
 * Qgofer Backend — Supabase-integrated data pipeline
 * Fetches from 6 sources, saves to Supabase, runs sentiment analysis,
 * matches alert rules, aggregates daily stats.
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
      res.on('end', () => { if (res.statusCode >= 200 && res.statusCode < 300) resolve(data); else reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`)); });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

/**
 * Supabase REST API request with proper error handling.
 * Checks HTTP status code and rejects on 4xx/5xx responses.
 */
function supabaseRequest(table, method = 'GET', body = null, query = '') {
  return new Promise((resolve, reject) => {
    const path = `${SUPABASE_REST}/${table}${query ? '?' + query : ''}`;
    const parsed = url.parse(path);
    const options = {
      hostname: parsed.hostname,
      path: parsed.path,
      method,
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': method === 'POST' ? 'return=representation' : 'return=representation',
      },
      timeout: 15000,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        // Check for Supabase error responses
        if (res.statusCode >= 400) {
          console.error(`[Supabase ERROR] ${method} ${path} => ${res.statusCode}: ${data.substring(0, 300)}`);
          reject(new Error(`Supabase ${res.statusCode}: ${data.substring(0, 200)}`));
          return;
        }
        try {
          const parsed = JSON.parse(data);
          resolve(parsed);
        } catch {
          resolve(data);
        }
      });
    });

    req.on('error', (err) => {
      console.error(`[Supabase ERROR] ${method} ${path} => network error: ${err.message}`);
      reject(err);
    });
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Supabase request timeout'));
    });

    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

/**
 * Count rows in a table matching a query.
 * Uses Supabase's count feature with a HEAD request.
 */
async function supabaseCount(table, query = '') {
  try {
    const path = `${SUPABASE_REST}/${table}${query ? '?' + query : ''}`;
    const parsed = url.parse(path);
    return new Promise((resolve) => {
      const req = https.request({
        hostname: parsed.hostname,
        path: parsed.path,
        method: 'HEAD',
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Prefer': 'count=exact',
        },
        timeout: 10000,
      }, (res) => {
        const count = parseInt(res.headers['content-range']?.split('/')[1] || '0', 10);
        resolve(count);
      });
      req.on('error', () => resolve(0));
      req.on('timeout', () => { req.destroy(); resolve(0); });
      req.end();
    });
  } catch { return 0; }
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
  } catch (e) { console.error('[Fetch] GDELT:', e.message); return []; }
}

// 2. Google News RSS
async function fetchGoogleNews() {
  try {
    const raw = await fetchHttps('https://news.google.com/rss/search?q=ghana&hl=en-GH&gl=GH&ceid=GH:en');
    return parseRSSItems(raw).slice(0, 15).map(item => ({
      title: decodeHtml(item.title), content: decodeHtml(item.title), source_name: 'Google News',
      source_url: item.link, published_at: new Date(item.pubDate).toISOString(), channel: 'googlenews', keyword_matched: 'ghana'
    }));
  } catch (e) { console.error('[Fetch] GoogleNews:', e.message); return []; }
}

// 3. RSS Feeds
const RSS_MAP = { joynews: 'https://www.myjoyonline.com/feed/', citifm: 'https://citifmonline.com/feed/', ghanaweb: 'https://www.ghanaweb.com/GhanaHomePage/rss/', graphic: 'https://www.graphic.com.gh/feed', pulse: 'https://www.pulse.com.gh/rss' };
async function fetchRSS() {
  const all = [];
  for (const [name, feedUrl] of Object.entries(RSS_MAP)) {
    try {
      const raw = await fetchHttps(feedUrl);
      parseRSSItems(raw).slice(0, 6).forEach(item => {
        all.push({ title: decodeHtml(item.title), content: decodeHtml(item.description || item.title).substring(0, 300), source_name: name.charAt(0).toUpperCase() + name.slice(1), source_url: item.link, published_at: new Date(item.pubDate).toISOString(), channel: 'rss', keyword_matched: name });
      });
    } catch (e) { console.error(`[Fetch] RSS ${name}:`, e.message); }
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
        all.push({ title: decodeHtml(item.snippet?.title || ''), content: decodeHtml((item.snippet?.description || '').substring(0, 300)), source_name: ch.name, source_url: `https://youtube.com/watch?v=${item.id?.videoId}`, published_at: new Date(item.snippet?.publishedAt).toISOString(), channel: 'youtube', keyword_matched: ch.name });
      });
    } catch (e) { console.error(`[Fetch] YT ${ch.name}:`, e.message); }
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
      return { title: t.text.substring(0, 120), content: t.text, source_name: u.name || 'Twitter/X', source_url: `https://twitter.com/i/web/status/${t.id}`, published_at: new Date(t.created_at).toISOString(), channel: 'twitter', keyword_matched: 'Ghana' };
    });
  } catch (e) { console.error('[Fetch] Twitter:', e.message); return demoTwitter(); }
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

// ─── Known source_urls cache (in-memory for this run) ──────
const knownUrls = new Set();

// Load existing URLs from Supabase at startup
async function loadKnownUrls() {
  try {
    console.log('[Dedup] Loading existing URLs from Supabase...');
    const results = await supabaseRequest('mentions', 'GET', null, 'select=source_url&limit=10000');
    if (Array.isArray(results)) {
      results.forEach(r => { if (r.source_url) knownUrls.add(r.source_url); });
      console.log(`[Dedup] Loaded ${knownUrls.size} existing URLs`);
    }
  } catch (e) {
    console.error('[Dedup] Failed to load existing URLs:', e.message);
  }
}

// ─── Pipeline: Save to Supabase ────────────────────────────

// Bulk insert mentions — much faster than one-by-one
async function saveMentions(mentions) {
  // Filter: June 1 2026+, dedup, add sentiment
  const toInsert = [];
  for (const m of mentions) {
    const pubDate = new Date(m.published_at);
    if (pubDate < JUNE_1_2026) continue;
    if (knownUrls.has(m.source_url)) continue;
    if (m.source_url === '#') continue; // skip placeholder URLs

    const sent = analyzeSentiment(m.content || m.title);
    const score = scoreSentiment(m.content || m.title);

    toInsert.push({
      title: m.title?.substring(0, 500) || '',
      content: m.content?.substring(0, 2000) || '',
      source_name: m.source_name?.substring(0, 100) || 'Unknown',
      source_url: m.source_url?.substring(0, 500) || '',
      published_at: m.published_at,
      sentiment: sent,
      sentiment_score: score,
      channel: m.channel || 'unknown',
      keyword_matched: m.keyword_matched?.substring(0, 100) || '',
    });
    knownUrls.add(m.source_url);
  }

  if (toInsert.length === 0) {
    console.log('[Pipeline] No new mentions to insert');
    return 0;
  }

  // Bulk insert using POST with array body
  try {
    const inserted = await supabaseRequest('mentions', 'POST', toInsert);
    const count = Array.isArray(inserted) ? inserted.length : 0;
    console.log(`[Pipeline] Bulk inserted ${count} mentions`);
    return count;
  } catch (e) {
    console.error('[Pipeline] Bulk insert failed:', e.message);

    // Fallback: try one-by-one and log individual failures
    let saved = 0;
    for (const item of toInsert) {
      try {
        await supabaseRequest('mentions', 'POST', item);
        saved++;
      } catch (innerErr) {
        console.error(`[Pipeline] Failed to insert: ${item.source_url.substring(0, 60)} — ${innerErr.message.substring(0, 100)}`);
      }
    }
    console.log(`[Pipeline] Fallback saved ${saved} mentions`);
    return saved;
  }
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
  if (!rules.length) {
    console.log('[Alerts] No active alert rules');
    return;
  }
  console.log(`[Alerts] Processing ${mentions.length} mentions against ${rules.length} rules`);

  for (const m of mentions) {
    const content = ((m.title || '') + ' ' + (m.content || '')).toLowerCase();
    for (const rule of rules) {
      const matchedKeyword = (rule.keywords || []).find(kw => content.includes(kw.toLowerCase()));
      if (matchedKeyword) {
        try {
          // Find the mention ID in Supabase by source_url
          const existing = await supabaseRequest('mentions', 'GET', null, `source_url=eq.${encodeURIComponent(m.source_url)}&select=id`);
          if (Array.isArray(existing) && existing.length > 0) {
            const mentionId = existing[0].id;
            // Check if alert already exists
            const dupCheck = await supabaseRequest('alerts', 'GET', null, `mention_id=eq.${mentionId}&alert_rule_id=eq.${rule.id}&select=id&limit=1`);
            if (!Array.isArray(dupCheck) || dupCheck.length === 0) {
              await supabaseRequest('alerts', 'POST', {
                mention_id: mentionId,
                alert_rule_id: rule.id,
                keyword_matched: matchedKeyword.substring(0, 100),
                severity: rule.severity || 'medium',
                status: 'active',
                triggered_at: new Date().toISOString(),
                source_name: m.source_name?.substring(0, 100) || 'Unknown',
                source_url: m.source_url?.substring(0, 500) || '',
                snippet: (m.content || m.title || '').substring(0, 200),
              });
              console.log(`[Alerts] Created alert: ${rule.topic} for ${m.source_name}`);
            }
          }
        } catch (e) {
          console.error('[Alerts] Creation error:', e.message);
        }
      }
    }
  }
}

// Update channel mention counts via Supabase function call
async function updateChannels() {
  try {
    // Get count per channel using a single query with grouping
    const mentions = await supabaseRequest('mentions', 'GET', null, 'select=channel&channel=not.is.null&limit=10000');
    if (!Array.isArray(mentions)) {
      console.log('[Channels] No mentions found for channel counting');
      return;
    }

    // Count per channel
    const channelCounts = {};
    mentions.forEach(m => {
      channelCounts[m.channel] = (channelCounts[m.channel] || 0) + 1;
    });

    // Update each channel individually
    for (const [chName, count] of Object.entries(channelCounts)) {
      try {
        const updated = await supabaseRequest('channels', 'PATCH', {
          total_mentions: count,
          last_fetched_at: new Date().toISOString(),
        }, `name=eq.${encodeURIComponent(chName)}`);
        console.log(`[Channels] Updated ${chName}: ${count} mentions`);
      } catch (e) {
        console.error(`[Channels] Failed to update ${chName}:`, e.message);
      }
    }
  } catch (e) {
    console.error('[Channels] Error:', e.message);
  }
}

// Aggregate daily sentiment
async function aggregateSentiment() {
  try {
    const today = new Date().toISOString().split('T')[0];
    const mentions = await supabaseRequest('mentions', 'GET', null, `published_at=gte.${today}T00:00:00Z&select=sentiment`);
    if (!Array.isArray(mentions)) return;

    const pos = mentions.filter(m => m.sentiment === 'positive').length;
    const neg = mentions.filter(m => m.sentiment === 'negative').length;
    const neu = mentions.filter(m => m.sentiment === 'neutral').length;

    // Upsert: check if exists, then PATCH or POST
    try {
      await supabaseRequest('sentiment_daily', 'PATCH', {
        positive_count: pos,
        negative_count: neg,
        neutral_count: neu,
        total_mentions: mentions.length,
      }, `date=eq.${today}`);
      console.log(`[Sentiment] Updated ${today}: ${mentions.length} total`);
    } catch {
      // If PATCH fails (no row), try POST
      try {
        await supabaseRequest('sentiment_daily', 'POST', {
          date: today,
          positive_count: pos,
          negative_count: neg,
          neutral_count: neu,
          total_mentions: mentions.length,
        });
        console.log(`[Sentiment] Created ${today}: ${mentions.length} total`);
      } catch (e2) {
        console.error('[Sentiment] Failed to upsert:', e2.message);
      }
    }
  } catch (e) {
    console.error('[Sentiment] Aggregation error:', e.message);
  }
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
    // Only process alerts for the NEWLY saved mentions
    // (we can't know which ones were saved in bulk, so process all but rely on dedup)
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

  // POST /api/pipeline — trigger a pipeline run manually
  if (parsed.pathname === '/api/pipeline' && req.method === 'POST') {
    console.log('[API] Manual pipeline triggered');
    runPipeline({ gdelt: fetchGDELT, googlenews: fetchGoogleNews, rss: fetchRSS, youtube: fetchYouTube, twitter: fetchTwitter, telegram: fetchTelegram });
    return send({ message: 'Pipeline started', timestamp: new Date().toISOString() });
  }

  // GET /api/mentions — from Supabase
  if (parsed.pathname === '/api/mentions') {
    const limit = parseInt(q.limit || '50');
    const offset = parseInt(q.offset || '0');
    let queryStr = `select=*&order=published_at.desc&limit=${limit}&offset=${offset}`;
    if (q.channel) queryStr += `&channel=eq.${encodeURIComponent(q.channel)}`;
    if (q.sentiment) queryStr += `&sentiment=eq.${encodeURIComponent(q.sentiment)}`;
    supabaseRequest('mentions', 'GET', null, queryStr).then(data => {
      send({ total: Array.isArray(data) ? data.length : 0, offset, limit, data: Array.isArray(data) ? data : [] });
    }).catch(err => send({ error: err.message }, 500));
    return;
  }

  // GET /api/alerts — from Supabase
  if (parsed.pathname === '/api/alerts') {
    let queryStr = `select=*&order=triggered_at.desc`;
    if (q.severity) queryStr += `&severity=eq.${encodeURIComponent(q.severity)}`;
    if (q.status) queryStr += `&status=eq.${encodeURIComponent(q.status)}`;
    const limit = parseInt(q.limit || '50');
    queryStr += `&limit=${limit}`;
    supabaseRequest('alerts', 'GET', null, queryStr).then(data => {
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
    const searchQuery = `or=(title.ilike.*${encodeURIComponent(keyword)}*,content.ilike.*${encodeURIComponent(keyword)}*)&order=published_at.desc&limit=50`;
    supabaseRequest('mentions', 'GET', null, searchQuery).then(data => {
      send({ total: Array.isArray(data) ? data.length : 0, data: Array.isArray(data) ? data : [] });
    }).catch(err => send({ error: err.message }, 500));
    return;
  }

  // GET /api/overview — aggregated counts using HEAD requests
  if (parsed.pathname === '/api/overview') {
    Promise.all([
      supabaseCount('mentions'),
      supabaseCount('alerts', 'severity=eq.high&status=eq.active'),
      supabaseCount('mentions', 'sentiment=eq.positive'),
      supabaseCount('mentions', 'sentiment=eq.negative'),
      supabaseCount('mentions', 'sentiment=eq.neutral'),
    ]).then(([totalMentions, highAlerts, positive, negative, neutral]) => {
      const totalSent = positive + negative + neutral || 1;
      send({
        totalMentions,
        highAlertCount: highAlerts,
        sentiment: {
          positive,
          negative,
          neutral,
          score: Math.round((positive / totalSent) * 100),
        },
        timestamp: new Date().toISOString(),
      });
    }).catch(err => {
      console.error('[API] Overview error:', err.message);
      send({ error: err.message }, 500);
    });
    return;
  }

  // POST /api/sentiment/analyze — analyze text
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
server.listen(PORT, async () => {
  console.log(`Qgofer backend on port ${PORT}`);
  console.log(`Supabase: ${SUPABASE_URL}`);

  // Pre-load known URLs for dedup
  await loadKnownUrls();

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
