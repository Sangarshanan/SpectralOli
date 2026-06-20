import { isAllowedFreesoundUrl, text } from './_shared.js';

export default async function handler(req, res) {
    if (req.method !== 'GET') {
        return text(res, 405, 'Method not allowed');
    }

    try {
        const rawTarget = req.query.url;
        const targetUrl = Array.isArray(rawTarget) ? rawTarget[0] : rawTarget;

        if (!targetUrl || !isAllowedFreesoundUrl(targetUrl)) {
            return text(res, 400, 'Invalid preview URL');
        }

        const resp = await fetch(targetUrl);
        if (!resp.ok) {
            return text(res, resp.status, `Preview fetch failed: ${resp.status}`);
        }

        const contentType = resp.headers.get('content-type') || 'audio/mpeg';
        const buffer = Buffer.from(await resp.arrayBuffer());

        res.status(200);
        res.setHeader('Content-Type', contentType);
        res.setHeader('Cache-Control', 'public, max-age=60');
        res.send(buffer);
    } catch (err) {
        text(res, 500, err.message);
    }
}
