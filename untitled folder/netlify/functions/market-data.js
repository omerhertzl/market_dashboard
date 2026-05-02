/**
 * Netlify Serverless Function: market-data
 * ----------------------------------------
 * Proxies all external API calls so API keys stay server-side
 * and the browser never hits a CORS wall.
 *
 * Routes (via ?type=...):
 *   market       → Bigdata.com market tearsheet (markdown)
 *   events       → Bigdata.com earnings/events calendar
 *   findcompany  → Bigdata.com company search
 *   company      → Bigdata.com company tearsheet
 *   news         → CoinDesk news feed (with sentiment)
 *   mtnews       → MT Newswires North America
 *
 * Required env vars (set in Netlify dashboard → Site settings → Env vars):
 *   BIGDATA_KEY    – your Bigdata.com API key
 *   COINDESK_KEY   – your CoinDesk data-API key
 *   MT_KEY         – your MT Newswires API key (if used)
 */

// ── Config ────────────────────────────────────────────────────────────────────
const BIGDATA_BASE  = 'https://api.bigdata.com/v1';   // ← verify with your Bigdata.com docs
const COINDESK_BASE = 'https://data-api.coindesk.com/v1';
const MT_BASE       = 'https://api.mtnewswires.com';  // ← verify with your MT docs

const CORS = {
  'Access-Control-Allow-Origin' : '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type'                : 'application/json',
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function ok(data) {
  return { statusCode: 200, headers: CORS, body: JSON.stringify(data) };
}
function fail(code, msg) {
  console.error(`[market-data] ${code}: ${msg}`);
  return { statusCode: code, headers: CORS, body: JSON.stringify({ error: true, message: msg }) };
}

async function apiFetch(url, options = {}) {
  const res = await fetch(url, { ...options, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Upstream ${res.status} from ${url.split('?')[0]} — ${body.substring(0, 200)}`);
  }
  return res.json();
}

// ── Routes ────────────────────────────────────────────────────────────────────

/** Global market overview — returns { result: "...markdown..." } */
async function fetchMarket() {
  const data = await apiFetch(`${BIGDATA_BASE}/market/tearsheet`, {
    headers: { 'X-API-Key': process.env.BIGDATA_KEY },
  });
  return ok(data);
}

/** Earnings / events calendar for the next N days */
async function fetchEvents(p) {
  const url = new URL(`${BIGDATA_BASE}/events/calendar`);
  url.searchParams.set('countries[]', 'US');
  if (p.start_date) url.searchParams.set('start_date', p.start_date);
  if (p.end_date)   url.searchParams.set('end_date',   p.end_date);
  url.searchParams.set('limit', p.limit || '100');

  const data = await apiFetch(url.toString(), {
    headers: { 'X-API-Key': process.env.BIGDATA_KEY },
  });
  return ok(data);
}

/** Search companies by ticker / name → returns array with id, name, type */
async function findCompany(p) {
  if (!p.query) return fail(400, '"query" parameter is required');

  const data = await apiFetch(
    `${BIGDATA_BASE}/companies/search?query=${encodeURIComponent(p.query)}`,
    { headers: { 'X-API-Key': process.env.BIGDATA_KEY } },
  );
  return ok(data);
}

/** Full company tearsheet (needs rp_entity_id from findCompany) */
async function fetchCompany(p) {
  if (!p.id) return fail(400, '"id" parameter is required');

  const url = new URL(`${BIGDATA_BASE}/company/tearsheet`);
  url.searchParams.set('rp_entity_id',  p.id);
  url.searchParams.set('company_type',  p.company_type || 'Public');

  const data = await apiFetch(url.toString(), {
    headers: { 'X-API-Key': process.env.BIGDATA_KEY },
  });
  return ok(data);
}

/** CoinDesk news with sentiment — returns { Data: [...] } */
async function fetchCoinDeskNews(p) {
  const limit = p.limit || 40;
  const url   = `${COINDESK_BASE}/news/articles?limit=${limit}`;

  const data = await apiFetch(url, {
    headers: {
      'Authorization': `Bearer ${process.env.COINDESK_KEY}`,
    },
  });
  return ok(data);
}

/** MT Newswires North America equities news */
async function fetchMTNews() {
  // ⚠️  Adjust endpoint path to match your MT Newswires subscription
  const data = await apiFetch(
    `${MT_BASE}/data?product=edge&dataset_name=mt_newswires_north_america&last=30`,
    { headers: { 'Authorization': `Bearer ${process.env.MT_KEY}` } },
  );
  return ok(data);
}

// ── Handler ───────────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  // CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  const p    = event.queryStringParameters || {};
  const type = p.type;

  try {
    switch (type) {
      case 'market':      return await fetchMarket();
      case 'events':      return await fetchEvents(p);
      case 'findcompany': return await findCompany(p);
      case 'company':     return await fetchCompany(p);
      case 'news':        return await fetchCoinDeskNews(p);
      case 'mtnews':      return await fetchMTNews();
      default:
        return fail(400, `Unknown type "${type}". Valid: market, events, findcompany, company, news, mtnews`);
    }
  } catch (e) {
    return fail(502, e.message);
  }
};
