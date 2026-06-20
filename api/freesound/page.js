import { fetchFreesoundJson, getApiKey, isAllowedFreesoundUrl, json } from './_shared.js';

export default async function handler(req, res) {
    if (req.method !== 'GET') {
        return json(res, 405, { error: 'Method not allowed' });
    }

    const apiKey = getApiKey();
    if (!apiKey) {
        return json(res, 500, { error: 'Missing FREESOUND_API_KEY in server env' });
    }

    try {
        const rawTarget = req.query.url;
        const targetUrl = Array.isArray(rawTarget) ? rawTarget[0] : rawTarget;

        if (!targetUrl || !isAllowedFreesoundUrl(targetUrl)) {
            return json(res, 400, { error: 'Invalid pagination URL' });
        }

        const data = await fetchFreesoundJson(targetUrl, apiKey);
        json(res, 200, data);
    } catch (err) {
        json(res, 500, { error: err.message });
    }
}
