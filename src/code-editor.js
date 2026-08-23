// CodeMirror 6 editor for per-track DSL code — replaces the old <textarea>,
// whose direct `.value =` writes clobbered undo history and caret sync.
import { EditorState, StateField, Compartment } from '@codemirror/state';
import { EditorView, keymap, placeholder as placeholderExt, showTooltip } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, insertTab } from '@codemirror/commands';
import { autocompletion, snippetCompletion } from '@codemirror/autocomplete';
import { StreamLanguage, syntaxHighlighting, HighlightStyle, indentUnit } from '@codemirror/language';
import { linter } from '@codemirror/lint';
import { tags as t } from '@lezer/highlight';
import { tryCompileDSL, FFT_SIZES, hasSeqStatement } from './dsl.js';

const FREQUENCY_MASKS = ['low', 'high', 'band', 'harmonic'];
const GLOBAL_DIRECTIVES = ['fft', 'clock', 'gain', 'slicep', 'slicem', 'slicee'];
const SEQUENCE_PATTERN = ['seq'];
const TIME_OPERATORS = [
    'fast', 'slow', 'rev', 'reverse', 'within', 'at', 'on',
    'stutter', 'shuffle', 'silence', 'repeat', 'euclid', 'mirror', 'every'
];
const SPECTRUM_OPERATORS = [
    'blur', 'sgranulate', 'scale', 'rotate', 'skew', 'transpose'
];
const VARIABLE_NAMES = ['time', 'freq', 'x', 'y', 'tRel', 'fRel'];

const FREQ_MASK_SET = new Set(FREQUENCY_MASKS);
const GLOBAL_DIR_SET = new Set(GLOBAL_DIRECTIVES);
const SEQ_PATTERN_SET = new Set(SEQUENCE_PATTERN);
const TIME_OP_SET = new Set(TIME_OPERATORS);
const SPECTRUM_OP_SET = new Set(SPECTRUM_OPERATORS);
const VARIABLE_SET = new Set(VARIABLE_NAMES);

// Slicing alone is silent until seq() consumes it, so these snippets bundle a
// starter seq("0:") (dropped if the doc already declares one).
const makeSliceCompletions = (withSeq) => {
    const tail = withSeq ? '\nseq("0:")' : '';
    return [
        snippetCompletion(`slicep \${1:512}${tail}`, { label: 'slicep', detail: 'Percussive slicing', type: 'function', info: 'slicep n' }),
        snippetCompletion(`slicem \${1:2048}${tail}`, { label: 'slicem', detail: 'Melodic slicing', type: 'function', info: 'slicem n' }),
        snippetCompletion(`slicee \${1:16}${tail}`, { label: 'slicee', detail: 'Equal-time slicing', type: 'function', info: 'slicee n' }),
    ];
};

