// DSL: Spectral expression language //
import { seq, within, at, on, stutter, reverse, shuffle, silence, repeat, euclid, mirror, every, slow, fast } from './slice-pattern.js';

const REGIONS = new Set(['low', 'high', 'band', 'harmonic']);
const METHOD_SPECS = {
    low: { kind: 'base_region' },
    high: { kind: 'base_region' },
    band: { kind: 'base_region' },
    harmonic: { kind: 'base_region' },
    add: { kind: 'region' },
    sub: { kind: 'region_sub' },
    invert: { kind: 'invert' },
    blur: { kind: 'blur' },
    sgranulate: { kind: 'granulate' },
    scale: { kind: 'scale' },
    rotate: { kind: 'rotate' },
    skew: { kind: 'skew' },
    transpose: { kind: 'transpose' },
    gain: { kind: 'gain' },
};
const METHODS = new Set(Object.keys(METHOD_SPECS)); // Only these can be chained
// Kinds that are chain-only and cannot open an expression as a base call
const CHAIN_ONLY_KINDS = new Set(['region', 'region_sub', 'invert']);
const BASE_METHODS = new Set(
    Object.keys(METHOD_SPECS).filter(m => !CHAIN_ONLY_KINDS.has(METHOD_SPECS[m].kind))
);
const PATTERN_OPS = new Set(['within', 'at', 'on', 'stutter', 'reverse', 'shuffle', 'silence', 'repeat', 'euclid', 'mirror', 'every', 'slow', 'fast']);
export const CLOCK_DEFAULTS = { speedMultiplier: 1.0, isReversed: false };

const createClockMod = () => ({ ...CLOCK_DEFAULTS });

// Tokenizer

function tokenize(src) {
    const tokens = [];
    let i = 0;
    while (i < src.length) {
        const ch = src[i];
        const startI = i;
        if (/\s/.test(ch)) { i++; continue; }

        if (/[a-zA-Z_]/.test(ch)) {
            let j = i + 1;
            while (j < src.length && /[a-zA-Z0-9_]/.test(src[j])) j++;
            const name = src.slice(i, j);
            // Consume 'Math.PROP' as a single MATHREF token so the '.' isn't
            // mistaken for a chain-method dot.
            if (name === 'Math' && src[j] === '.') {
                j++; // consume '.'
                const k = j;
                while (j < src.length && /[a-zA-Z0-9_]/.test(src[j])) j++;
                tokens.push({ t: 'MATHREF', v: src.slice(k, j), pos: startI });
            } else {
                tokens.push({ t: 'ID', v: name, pos: startI });
            }
            i = j;
            continue;
        }

        // Quoted string literals ("..." or '...')
        if (ch === '"' || ch === "'") {
            const quote = ch;
            let j = i + 1;
            let str = '';
            while (j < src.length) {
                if (src[j] === '\\' && j + 1 < src.length) {
                    str += src[j + 1];
                    j += 2;
                } else if (src[j] === quote) {
                    j++;
                    break;
                } else {
                    str += src[j++];
                }
            }
            tokens.push({ t: 'STR', v: str });
            i = j;
            continue;
        }

        // Numeric literals (including decimals starting with '.' like .25)
        if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
            let j = i + 1;
            while (j < src.length && /[0-9.]/.test(src[j])) j++;
            tokens.push({ t: 'NUM', v: parseFloat(src.slice(i, j)), pos: startI });
            i = j;
            continue;
        }

        if (ch === '(') { tokens.push({ t: '(', pos: startI }); i++; continue; }
        if (ch === ')') { tokens.push({ t: ')', pos: startI }); i++; continue; }
        if (ch === ',') { tokens.push({ t: ',', pos: startI }); i++; continue; }
        if (ch === '.') { tokens.push({ t: '.', pos: startI }); i++; continue; }
        if (/[+\-*\/%><=!&|?:^~]/.test(ch)) {
            let j = i + 1;
            while (j < src.length && /[+\-*\/%><=!&|?:^~]/.test(src[j])) j++;
            tokens.push({ t: 'OP', v: src.slice(i, j), pos: startI });
            i = j;
            continue;
        }

        const err = new Error(`Unexpected character '${ch}' at position ${i}`);
        err.pos = i;
        throw err;
    }
    return tokens;
}

