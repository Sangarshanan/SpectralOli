const API_SEARCH_URL = '/api/freesound/search';
const API_PAGE_URL = '/api/freesound/page';
const API_PREVIEW_URL = '/api/freesound/preview';

export function setupFreesoundModal({ addTrackFromArrayBuffer }) {
    const queryBtn = document.getElementById('queryFreesoundBtn');
    const modal = document.getElementById('freesoundModal');
    const closeBtn = document.getElementById('freesoundCloseBtn');
    const queryInput = document.getElementById('fsQueryInput');
    const tagInput = document.getElementById('fsTagInput');
    const durationMinInput = document.getElementById('fsDurationMin');
    const durationMaxInput = document.getElementById('fsDurationMax');
    const sortSelect = document.getElementById('fsSortSelect');
    const searchBtn = document.getElementById('fsSearchBtn');
    const statusEl = document.getElementById('fsStatus');
    const resultsEl = document.getElementById('fsResults');
    const prevBtn = document.getElementById('fsPrevBtn');
    const nextBtn = document.getElementById('fsNextBtn');
    const pageInfoEl = document.getElementById('fsPageInfo');

    const state = {
        page: 1,
        nextUrl: null,
        prevUrl: null,
        previewAudio: null,
        previewButton: null,
    };

    function setStatus(text) {
        statusEl.textContent = text;
    }

    function updatePaginationUI() {
        pageInfoEl.textContent = `Page ${state.page}`;
        prevBtn.disabled = !state.prevUrl;
        nextBtn.disabled = !state.nextUrl;
    }

    function clearResults() {
        resultsEl.innerHTML = '';
    }

    function openModal() {
        modal.classList.add('open');
        modal.setAttribute('aria-hidden', 'false');
        queryInput.focus();
    }

    function closeModal() {
        modal.classList.remove('open');
        modal.setAttribute('aria-hidden', 'true');
        stopPreview();
    }

    function buildFilter() {
        const filters = [];
        const tag = tagInput.value.trim();
        const minDur = durationMinInput.value.trim();
        const maxDur = durationMaxInput.value.trim();

        if (tag) filters.push(`tag:${tag}`);
        if (minDur || maxDur) {
            const min = minDur || '0';
            const max = maxDur || '*';
            filters.push(`duration:[${min} TO ${max}]`);
        }
        if (!tag) filters.push('tag:loop');

        return filters.join(' ');
    }

    function previewProxyUrl(originalPreviewUrl) {
        return `${API_PREVIEW_URL}?url=${encodeURIComponent(originalPreviewUrl)}`;
    }

    function getPreviewUrl(item) {
        return item.previews?.['preview-hq-mp3'] || item.previews?.['preview-lq-mp3'] || item.previews?.['preview-hq-ogg'] || item.previews?.['preview-lq-ogg'] || null;
    }

    function stopPreview() {
        if (state.previewAudio) {
            state.previewAudio.pause();
            state.previewAudio.currentTime = 0;
            state.previewAudio = null;
        }
        if (state.previewButton) {
            state.previewButton.classList.remove('playing');
            state.previewButton.textContent = 'Preview';
            state.previewButton = null;
        }
    }

    function attachPreview(button, item) {
        button.addEventListener('click', () => {
            const rawUrl = getPreviewUrl(item);
            if (!rawUrl) {
                setStatus('Preview not available for this sound.');
                return;
            }

            // Toggle off if same preview is already playing.
            if (state.previewButton === button && state.previewAudio) {
                stopPreview();
                return;
            }

            stopPreview();

            const audio = new Audio(previewProxyUrl(rawUrl));
            audio.addEventListener('ended', () => stopPreview());
            audio.play().catch(err => {
                setStatus(`Preview failed: ${err.message}`);
                stopPreview();
            });

            state.previewAudio = audio;
            state.previewButton = button;
            button.classList.add('playing');
            button.textContent = 'Pause';
        });
    }

    async function loadResult(item, loadBtn) {
        const rawUrl = getPreviewUrl(item);
        if (!rawUrl) throw new Error('No preview URL available for this sound');

        stopPreview();
        setStatus(`Fetching preview: ${item.name}...`);
        loadBtn.disabled = true;
        loadBtn.textContent = 'Loading...';

        const resp = await fetch(previewProxyUrl(rawUrl));
        if (!resp.ok) throw new Error(`Preview fetch failed (HTTP ${resp.status})`);

        const raw = await resp.arrayBuffer();
        const safeName = `${item.name || 'freesound'}_${item.id}`.replace(/\.[^/.]+$/, '');
        await addTrackFromArrayBuffer(raw, safeName);

        setStatus(`Loaded: ${item.name}`);
        closeModal();
    }

    function renderResults(results) {
        clearResults();

        if (!results.length) {
            setStatus('No results. Try broader query or wider duration range.');
            return;
        }

        for (const item of results) {
            const row = document.createElement('div');
            row.className = 'fs-item';

            const left = document.createElement('div');
            const title = document.createElement('div');
            title.textContent = `${item.name || 'untitled'} · @${item.username || 'unknown'}`;

            const meta = document.createElement('div');
            meta.className = 'fs-meta';
            const duration = Number.isFinite(item.duration) ? `${item.duration.toFixed(2)}s` : 'unknown';
            meta.textContent = `id:${item.id} · ${duration} · ${item.license || 'license n/a'}`;

            left.append(title, meta);

            const actions = document.createElement('div');
            actions.className = 'fs-actions';

            const previewBtn = document.createElement('button');
            previewBtn.className = 'fs-preview-btn';
            previewBtn.textContent = 'Preview';
            attachPreview(previewBtn, item);

            const loadBtn = document.createElement('button');
            loadBtn.className = 'fs-load-btn';
            loadBtn.textContent = 'Load';
            loadBtn.addEventListener('click', async () => {
                try {
                    await loadResult(item, loadBtn);
                } catch (err) {
                    setStatus(`Load failed: ${err.message}`);
                    loadBtn.disabled = false;
                    loadBtn.textContent = 'Load';
                }
            });

            actions.append(previewBtn, loadBtn);
            row.append(left, actions);
            resultsEl.appendChild(row);
        }

        setStatus(`Found ${results.length} result(s). Preview or load a sound.`);
    }

    async function fetchSearchPage(query, page = 1) {
        const params = new URLSearchParams({
            query,
            page: String(page),
            page_size: '20',
            sort: sortSelect.value || 'score',
            fields: 'id,name,username,duration,license,previews',
        });

        const filter = buildFilter();
        if (filter) params.set('filter', filter);

        const resp = await fetch(`${API_SEARCH_URL}?${params.toString()}`);
        if (!resp.ok) {
            const txt = await resp.text();
            throw new Error(`Search failed (HTTP ${resp.status}): ${txt.slice(0, 120)}`);
        }
        return resp.json();
    }

    async function fetchByPageUrl(pageUrl) {
        const params = new URLSearchParams({ url: pageUrl });
        const resp = await fetch(`${API_PAGE_URL}?${params.toString()}`);
        if (!resp.ok) {
            const txt = await resp.text();
            throw new Error(`Page request failed (HTTP ${resp.status}): ${txt.slice(0, 120)}`);
        }
        return resp.json();
    }

    function applyPageData(data) {
        state.nextUrl = data.next || null;
        state.prevUrl = data.previous || null;
        renderResults(data.results || []);
        updatePaginationUI();
    }

    async function doSearch() {
        const query = queryInput.value.trim();
        if (!query) {
            setStatus('Enter a search query first.');
            return;
        }

        stopPreview();
        clearResults();
        setStatus('Searching Freesound...');

        state.page = 1;
        const data = await fetchSearchPage(query, state.page);
        applyPageData(data);
    }

    async function gotoNext() {
        if (!state.nextUrl) return;
        stopPreview();
        clearResults();
        setStatus('Loading next page...');
        const data = await fetchByPageUrl(state.nextUrl);
        state.page += 1;
        applyPageData(data);
    }

    async function gotoPrev() {
        if (!state.prevUrl) return;
        stopPreview();
        clearResults();
        setStatus('Loading previous page...');
        const data = await fetchByPageUrl(state.prevUrl);
        state.page = Math.max(1, state.page - 1);
        applyPageData(data);
    }

    queryBtn?.addEventListener('click', openModal);
    closeBtn?.addEventListener('click', closeModal);
    searchBtn?.addEventListener('click', async () => {
        try { await doSearch(); }
        catch (err) { setStatus(`Error: ${err.message}`); }
    });

    queryInput?.addEventListener('keydown', async e => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        try { await doSearch(); }
        catch (err) { setStatus(`Error: ${err.message}`); }
    });

    prevBtn?.addEventListener('click', async () => {
        try { await gotoPrev(); }
        catch (err) { setStatus(`Error: ${err.message}`); }
    });

    nextBtn?.addEventListener('click', async () => {
        try { await gotoNext(); }
        catch (err) { setStatus(`Error: ${err.message}`); }
    });

    modal?.addEventListener('click', e => {
        if (e.target === modal) closeModal();
    });

    window.addEventListener('keydown', e => {
        if (e.key === 'Escape' && modal?.classList.contains('open')) closeModal();
    });

    updatePaginationUI();
}
