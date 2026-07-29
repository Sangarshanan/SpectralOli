// CodeMirror 6 powered editor for per-track DSL code.
// Replaces the previous bare <textarea>, which had no undo-safe mutation
// path (direct `.value =` writes clobbered the native undo stack and could
// desync the caret from the visible text) and no wrapping/highlighting.
import { EditorState, StateField } from '@codemirror/state';
import { EditorView, keymap, placeholder as placeholderExt, showTooltip } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, insertTab } from '@codemirror/commands';
import { autocompletion, snippetCompletion } from '@codemirror/autocomplete';
import { StreamLanguage, syntaxHighlighting, HighlightStyle, indentUnit } from '@codemirror/language';
import { linter } from '@codemirror/lint';
import { tags as t } from '@lezer/highlight';
import { tryCompileDSL } from './dsl.js';

const REGION_NAMES  = ['low', 'high', 'band', 'harmonic'];
const METHOD_NAMES  = [
    'add', 'sub', 'invert', 'blur', 'fast', 'slow', 'rev', 'sgranulate',
    'scale', 'rotate', 'skew', 'transpose', 'gain',
    'seq', 'slicep', 'slicem', 'slicee', 'fft',
    'within', 'at', 'on', 'stutter', 'reverse', 'shuffle', 'silence',
    'repeat', 'euclid', 'mirror', 'every',
];
const VARIABLE_NAMES = ['time', 'freq', 'x', 'y', 'tRel', 'fRel'];
const REGION_SET = new Set(REGION_NAMES);
const METHOD_SET = new Set(METHOD_NAMES);
const VARIABLE_SET = new Set(VARIABLE_NAMES);

const completions = [
    snippetCompletion('slicep(${1:512})\nseq("0:")', { label: 'slicep', detail: 'Percussive slicing', type: 'function', info: 'slicep(fftSize)' }),
    snippetCompletion('slicem(${1:2048})\nseq("0:")', { label: 'slicem', detail: 'Melodic slicing', type: 'function', info: 'slicem(fftSize)' }),
    snippetCompletion('slicee(${1:16})\nseq("0:")', { label: 'slicee', detail: 'Equal-time slicing', type: 'function', info: 'slicee(numSlices)' }),
    snippetCompletion('band(${1:200}, ${2:4000})', { label: 'band', detail: 'Filter freq band', type: 'function', info: 'band(lowHz, highHz)' }),
    snippetCompletion('harmonic(${1:110}, ${2:6})', { label: 'harmonic', detail: 'Harmonic series filter', type: 'function', info: 'harmonic(baseHz, count)' }),
    snippetCompletion('low(${1:1000})', { label: 'low', detail: 'Low-pass filter', type: 'function', info: 'low(hz)' }),
    snippetCompletion('high(${1:2000})', { label: 'high', detail: 'High-pass filter', type: 'function', info: 'high(hz)' }),
    snippetCompletion('on("${1:0:4}", ${2:}, ${3:0.5})', { label: 'on', detail: 'Modify matching step range', type: 'method', info: 'on(stepSpec, op, [prob])' }),
    snippetCompletion('at("${1:0}", ${2:}, ${3:0.5})', { label: 'at', detail: 'Modify step indices', type: 'method', info: 'at(indexSpec, op, [prob])' }),
    snippetCompletion('every(${1:4}, ${2:})', { label: 'every', detail: 'Run op every n-th cycle', type: 'method', info: 'every(n, op)' }),
    snippetCompletion('fast(${1:2})', { label: 'fast', detail: 'Speed up sequence', type: 'method', info: 'fast(multiplier)' }),
    snippetCompletion('slow(${1:2})', { label: 'slow', detail: 'Slow down sequence', type: 'method', info: 'slow(multiplier)' }),
    snippetCompletion('blur(${1:0.3}, ${2:0.5})', { label: 'blur', detail: 'Spectral blur', type: 'method', info: 'blur(timeAmt, freqAmt)' }),
    snippetCompletion('sgranulate(${1:0.5}, ${2:0.8})', { label: 'sgranulate', detail: 'Spectral granulation', type: 'method', info: 'sgranulate(density, size)' }),
    snippetCompletion('scale(${1:1.5}, ${2:1.0})', { label: 'scale', detail: 'Scale time & freq', type: 'method', info: 'scale(time, freq, [mix])' }),
    snippetCompletion('rotate(${1:45})', { label: 'rotate', detail: 'Rotate spectrum', type: 'method', info: 'rotate(degrees, [mix])' }),
    snippetCompletion('skew(${1:0.5}, ${2:0.0})', { label: 'skew', detail: 'Skew freq across time', type: 'method', info: 'skew(x_skew, y_skew, [mix])' }),
    snippetCompletion('transpose(${1:12})', { label: 'transpose', detail: 'Pitch shift', type: 'method', info: 'transpose(semitones, [mix])' }),
    snippetCompletion('add(${1:high(4000)})', { label: 'add', detail: 'Add filter spectrum', type: 'method', info: 'add(spectrum)' }),
    snippetCompletion('sub(${1:band(800, 1200)})', { label: 'sub', detail: 'Subtract filter spectrum', type: 'method', info: 'sub(spectrum)' }),
    snippetCompletion('invert()', { label: 'invert', detail: 'Invert spectral magnitudes', type: 'method', info: 'invert()' }),
    snippetCompletion('stutter(${1:2})', { label: 'stutter', detail: 'Repeat step n times', type: 'function', info: 'stutter(n)' }),
    snippetCompletion('silence()', { label: 'silence', detail: 'Mute targeted steps', type: 'function', info: 'silence()' }),
    snippetCompletion('reverse()', { label: 'reverse', detail: 'Reverse step audio', type: 'function', info: 'reverse()' }),
    snippetCompletion('euclid(${1:k}, ${2:n})', { label: 'euclid', detail: 'Euclidean rhythm generator', type: 'function', info: 'euclid(k, n)' }),
    snippetCompletion('shuffle()', { label: 'shuffle', detail: 'Randomize step order', type: 'function', info: 'shuffle()' }),
    snippetCompletion('repeat(${1:2})', { label: 'repeat', detail: 'Loop targeted block', type: 'function', info: 'repeat(n)' }),
    snippetCompletion('mirror()', { label: 'mirror', detail: 'Append mirrored copy', type: 'function', info: 'mirror()' })
];

