// Argus website scraper - Vercel serverless function
// Lives at /api/scrape in the same project as argus.html.
// Argus calls this instead of a public CORS proxy: faster, not rate-limited,
// proper browser user-agent so far fewer sites refuse the request.
//
// Deploy: put this file at api/scrape.js in the repo root (alongside argus.html)
// and push. Vercel picks it up automatically - no config needed.

const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.|169\.254\.|::1|\[::1\])/i;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'GET only' });
  }

  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'url parameter required' });

  let target;
  try {
    target = new URL(url);
  } catch (e) {
    return res.status(400).json({ error: 'invalid url' });
  }

  // SSRF protection: only public http(s) hosts
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return res.status(400).json({ error: 'http(s) only' });
  }
  if (PRIVATE_HOST.test(target.hostname)) {
    return res.status(400).json({ error: 'blocked host' });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 9000);

  try {
    const upstream = await fetch(target.href, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-IE,en-GB;q=0.9,en;q=0.8'
      }
    });

    const contentType = upstream.headers.get('content-type') || '';
    if (!/text|html|xml/i.test(contentType)) {
      return res.status(415).json({ error: 'not an html page' });
    }

    // stream with a 600KB cap - plenty for contact info, keeps responses fast
    const reader = upstream.body.getReader();
    const chunks = [];
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      chunks.push(value);
      if (received > 600 * 1024) {
        controller.abort();
        break;
      }
    }

    const text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');

    // cache successful fetches at the edge for a day - re-scans are instant and free
    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=604800');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.status(200).send(text);
  } catch (e) {
    return res.status(502).json({ error: 'fetch failed', detail: String(e && e.name) });
  } finally {
    clearTimeout(timer);
  }
}
