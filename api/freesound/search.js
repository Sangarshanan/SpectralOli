import { FREESOUND_API_BASE, fetchFreesoundJson, getApiKey, json } from './_shared.js';

export default async function handler(req, res) {
    if (req.method !== 'GET') {
        return json(res, 405, { error: 'Method not allowed' });
    }

    const apiKey = getApiKey();
    if (!apiKey) {
        return json(res, 500, { error: 'Missing FREESOUND_API_KEY in server env' });
    }

    try {
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(req.query || {})) {
            if (Array.isArray(value)) {
                for (const item of value) params.append(key, String(item));
            } else if (value !== undefined) {
                params.append(key, String(value));
            }
        }

        const endpoint = `${FREESOUND_API_BASE}/search/text/?${params.toString()}`;
        const data = await fetchFreesoundJson(endpoint, apiKey);
        json(res, 200, data);
    } catch (err) {
        json(res, 500, { error: err.message });
    }
}
