// ─── DSL: Spectral expression language ───────────────────────────────────────
//
// Syntax:  base_region.chain_method(...).chain_method(...)
//
// Base regions  (select frequencies, return 0 or 1)
//   low(hz)          — below hz
//   high(hz)         — above hz
//   band(min, max)   — between min and max
//   notch(min, max)  — everything except min–max
//
// Arguments  (arithmetic; constants fold at parse time, 'time' and 'freq' stay as runtime JS)
//   band(440*2, 440*8)                       — constant: harmonic band
//   low(time * 800 % 8000)                   — dynamic: sweeping cutoff
//   band(Math.sin(time * 0.5) * 1000 + 1500, 4000) — dynamic: oscillating lower bound
//   low(Math.random() * 2000 + 500)          — dynamic: random per-hop
//   high(20000-500)                          — constant: subtraction
//   low(Math.PI * 1000)                      — constant: Math constants
//   band(Math.sqrt(160000), 8000)            — constant: Math functions
//
// Spectral operations
//   blur(freq_amt, time_amt)  — freq_amt: spread across neighboring bins (0–1)
//                               time_amt: mix with previous frame (0–1)
//                               both default to 0.5 if omitted
//                               arguments may use time/Math.* expressions
//
// Chain methods
//   .add(region)              — union  (Math.max)
//   .blur(freq_amt, time_amt) — spectral blur as post-process (args optional, default 0.5)
//
// Examples
//   band(200, 4000)
//   low(time * 800 % 8000)
//   band(Math.sin(time * 0.5) * 1000 + 1500, 4000)
//   band(440*2, 440*8).add(high(5000))

const REGIONS = new Set(['low', 'high', 'band', 'notch']);
const METHOD_SPECS = {
    add:       { kind: 'region' },
    blur:      { kind: 'blur' },
    fast:      { kind: 'clock' },
    slow:      { kind: 'clock' },
    fit:       { kind: 'clock' },
    rev:       { kind: 'clock' },
    granulate: { kind: 'granulate' },
};
const METHODS = new Set(Object.keys(METHOD_SPECS)); // Only these can be chained
const BASE_METHODS = new Set(
    Object.keys(METHOD_SPECS).filter(method => METHOD_SPECS[method].kind !== 'region')
);
const CLOCK_DEFAULTS = { fitCycles: 1, speedMultiplier: 1.0, isReversed: false };

const createClockMod = () => ({ ...CLOCK_DEFAULTS });

// ─── Tokenizer ────────────────────────────────────────────────────────────────

function tokenize(src) {
    const tokens = [];
    let i = 0;
    while (i < src.length) {
        const ch = src[i];
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
                tokens.push({ t: 'MATHREF', v: src.slice(k, j) });
            } else {
                tokens.push({ t: 'ID', v: name });
            }
            i = j;
            continue;
        }

        // Numeric literals (including decimals starting with '.' like .25)
        if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
            let j = i + 1;
            while (j < src.length && /[0-9.]/.test(src[j])) j++;
            tokens.push({ t: 'NUM', v: parseFloat(src.slice(i, j)) });
            i = j;
            continue;
        }

        if (ch === '(') { tokens.push({ t: '(' }); i++; continue; }
        if (ch === ')') { tokens.push({ t: ')' }); i++; continue; }
        if (ch === ',') { tokens.push({ t: ',' }); i++; continue; }
        if (ch === '.') { tokens.push({ t: '.' }); i++; continue; }
        if (ch === '+' || ch === '-' || ch === '*' || ch === '/' || ch === '%') {
            tokens.push({ t: 'OP', v: ch }); i++; continue;
        }

        throw new Error(`Unexpected character '${ch}' at position ${i}`);
    }
    return tokens;
}

// ─── Parser ───────────────────────────────────────────────────────────────────