function dslCompletions(context) {
    let word = context.matchBefore(/\w*/);
    if (word.from === word.to && !context.explicit) return null;
    return {
        from: word.from,
        options: completions
    };
}

const SIGNATURES = {};
for (const comp of completions) {
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

// Minimal stream tokenizer for syntax highlighting only (validation is
// handled by the real recursive-descent parser in dsl.js via the linter).
const dslStreamParser = {
    token(stream) {
        if (stream.eatSpace()) return null;
        if (stream.match(/^Math\.[a-zA-Z_]+/)) return 'atom';
        if (stream.match(/^[a-zA-Z_][a-zA-Z0-9_]*/)) {
            const word = stream.current();
            if (REGION_SET.has(word)) return 'keyword';
            if (METHOD_SET.has(word)) return 'propertyName';
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
    { tag: t.keyword,      color: '#00ff88' },
    { tag: t.propertyName, color: '#8cd8ff' },
    { tag: t.variableName, color: '#c8c8c8' },
    { tag: t.number,       color: '#f4b860' },
    { tag: t.string,       color: '#00ff88' },
    { tag: t.comment,      color: '#565f89', fontStyle: 'italic' },
    { tag: t.atom,         color: '#ff7f95' },
    { tag: t.operator,     color: '#c8c8c8' },
    { tag: t.punctuation,  color: '#6a6a6a' },
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

// Runs the real DSL parser/compiler and reports the first error, if any,
// underlined at the character offset the parser attached to it.
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
            syntaxHighlighting(dslHighlightStyle),
            linter(dslLinter),
            indentUnit.of('  '),
            placeholderExt('band(200, 4000).invert().add(band(5000, 8000))'),
            EditorView.lineWrapping,
            autocompletion({ override: [dslCompletions] }),
            signatureTooltipField,
            applyKeymap,
            dslTheme,
            EditorView.updateListener.of(update => {
                if (update.docChanged) onChange?.(update.state.doc.toString());
                if (update.docChanged || update.selectionSet) onCursorActivity?.(update.view);
            }),
        ],
    });

    const view = new EditorView({ state, parent: parentEl });
    return view;
}

export function getTrackCode(view) {
    return view.state.doc.toString();
}

// Replaces the entire document in one undo-able transaction — never use
// direct string concatenation into a fresh EditorState, which would reset
// undo history and any active selection.
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
