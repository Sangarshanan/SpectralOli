// DSL: Spectral expression language
// Grammar (full spec: references/DSL-CHAINING-RULES.md), each statement optional, at most once:
//   GLOBAL     clock <mult>  gain <expr>  fft <n>  slicep <n>  slicem <n>  slicee <n>
//   SEQUENCE   seq(...).within(...).at(...)...
//   MASK       !band(100,2000) - band(400,600) + high(5000)  (infix, '!' negate/'+' union/'-' subtract, not chainable)
//   PIPELINE   blur(0.85, 0.2).rotate(45)  (dot-chained, applied in order)
// Mask and pipeline are independent top-level statements in either order; a mask always feeds its track's pipeline.
import * as PatternOps from './slice-pattern.js';

const REGIONS = new Set(['low', 'high', 'band', 'harmonic']);
// Only these can appear in the transform pipeline (dot-chained, last-write-wins per slot).
const METHOD_SPECS = {
    blur: { kind: 'blur' },
    sgranulate: { kind: 'granulate' },
    scale: { kind: 'scale' },
    rotate: { kind: 'rotate' },
    skew: { kind: 'skew' },
    transpose: { kind: 'transpose' },
};
const TRANSFORM_METHODS = new Set(Object.keys(METHOD_SPECS));
const PATTERN_OPS = new Set(Object.keys(PatternOps).filter(k => k !== 'seq'));
export const CLOCK_DEFAULTS = { speedMultiplier: 1.0, isReversed: false };

const createClockMod = () => ({ ...CLOCK_DEFAULTS });

// Tokenizer

function stripComments(src) {
    let out = '';
    let i = 0;
    let inQuote = null;
    while (i < src.length) {
        const ch = src[i];
        if (inQuote) {
            out += ch;
            if (ch === inQuote && src[i - 1] !== '\\') inQuote = null;
            i++;
        } else if (ch === '"' || ch === "'") {
            inQuote = ch;
            out += ch;
            i++;
        } else if (ch === '/' && src[i + 1] === '/') {
            while (i < src.length && src[i] !== '\n') i++;
            out += '\n';
        } else if (ch === '/' && src[i + 1] === '*') {
            i += 2;
            while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
            i += 2;
        } else {
            out += ch;
            i++;
        }
    }
    return out;
}

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
            // 'Math.PROP' is consumed as one MATHREF token so '.' isn't mistaken for a chain dot.
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

// Standalone expression evaluator for a bare 'gain <expr>' directive's value.
// Mirrors the numeric-argument grammar used inside method calls further down,
// but runs over its own token array since it executes before the main tokenize pass.
function parseLeadingExpr(tokens) {
    let pos = 0;
    const peek = () => tokens[pos];
    const eat = () => tokens[pos++];
    const need = (t, v) => {
        const tok = eat();
        if (!tok || tok.t !== t || (v !== undefined && tok.v !== v))
            throw new Error(`Expected ${t}${v !== undefined ? ` "${v}"` : ''}, got ${JSON.stringify(tok)}`);
        return tok;
    };
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
                eat();
                if (peek()?.t === ')') {
                    eat();
                    if (typeof Math[prop] !== 'function') throw new Error(`Math.${prop} is not a function`);
                    return `Math.${prop}()`;
                }
                const fnArgs = [parseAddSub()];
                while (peek()?.t === ',') { eat(); fnArgs.push(parseAddSub()); }
                need(')');
                if (typeof Math[prop] !== 'function') throw new Error(`Math.${prop} is not a function`);
                if (fnArgs.every(isNum)) return Math[prop](...fnArgs);
                return `Math.${prop}(${fnArgs.join(', ')})`;
            }
            if (typeof Math[prop] !== 'number') throw new Error(`Math.${prop} is not a numeric constant`);
            return Math[prop];
        }
        throw new Error(`Expected a number, time/freq/x/y/tRel/fRel, or Math expr, got ${JSON.stringify(tok)}`);
    }

    if (tokens.length === 0) throw new Error('Expected a value');
    const value = parseAddSub();
    return { value, endPos: pos };
}