export function parse(src) {
    const tokens = tokenize(src.trim());
    let pos = 0;

    const peek = ()      => tokens[pos];
    const eat  = ()      => tokens[pos++];
    const need = (t, v)  => {
        const tok = eat();
        if (!tok || tok.t !== t || (v !== undefined && tok.v !== v))
            throw new Error(`Expected ${t}${v !== undefined ? ` "${v}"` : ''}, got ${JSON.stringify(tok)}`);
        return tok;
    };

    // ── Arithmetic expression parser ──
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
        if (tok?.t === '(') {
            eat();
            const v = parseAddSub();
            need(')');
            return isNum(v) ? v : `(${v})`;
        }
        if (tok?.t === 'ID') {
            const name = eat().v;
            if (name === 'time' || name === 'freq') return name;
            throw new Error(`Unknown identifier '${name}' in argument — use 'time' or 'freq'`);
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
        throw new Error(`Expected a number, 'time', 'freq', or Math expression, got ${JSON.stringify(tok)}`);
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
            throw new Error(`Expected a region (low/high/band/notch), got '${name}'`);
        const args = parseNumArgs();
        return { type: 'Region', name, args };
    }

    function parseBlurArgs() {
        let freqAmt = 0.5;
        let timeAmt = 0.5;
        if (peek()?.t !== ')') {
            freqAmt = parseAddSub();
            if (peek()?.t === ',') {
                eat();
                timeAmt = parseAddSub();
            }
        }
        return [freqAmt, timeAmt];
    }

    function parseClockArgs(method) {
        if (method === 'rev') return [];
        return [parseAddSub()];
    }

    function parseGranulateArgs() {
        let poolSize  = 2;
        let scatter   = 0.5;
        let grainRate = 80;
        let density   = 0.8;
        let freeze    = 0;
        if (peek()?.t !== ')') {
            poolSize = parseAddSub();
            if (peek()?.t === ',') { eat(); scatter   = parseAddSub(); }
            if (peek()?.t === ',') { eat(); grainRate = parseAddSub(); }
            if (peek()?.t === ',') { eat(); density   = parseAddSub(); }
            if (peek()?.t === ',') { eat(); freeze    = parseAddSub(); }
        }
        return [poolSize, scatter, grainRate, density, freeze];
    }

    function parseMethodArgs(method) {
        const spec = METHOD_SPECS[method];
        if (!spec) throw new Error(`Unknown method '${method}'`);

        if (spec.kind === 'blur') return parseBlurArgs();
        if (spec.kind === 'clock') return parseClockArgs(method);
        if (spec.kind === 'granulate') return parseGranulateArgs();

        const args = [];
        if (peek()?.t !== ')') {
            args.push(parseRegionArg());
            while (peek()?.t === ',') { eat(); args.push(parseRegionArg()); }
        }
        return args;
    }

    // ── Base region or blur ─────────────────────────────────────────────────
    if (!peek() || peek().t !== 'ID') throw new Error('Expected a region or blur() call');
    const baseName = eat().v;

    let base;
    if (REGIONS.has(baseName)) {
        base = { name: baseName, args: parseNumArgs() };
    } else if (BASE_METHODS.has(baseName)) {
        need('(');
        base = { name: baseName, args: parseMethodArgs(baseName) };
        need(')');
    } else {
        throw new Error(`Expected a region or effect (low/high/band/notch/blur/fast/slow/fit/rev/granulate), got '${baseName}'`);
    }

    // ── Chain ─────────────────────────────────────────────────────────────────
    const chain = [];
    while (pos < tokens.length) {
        if (peek()?.t !== '.') break;
        eat(); // consume '.'

        const methodTok = need('ID');
        if (!METHODS.has(methodTok.v)) throw new Error(`Unknown chain method '${methodTok.v}'`);
        const method = methodTok.v;

        need('(');
        const args = parseMethodArgs(method);
        need(')');
        chain.push({ method, args });
    }

    if (pos < tokens.length) throw new Error(`Unexpected token: ${JSON.stringify(peek())}`);

    return { type: 'Expression', base, chain };
}

// ─── Math dictionary ──────────────────────────────────────────────────────────