const completions = [
    snippetCompletion('band(${1:200}, ${2:4000})', { label: 'band', detail: 'Filter freq band', type: 'function', info: 'band(lowHz, highHz)' }),
    snippetCompletion('harmonic(${1:110}, ${2:6}, ${3:45})', { label: 'harmonic', detail: 'Harmonic series filter', type: 'function', info: 'harmonic(baseHz, count, [width])' }),
    snippetCompletion('low(${1:1000})', { label: 'low', detail: 'Low-pass filter', type: 'function', info: 'low(hz)' }),
    snippetCompletion('high(${1:2000})', { label: 'high', detail: 'High-pass filter', type: 'function', info: 'high(hz)' }),
    snippetCompletion('on("${1:0:4}", ${2:}, ${3:0.5})', { label: 'on', detail: 'Modify matching step range', type: 'method', info: 'on(stepSpec, op, [prob])' }),
    snippetCompletion('at("${1:0}", ${2:}, ${3:0.5})', { label: 'at', detail: 'Modify step indices', type: 'method', info: 'at(indexSpec, op, [prob])' }),
    snippetCompletion('every(${1:4}, ${2:})', { label: 'every', detail: 'Run op every n-th cycle', type: 'method', info: 'every(n, op)' }),
    snippetCompletion('fast(${1:2})', { label: 'fast', detail: 'Speed up sequence', type: 'method', info: 'fast(multiplier)' }),
    snippetCompletion('slow(${1:2})', { label: 'slow', detail: 'Slow down sequence', type: 'method', info: 'slow(multiplier)' }),
    snippetCompletion('blur(${1:0.3}, ${2:0.5})', { label: 'blur', detail: 'Spectral blur', type: 'method', info: 'blur(timeAmt, freqAmt)' }),
    snippetCompletion('sgranulate(${1:0.5}, ${2:0.8})', { label: 'sgranulate', detail: 'Spectral granulation', type: 'method', info: 'sgranulate(scatter, mix)' }),
    snippetCompletion('scale(${1:1.5}, ${2:1.0})', { label: 'scale', detail: 'Scale time & freq', type: 'method', info: 'scale(time, freq, [mix])' }),
    snippetCompletion('rotate(${1:45})', { label: 'rotate', detail: 'Rotate spectrum', type: 'method', info: 'rotate(degrees, [mix])' }),
    snippetCompletion('skew(${1:0.5}, ${2:0.0})', { label: 'skew', detail: 'Skew freq across time', type: 'method', info: 'skew(x_skew, y_skew, [mix])' }),
    snippetCompletion('transpose(${1:12})', { label: 'transpose', detail: 'Pitch shift', type: 'method', info: 'transpose(semitones, [mix])' }),
    snippetCompletion('fft ${1:1024}', { label: 'fft', detail: 'STFT frame size', type: 'function', info: 'fft n' }),
    snippetCompletion('clock ${1:0.5}', { label: 'clock', detail: 'Global speed multiplier', type: 'function', info: 'clock multiplier' }),
    snippetCompletion('gain ${1:1.5}', { label: 'gain', detail: 'Output gain (dynamic expression allowed)', type: 'function', info: 'gain expr' }),
    snippetCompletion('stutter(${1:2})', { label: 'stutter', detail: 'Repeat step n times', type: 'function', info: 'stutter(n)' }),
    snippetCompletion('silence()', { label: 'silence', detail: 'Mute targeted steps', type: 'function', info: 'silence()' }),
    snippetCompletion('reverse()', { label: 'reverse', detail: 'Reverse step audio', type: 'function', info: 'reverse()' }),
    snippetCompletion('euclid(${1:k}, ${2:n}, ${3:offset})', { label: 'euclid', detail: 'Euclidean rhythm generator', type: 'function', info: 'euclid(k, n, [offset]) - offset rotates the pattern' }),
    snippetCompletion('shuffle()', { label: 'shuffle', detail: 'Randomize step order', type: 'function', info: 'shuffle([rng])' }),
    snippetCompletion('repeat(${1:2})', { label: 'repeat', detail: 'Loop targeted block', type: 'function', info: 'repeat(n)' }),
    snippetCompletion('mirror()', { label: 'mirror', detail: 'Append mirrored copy', type: 'function', info: 'mirror()' })
];

// Descending boost keeps numeric order — CodeMirror otherwise sorts labels as strings.
const fftSizeOptions = FFT_SIZES.map((n, i) => ({
    label: String(n),
    type: 'constant',
    detail: 'FFT size',
    boost: (FFT_SIZES.length - i) * 10,
}));

function dslCompletions(context) {
    // After a bare fft/slicep/slicem directive only the fixed window sizes are legal.
    if (context.matchBefore(/\b(?:fft|slicep|slicem)\s+\d*/)) {
        const digits = context.matchBefore(/\d*/);
        return { from: digits.from, options: fftSizeOptions, validFor: /^\d*$/ };
    }
    let word = context.matchBefore(/\w*/);
    if (word.from === word.to && !context.explicit) return null;
    const needsSeq = !hasSeqStatement(context.state.doc.toString());
    return {
        from: word.from,
        options: [...makeSliceCompletions(needsSeq), ...completions]
    };
}

const SIGNATURES = {};
for (const comp of [...makeSliceCompletions(false), ...completions]) {
    if (comp.label && comp.info) {
        SIGNATURES[comp.label] = typeof comp.info === 'function' ? comp.info() : comp.info;
    }
}

function getSignatureTooltip(state) {
    const pos = state.selection.main.head;
    const line = state.doc.lineAt(pos);
    const text = line.text;
    const col = pos - line.from;

    let depth = 0;
    for (let i = col - 1; i >= 0; i--) {
        if (text[i] === ')') depth++;
        else if (text[i] === '(') {
            depth--;
            if (depth < 0) {
                let match = text.slice(0, i).match(/\b([a-zA-Z_]\w*)$/);
                if (match) {
                    const funcName = match[1];
                    const sig = SIGNATURES[funcName];
                    if (sig) {
                        return {
                            pos: line.from + i,
                            above: true,
                            strictSide: true,
                            create() {
                                let dom = document.createElement("div");
                                dom.className = "cm-signature-tooltip";
                                dom.textContent = sig;
                                return { dom };
                            }
                        };
                    }
                }
                break;
            }
        }
    }
    return null;
}

