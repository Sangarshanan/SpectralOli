import { state } from './state.js';
import { drawWaveformOntoCanvas, drawTrackWaveform, sendSlicesToWorklet } from './waveform.js';

let container;
let headerTitle;
let canvas;
let ctx;
let editorWidth = 0;
let editorHeight = 0;
let isDragging = false;
let dragIdx = -1;

export function initSliceEditor() {
    container = document.getElementById('sliceEditor');
    headerTitle = document.getElementById('sliceEditorTitle');
    canvas = document.getElementById('sliceEditorCanvas');
    if (!canvas) return;
    ctx = canvas.getContext('2d');

    // Handle resizing (simple approach: sync to layout)
    new ResizeObserver(() => {
        if (container.style.display !== 'none') {
            updateEditorDimensions();
            redrawEditor();
        }
    }).observe(container);

    const closeBtn = document.getElementById('sliceEditorCloseBtn');
    if (closeBtn) {
        closeBtn.addEventListener('click', () => {
            const track = state.activeTrack;
            if (track) {
                track.slices = null;
                sendSlicesToWorklet(track);
                drawTrackWaveform(track);
                
                // Keep the button toggle in track-dom in sync by removing active class
                const controls = document.getElementById(`controls-${track.id}`);
                if (controls) {
                    const sliceBtn = controls.querySelector('.btn-slice');
                    if (sliceBtn) sliceBtn.classList.remove('active');
                }
            }
            updateSliceEditor();
        });
    }

    setupEditorDrag();
}

function updateEditorDimensions() {
    const rect = canvas.parentElement.getBoundingClientRect();
    canvas.width = rect.width;
    canvas.height = rect.height;
    editorWidth = rect.width;
    editorHeight = rect.height;
}

export function hideSliceEditor() {
    if (container) {
        container.style.display = 'none';
        isDragging = false;
        dragIdx = -1;
    }
}

export function updateSliceEditor() {
    if (!container || !canvas) return;
    
    const track = state.activeTrack;
    if (track && track.slices && track.slices.length > 0) {
        // Show editor
        container.style.display = 'flex';
        headerTitle.textContent = `Slice Editor — ${track.name}`;
        updateEditorDimensions();
        redrawEditor();
    } else {
        // Hide editor
        container.style.display = 'none';
        isDragging = false;
        dragIdx = -1;
    }
}

export function redrawEditor() {
    if (container.style.display === 'none' || !state.activeTrack) return;
    drawWaveformOntoCanvas(ctx, editorWidth, editorHeight, state.activeTrack);
}

function pointerRatio(e) {
    const r = canvas.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
}

function setupEditorDrag() {
    canvas.addEventListener('mousedown', e => {
        const track = state.activeTrack;
        if (!track || !track.slices || track.slices.length <= 1) return;

        const r = pointerRatio(e);
        const totalSamples = track.audioBuffer.length;
        let bestDist = Infinity;
        let bestIdx = -1;
        
        // Internal boundaries only
        for (let i = 1; i < track.slices.length; i++) {
            const bx = (track.slices[i].start / totalSamples) * editorWidth;
            const d = Math.abs(r * editorWidth - bx);
            if (d < bestDist) { bestDist = d; bestIdx = i; }
        }
        
        // Larger hit area for the big editor
        if (bestDist < 20) {
            isDragging = true;
            dragIdx = bestIdx;
            e.preventDefault();
        }
    });

    window.addEventListener('mousemove', e => {
        if (!isDragging) {
            // Update cursor based on hover
            const track = state.activeTrack;
            if (track && track.slices && container.style.display !== 'none' && e.target === canvas) {
                const r = pointerRatio(e);
                const totalSamples = track.audioBuffer.length;
                let nearest = Infinity;
                for (let i = 1; i < track.slices.length; i++) {
                    const bx = (track.slices[i].start / totalSamples) * editorWidth;
                    nearest = Math.min(nearest, Math.abs(r * editorWidth - bx));
                }
                canvas.style.cursor = nearest < 20 ? 'col-resize' : 'default';
            }
            return;
        }

        const track = state.activeTrack;
        if (!track || !track.slices) return;

        const r = pointerRatio(e);
        const totalSamples = track.audioBuffer.length;
        const rawSample = Math.round(r * totalSamples);

        const lo = track.slices[dragIdx - 1].start + 1;
        const hi = track.slices[dragIdx].end - 1;
        const newBoundary = Math.max(lo, Math.min(rawSample, hi));

        track.slices[dragIdx - 1].end = newBoundary;
        track.slices[dragIdx].start = newBoundary;

        // Redraw both editors
        redrawEditor();
        drawTrackWaveform(track);
    });

    window.addEventListener('mouseup', () => {
        if (isDragging) {
            isDragging = false;
            const track = state.activeTrack;
            if (track) {
                sendSlicesToWorklet(track);
            }
        }
    });
}