// Parser

// Leading environment statements that are stripped before the main expression:
//   fft(size)    — power-of-two FFT window, 256–8192
//   slicep(n)    — percussive onset detection, fft size n
//   slicem(n)    — melodic onset detection, fft size n
//   slicee(n)    — equal-width slice into n chunks
const FFT_STMT_RE = /^fft\s*\(\s*(\d+)\s*\)\s*(?:;)?\s*/;
const SLICEP_RE = /^slicep\s*\(\s*(\d+)\s*\)\s*(?:;)?\s*/;
const SLICEM_RE = /^slicem\s*\(\s*(\d+)\s*\)\s*(?:;)?\s*/;
const SLICEE_RE = /^slicee\s*\(\s*(\d+)\s*\)\s*(?:;)?\s*/;
// The only window sizes fft()/slicep()/slicem() accept. Also drives the
// numeric autocomplete in code-editor.js so the two can't drift apart.
export const FFT_SIZES = [256, 512, 1024, 2048, 4096, 8192];
const FFT_SIZE_HINT = `use one of ${FFT_SIZES.join(', ')}`;
// True if the source already declares a sequence. The slice-statement snippets
// append a starter seq("0:") for convenience; this lets them skip that when one
// is already present rather than inserting a duplicate.
export const hasSeqStatement = (src) => /\bseq\s*\(/.test(src);
// Global fast()/slow() — same names as the seq() ops, but as a bare statement
// they scale the whole track's clock instead of a single step.
const SPEED_STMT_RE = /^(fast|slow)\s*\(\s*(\d*\.?\d+)\s*\)\s*(?:;)?\s*/;

// Advances past whitespace and JS-style comments (// line, /* block */) starting at idx.
// Used so trailing comments don't get mistaken for the end of a chained statement.
function skipTrivia(src, idx) {
    let j = idx;
    while (j < src.length) {
        if (/\s/.test(src[j])) {
            j++;
        } else if (src[j] === '/' && src[j + 1] === '/') {
            j += 2;
            while (j < src.length && src[j] !== '\n') j++;
        } else if (src[j] === '/' && src[j + 1] === '*') {
            j += 2;
            while (j < src.length && !(src[j] === '*' && src[j + 1] === '/')) j++;
            j = Math.min(j + 2, src.length);
        } else {
            break;
        }
    }
    return j;
}

function extractSlicePatternStmt(src) {
    if (!src.startsWith('seq(')) {
        return null;
    }
    let depth = 0;
    let inQuote = null;
    let i = 0;
    let started = false;
    while (i < src.length) {
        const ch = src[i];
        if (inQuote) {
            if (ch === inQuote && src[i - 1] !== '\\') {
                inQuote = null;
            }
        } else if (ch === '"' || ch === "'") {
            inQuote = ch;
        } else if (ch === '/' && src[i + 1] === '/') {
            // Skip line comment entirely — its contents shouldn't affect paren
            // depth or chain-continuation detection.
            i = skipTrivia(src, i);
            continue;
        } else if (ch === '/' && src[i + 1] === '*') {
            i = skipTrivia(src, i);
            continue;
        } else if (ch === '(') {
            depth++;
            started = true;
        } else if (ch === ')') {
            depth--;
            if (started && depth === 0) {
                // Peek ahead — skip whitespace/comments then check what follows
                let j = skipTrivia(src, i + 1);
                // If a dot follows, check if it's a known pattern-op chain (.within, .stutter, etc.)
                if (j < src.length && src[j] === '.') {
                    let k = skipTrivia(src, j + 1);
                    // Read identifier
                    let m = k;
                    while (m < src.length && /[a-zA-Z_]/.test(src[m])) m++;
                    while (m < src.length && /[a-zA-Z0-9_]/.test(src[m])) m++;
                    const methodName = src.slice(k, m);
                    if (PATTERN_OPS.has(methodName)) {
                        // Continue scanning — include this chained call
                        i++;
                        continue;
                    }
                    // Otherwise it's a spectral method chain — stop here, strip the dot
                    const stmt = src.slice(0, i + 1);
                    let remainder = src.slice(j + 1).trimStart(); // skip the dot
                    return { stmt, remainder };
                }
                // No dot, or end of input — this is the end of the pattern statement.
                // Skip any trailing whitespace/comment (and an optional semicolon)
                // so it doesn't leak into the remainder as bogus source text.
                const stmt = src.slice(0, i + 1);
                let remStart = skipTrivia(src, i + 1);
                if (src[remStart] === ';') remStart = skipTrivia(src, remStart + 1);
                const remainder = src.slice(remStart);
                return { stmt, remainder };
            }
        }
        i++;
    }
    return null;
}

export function parse(src) {
    let source = src.trim();
    let fftSize = null;
    let seqIndices = null;
    let pendingSlice = null;
    let clockMod = null;

    // Standalone statements (fft/slicep/slicem/slicee) cannot be dot-chained
    // onto whatever follows — they're per-track init, not expression modifiers.
    // Throws a short, specific error if a '.' immediately follows one.
    function rejectDotChain(name) {
        if (source[0] === '.') throw new Error(`${name}() is a standalone statement and cannot be chained`);
    }

    // Strip prefix statements in any order; each at most once
    let changed = true;
    while (changed) {
        changed = false;
        const fftMatch = source.match(FFT_STMT_RE);
        if (fftMatch) {
            const n = parseInt(fftMatch[1], 10);
            if (!FFT_SIZES.includes(n))
                throw new Error(`fft(${n}) invalid — ${FFT_SIZE_HINT}`);
            fftSize = n;
            source = source.slice(fftMatch[0].length).trimStart();
            rejectDotChain('fft');
            changed = true;
        }
        const slicepMatch = source.match(SLICEP_RE);
        if (slicepMatch) {
            const n = parseInt(slicepMatch[1], 10);
            if (!FFT_SIZES.includes(n))
                throw new Error(`slicep(${n}) invalid — ${FFT_SIZE_HINT}`);
            pendingSlice = { kind: 'percussion', fftSize: n };
            source = source.slice(slicepMatch[0].length).trimStart();
            rejectDotChain('slicep');
            changed = true;
        }
        const slicemMatch = source.match(SLICEM_RE);
        if (slicemMatch) {
            const n = parseInt(slicemMatch[1], 10);
            if (!FFT_SIZES.includes(n))
                throw new Error(`slicem(${n}) invalid — ${FFT_SIZE_HINT}`);
            pendingSlice = { kind: 'melodic', fftSize: n };
            source = source.slice(slicemMatch[0].length).trimStart();
            rejectDotChain('slicem');
            changed = true;
        }
        const sliceeMatch = source.match(SLICEE_RE);
        if (sliceeMatch) {
            const n = parseInt(sliceeMatch[1], 10);
            if (n < 1) throw new Error(`slicee(${n}) needs n >= 1`);
            pendingSlice = { kind: 'equal', n };
            source = source.slice(sliceeMatch[0].length).trimStart();
            rejectDotChain('slicee');
            changed = true;
        }
        const patMatch = extractSlicePatternStmt(source);
        if (patMatch) {
            try {
                const fn = new Function('seq', 'within', 'at', 'on', 'stutter', 'reverse', 'shuffle', 'silence', 'repeat', 'euclid', 'mirror', 'every', 'slow', 'fast', `return ${patMatch.stmt};`);
                seqIndices = fn(seq, within, at, on, stutter, reverse, shuffle, silence, repeat, euclid, mirror, every, slow, fast);
            } catch (err) {
                throw new Error(`Bad seq pattern: ${err.message}`);
            }
            source = patMatch.remainder;
            changed = true;
        }
        const speedMatch = source.match(SPEED_STMT_RE);
        if (speedMatch) {
            const mult = parseFloat(speedMatch[2]);
            if (!(mult > 0))
                throw new Error(`${speedMatch[1]}() needs a positive number`);
            const factor = speedMatch[1] === 'fast' ? mult : 1 / mult;
            const base = clockMod ?? createClockMod();
            clockMod = { ...base, speedMultiplier: base.speedMultiplier * factor };
            source = source.slice(speedMatch[0].length).trimStart();
            // Unlike fft/slicep/slicem/slicee, fast()/slow() ARE chainable —
            // eat a leading dot so 'fast(2).band(...)' parses like
            // 'fast(2); band(...)' instead of leaving a dangling '.'.
            if (source[0] === '.') source = source.slice(1).trimStart();
            changed = true;
        }
    }

    const tokens = tokenize(source);
    let pos = 0;

    const peek = () => tokens[pos];
    const eat = () => tokens[pos++];
    const need = (t, v) => {
        const tok = eat();
        if (!tok || tok.t !== t || (v !== undefined && tok.v !== v))
            throw new Error(`Expected ${t}${v !== undefined ? ` "${v}"` : ''}, got ${JSON.stringify(tok)}`);
        return tok;
    };

    // Arithmetic expression parser
    // Constants fold at parse time.  'time' and 'freq' stay as runtime JS strings.
    // Supports: +  -  *  /  %  unary-  parentheses  Math.*  time  freq

    const isNum = v => typeof v === 'number';

    function binOp(op, a, b) {
        if (isNum(a) && isNum(b)) {
            if (op === '+') return a + b;
            if (op === '-') return a - b;
            if (op === '*') return a * b;
            if (op === '/') return a / b;
            if (op === '%') return a % b;
        }
        return `${a} ${op} ${b}`;
    }

    function parseAddSub() {
        let v = parseMulDiv();
        while (peek()?.t === 'OP' && (peek().v === '+' || peek().v === '-')) {
            const op = eat().v;
            v = binOp(op, v, parseMulDiv());
        }
        return v;
    }

    function parseMulDiv() {
        let v = parseUnary();
        while (peek()?.t === 'OP' && (peek().v === '*' || peek().v === '/' || peek().v === '%')) {
            const op = eat().v;
            v = binOp(op, v, parseUnary());
        }
        return v;
    }

    function parseUnary() {
        if (peek()?.t === 'OP' && peek().v === '-') {
            eat();
            const v = parsePrimary();
            return isNum(v) ? -v : `-(${v})`;
        }
        return parsePrimary();
    }

    function parsePrimary() {
        const tok = peek();
        if (tok?.t === 'NUM') { eat(); return tok.v; }
        if (tok?.t === 'STR') { eat(); return tok.v; }
        if (tok?.t === '(') {
            eat();
            const v = parseAddSub();
            need(')');
            return isNum(v) ? v : `(${v})`;
        }
        if (tok?.t === 'ID') {
            const name = eat().v;
            if (name === 'time' || name === 'freq' || name === 'x' || name === 'y' || name === 'tRel' || name === 'fRel') return name;
            throw new Error(`Unknown identifier '${name}' — use time/freq/x/y/tRel/fRel`);
        }
        if (tok?.t === 'MATHREF') {
            eat();
            const prop = tok.v;
            if (peek()?.t === '(') {
                eat(); // '('
                // Zero-arg functions e.g. Math.random()
                if (peek()?.t === ')') {
                    eat();
                    if (typeof Math[prop] !== 'function')
                        throw new Error(`Math.${prop} is not a function`);
                    return `Math.${prop}()`;
                }
                const fnArgs = [parseAddSub()];
                while (peek()?.t === ',') { eat(); fnArgs.push(parseAddSub()); }
                need(')');
                if (typeof Math[prop] !== 'function')
                    throw new Error(`Math.${prop} is not a function`);
                // Constant-fold when all args are known numbers
                if (fnArgs.every(isNum)) return Math[prop](...fnArgs);
                return `Math.${prop}(${fnArgs.join(', ')})`;
            }
            // Math constant: Math.PI, Math.E, Math.LN2 …
            if (typeof Math[prop] !== 'number')
                throw new Error(`Math.${prop} is not a numeric constant`);
            return Math[prop];
        }
        throw new Error(`Expected a number, time/freq/x/y/tRel/fRel, or Math expr, got ${JSON.stringify(tok)}`);
    }

    // Parse a comma-separated list of argument expressions: (expr, expr, ...)
    function parseNumArgs() {
        need('(');
        const args = [];
        if (peek()?.t !== ')') {
            args.push(parseAddSub());
            while (peek()?.t === ',') { eat(); args.push(parseAddSub()); }
        }
        need(')');
        return args;
    }

    // Parse a single region call-expression used as a chain argument
    function parseRegionArg() {
        if (peek()?.t !== 'ID') throw new Error(`Expected a region call, got ${JSON.stringify(peek())}`);
        const name = eat().v;
        if (!REGIONS.has(name))
            throw new Error(`Expected a region (${Array.from(REGIONS).join('/')}), got '${name}'`);
        need('(');
        const args = parseMethodArgs(name);
        need(')');
        return { type: 'Region', name, args };
    }

    function parseBlurArgs() {
        let timeAmt = 0.5;
        let freqAmt = 0.5;
        if (peek()?.t !== ')') {
            timeAmt = parseAddSub();
            if (peek()?.t === ',') {
                eat();
                freqAmt = parseAddSub();
            }
        }
        return [timeAmt, freqAmt];
    }

    function parseGranulateArgs() {
        let scatter = 0.5;
        let mix = 0.8;
        if (peek()?.t !== ')') {
            scatter = parseAddSub();
            if (peek()?.t === ',') { eat(); mix = parseAddSub(); }
        }
        return [scatter, mix];
    }

    function parseScaleArgs() {
        let xStretch = 1;
        let yStretch = 1;
        let mix = 1;
        if (peek()?.t !== ')') {
            xStretch = parseAddSub();
            if (peek()?.t === ',') { eat(); yStretch = parseAddSub(); }
            if (peek()?.t === ',') { eat(); mix = parseAddSub(); }
        }
        return [xStretch, yStretch, mix];
    }

    function parseRotateArgs() {
        let degrees = 0;
        let mix = 1;
        if (peek()?.t !== ')') {
            degrees = parseAddSub();
            if (peek()?.t === ',') { eat(); mix = parseAddSub(); }
        }
        return [degrees, mix];
    }

    function parseSkewArgs() {
        let xSkew = 0;
        let ySkew = 0;
        let mix = 1;
        if (peek()?.t !== ')') {
            xSkew = parseAddSub();
            if (peek()?.t === ',') { eat(); ySkew = parseAddSub(); }
            if (peek()?.t === ',') { eat(); mix = parseAddSub(); }
        }
        return [xSkew, ySkew, mix];
    }

    function parseTransposeArgs() {
        let mix = 1;
        if (peek()?.t !== ')') { mix = parseAddSub(); }
        return [mix];
    }

    function parseMethodArgs(method) {
        const spec = METHOD_SPECS[method];
        if (!spec) throw new Error(`Unknown method '${method}'`);

        if (spec.kind === 'base_region') {
            const args = [];
            if (peek()?.t !== ')') {
                args.push(parseAddSub());
                while (peek()?.t === ',') { eat(); args.push(parseAddSub()); }
            }
            return args;
        }
        if (spec.kind === 'blur') return parseBlurArgs();
        if (spec.kind === 'granulate') return parseGranulateArgs();
        if (spec.kind === 'scale') return parseScaleArgs();
        if (spec.kind === 'rotate') return parseRotateArgs();
        if (spec.kind === 'skew') return parseSkewArgs();
        if (spec.kind === 'transpose') return parseTransposeArgs();
        if (spec.kind === 'gain') return [parseAddSub()];
        if (spec.kind === 'invert') return [];

        // region / region_sub — accept one or more region args
        const args = [];
        if (peek()?.t !== ')') {
            args.push(parseRegionArg());
            while (peek()?.t === ',') { eat(); args.push(parseRegionArg()); }
        }
        return args;
    }

    // Base region or blur — omitted entirely if source was only an fft() or sliceX/seq statement
    try {
        if (tokens.length === 0 && (fftSize !== null || seqIndices !== null || pendingSlice !== null || clockMod !== null)) {
            return { type: 'Expression', base: null, chain: [], fftSize, seqIndices, pendingSlice, clockMod };
        }
        if (!peek() || peek().t !== 'ID') throw new Error('Expected a region or blur() call');
        const baseName = eat().v;

        let base;
        if (REGIONS.has(baseName)) {
            need('(');
            base = { name: baseName, args: parseMethodArgs(baseName) };
            need(')');
        } else if (BASE_METHODS.has(baseName)) {
            need('(');
            base = { name: baseName, args: parseMethodArgs(baseName) };
            need(')');
        } else if (CHAIN_ONLY_KINDS.has(METHOD_SPECS[baseName]?.kind)) {
            throw new Error(`Cannot start with '.${baseName}()'`);
        } else {
            throw new Error(`Unknown '${baseName}()'`);
        }

        // Chain
        const chain = [];
        while (pos < tokens.length) {
            if (peek()?.t !== '.') break;
            eat(); // consume '.'

            const methodTok = need('ID');
            if (!METHODS.has(methodTok.v)) {
                if (PATTERN_OPS.has(methodTok.v)) {
                    throw new Error(`'.${methodTok.v}()' must follow seq(...), not a spectral filter`);
                }
                if (/^(?:slicep|slicem|slicee|fft)$/.test(methodTok.v)) {
                    throw new Error(`${methodTok.v}() is a standalone statement and cannot be chained`);
                }
                throw new Error(`Unknown chain method '.${methodTok.v}()'`);
            }
            const method = methodTok.v;

            need('(');
            const args = parseMethodArgs(method);
            need(')');
            chain.push({ method, args });
        }

        if (pos < tokens.length) {
            const nextTok = peek();
            const tokStr = nextTok?.t === 'ID' ? nextTok.v : (nextTok?.v || nextTok?.t);
            throw new Error(`Unexpected token '${tokStr}' — chain with '.' or combine with '.add()'/'.sub()'`);
        }

        return { type: 'Expression', base, chain, fftSize, seqIndices, pendingSlice, clockMod };
    } catch (e) {
        if (e.pos === undefined) e.pos = tokens[pos]?.pos ?? src.trim().length;
        throw e;
    }
}

// Math dictionary

const MATH = {
    // Regions — return 0 or 1
    band: (a, b) => `(freq >= ${a} && freq <= ${b} ? 1 : 0)`,
    low: (hz) => `(freq <= ${hz} ? 1 : 0)`,
    high: (hz) => `(freq >= ${hz} ? 1 : 0)`,
    harmonic: (base, count, width = 45) => `((Math.round(freq / (${base})) >= 1 && Math.round(freq / (${base})) <= (${count}) && Math.abs(freq - Math.round(freq / (${base})) * (${base})) <= (${width}) / 2) ? 1 : 0)`,
};

function compileFn(node) {
    const fn = MATH[node.name];
    if (!fn) throw new Error(`No math mapping for '${node.name}'`);
    return fn(...node.args);
}

// argStr: normalise a parsed argument (number or expression string) to a string.
// Every method argument flows through this so dynamic math is always supported.
const argStr = (v, fallback = 0) => String(v ?? fallback);

// Compiler



function applyMethod(state, method, args) {
    const spec = METHOD_SPECS[method];
    if (!spec) throw new Error(`Unknown method '${method}'`);

    switch (spec.kind) {
        case 'base_region':
            if (state.expr !== null) {
                throw new Error(`Region already set — use '.add(${method}(...))' or '.sub(${method}(...))'`);
            }
            state.expr = compileFn({ name: method, args });
            break;
        case 'region': // .add(region) — union
            state.expr = state.expr !== null
                ? `Math.max(${state.expr}, ${compileFn(args[0])})`
                : compileFn(args[0]);
            break;
        case 'region_sub': // .sub(region) — mask out
            state.expr = state.expr !== null
                ? `Math.max(0, (${state.expr}) - (${compileFn(args[0])}))`
                : `0`;
            break;
        case 'invert': // .invert() — complement
            state.expr = state.expr !== null
                ? `(1 - (${state.expr}))`
                : `1`;
            break;
        case 'blur':
            state.blur = { timeAmt: argStr(args[0], 0.5), freqAmt: argStr(args[1], 0.5) };
            break;
        case 'granulate':
            state.granulate = {
                poolSize: '2',
                scatter: argStr(args[0], 0.5),
                grainRate: '80',
                mix: argStr(args[1], 0.8),
                freeze: '0',
            };
            break;
        case 'scale':
            state.scale = {
                xStretch: argStr(args[0], 1),
                yStretch: argStr(args[1], 1),
                mix: argStr(args[2], 1),
            };
            break;
        case 'rotate':
            state.rotate = {
                degrees: argStr(args[0], 0),
                mix: argStr(args[1], 1),
            };
            break;
        case 'skew':
            state.skew = {
                xSkew: argStr(args[0], 0),
                ySkew: argStr(args[1], 0),
                mix: argStr(args[2], 1),
            };
            break;
        case 'transpose':
            state.transpose = {
                mix: argStr(args[0], 1),
            };
            break;
        case 'gain':
            state.gain = state.gain !== null
                ? `(${state.gain}) * (${argStr(args[0], 1)})`
                : argStr(args[0], 1);
            break;
    }
}

function compile(ast) {
    const state = { expr: null, blur: null, clockMod: null, granulate: null, scale: null, rotate: null, skew: null, transpose: null, gain: null };
    if (ast.seqIndices && ast.seqIndices.clockMod) {
        state.clockMod = { ...ast.seqIndices.clockMod };
    }
    // Global fast()/slow() statement scales the whole track's clock rate.
    if (ast.clockMod) {
        state.clockMod = { ...createClockMod(), ...state.clockMod, ...ast.clockMod };
    }

    if (ast.base) {
        if (REGIONS.has(ast.base.name)) {
            state.expr = compileFn(ast.base);
        } else {
            applyMethod(state, ast.base.name, ast.base.args);
        }
    }

    for (const link of ast.chain) applyMethod(state, link.method, link.args);

    const baseCode = state.expr !== null ? `mag * ${state.expr}` : 'mag';
    const code = state.gain !== null ? `(${baseCode}) * (${state.gain})` : baseCode;
    const eval2D = /\b(?:x|y|tRel|fRel)\b/.test(code);
    const requiresCanvasPool = state.scale !== null || state.rotate !== null || state.skew !== null || state.transpose !== null || eval2D;

    return {
        code,
        blur: state.blur,
        clockMod: state.clockMod,
        granulate: state.granulate,
        scale: state.scale,
        rotate: state.rotate,
        skew: state.skew,
        transpose: state.transpose,
        requiresCanvasPool,
        eval2D,
        seqIndices: ast.seqIndices ?? null,
        fftSize: ast.fftSize ?? null,
        pendingSlice: ast.pendingSlice ?? null,
    };
}

// Serializer
// Converts an AST back to a canonical DSL string. Used by the overlay drag system
// to round-trip edits made via SVG handles back into the code input.

export function serialize(ast) {
    function node(n) { return `${n.name}(${n.args.join(', ')})`; }
    function formatLink(link) {
        const spec = METHOD_SPECS[link.method];
        if (!spec) throw new Error(`Unknown method '${link.method}'`);

        if (spec.kind === 'region' || spec.kind === 'region_sub')
            return `.${link.method}(${node(link.args[0])})`;
        if (spec.kind === 'invert') return '.invert()';
        if (spec.kind === 'clock' && link.method === 'rev') return '.rev()';
        if (spec.kind === 'granulate') return `.sgranulate(${link.args.join(', ')})`;
        if (spec.kind === 'scale') return `.scale(${link.args.join(', ')})`;
        if (spec.kind === 'rotate') return `.rotate(${link.args.join(', ')})`;
        if (spec.kind === 'skew') return `.skew(${link.args.join(', ')})`;
        if (spec.kind === 'transpose') return `.transpose(${link.args.join(', ')})`;
        if (spec.kind === 'gain') return `.gain(${link.args[0]})`;
        return `.${link.method}(${link.args.join(', ')})`;
    }

    let s = ast.fftSize ? `fft(${ast.fftSize})\n` : '';
    s += ast.base ? node(ast.base) : '';
    for (const link of ast.chain) s += formatLink(link);
    return s;
}

// Convenience
// tryCompileDSL returns { code, blur, clockMod, granulate, scale, rotate, skew, transpose, seqIndices, fftSize, pendingSlice, error }
// error is null on success, or a string message on parse/compile failure.
export function tryCompileDSL(src) {
    const trimmed = src.trim();
    try {
        const { code, blur, clockMod, granulate, scale, rotate, skew, transpose, requiresCanvasPool, eval2D, seqIndices, fftSize, pendingSlice } = compile(parse(trimmed));
        return { code, blur, clockMod, granulate, scale, rotate, skew, transpose, requiresCanvasPool, eval2D, seqIndices, fftSize, pendingSlice, error: null, errorPos: null };
    } catch (e) {
        return { code: 'mag', blur: null, clockMod: null, granulate: null, scale: null, rotate: null, skew: null, transpose: null, requiresCanvasPool: false, eval2D: false, seqIndices: null, fftSize: null, pendingSlice: null, error: e.message, errorPos: e.pos ?? null };
    }
}
