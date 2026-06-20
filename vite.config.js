import { defineConfig, loadEnv } from 'vite';

const FREESOUND_API_BASE = 'https://freesound.org/apiv2';

function json(res, statusCode, payload) {
    res.statusCode = statusCode;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(payload));
}

function text(res, statusCode, payload) {
    res.statusCode = statusCode;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end(payload);
}

function normalizeRequestedUrl(value) {
    const raw = String(value ?? '')
        .trim()
        .replace(/^\d+\.\s+/, '')
        .replace(/^['"]|['"]$/g, '');

    if (/^https?%3A/i.test(raw)) {
        try {
            return decodeURIComponent(raw);
        } catch {
            return raw;
        }
    }

    return raw;
}

async function fetchFreesoundJson(url, apiKey) {
    const resp = await fetch(url, {
        headers: { Authorization: `Token ${apiKey}` },
    });

    const contentType = resp.headers.get('content-type') || '';
    if (!resp.ok) {
        const body = await resp.text();
        throw new Error(`${resp.status} ${body.slice(0, 200)}`);
    }

    if (!contentType.includes('application/json')) {
        const body = await resp.text();
        throw new Error(`Unexpected content-type: ${contentType} ${body.slice(0, 120)}`);
    }

    return resp.json();
}

function isFreesoundHost(hostname) {
    return hostname === 'freesound.org' || hostname.endsWith('.freesound.org');
}

function isAllowedFreesoundUrl(value) {
    try {
        const url = new URL(value);
        const isHttp = url.protocol === 'http:' || url.protocol === 'https:';
        if (!isHttp || !isFreesoundHost(url.hostname)) return false;

        return (
            url.pathname.startsWith('/apiv2/') ||
            url.pathname.startsWith('/data/previews/') ||
            url.pathname.startsWith('/previews/')
        );
    } catch {
        return false;
    }
}

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, process.cwd(), '');
    const apiKey = env.FREESOUND_API_KEY || env.VITE_FREESOUND_API_KEY || '';

    return {
        plugins: [
            {
                name: 'freesound-proxy',
                configureServer(server) {
                    server.middlewares.use('/api/freesound/search', async (req, res) => {
                        try {
                            if (!apiKey) {
                                json(res, 500, { error: 'Missing FREESOUND_API_KEY in server env' });
                                return;
                            }

                            const url = new URL(req.url, 'http://localhost');
                            const query = new URLSearchParams(url.search);
                            const endpoint = `${FREESOUND_API_BASE}/search/text/?${query.toString()}`;
                            const data = await fetchFreesoundJson(endpoint, apiKey);
                            json(res, 200, data);
                        } catch (err) {
                            json(res, 500, { error: err.message });
                        }
                    });

                    server.middlewares.use('/api/freesound/page', async (req, res) => {
                        try {
                            if (!apiKey) {
                                json(res, 500, { error: 'Missing FREESOUND_API_KEY in server env' });
                                return;
                            }

                            const url = new URL(req.url, 'http://localhost');
                            const targetUrl = normalizeRequestedUrl(url.searchParams.get('url'));
                            if (!targetUrl || !isAllowedFreesoundUrl(targetUrl)) {
                                json(res, 400, { error: 'Invalid pagination URL' });
                                return;
                            }

                            const data = await fetchFreesoundJson(targetUrl, apiKey);
                            json(res, 200, data);
                        } catch (err) {
                            json(res, 500, { error: err.message });
                        }
                    });

                    server.middlewares.use('/api/freesound/preview', async (req, res) => {
                        try {
                            const url = new URL(req.url, 'http://localhost');
                            const targetUrl = normalizeRequestedUrl(url.searchParams.get('url'));
                            if (!targetUrl || !isAllowedFreesoundUrl(targetUrl)) {
                                text(res, 400, 'Invalid preview URL');
                                return;
                            }

                            const resp = await fetch(targetUrl);
                            if (!resp.ok) {
                                text(res, resp.status, `Preview fetch failed: ${resp.status}`);
                                return;
                            }

                            const contentType = resp.headers.get('content-type') || 'audio/mpeg';
                            const buffer = Buffer.from(await resp.arrayBuffer());
                            res.statusCode = 200;
                            res.setHeader('Content-Type', contentType);
                            res.setHeader('Cache-Control', 'public, max-age=60');
                            res.end(buffer);
                        } catch (err) {
                            text(res, 500, err.message);
                        }
                    });
                },
            },
        ],
    };
});