const MATH = {
    // Regions — return 0 or 1
    band:  (a, b) => `(freq >= ${a} && freq <= ${b} ? 1 : 0)`,
    low:   (hz)   => `(freq <= ${hz} ? 1 : 0)`,
    high:  (hz)   => `(freq >= ${hz} ? 1 : 0)`,
    notch: (a, b) => `(freq < ${a} || freq > ${b} ? 1 : 0)`,

};

function compileFn(node) {
    const fn = MATH[node.name];
    if (!fn) throw new Error(`No math mapping for '${node.name}'`);
    return fn(...node.args);
}

// argStr: normalise a parsed argument (number or expression string) to a string.
// Every method argument flows through this so dynamic math is always supported.
const argStr = (v, fallback = 0) => String(v ?? fallback);

// ─── Compiler ─────────────────────────────────────────────────────────────────

function applyClockStep(clockMod, method, args) {
    switch (method) {
        case 'fit':  clockMod.fitCycles = Number(args[0]) || 1; break;
        case 'fast': clockMod.speedMultiplier *= (Number(args[0]) || 1); break;
        case 'slow': clockMod.speedMultiplier /= (Number(args[0]) || 1); break;
        case 'rev':  clockMod.isReversed = !clockMod.isReversed; break;
    }
}

function applyMethod(state, method, args) {
    const spec = METHOD_SPECS[method];
    if (!spec) throw new Error(`Unknown method '${method}'`);

    switch (spec.kind) {
        case 'region':
            state.expr = state.expr !== null
                ? `Math.max(${state.expr}, ${compileFn(args[0])})`
                : compileFn(args[0]);
            break;
        case 'blur':
            state.blur = { freqAmt: argStr(args[0], 0.5), timeAmt: argStr(args[1], 0.5) };
            break;
        case 'clock':
            if (!state.clockMod) state.clockMod = createClockMod();
            applyClockStep(state.clockMod, method, args);
            break;
        case 'granulate':
            state.granulate = {
                poolSize:  argStr(args[0], 2),
                scatter:   argStr(args[1], 0.5),
                grainRate: argStr(args[2], 80),
                density:   argStr(args[3], 0.8),
                freeze:    argStr(args[4], 0),
            };
            break;
    }
}

export function compile(ast) {
    const state = { expr: null, blur: null, clockMod: null, granulate: null };

    if (REGIONS.has(ast.base.name)) {
        state.expr = compileFn(ast.base);
    } else {
        applyMethod(state, ast.base.name, ast.base.args);
    }

    for (const link of ast.chain) applyMethod(state, link.method, link.args);

    const code = state.expr !== null ? `mag * ${state.expr}` : 'mag';
    return { code, blur: state.blur, clockMod: state.clockMod, granulate: state.granulate };
}

// ─── Serializer ───────────────────────────────────────────────────────────────
// Converts an AST back to a canonical DSL string. Used by the overlay drag system
// to round-trip edits made via SVG handles back into the code input.

export function serialize(ast) {
    function node(n) { return `${n.name}(${n.args.join(', ')})`; }
    function formatLink(link) {
        const spec = METHOD_SPECS[link.method];
        if (!spec) throw new Error(`Unknown method '${link.method}'`);

        if (spec.kind === 'region') return `.${link.method}(${node(link.args[0])})`;
        if (spec.kind === 'clock' && link.method === 'rev') return '.rev()';
        if (spec.kind === 'granulate') return `.granulate(${link.args.join(', ')})`;
        return `.${link.method}(${link.args.join(', ')})`;  
    }

    let s = node(ast.base);
    for (const link of ast.chain) s += formatLink(link);
    return s;
}

// ─── Convenience ──────────────────────────────────────────────────────────────
// tryCompileDSL returns { code, blur, clockMod, error }
// error is null on success, or a string message on parse/compile failure.
export function tryCompileDSL(src) {
    const trimmed = src.trim();
    try {
        const { code, blur, clockMod, granulate } = compile(parse(trimmed));
        return { code, blur, clockMod, granulate, error: null };
    } catch (e) {
        return { code: 'mag', blur: null, clockMod: null, granulate: null, error: e.message };
    }
}
