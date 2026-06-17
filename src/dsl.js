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
// Spectral operations (standalone expressions, not chainable)
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
const METHODS = new Set(['add', 'blur', 'fast', 'slow', 'fit', 'rev']); // Only these can be chained

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

    // ── Base region or blur ─────────────────────────────────────────────────
    if (!peek() || peek().t !== 'ID') throw new Error('Expected a region or blur() call');
    const baseName = eat().v;

    if (baseName === 'blur') {
        need('(');
        let freqAmt = 0.5, timeAmt = 0.5;
        if (peek()?.t !== ')') {
            freqAmt = parseAddSub();
            if (peek()?.t === ',') {
                eat();
                timeAmt = parseAddSub();
            }
        }
        need(')');
        if (pos < tokens.length) throw new Error(`Unexpected token after blur(): ${JSON.stringify(peek())}`);
        return { type: 'Blur', freqAmt, timeAmt };
    }

    // ── Standalone clock-only expression: fast/slow/fit/rev ──────────────────
    const CLOCK_METHODS = new Set(['fast', 'slow', 'fit', 'rev']);
    if (CLOCK_METHODS.has(baseName)) {
        // Parse as a chain starting from a synthetic all-pass region
        // e.g. "fast(2)" → ClockOnly with speedMultiplier 2
        const clockChain = [];
        // Consume the first method (baseName is already eaten as the "base")
        if (baseName === 'rev') {
            need('('); need(')');
            clockChain.push({ method: 'rev', args: [] });
        } else {
            const arg = parseNumArgs();
            clockChain.push({ method: baseName, args: arg });
        }
        // Consume any chained clock methods
        while (pos < tokens.length && peek()?.t === '.') {
            eat();
            const mTok = need('ID');
            if (!CLOCK_METHODS.has(mTok.v)) throw new Error(`Unknown clock method '${mTok.v}'`);
            if (mTok.v === 'rev') {
                need('('); need(')');
                clockChain.push({ method: 'rev', args: [] });
            } else {
                clockChain.push({ method: mTok.v, args: parseNumArgs() });
            }
        }
        if (pos < tokens.length) throw new Error(`Unexpected token: ${JSON.stringify(peek())}`);
        return { type: 'ClockOnly', chain: clockChain };
    }

    if (!REGIONS.has(baseName)) throw new Error(`Base must be a region (low/high/band/notch), got '${baseName}'`);
    const baseArgs = parseNumArgs();

    // ── Chain ─────────────────────────────────────────────────────────────────
    const chain = [];
    while (pos < tokens.length) {
        if (peek()?.t !== '.') break;
        eat(); // consume '.'

        const methodTok = need('ID');
        if (!METHODS.has(methodTok.v)) throw new Error(`Unknown chain method '${methodTok.v}'`);
        const method = methodTok.v;

        need('(');
        let args;
        if (method === 'blur') {
            // .blur(freq_amt, time_amt) — arithmetic expressions, both optional
            let freqAmt = 0.5, timeAmt = 0.5;
            if (peek()?.t !== ')') {
                freqAmt = parseAddSub();
                if (peek()?.t === ',') {
                    eat();
                    timeAmt = parseAddSub();
                }
            }
            args = [freqAmt, timeAmt];
        } else if (method === 'fast' || method === 'slow' || method === 'fit') {
            args = [parseAddSub()];
        } else if (method === 'rev') {
            args = [];
        } else {
            args = [];
            if (peek()?.t !== ')') {
                args.push(parseRegionArg());
                while (peek()?.t === ',') { eat(); args.push(parseRegionArg()); }
            }
        }
        need(')');
        chain.push({ method, args });
    }

    if (pos < tokens.length) throw new Error(`Unexpected token: ${JSON.stringify(peek())}`);

    return {
        type:  'Expression',
        base:  { name: baseName, args: baseArgs },
        chain,
    };
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

