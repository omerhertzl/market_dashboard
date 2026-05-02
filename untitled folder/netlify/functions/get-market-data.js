/**
 * Netlify Function: get-market-data
 * ----------------------------------
 * Single serverless endpoint that aggregates data from:
 *   - Yahoo Finance  (via yahoo-finance2)  → watchlist quotes
 *   - Finnhub.io     (FINNHUB_KEY env var) → market news
 *   - CoinGecko      (free, no key)        → crypto prices
 *
 * Routes:  GET /.netlify/functions/get-market-data?type=<route>
 *   all           – fetch watchlist + news + crypto in one shot
 *   watchlist     – stock/index quotes only
 *   news          – Finnhub market news only
 *   crypto        – CoinGecko top coins only
 *   quote         – single ticker  (?type=quote&symbol=AAPL)
 */

const yahooFinance = require('yahoo-finance2').default;
const axios        = require('axios');

// ── Constants ─────────────────────────────────────────────────────────────────

const FINNHUB_BASE = 'https://finnhub.io/api/v1';
const GECKO_BASE   = 'https://api.coingecko.com/api/v3';

const WATCHLIST = [
  // Major indices
  { symbol: '^GSPC', name: 'S&P 500',      type: 'index' },
  { symbol: '^DJI',  name: 'Dow Jones',    type: 'index' },
  { symbol: '^IXIC', name: 'NASDAQ',       type: 'index' },
  { symbol: '^RUT',  name: 'Russell 2000', type: 'index' },
  { symbol: '^VIX',  name: 'VIX',          type: 'vix'   },
  // Mega-caps
  { symbol: 'AAPL',  name: 'Apple',        type: 'stock' },
  { symbol: 'MSFT',  name: 'Microsoft',    type: 'stock' },
  { symbol: 'NVDA',  name: 'NVIDIA',       type: 'stock' },
  { symbol: 'AMZN',  name: 'Amazon',       type: 'stock' },
  { symbol: 'TSLA',  name: 'Tesla',        type: 'stock' },
  { symbol: 'META',  name: 'Meta',         type: 'stock' },
  { symbol: 'GOOGL', name: 'Alphabet',     type: 'stock' },
  { symbol: 'AMD',   name: 'AMD',          type: 'stock' },
  // ETFs
  { symbol: 'SPY',   name: 'SPY ETF',      type: 'etf'   },
  { symbol: 'QQQ',   name: 'QQQ ETF',      type: 'etf'   },
  { symbol: 'IWM',   name: 'IWM ETF',      type: 'etf'   },
];

const CORS = {
  'Access-Control-Allow-Origin' : '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type'                : 'application/json',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

const ok   = (data) => ({ statusCode: 200, headers: CORS, body: JSON.stringify(data) });
const fail = (code, msg) => {
  console.error(`[get-market-data] ${code}: ${msg}`);
  return { statusCode: code, headers: CORS, body: JSON.stringify({ error: true, message: msg }) };
};

function normaliseQuote(q, meta = {}) {
  return {
    symbol       : q.symbol,
    name         : meta.name || q.longName || q.shortName || q.symbol,
    type         : meta.type || 'stock',
    price        : q.regularMarketPrice        ?? null,
    change       : q.regularMarketChange       ?? null,
    changePct    : q.regularMarketChangePercent ?? null,   // already in % form
    volume       : q.regularMarketVolume        ?? null,
    dayHigh      : q.regularMarketDayHigh       ?? null,
    dayLow       : q.regularMarketDayLow        ?? null,
    open         : q.regularMarketOpen          ?? null,
    prevClose    : q.regularMarketPreviousClose ?? null,
    marketCap    : q.marketCap                  ?? null,
    fiftyTwoWeekHigh : q.fiftyTwoWeekHigh       ?? null,
    fiftyTwoWeekLow  : q.fiftyTwoWeekLow        ?? null,
    currency     : q.currency || 'USD',
  };
}

// ── Data fetchers ─────────────────────────────────────────────────────────────

async function fetchWatchlist() {
  const results = await Promise.allSettled(
    WATCHLIST.map(({ symbol, name, type }) =>
      yahooFinance.quote(symbol).then(q => normaliseQuote(q, { name, type }))
    )
  );

  return results.map((r, i) =>
    r.status === 'fulfilled'
      ? r.value
      : {
          symbol : WATCHLIST[i].symbol,
          name   : WATCHLIST[i].name,
          type   : WATCHLIST[i].type,
          error  : r.reason?.message ?? 'fetch failed',
        }
  );
}

async function fetchSingleQuote(symbol) {
  const q = await yahooFinance.quote(symbol.toUpperCase());
  return normaliseQuote(q);
}

async function fetchNews() {
  const res = await axios.get(`${FINNHUB_BASE}/news`, {
    params : { category: 'general', token: process.env.FINNHUB_KEY },
    timeout: 9_000,
  });

  return (res.data || []).slice(0, 30).map(n => ({
    id       : n.id,
    headline : n.headline,
    summary  : n.summary  || '',
    source   : n.source,
    url      : n.url,
    datetime : n.datetime,       // unix timestamp
    image    : n.image   || '',
    related  : n.related || '',
  }));
}

async function fetchCrypto() {
  const res = await axios.get(`${GECKO_BASE}/coins/markets`, {
    params: {
      vs_currency              : 'usd',
      order                    : 'market_cap_desc',
      per_page                 : 15,
      page                     : 1,
      sparkline                : false,
      price_change_percentage  : '1h,24h,7d',
    },
    timeout: 9_000,
  });

  return (res.data || []).map(c => ({
    id       : c.id,
    symbol   : c.symbol.toUpperCase(),
    name     : c.name,
    image    : c.image,
    price    : c.current_price,
    marketCap: c.market_cap,
    volume24h: c.total_volume,
    change1h : c.price_change_percentage_1h_in_currency  ?? null,
    change24h: c.price_change_percentage_24h             ?? null,
    change7d : c.price_change_percentage_7d_in_currency  ?? null,
    high24h  : c.high_24h,
    low24h   : c.low_24h,
    rank     : c.market_cap_rank,
  }));
}

// ── Handler ───────────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  const p    = event.queryStringParameters || {};
  const type = (p.type || '').toLowerCase();

  try {
    switch (type) {

      case 'watchlist':
        return ok(await fetchWatchlist());

      case 'news':
        return ok(await fetchNews());

      case 'crypto':
        return ok(await fetchCrypto());

      case 'quote': {
        if (!p.symbol) return fail(400, '"symbol" query param is required for type=quote');
        return ok(await fetchSingleQuote(p.symbol));
      }

      case 'all': {
        const [wl, nw, cr] = await Promise.allSettled([
          fetchWatchlist(),
          fetchNews(),
          fetchCrypto(),
        ]);

        return ok({
          watchlist : wl.status === 'fulfilled' ? wl.value : { error: wl.reason?.message },
          news      : nw.status === 'fulfilled' ? nw.value : { error: nw.reason?.message },
          crypto    : cr.status === 'fulfilled' ? cr.value : { error: cr.reason?.message },
          fetchedAt : new Date().toISOString(),
        });
      }

      default:
        return fail(400, `Unknown type "${type}". Valid: all, watchlist, news, crypto, quote`);
    }
  } catch (e) {
    console.error('[get-market-data] unhandled:', e);
    return fail(502, e.message);
  }
};