const signatureTooltipField = StateField.define({
    create: getSignatureTooltip,
    update(tooltips, tr) {
        if (!tr.docChanged && !tr.selection) return tooltips;
        return getSignatureTooltip(tr.state);
    },
    provide: f => showTooltip.computeN([f], state => {
        let t = state.field(f);
        return t ? [t] : [];
    })
});

// Syntax highlighting only — validation runs via the real parser in dsl.js.
const dslStreamParser = {
    token(stream) {
        if (stream.eatSpace()) return null;
        if (stream.match(/^Math\.[a-zA-Z_]+/)) return 'atom';
        if (stream.match(/^[a-zA-Z_][a-zA-Z0-9_]*/)) {
            const word = stream.current();
            if (FREQ_MASK_SET.has(word)) return 'keyword';
            if (SPECTRUM_OP_SET.has(word)) return 'propertyName';
            if (GLOBAL_DIR_SET.has(word)) return 'type';
            if (SEQ_PATTERN_SET.has(word) || TIME_OP_SET.has(word)) return 'meta';
            if (VARIABLE_SET.has(word)) return 'variableName';
            return 'variableName';
        }
        if (stream.match(/^"(?:[^"\\]|\\.)*"|^'(?:[^'\\]|\\.)*'/)) return 'string';
        if (stream.match(/^\d*\.?\d+/)) return 'number';
        if (stream.match(/^\/\/.*/)) return 'comment';
        if (stream.match(/^[+\-*/%><=!&|?:^~]/)) return 'operator';
        if (stream.match(/^[(),.]/)) return 'punctuation';
        stream.next();
        return null;
    },
};

const dslLanguage = StreamLanguage.define(dslStreamParser);

const dslHighlightStyle = HighlightStyle.define([
    { tag: t.keyword, color: '#00ff88' }, // Frequency Mask
    { tag: t.propertyName, color: '#8cd8ff' }, // Transform Pipeline
    { tag: t.typeName, color: '#ff7f95' }, // Global Directives
    { tag: t.meta, color: '#cba6f7' }, // Sequence Pattern
    { tag: t.variableName, color: '#c8c8c8' },
    { tag: t.number, color: '#f4b860' },
    { tag: t.string, color: '#f4b860' },
    { tag: t.comment, color: '#565f89', fontStyle: 'italic' },
    { tag: t.atom, color: '#ff7f95' },
    { tag: t.operator, color: '#c8c8c8' },
    { tag: t.punctuation, color: '#6a6a6a' },
]);

// The dark palette above deliberately uses bright neon colours. Those colours
// lose contrast on the light editor background, so keep an equivalent set of
// darker token colours for light mode.
const dslHighlightStyleLight = HighlightStyle.define([
    { tag: t.keyword, color: '#087443' }, // Frequency Mask
    { tag: t.propertyName, color: '#006e9c' }, // Transform Pipeline
    { tag: t.typeName, color: '#b4233f' }, // Global Directives
    { tag: t.meta, color: '#7042a5' }, // Sequence Pattern
    { tag: t.variableName, color: '#1f2937' },
    { tag: t.number, color: '#9a5a00' },
    { tag: t.string, color: '#9a5a00' },
    { tag: t.comment, color: '#526174', fontStyle: 'italic' },
    { tag: t.atom, color: '#b4233f' },
    { tag: t.operator, color: '#374151' },
    { tag: t.punctuation, color: '#4b5563' },
]);

const dslTheme = EditorView.theme({
    '&': {
        backgroundColor: '#0c0c0c',
        color: '#00ff88',
        fontSize: '0.9rem',
        border: '1px solid #1e1e1e',
        borderRadius: '4px',
    },
    '&.cm-focused': { outline: 'none', borderColor: '#00ff88' },
    '.cm-content': {
        fontFamily: "'JetBrains Mono', 'Courier New', monospace",
        padding: '8px 10px',
        minHeight: '80px',
        caretColor: '#00ff88',
    },
    '.cm-gutters': { backgroundColor: '#0c0c0c', border: 'none' },
    '.cm-lineNumbers .cm-gutterElement': { color: '#333' },
    '.cm-line': { padding: 0 },
    '.cm-placeholder': { color: '#3f5a46' },
    '.cm-scroller': { overflow: 'auto' },
    '.cm-tooltip-lint': {
        backgroundColor: '#141414',
        border: '1px solid #ff4466',
        color: '#ff9caa',
        fontFamily: "'JetBrains Mono', 'Courier New', monospace",
        fontSize: '0.78rem',
    },
    '.cm-signature-tooltip': {
        backgroundColor: '#1e1e2e',
        color: '#cdd6f4',
        border: '1px solid #cba6f7',
        padding: '4px 8px',
        borderRadius: '4px',
        fontFamily: "'JetBrains Mono', 'Courier New', monospace",
        fontSize: '0.8rem',
        zIndex: 100
    },
}, { dark: true });