export function compile(ast) {
    if (ast.type === 'Blur') {
        return {
            code: 'mag',
            blur: { freqAmt: argStr(ast.freqAmt, 0.5), timeAmt: argStr(ast.timeAmt, 0.5) },
            clockMod: null,
        };
    }
    if (ast.type === 'ClockOnly') {
        // Pass audio through unchanged; only modify clock parameters
        const clockMod = { fitCycles: 1, speedMultiplier: 1.0, isReversed: false };
        for (const link of ast.chain) {
            switch (link.method) {
                case 'fit':  clockMod.fitCycles = Number(link.args[0]) || 1; break;
                case 'fast': clockMod.speedMultiplier *= (Number(link.args[0]) || 1); break;
                case 'slow': clockMod.speedMultiplier /= (Number(link.args[0]) || 1); break;
                case 'rev':  clockMod.isReversed = !clockMod.isReversed; break;
            }
        }
        return { code: 'mag', blur: null, clockMod };
    }
    let expr = compileFn(ast.base);
    let blur = null;
    let clockMod = null;

    for (const link of ast.chain) {
        switch (link.method) {
            case 'add':
                expr = `Math.max(${expr}, ${compileFn(link.args[0])})`;
                break;
            case 'blur':
                blur = { freqAmt: argStr(link.args[0], 0.5), timeAmt: argStr(link.args[1], 0.5) };
                break;
            case 'fit':
                if (!clockMod) clockMod = { fitCycles: 1, speedMultiplier: 1.0, isReversed: false };
                clockMod.fitCycles = Number(link.args[0]) || 1;
                break;
            case 'fast':
                if (!clockMod) clockMod = { fitCycles: 1, speedMultiplier: 1.0, isReversed: false };
                clockMod.speedMultiplier = (clockMod.speedMultiplier || 1.0) * (Number(link.args[0]) || 1);
                break;
            case 'slow':
                if (!clockMod) clockMod = { fitCycles: 1, speedMultiplier: 1.0, isReversed: false };
                clockMod.speedMultiplier = (clockMod.speedMultiplier || 1.0) / (Number(link.args[0]) || 1);
                break;
            case 'rev':
                if (!clockMod) clockMod = { fitCycles: 1, speedMultiplier: 1.0, isReversed: false };
                clockMod.isReversed = !clockMod.isReversed;
                break;
        }
    }

    return { code: `mag * ${expr}`, blur, clockMod };
}

// ─── Serializer ───────────────────────────────────────────────────────────────
// Converts an AST back to a canonical DSL string. Used by the overlay drag system
// to round-trip edits made via SVG handles back into the code input.

export function serialize(ast) {
    if (ast.type === 'Blur') return `blur(${ast.freqAmt}, ${ast.timeAmt})`;
    if (ast.type === 'ClockOnly') {
        return ast.chain.map(link =>
            link.method === 'rev' ? `rev()` : `${link.method}(${link.args[0]})`
        ).join('.');
    }
    function node(n) { return `${n.name}(${n.args.join(', ')})`; }
    let s = node(ast.base);
    for (const link of ast.chain) {
        if (link.method === 'blur') s += `.blur(${link.args[0]}, ${link.args[1]})`;
        else if (link.method === 'fast' || link.method === 'slow' || link.method === 'fit') s += `.${link.method}(${link.args[0]})`;
        else if (link.method === 'rev') s += `.rev()`;
        else s += `.${link.method}(${node(link.args[0])})`;
    }
    return s;
}

// ─── Convenience ──────────────────────────────────────────────────────────────
// tryCompileDSL returns { code: string, blur: { freqAmt, timeAmt } | null, timeMod: { type, factor } | null }

// tryCompileDSL returns { code, blur, clockMod, error }
// error is null on success, or a string message on parse/compile failure.
export function tryCompileDSL(src) {
    const trimmed = src.trim();
    try {
        const { code, blur, clockMod } = compile(parse(trimmed));
        return { code, blur, clockMod, error: null };
    } catch (e) {
        return { code: 'mag', blur: null, clockMod: null, error: e.message };
    }
}
