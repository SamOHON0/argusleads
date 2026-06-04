// Argus site audit - Vercel serverless function
// Lives at /api/audit alongside /api/scrape. Unlike a plain fetch, this
// actually TESTS the things the grader claims:
//   - SSL: attempts a real https connection (and reports the failure code)
//   - redirects: follows them and reports where the site really ends up
//   - speed: measures server response time
//   - size: page weight
// Returns JSON: { ok, finalUrl, status, ms, bytes, ssl: {ok, code, httpFallback},
//                 redirectedToSocial, html }

const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.|169\.254\.|::1|\[::1\])/i;
const SOCIAL_HOSTS = ['facebook.com', 'instagram.com', 'linktr.ee', 'tiktok.com', 'twitter.com', 'x.com', 'business.site'];

const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-IE,en-GB;q=0.9,en;q=0.8'
};

async function tryFetch(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: BROWSER_HEADERS
    });
    return { res, ms: Date.now() - started, error: null };
  } catch (e) {
    return {
      res: null,
      ms: Date.now() - started,
      error: (e && e.cause && e.cause.code) || (e && e.name) || 'FETCH_FAILED'
    };
  } finally {
    clearTimeout(timer);
  }
}

async function readCapped(res, capBytes) {
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.length;
    chunks.push(value);
    if (received > capBytes) break;
  }
  return { text: Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8'), bytes: received };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const raw = req.query.url;
  if (!raw) return res.status(400).json({ error: 'url parameter required' });

  let target;
  try {
    target = new URL(raw);
  } catch (e) {
    return res.status(400).json({ error: 'invalid url' });
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return res.status(400).json({ error: 'http(s) only' });
  }
  if (PRIVATE_HOST.test(target.hostname)) {
    return res.status(400).json({ error: 'blocked host' });
  }

  // Always test https first - this IS the SSL check
  const httpsUrl = 'https://' + target.host + target.pathname + target.search;
  const httpUrl = 'http://' + target.host + target.pathname + target.search;

  let attempt = await tryFetch(httpsUrl, 9000);
  const ssl = { ok: !!attempt.res, code: attempt.error || null, httpFallback: false };

  if (!attempt.res) {
    // https failed entirely (bad/expired cert, no https at all) - try plain http
    attempt = await tryFetch(httpUrl, 9000);
    if (attempt.res) ssl.httpFallback = true;
  }

  if (!attempt.res) {
    return res.status(200).json({
      ok: false,
      ssl,
      status: 0,
      ms: attempt.ms,
      error: attempt.error,
      html: ''
    });
  }

  const upstream = attempt.res;
  const contentType = upstream.headers.get('content-type') || '';
  let html = '';
  let bytes = 0;
  if (/text|html|xml/i.test(contentType)) {
    try {
      const capped = await readCapped(upstream, 600 * 1024);
      html = capped.text;
      bytes = capped.bytes;
    } catch (e) {
      /* partial reads are fine */
    }
  }

  let finalHost = '';
  try {
    finalHost = new URL(upstream.url).hostname.replace(/^www\./, '');
  } catch (e) {}

  const redirectedToSocial = SOCIAL_HOSTS.some(
    (h) => finalHost === h || finalHost.endsWith('.' + h)
  );

  res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=604800');
  return res.status(200).json({
    ok: upstream.status < 400,
    finalUrl: upstream.url,
    status: upstream.status,
    ms: attempt.ms,
    bytes,
    ssl,
    redirectedToSocial,
    html
  });
}
