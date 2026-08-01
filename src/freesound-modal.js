// Freesound search modal
//
// Design rules this module follows, each one fixing a class of bug the previous
// version had:
//
// 1. Every async action restores its own UI state in a `finally`, including the
//    success path. The old code only re-enabled a Load button in its error
//    handler, so a successful load left the button stranded on "Loading..."
//    forever — the row stayed dead until the user ran a whole new search.
// 2. Page navigations are abortable and token-guarded, so a slow response can
//    never overwrite newer results.
// 3. Exactly one <audio> element exists, so it is structurally impossible for
//    two previews to overlap.

const API_SEARCH_URL = '/api/freesound/search';
const API_PAGE_URL = '/api/freesound/page';
const API_PREVIEW_URL = '/api/freesound/preview';

const PAGE_SIZE = 20;
const SEARCH_FIELDS = 'id,name,username,duration,license,previews,bpm';

// Auditioning wants the smallest file that starts soonest; loading a track wants
// the best quality available. Same endpoint, opposite preference order.
const PREVIEW_QUALITY = ['preview-lq-mp3', 'preview-lq-ogg', 'preview-hq-mp3', 'preview-hq-ogg'];
const LOAD_QUALITY = ['preview-hq-mp3', 'preview-hq-ogg', 'preview-lq-mp3', 'preview-lq-ogg'];

function pickUrl(item, order) {
    const previews = item?.previews;
    if (!previews) return null;
    for (const key of order) {
        if (previews[key]) return previews[key];
    }
    return null;
}

function proxied(url) {
    return `${API_PREVIEW_URL}?url=${encodeURIComponent(url)}`;
}

function readSourceBpm(item) {
    // `bpm` is the flat search field; `ac_analysis.ac_tempo` is where the
    // AudioCommons analysis puts it. Accept either so metadata isn't silently
    // dropped depending on which shape the API returns.
    const raw = item?.bpm ?? item?.ac_analysis?.ac_tempo;
    const bpm = Number(raw);
    return Number.isFinite(bpm) && bpm > 0 ? bpm : null;
}

function describe(item) {
    return item?.name || `sound ${item?.id ?? ''}`.trim();
}

