import { Readable } from 'node:stream';
import { isAllowedFreesoundUrl, text } from './_shared.js';

// Audio preview proxy.
//
// This streams the upstream response straight through instead of buffering it.
// Buffering the whole file (await resp.arrayBuffer() then res.send) serialised
// two full downloads before playback could start — the function had to receive
// every byte from Freesound, then the browser had to receive every byte from
// the function. Piping lets <audio> start decoding on the first chunk.
//
// Range requests are forwarded as well, so the browser can seek and can fetch
// only what it needs to begin playing rather than the entire file.

const FORWARDED_REQUEST_HEADERS = ['range', 'if-range', 'if-none-match', 'if-modified-since'];
const FORWARDED_RESPONSE_HEADERS = [
    'content-type',
    'content-length',
    'content-range',
    'accept-ranges',
    'etag',
    'last-modified',
];

export default async function handler(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        return text(res, 405, 'Method not allowed');
    }

    const rawTarget = req.query.url;
    const targetUrl = Array.isArray(rawTarget) ? rawTarget[0] : rawTarget;

    if (!targetUrl || !isAllowedFreesoundUrl(targetUrl)) {
        return text(res, 400, 'Invalid preview URL');
    }

    try {
        const headers = {};
        for (const name of FORWARDED_REQUEST_HEADERS) {
            const value = req.headers[name];
            if (value) headers[name] = value;
        }

        const upstream = await fetch(targetUrl, { method: req.method, headers });

        // 206 (partial) and 304 (not modified) are successes for our purposes.
        if (!upstream.ok && upstream.status !== 206 && upstream.status !== 304) {
            return text(res, upstream.status, `Preview fetch failed: ${upstream.status}`);
        }

        res.status(upstream.status);
        for (const name of FORWARDED_RESPONSE_HEADERS) {
            const value = upstream.headers.get(name);
            if (value) res.setHeader(name, value);
        }
        if (!upstream.headers.get('accept-ranges')) res.setHeader('Accept-Ranges', 'bytes');
        if (!upstream.headers.get('content-type')) res.setHeader('Content-Type', 'audio/mpeg');

        // Preview files are content-addressed by Freesound and never change, so
        // a long cache makes re-previewing the same result instant.
        res.setHeader('Cache-Control', 'public, max-age=86400, immutable');

        if (req.method === 'HEAD' || upstream.status === 304 || !upstream.body) {
            return res.end();
        }

        const stream = Readable.fromWeb(upstream.body);
        stream.on('error', () => res.end());
        res.on('close', () => stream.destroy());
        stream.pipe(res);
    } catch (err) {
        if (res.headersSent) res.end();
        else text(res, 500, err.message);
    }
}
