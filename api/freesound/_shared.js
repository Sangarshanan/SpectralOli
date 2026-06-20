const FREESOUND_API_BASE = 'https://freesound.org/apiv2';

export function getApiKey() {
    return process.env.FREESOUND_API_KEY || process.env.VITE_FREESOUND_API_KEY || '';
}

export function json(res, statusCode, payload) {
    res.status(statusCode).json(payload);
}

export function text(res, statusCode, payload) {
    res.status(statusCode).setHeader('Content-Type', 'text/plain; charset=utf-8').send(payload);
}

export async function fetchFreesoundJson(url, apiKey) {
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

export function isAllowedFreesoundUrl(value) {
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

export { FREESOUND_API_BASE };
