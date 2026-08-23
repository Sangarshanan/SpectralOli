// Shared mutable application state — all modules import and read/write it directly.
export const state = {
// Audio context
    audioCtx:       null,
    masterGain:     null,
    masterAnalyser: null,
    playing:        false,
    rafRunning:     false,
    bpm:            80,
    beatsPerCycle:  4,

// Master spectrogram buffers
    masterW:        900,
    masterH:        220,
    masterFreqData: null,
    masterImgData:  null,
    masterPixels32: null,
    masterVisHead:  0,
    masterVisData:  null,
    masterVizMax:   1,
    masterBandRows: null,
    resizeRaf:      null,

// Track registry
    tracks:        new Map(),

// Drag state
    activeWaveDrag: null,
    activeSvgDrag:  null,
    activeTrack:    null,

// UI selection
    selectedTrackId: null,
};