const dslThemeLight = EditorView.theme({
    '&': {
        backgroundColor: '#f5f5f5',
        color: '#00804a',
        fontSize: '0.9rem',
        border: '1px solid #c8c8c8',
        borderRadius: '4px',
    },
    '&.cm-focused': { outline: 'none', borderColor: '#00804a' },
    '.cm-content': {
        fontFamily: "'JetBrains Mono', 'Courier New', monospace",
        padding: '8px 10px',
        minHeight: '80px',
        caretColor: '#00804a',
    },
    '.cm-gutters': { backgroundColor: '#f0f0f0', border: 'none' },
    '.cm-lineNumbers .cm-gutterElement': { color: '#aaa' },
    '.cm-line': { padding: 0 },
    '.cm-placeholder': { color: '#7aaf90' },
    '.cm-scroller': { overflow: 'auto' },
    '.cm-tooltip-lint': {
        backgroundColor: '#fff',
        border: '1px solid #d42050',
        color: '#a00030',
        fontFamily: "'JetBrains Mono', 'Courier New', monospace",
        fontSize: '0.78rem',
    },
    '.cm-signature-tooltip': {
        backgroundColor: '#eef0ff',
        color: '#2a2e6e',
        border: '1px solid #9ba0c8',
        padding: '4px 8px',
        borderRadius: '4px',
        fontFamily: "'JetBrains Mono', 'Courier New', monospace",
        fontSize: '0.8rem',
        zIndex: 100
    },
}, { dark: false });

export const themeCompartment = new Compartment();
const highlightCompartment = new Compartment();
export const getActiveTheme = () => document.documentElement.getAttribute('data-theme') === 'light' ? dslThemeLight : dslTheme;
const getActiveHighlighting = () => syntaxHighlighting(
    document.documentElement.getAttribute('data-theme') === 'light' ? dslHighlightStyleLight : dslHighlightStyle
);

// Runs the real parser/compiler and underlines the first error, if any.
function dslLinter(view) {
    const src = view.state.doc.toString();
    if (!src.trim()) return [];
    const { error, errorPos } = tryCompileDSL(src);
    if (!error) return [];
    const docLen = view.state.doc.length;
    const from = Math.max(0, Math.min(errorPos ?? docLen, docLen));
    const to = Math.min(from + 1, docLen) > from ? from + 1 : docLen;
    return [{ from, to: Math.max(to, from), severity: 'error', message: error }];
}

/**
 * Creates a CodeMirror editor bound to a track's DSL code, appends it to
 * `parentEl`, and returns the EditorView. `onApply` fires on Mod-Enter.
 */
export function createTrackCodeEditor(parentEl, { initialCode = '', onApply, onChange, onCursorActivity } = {}) {
    const applyKeymap = keymap.of([
        {
            key: 'Mod-Enter',
            run: view => {
                onApply?.(view.state.doc.toString());
                return true;
            },
        },
        { key: 'Tab', run: insertTab },
        ...historyKeymap,
        ...defaultKeymap,
    ]);

    const state = EditorState.create({
        doc: initialCode,
        extensions: [
            history(),
            dslLanguage,
            highlightCompartment.of(getActiveHighlighting()),
            linter(dslLinter),
            indentUnit.of('  '),
            placeholderExt('Write your code here..'),
            EditorView.lineWrapping,
            autocompletion({ override: [dslCompletions] }),
            signatureTooltipField,
            applyKeymap,
            themeCompartment.of(getActiveTheme()),
            EditorView.updateListener.of(update => {
                if (update.docChanged) onChange?.(update.state.doc.toString());
                if (update.docChanged || update.selectionSet) onCursorActivity?.(update.view);
            }),
        ],
    });

    const view = new EditorView({ state, parent: parentEl });
    return view;
}

export function updateEditorTheme(view) {
    view.dispatch({
        effects: [
            themeCompartment.reconfigure(getActiveTheme()),
            highlightCompartment.reconfigure(getActiveHighlighting()),
        ]
    });
}

export function getTrackCode(view) {
    return view.state.doc.toString();
}

// Single undo-able transaction — avoid raw doc replacement, which resets undo history.
export function setTrackCode(view, code, { focus = false } = {}) {
    view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: code },
        selection: { anchor: code.length },
    });
    if (focus) view.focus();
}

export function setEditorError(view, hasError) {
    view.dom.classList.toggle('cm-has-error', !!hasError);
}