// Parser

// Bare global directives (stripped before tokenising the mask/pipeline expression):
//   clock <mult> speed multiplier · gain <expr> output amplitude (dynamic expr allowed)
//   fft <n> power-of-two FFT window 256–8192 · slicep/slicem <n> onset detection · slicee <n> equal-width chunks
const CLOCK_STMT_RE = /^clock\s+(-?\d*\.?\d+)\b\s*(?:;)?\s*/;
const FFT_STMT_RE = /^fft\s+(\d+)\b\s*(?:;)?\s*/;
const SLICEP_RE = /^slicep\s+(\d+)\b\s*(?:;)?\s*/;
const SLICEM_RE = /^slicem\s+(\d+)\b\s*(?:;)?\s*/;
const SLICEE_RE = /^slicee\s+(\d+)\b\s*(?:;)?\s*/;
// Fixed window sizes fft/slicep/slicem accept; also drives code-editor.js's autocomplete.
export const FFT_SIZES = [256, 512, 1024, 2048, 4096, 8192];
const FFT_SIZE_HINT = `use one of ${FFT_SIZES.join(', ')}`;
// True if the source already declares a sequence (lets slice snippets skip their starter seq()).
export const hasSeqStatement = (src) => /\bseq\s*\(/.test(src);

// Pulls a bare 'gain <expr>' directive off the front of source — unlike other
// global directives, gain's value is a full arithmetic expression, so it needs
// the tokenizer/expression-parser rather than a plain numeric regex.
function stripGainStmt(source) {
    if (!/^gain\b/.test(source)) return null;
    let rest = source.slice('gain'.length);
    if (/^\s*\(/.test(rest)) {
        throw new Error(`gain is a global directive, not a call — write 'gain <value>' without parentheses, e.g. 'gain 1.5'`);
    }
    const leadWs = rest.match(/^[ \t]+/);
    if (!leadWs) throw new Error(`gain needs a value, e.g. 'gain 1.5'`);
    rest = rest.slice(leadWs[0].length);
    const toks = tokenize(rest);
    if (toks.length === 0) throw new Error(`gain needs a value, e.g. 'gain 1.5'`);
    const { value, endPos } = parseLeadingExpr(toks);
    const nextTok = toks[endPos];
    const cutPos = nextTok ? nextTok.pos : rest.length;
    const remainder = rest.slice(cutPos).replace(/^\s*(?:;)?\s*/, '');
    return { value: String(value), remainder };
}

function extractSlicePatternStmt(src) {
    if (!src.startsWith('seq(')) {
        return null;
    }
    let depth = 0;
    let inQuote = null;
    let i = 0;
    let started = false;

    function skipTrivia(src, idx) {
        let j = idx;
        while (j < src.length) {
            if (/\s/.test(src[j])) {
                j++;
            } else {
                break;
            }
        }
        return j;
    }

    while (i < src.length) {
        const ch = src[i];
        if (inQuote) {
            if (ch === inQuote && src[i - 1] !== '\\') {
                inQuote = null;
            }
        } else if (ch === '"' || ch === "'") {
            inQuote = ch;
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
                // No dot / end of input: end of the pattern statement — skip trailing
                // trivia (and an optional semicolon) so it doesn't leak into the remainder.
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
    let source = stripComments(src).trim();
    let fftSize = null;
    let seqIndices = null;
    let pendingSlice = null;
    let clockMod = null;
    let gainExpr = null;

    // Strip bare global directives + seq(...) in any order; each at most once
    let changed = true;
    while (changed) {
        changed = false;

        const clockMatch = source.match(CLOCK_STMT_RE);
        if (clockMatch) {
            const v = parseFloat(clockMatch[1]);
            if (v === 0) throw new Error(`clock ${clockMatch[1]} cannot be zero`);
            clockMod = { ...(clockMod ?? createClockMod()), speedMultiplier: Math.abs(v), isReversed: v < 0 };
            source = source.slice(clockMatch[0].length);
            changed = true;
        }
        const fftMatch = source.match(FFT_STMT_RE);
        if (fftMatch) {
            const n = parseInt(fftMatch[1], 10);
            if (!FFT_SIZES.includes(n))
                throw new Error(`fft ${n} invalid — ${FFT_SIZE_HINT}`);
            fftSize = n;
            source = source.slice(fftMatch[0].length);
            changed = true;
        }
        const slicepMatch = source.match(SLICEP_RE);
        if (slicepMatch) {
            const n = parseInt(slicepMatch[1], 10);
            if (!FFT_SIZES.includes(n))
                throw new Error(`slicep ${n} invalid — ${FFT_SIZE_HINT}`);
            pendingSlice = { kind: 'percussion', fftSize: n };
            source = source.slice(slicepMatch[0].length);
            changed = true;
        }
        const slicemMatch = source.match(SLICEM_RE);
        if (slicemMatch) {
            const n = parseInt(slicemMatch[1], 10);
            if (!FFT_SIZES.includes(n))
                throw new Error(`slicem ${n} invalid — ${FFT_SIZE_HINT}`);
            pendingSlice = { kind: 'melodic', fftSize: n };
            source = source.slice(slicemMatch[0].length);
            changed = true;
        }
        const sliceeMatch = source.match(SLICEE_RE);
        if (sliceeMatch) {
            const n = parseInt(sliceeMatch[1], 10);
            if (n < 1) throw new Error(`slicee ${n} needs n >= 1`);
            pendingSlice = { kind: 'equal', n };
            source = source.slice(sliceeMatch[0].length);
            changed = true;
        }
        const gainMatch = stripGainStmt(source);
        if (gainMatch) {
            gainExpr = gainMatch.value;
            source = gainMatch.remainder;
            changed = true;
        }
        const patMatch = extractSlicePatternStmt(source);
        if (patMatch) {
            try {
                const keys = Object.keys(PatternOps);
                const values = keys.map(k => PatternOps[k]);
                const fn = new Function(...keys, `return ${patMatch.stmt};`);
                seqIndices = fn(...values);
            } catch (err) {
                throw new Error(`Bad seq pattern: ${err.message}`);
            }
            source = patMatch.remainder;
            changed = true;
        }
    }
    source = source.trim();

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

    // Arithmetic expression parser: +  -  *  /  %  unary-  parens  Math.*  time  freq.
    // Constants fold at parse time; 'time'/'freq' stay as runtime JS strings.

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

    // Parse a comma-separated list of numeric argument expressions: (expr, expr, ...)
    function parseNumArgList() {
        const args = [];
        if (peek()?.t !== ')') {
            args.push(parseAddSub());
            while (peek()?.t === ',') { eat(); args.push(parseAddSub()); }
        }
        return args;
    }

    function parseBlurArgs() {
        let timeAmt = 0.5;
        let freqAmt = 0.5;
        let mix = 1;
        if (peek()?.t !== ')') {
            timeAmt = parseAddSub();
            if (peek()?.t === ',') {
                eat();
                freqAmt = parseAddSub();
                if (peek()?.t === ',') {
                    eat();
                    mix = parseAddSub();
                }
            }
        }
        return [timeAmt, freqAmt, mix];
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

    // Arguments for a transform-pipeline method (blur/sgranulate/scale/rotate/skew/transpose)
    function parseTransformArgs(method) {
        const spec = METHOD_SPECS[method];
        if (!spec) throw new Error(`Unknown method '${method}'`);
        if (spec.kind === 'blur') return parseBlurArgs();
        if (spec.kind === 'granulate') return parseGranulateArgs();
        if (spec.kind === 'scale') return parseScaleArgs();
        if (spec.kind === 'rotate') return parseRotateArgs();
        if (spec.kind === 'skew') return parseSkewArgs();
        if (spec.kind === 'transpose') return parseTransposeArgs();
        throw new Error(`Unknown method '${method}'`);
    }

    // --- Frequency mask grammar ---------------------------------------------
    // maskExpr := maskTerm (('+' | '-') maskTerm)*
    // maskTerm := '!'* maskAtom
    // maskAtom := region '(' args ')'  |  '(' maskExpr ')'

    function parseRegionCall() {
        const name = need('ID').v;
        if (!REGIONS.has(name)) throw new Error(`Expected a region (${Array.from(REGIONS).join('/')}), got '${name}'`);
        need('(');
        const args = parseNumArgList();
        need(')');
        return { type: 'Region', name, args };
    }

    function parseMaskTerm() {
        let negate = false;
        while (peek()?.t === 'OP' && peek().v === '!') { eat(); negate = !negate; }
        let node;
        if (peek()?.t === '(') {
            eat();
            node = parseMaskExpr();
            need(')');
        } else if (peek()?.t === 'ID' && REGIONS.has(peek().v)) {
            node = parseRegionCall();
        } else {
            throw new Error(`Expected a region (low/high/band/harmonic) or '(' in the frequency mask, got ${JSON.stringify(peek())}`);
        }
        return negate ? { type: 'Not', expr: node } : node;
    }

    function parseMaskExpr() {
        let left = parseMaskTerm();
        while (peek()?.t === 'OP' && (peek().v === '+' || peek().v === '-')) {
            const op = eat().v;
            const right = parseMaskTerm();
            left = { type: 'BinOp', op, left, right };
        }
        return left;
    }

    // --- Transform pipeline grammar ------------------------------------------
    // pipeline := transform ('.' transform)*

    function parsePipeline() {
        const chain = [];
        const nameTok = need('ID');
        if (!TRANSFORM_METHODS.has(nameTok.v)) {
            throw new Error(`Unknown '${nameTok.v}()' — expected a transform: ${Array.from(TRANSFORM_METHODS).join('/')}`);
        }
        need('(');
        chain.push({ method: nameTok.v, args: parseTransformArgs(nameTok.v) });
        need(')');
        while (peek()?.t === '.') {
            eat();
            const m = need('ID');
            if (!TRANSFORM_METHODS.has(m.v)) {
                if (REGIONS.has(m.v)) {
                    throw new Error(`'.${m.v}()' cannot be chained onto a transform — frequency masks are a separate statement, e.g. write '${m.v}(...)' on its own line instead of chaining it.`);
                }
                if (PATTERN_OPS.has(m.v)) {
                    throw new Error(`'.${m.v}()' must follow seq(...), not a transform pipeline.`);
                }
                throw new Error(`Unknown chain method '.${m.v}()'`);
            }
            need('(');
            chain.push({ method: m.v, args: parseTransformArgs(m.v) });
            need(')');
        }
        return chain;
    }

    // --- Top level: mask and/or pipeline, in either order --------------------

    function isMaskStart() {
        const p = peek();
        if (!p) return false;
        if (p.t === 'OP' && p.v === '!') return true;
        if (p.t === '(') return true;
        return p.t === 'ID' && REGIONS.has(p.v);
    }
    function isPipelineStart() {
        const p = peek();
        return p?.t === 'ID' && TRANSFORM_METHODS.has(p.v);
    }

    let mask = null;
    let pipeline = [];

    try {
        if (tokens.length === 0) {
            if (fftSize === null && seqIndices === null && pendingSlice === null && clockMod === null && gainExpr === null) {
                throw new Error(`Expected a frequency mask (e.g. 'band(200, 4000)') or a transform (e.g. 'blur(0.3, 0.5)')`);
            }
            // Only global directives / a seq pattern were given — valid, means passthrough.
            return { type: 'Expression', mask: null, pipeline: [], fftSize, seqIndices, pendingSlice, clockMod, gain: gainExpr };
        }

        if (isMaskStart()) {
            mask = parseMaskExpr();
            if (peek()?.t === '.') {
                throw new Error(`'.' chaining is not allowed on a frequency mask — write the transform pipeline as a separate statement, e.g. put 'blur(...)' on its own line after the mask.`);
            }
            if (isPipelineStart()) pipeline = parsePipeline();
        } else if (isPipelineStart()) {
            pipeline = parsePipeline();
            if (isMaskStart()) mask = parseMaskExpr();
        } else {
            throw new Error(`Expected a region (low/high/band/harmonic), '!', or a transform (${Array.from(TRANSFORM_METHODS).join('/')}), got ${JSON.stringify(peek())}`);
        }

        if (pos < tokens.length) {
            const nextTok = peek();
            const tokStr = nextTok?.t === 'ID' ? nextTok.v : (nextTok?.v || nextTok?.t);
            throw new Error(`Unexpected token '${tokStr}' — a track has at most one frequency mask and one transform pipeline`);
        }

        return { type: 'Expression', mask, pipeline, fftSize, seqIndices, pendingSlice, clockMod, gain: gainExpr };
    } catch (e) {
        if (e.pos === undefined) e.pos = tokens[pos]?.pos ?? src.trim().length;
        throw e;
    }
}

// Reorders DSL statements into canonical form without changing semantics:
// 1. global directives, 2. seq(...) chains, 3. frequency-region algebra, 4. spectral transforms.
// Uses a line-by-line classifier (not ^-anchored regexes) so directives are found
// regardless of source order or what precedes them.
export function normalizeDSL(src) {
    const cleaned = stripComments(src).trim();
    if (!cleaned) return src;

    const globals = [];
    const seqStmts = [];
    const rest = [];

    const lines = cleaned.split('\n');
    let i = 0;

    while (i < lines.length) {
        const line = lines[i].trim();
        if (!line) { i++; continue; }

        // Global directives — all single-line, identified by a leading keyword
        if (/^(clock|fft|slicep|slicem|slicee)\s+/.test(line) || /^gain\s/.test(line)) {
            globals.push(line.replace(/\s*;?\s*$/, '')); // strip trailing semicolons
            i++;
        } else if (/^seq\s*\(/.test(line)) {
            // Accumulate any continuation lines that begin with a dot-chained method
            let stmt = line;
            while (i + 1 < lines.length && /^\s*\./.test(lines[i + 1])) {
                i++;
                stmt += '\n' + lines[i].trim();
            }
            seqStmts.push(stmt);
            i++;
        } else {
            // Frequency mask or transform pipeline — leave as-is, parser handles both orders
            rest.push(line);
            i++;
        }
    }

    const sections = [
        globals.join('\n'),
        seqStmts.join('\n'),
        rest.join('\n'),
    ].filter(Boolean);

    return sections.join('\n\n');
}


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

// Compiles a mask AST node to a per-bin 0..1 gate expression. '+' is a saturating
// (clamped) union, not Math.max, so overlapping soft-edged gates stack honestly. '-' is
// clamped subtraction, '!' is a complement.
function compileMask(node) {
    switch (node.type) {
        case 'Region': return compileFn(node);
        case 'Not': return `(1 - (${compileMask(node.expr)}))`;
        case 'BinOp':
            if (node.op === '+') return `Math.min(1, (${compileMask(node.left)}) + (${compileMask(node.right)}))`;
            if (node.op === '-') return `Math.max(0, (${compileMask(node.left)}) - (${compileMask(node.right)}))`;
            throw new Error(`Unknown mask operator '${node.op}'`);
        default:
            throw new Error(`Unknown mask node type '${node.type}'`);
    }
}

// Normalises a parsed argument (number or expression string) so dynamic math is always supported.
const argStr = (v, fallback = 0) => String(v ?? fallback);

// Compiler

function applyMethod(state, method, args) {
    const spec = METHOD_SPECS[method];
    if (!spec) throw new Error(`Unknown method '${method}'`);

    switch (spec.kind) {
        case 'blur':
            state.blur = { timeAmt: argStr(args[0], 0.5), freqAmt: argStr(args[1], 0.5), mix: argStr(args[2], 1) };
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
    }
}

function compile(ast) {
    const state = { blur: null, clockMod: null, granulate: null, scale: null, rotate: null, skew: null, transpose: null };
    if (ast.seqIndices && ast.seqIndices.clockMod) {
        state.clockMod = { ...ast.seqIndices.clockMod };
    }
    // Global clock <mult> directive scales the whole track's playback rate.
    if (ast.clockMod) {
        state.clockMod = { ...createClockMod(), ...state.clockMod, ...ast.clockMod };
    }

    for (const link of ast.pipeline) applyMethod(state, link.method, link.args);

    const maskCode = ast.mask !== null ? compileMask(ast.mask) : null;
    const baseCode = maskCode !== null ? `mag * ${maskCode}` : 'mag';
    const code = ast.gain !== null && ast.gain !== undefined ? `(${baseCode}) * (${ast.gain})` : baseCode;
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

// Serializer — converts an AST back to canonical DSL string, used by the overlay drag
// system to round-trip SVG handle edits back into the code input. Only covers what
// dragging can produce (fft size, gain, mask, pipeline), not seq/slicep/clock statements.

function serializeMaskNode(node) {
    switch (node.type) {
        case 'Region':
            return `${node.name}(${node.args.join(', ')})`;
        case 'Not': {
            const inner = serializeMaskNode(node.expr);
            return node.expr.type === 'BinOp' ? `!(${inner})` : `!${inner}`;
        }
        case 'BinOp': {
            const leftStr = serializeMaskNode(node.left);
            const rightInner = serializeMaskNode(node.right);
            const rightStr = node.right.type === 'BinOp' ? `(${rightInner})` : rightInner;
            return `${leftStr} ${node.op} ${rightStr}`;
        }
        default:
            throw new Error(`Unknown mask node type '${node.type}'`);
    }
}

export function serialize(ast) {
    let s = '';
    if (ast.fftSize) s += `fft ${ast.fftSize}\n`;
    if (ast.gain !== null && ast.gain !== undefined) s += `gain ${ast.gain}\n`;
    if (ast.mask) s += serializeMaskNode(ast.mask);
    if (ast.mask && ast.pipeline?.length) s += '\n';
    if (ast.pipeline?.length) s += ast.pipeline.map(link => `${link.method}(${link.args.join(', ')})`).join('.');
    return s;
}

// Convenience: tryCompileDSL() returns { code, blur, clockMod, granulate, scale, rotate,
// skew, transpose, seqIndices, fftSize, pendingSlice, error } — error is null on success.
export function tryCompileDSL(src) {
    const trimmed = src.trim();
    try {
        const { code, blur, clockMod, granulate, scale, rotate, skew, transpose, requiresCanvasPool, eval2D, seqIndices, fftSize, pendingSlice } = compile(parse(trimmed));
        return { code, blur, clockMod, granulate, scale, rotate, skew, transpose, requiresCanvasPool, eval2D, seqIndices, fftSize, pendingSlice, error: null, errorPos: null };
    } catch (e) {
        return { code: 'mag', blur: null, clockMod: null, granulate: null, scale: null, rotate: null, skew: null, transpose: null, requiresCanvasPool: false, eval2D: false, seqIndices: null, fftSize: null, pendingSlice: null, error: e.message, errorPos: e.pos ?? null };
    }
}
