import { trackNavigator, navCount } from './dom.js';
import { state } from './state.js';

// Collapse / Expand

export function toggleCollapse(track) {
    track.collapsed = !track.collapsed;
    track.el.classList.toggle('collapsed', track.collapsed);
}

// Play button enabled state

export function updatePlayButton() {
    const playBtn = document.getElementById('playBtn');
    if (playBtn) playBtn.disabled = state.tracks.size === 0;
}

// Track navigator pills

export function updateNavigator() {
    trackNavigator.querySelectorAll('.nav-pill').forEach(p => p.remove());

    const n = state.tracks.size;
    navCount.textContent = n > 0 ? `${n} total` : '';

    for (const track of state.tracks.values()) {
        const pill = document.createElement('button');
        pill.className = 'nav-pill';
        pill.dataset.trackId = track.id;
        pill.textContent = track.name;
        if (track.muted) pill.classList.add('muted');
        if (track.id === state.masterTrackId) pill.classList.add('master');
        pill.addEventListener('click', () => scrollToTrack(track.id));
        trackNavigator.insertBefore(pill, navCount);
    }
}

// Scroll & select track

export function scrollToTrack(id) {
    const track = state.tracks.get(id);
    if (!track || !track.el) return;

    if (track.collapsed) toggleCollapse(track);

    track.el.scrollIntoView({ behavior: 'smooth', block: 'center' });

    state.selectedTrackId = id;

    state.tracks.forEach(t => {
        if (t.el) t.el.classList.toggle('active-lane', t.id === id);
    });

    trackNavigator.querySelectorAll('.nav-pill').forEach(p => {
        p.classList.toggle('active', p.dataset.trackId === id);
    });
}