export function setupFreesoundModal({ addTrackFromArrayBuffer, getBpm, getMasterDuration }) {
    const el = {
        openBtn: document.getElementById('queryFreesoundBtn'),
        modal: document.getElementById('freesoundModal'),
        closeBtn: document.getElementById('freesoundCloseBtn'),
        query: document.getElementById('fsQueryInput'),
        durationMin: document.getElementById('fsDurationMin'),
        durationMax: document.getElementById('fsDurationMax'),
        bpmMin: document.getElementById('fsBpmMin'),
        bpmMax: document.getElementById('fsBpmMax'),
        sort: document.getElementById('fsSortSelect'),
        searchBtn: document.getElementById('fsSearchBtn'),
        status: document.getElementById('fsStatus'),
        results: document.getElementById('fsResults'),
        prevBtn: document.getElementById('fsPrevBtn'),
        nextBtn: document.getElementById('fsNextBtn'),
        pageInfo: document.getElementById('fsPageInfo'),
    };

    if (!el.modal || !el.results) return;

    // One element for the lifetime of the modal: the browser keeps its decoder
    // and connection warm between previews, and only one can ever be audible.
    const audio = new Audio();
    audio.preload = 'none';

    const session = {
        page: 1,
        nextUrl: null,
        prevUrl: null,
        navToken: 0,
        navAbort: null,
        loading: false,
        previewBtn: null,
        rows: [],
        lastFocus: null,
    };

    // ── Small UI helpers ────────────────────────────────────────────────────

    const isOpen = () => el.modal.classList.contains('open');
    const setStatus = msg => { el.status.textContent = msg; };

    function updatePagination() {
        el.pageInfo.textContent = `Page ${session.page}`;
        el.prevBtn.disabled = !session.prevUrl;
        el.nextBtn.disabled = !session.nextUrl;
    }

    function setNavBusy(busy) {
        el.searchBtn.disabled = busy;
        if (busy) {
            el.prevBtn.disabled = true;
            el.nextBtn.disabled = true;
        } else {
            updatePagination();
        }
    }

    function clearResults() {
        session.rows = [];
        el.results.replaceChildren();
    }

    // Defensive: no path should leave a row disabled, but reopening the modal
    // must never present a dead button even if one somehow slipped through.
    function resetRowButtons() {
        for (const row of session.rows) {
            row.loadBtn.disabled = false;
            row.loadBtn.textContent = 'Load';
        }
    }

    // ── Preview ─────────────────────────────────────────────────────────────

    function setPreviewLabel(btn, label, playing) {
        btn.textContent = label;
        btn.classList.toggle('playing', playing);
    }

    function stopPreview() {
        audio.pause();
        if (session.previewBtn) {
            setPreviewLabel(session.previewBtn, 'Preview', false);
            session.previewBtn = null;
        }
    }

    function togglePreview(item, btn) {
        if (session.previewBtn === btn) {
            stopPreview();
            return;
        }
        stopPreview();

        const url = pickUrl(item, PREVIEW_QUALITY);
        if (!url) {
            setStatus('Preview not available for this sound.');
            return;
        }

        session.previewBtn = btn;
        setPreviewLabel(btn, 'Buffering…', true);
        audio.src = proxied(url);
        audio.play().catch(err => {
            if (session.previewBtn !== btn) return; // superseded by another click
            setStatus(`Preview failed: ${err.message}`);
            stopPreview();
        });
    }

    audio.addEventListener('playing', () => {
        if (session.previewBtn) setPreviewLabel(session.previewBtn, 'Pause', true);
    });
    audio.addEventListener('waiting', () => {
        if (session.previewBtn) setPreviewLabel(session.previewBtn, 'Buffering…', true);
    });
    audio.addEventListener('ended', stopPreview);
    audio.addEventListener('error', () => {
        if (!session.previewBtn) return;
        setStatus('Preview failed to load.');
        stopPreview();
    });

    // ── Loading a result into a track ───────────────────────────────────────

    async function loadItem(item, btn) {
        if (session.loading) return;

        const url = pickUrl(item, LOAD_QUALITY);
        if (!url) {
            setStatus('No audio available for this sound.');
            return;
        }

        session.loading = true;
        btn.disabled = true;
        btn.textContent = 'Loading…';
        stopPreview();

        try {
            setStatus(`Fetching ${describe(item)}…`);
            const resp = await fetch(proxied(url));
            if (!resp.ok) throw new Error(`fetch failed (HTTP ${resp.status})`);

            const raw = await resp.arrayBuffer();
            const sourceBpm = readSourceBpm(item);
            const name = `${item.name || 'freesound'}_${item.id}`.replace(/\.[^/.]+$/, '');

            await addTrackFromArrayBuffer(raw, name, sourceBpm);

            // Tempo is matched at playback time from the loop's musical length,
            // so nothing is time-stretched during load.
            setStatus(sourceBpm
                ? `Loaded ${describe(item)} — source ${sourceBpm} BPM.`
                : `Loaded ${describe(item)}.`);
            closeModal();
        } catch (err) {
            setStatus(`Load failed: ${err.message}`);
        } finally {
            // Runs on success too. This is the fix for the stranded-button bug.
            session.loading = false;
            btn.disabled = false;
            btn.textContent = 'Load';
        }
    }

    // ── Rendering ───────────────────────────────────────────────────────────

    function buildRow(item) {
        const row = document.createElement('div');
        row.className = 'fs-item';

        const left = document.createElement('div');

        const title = document.createElement('div');
        title.textContent = `${item.name || 'untitled'} · @${item.username || 'unknown'}`;

        const meta = document.createElement('div');
        meta.className = 'fs-meta';
        const duration = Number.isFinite(item.duration) ? `${item.duration.toFixed(2)}s` : 'unknown';
        const bpm = readSourceBpm(item);
        meta.textContent = `id:${item.id} · ${duration}${bpm ? ` · ${bpm} BPM` : ''} · ${item.license || 'license n/a'}`;

        left.append(title, meta);

        const actions = document.createElement('div');
        actions.className = 'fs-actions';

        const previewBtn = document.createElement('button');
        previewBtn.className = 'fs-preview-btn';
        previewBtn.textContent = 'Preview';
        previewBtn.addEventListener('click', () => togglePreview(item, previewBtn));

        const loadBtn = document.createElement('button');
        loadBtn.className = 'fs-load-btn';
        loadBtn.textContent = 'Load';
        loadBtn.addEventListener('click', () => loadItem(item, loadBtn));

        actions.append(previewBtn, loadBtn);
        row.append(left, actions);

        return { row, previewBtn, loadBtn };
    }

    function renderResults(results) {
        clearResults();

        if (!results.length) {
            setStatus('No results. Try a broader query or a wider duration range.');
            return;
        }

        const frag = document.createDocumentFragment();
        for (const item of results) {
            const built = buildRow(item);
            session.rows.push(built);
            frag.appendChild(built.row);
        }
        el.results.appendChild(frag);

        setStatus(`Found ${results.length} result(s). Preview or load a sound.`);
    }

    // ── Requests ────────────────────────────────────────────────────────────

    function buildFilter() {
        const filters = [];
        const minDur = el.durationMin.value.trim();
        const maxDur = el.durationMax.value.trim();
        const minBpm = el.bpmMin.value.trim();
        const maxBpm = el.bpmMax.value.trim();

        if (minDur || maxDur) filters.push(`duration:[${minDur || '0'} TO ${maxDur || '*'}]`);
        if (minBpm || maxBpm) filters.push(`bpm:[${minBpm || '0'} TO ${maxBpm || '*'}]`);
        filters.push('tag:loop');

        return filters.join(' ');
    }

    async function getJson(url, signal) {
        const resp = await fetch(url, { signal });
        if (!resp.ok) {
            const body = await resp.text();
            throw new Error(`HTTP ${resp.status}: ${body.slice(0, 120)}`);
        }
        return resp.json();
    }

    function searchUrl(query, page) {
        const params = new URLSearchParams({
            query,
            page: String(page),
            page_size: String(PAGE_SIZE),
            sort: el.sort.value || 'score',
            fields: SEARCH_FIELDS,
        });
        const filter = buildFilter();
        if (filter) params.set('filter', filter);
        return `${API_SEARCH_URL}?${params.toString()}`;
    }

    function pageUrl(url) {
        return `${API_PAGE_URL}?${new URLSearchParams({ url }).toString()}`;
    }

    // Single funnel for every page transition, so aborting, race-guarding and
    // busy-state restoration are written once rather than per navigation.
    async function navigate(label, buildUrl, nextPage) {
        session.navAbort?.abort();
        const abort = new AbortController();
        session.navAbort = abort;
        const token = ++session.navToken;

        stopPreview();
        clearResults();
        setStatus(label);
        setNavBusy(true);

        try {
            const data = await getJson(buildUrl(), abort.signal);
            if (token !== session.navToken) return; // a newer navigation won

            session.page = nextPage();
            session.nextUrl = data.next || null;
            session.prevUrl = data.previous || null;
            renderResults(data.results || []);
        } catch (err) {
            if (err.name === 'AbortError' || token !== session.navToken) return;
            setStatus(`Error: ${err.message}`);
        } finally {
            if (token === session.navToken) {
                session.navAbort = null;
                setNavBusy(false);
            }
        }
    }

    function doSearch() {
        const query = el.query.value.trim();
        if (!query) {
            setStatus('Enter a search query first.');
            el.query.focus();
            return;
        }
        return navigate('Searching Freesound…', () => searchUrl(query, 1), () => 1);
    }

    function goNext() {
        if (!session.nextUrl) return;
        const url = session.nextUrl;
        return navigate('Loading next page…', () => pageUrl(url), () => session.page + 1);
    }

    function goPrev() {
        if (!session.prevUrl) return;
        const url = session.prevUrl;
        return navigate('Loading previous page…', () => pageUrl(url), () => Math.max(1, session.page - 1));
    }

    // ── Open / close ────────────────────────────────────────────────────────

    // Only fills blanks, so reopening never discards values the user typed.
    function prefillFilters() {
        const duration = getMasterDuration ? getMasterDuration() : null;
        if (!el.durationMin.value && !el.durationMax.value) {
            if (duration !== null && duration > 0) {
                el.durationMin.value = Math.max(0, duration - 10).toFixed(1);
                el.durationMax.value = (duration + 10).toFixed(1);
            } else {
                el.durationMin.value = '5';
                el.durationMax.value = '20';
            }
        }

        if (getBpm && !el.bpmMin.value && !el.bpmMax.value) {
            const bpm = getBpm();
            if (Number.isFinite(bpm) && bpm > 0) {
                el.bpmMin.value = String(Math.max(1, Math.round(bpm - 20)));
                el.bpmMax.value = String(Math.round(bpm + 20));
            }
        }
    }

    function openModal() {
        session.lastFocus = document.activeElement;
        prefillFilters();
        resetRowButtons();
        updatePagination();
        el.modal.classList.add('open');
        el.modal.setAttribute('aria-hidden', 'false');
        el.query.focus();
        el.query.select();
    }

    function closeModal() {
        stopPreview();
        // In-flight page requests are pointless once hidden; an in-flight track
        // load is deliberately left running so closing doesn't discard it.
        session.navAbort?.abort();
        session.navAbort = null;
        setNavBusy(false);

        el.modal.classList.remove('open');
        el.modal.setAttribute('aria-hidden', 'true');
        session.lastFocus?.focus?.();
        session.lastFocus = null;
    }

    // ── Wiring ──────────────────────────────────────────────────────────────

    el.openBtn?.addEventListener('click', openModal);
    el.closeBtn?.addEventListener('click', closeModal);
    el.searchBtn?.addEventListener('click', doSearch);
    el.prevBtn?.addEventListener('click', goPrev);
    el.nextBtn?.addEventListener('click', goNext);

    for (const input of [el.query, el.durationMin, el.durationMax, el.bpmMin, el.bpmMax]) {
        input?.addEventListener('keydown', e => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            doSearch();
        });
    }
    el.sort?.addEventListener('change', () => {
        if (el.query.value.trim()) doSearch();
    });

    el.modal.addEventListener('click', e => {
        if (e.target === el.modal) closeModal();
    });

    window.addEventListener('keydown', e => {
        if (e.key === 'Escape' && isOpen()) closeModal();
    });

    updatePagination();
}
