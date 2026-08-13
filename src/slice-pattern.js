import { state } from './state.js';

const DEFAULT_SLICE_COUNT = 16;

/**
 * @typedef {Object} Step
 * @property {number} sliceIndex
 * @property {boolean} muted
 * @property {boolean} [reversed]
 */

/**
 * @typedef {Step[]} Pattern
 */

/**
 * @typedef {(p: Pattern) => Pattern} Operation
 */

/**
 * Parse a slice-spec string into an array of index/range tokens.
 * @param {string} [specStr] 
 * @returns {Array<{type: 'index'|'range', index?: number, start?: number|null, stop?: number|null}>}
 */
function parseSpec(specStr) {
    if (!specStr || typeof specStr !== 'string' || !specStr.trim()) {
        return [];
    }
    const tokens = specStr.split(',').map(s => s.trim()).filter(Boolean);
    const parsed = [];
    for (const token of tokens) {
        if (token.includes(':')) {
            const parts = token.split(':').map(s => s.trim());
            const start = parts[0] !== '' && !isNaN(Number(parts[0])) ? parseInt(parts[0], 10) : null;
            const stop = parts[1] !== undefined && parts[1] !== '' && !isNaN(Number(parts[1])) ? parseInt(parts[1], 10) : null;
            parsed.push({ type: 'range', start, stop });
        } else {
            const val = parseInt(token, 10);
            if (!isNaN(val)) {
                parsed.push({ type: 'index', index: val });
            }
        }
    }
    return parsed;
}

/**
 * Generate a Pattern from a slice-spec string against buffer slice count N.
 * @param {string} [spec] 
 * @param {number|Array|Object} [bufferSliceCount] 
 * @returns {Pattern}
 */
function attachMethods(pattern) {
    if (!pattern || !Array.isArray(pattern)) return pattern;
    if (pattern.at) return pattern;

    const wrap = (self, res) => {
        return attachMethods(res);
    };

    Object.defineProperty(pattern, 'at', {
        value: function(spec, op, prob, rng) { return wrap(this, at(spec, op, prob, rng)(this)); },
        enumerable: false, writable: true, configurable: true
    });
    Object.defineProperty(pattern, 'stutter', {
        value: function(count) { return wrap(this, stutter(count)(this)); },
        enumerable: false, writable: true, configurable: true
    });
    Object.defineProperty(pattern, 'reverse', {
        value: function() { return wrap(this, reverse()(this)); },
        enumerable: false, writable: true, configurable: true
    });
    Object.defineProperty(pattern, 'shuffle', {
        value: function(rng) { return wrap(this, shuffle(rng)(this)); },
        enumerable: false, writable: true, configurable: true
    });
    Object.defineProperty(pattern, 'silence', {
        value: function() { return wrap(this, silence()(this)); },
        enumerable: false, writable: true, configurable: true
    });
    Object.defineProperty(pattern, 'repeat', {
        value: function(n) { return wrap(this, repeat(n)(this)); },
        enumerable: false, writable: true, configurable: true
    });
    Object.defineProperty(pattern, 'euclid', {
        value: function(hits, steps, offset) { return wrap(this, euclid(hits, steps, offset)(this)); },
        enumerable: false, writable: true, configurable: true
    });
    Object.defineProperty(pattern, 'mirror', {
        value: function() { return wrap(this, mirror()(this)); },
        enumerable: false, writable: true, configurable: true
    });
    Object.defineProperty(pattern, 'every', {
        value: function(n, op) { return wrap(this, every(n, op)(this)); },
        enumerable: false, writable: true, configurable: true
    });
    Object.defineProperty(pattern, 'slow', {
        value: function(mult = 2) {
            const factor = Number(mult) || 1;
            for (let i = 0; i < this.length; i++) {
                this[i].speedMultiplier = (this[i].speedMultiplier || 1.0) / factor;
            }
            return this;
        },
        enumerable: false, writable: true, configurable: true
    });
    Object.defineProperty(pattern, 'fast', {
        value: function(mult = 2) {
            const factor = Number(mult) || 1;
            for (let i = 0; i < this.length; i++) {
                this[i].speedMultiplier = (this[i].speedMultiplier || 1.0) * factor;
            }
            return this;
        },
        enumerable: false, writable: true, configurable: true
    });

    return pattern;
}

export function seq(spec, bufferSliceCount) {
    let N = DEFAULT_SLICE_COUNT;
    if (typeof bufferSliceCount === 'number' && bufferSliceCount >= 0) {
        N = bufferSliceCount;
    } else if (bufferSliceCount && typeof bufferSliceCount.length === 'number') {
        N = bufferSliceCount.length;
    } else if (state && state.activeTrack && state.activeTrack.slices && typeof state.activeTrack.slices.length === 'number') {
        N = state.activeTrack.slices.length;
    }

    if (!spec || typeof spec !== 'string' || !spec.trim()) {
        const pattern = [];
        for (let i = 0; i < N; i++) {
            pattern.push({ sliceIndex: i, muted: false });
        }
        return attachMethods(pattern);
    }

    const parsed = parseSpec(spec);
    const pattern = [];

    for (const item of parsed) {
        if (item.type === 'range') {
            let start = item.start !== null && item.start !== undefined ? item.start : 0;
            let stop = item.stop !== null && item.stop !== undefined ? item.stop : N;

            if (start < 0) start = N + start;
            if (stop < 0) stop = N + stop;

            start = Math.max(0, Math.min(N, start));
            stop = Math.max(0, Math.min(N, stop));

            for (let i = start; i < stop; i++) {
                pattern.push({ sliceIndex: i, muted: false });
            }
        } else if (item.type === 'index') {
            let idx = item.index;
            if (idx < 0) idx = N + idx;
            if (idx < 0 || idx >= N) {
                console.warn(`[SlicePattern] Index ${item.index} out of bounds for buffer length ${N}`);
            } else {
                pattern.push({ sliceIndex: idx, muted: false });
            }
        }
    }

    return attachMethods(pattern);
}

/**
 * Apply an operation to a subset of steps in a pattern selected by spec, probabilistically per step.
 * @param {string} spec 
 * @param {Operation} operation 
 * @param {number} [prob=1] 
 * @param {() => number} [rng=Math.random] 
 * @returns {Operation}
 */
export function at(spec, operation, prob = 1, rng = Math.random) {
    return within(spec, operation, prob, rng);
}

function within(spec, operation, prob = 1, rng = Math.random) {
    return (pattern) => {
        const L = pattern.length;
        if (L === 0) return attachMethods([]);

        const parsed = parseSpec(spec);
        const isTargeted = new Array(L).fill(false);
        let anyValidTarget = false;

        for (const item of parsed) {
                if (item.type === 'range') {
                    let start = item.start !== null && item.start !== undefined ? item.start : 0;
                    let stop = item.stop !== null && item.stop !== undefined ? item.stop : L;

                    if (start < 0) start = L + start;
                    if (stop < 0) stop = L + stop;

                    start = Math.max(0, Math.min(L, start));
                    stop = Math.max(0, Math.min(L, stop));

                    for (let i = start; i < stop; i++) {
                        isTargeted[i] = true;
                        anyValidTarget = true;
                    }
                } else if (item.type === 'index') {
                    let idx = item.index;
                    if (idx < 0) idx = L + idx;
                    if (idx < 0 || idx >= L) {
                        console.warn(`[SlicePattern] Index ${item.index} out of bounds for pattern length ${L}`);
                    } else {
                        isTargeted[idx] = true;
                        anyValidTarget = true;
                    }
                }
            }

        const p = typeof prob === 'number' ? Math.max(0, Math.min(1, prob)) : 1;
        if (p < 1) {
            anyValidTarget = false;
            for (let i = 0; i < L; i++) {
                if (isTargeted[i]) {
                    if (rng() < p) {
                        anyValidTarget = true;
                    } else {
                        isTargeted[i] = false;
                    }
                }
            }
        }

        if (!anyValidTarget) {
            return attachMethods(pattern);
        }

        // Group targeted indices into contiguous blocks
        const blocks = [];
        let currentBlock = null;
        const targetedSteps = [];

        for (let i = 0; i < L; i++) {
            if (isTargeted[i]) {
                targetedSteps.push(pattern[i]);
                if (!currentBlock) {
                    currentBlock = { start: i, end: i + 1, count: 1 };
                    blocks.push(currentBlock);
                } else {
                    currentBlock.end = i + 1;
                    currentBlock.count++;
                }
            } else {
                currentBlock = null;
            }
        }

        const operated = operation(targetedSteps);
        const totalTargeted = targetedSteps.length;
        const totalOperated = operated.length;

        // Construct the result array by splicing operated segments into targeted block positions
        const result = [];
        let operatedIndex = 0;
        let blockIndex = 0;

        let i = 0;
        while (i < L) {
            if (!isTargeted[i]) {
                result.push(pattern[i]);
                i++;
            } else {
                const block = blocks[blockIndex++];
                let sliceLen;
                if (blockIndex === blocks.length) {
                    // Last block gets all remaining operated elements to avoid rounding errors
                    sliceLen = totalOperated - operatedIndex;
                } else {
                    sliceLen = Math.round(totalOperated * (block.count / totalTargeted));
                }
                for (let j = 0; j < sliceLen; j++) {
                    if (operatedIndex < totalOperated) {
                        result.push(operated[operatedIndex++]);
                    }
                }
                i = block.end;
            }
        }

        return attachMethods(result);
    };
}

/**
 * Repeats each targeted step count times within that step's own original time slot.
 * @param {number} count 
 * @returns {Operation}
 */
export function stutter(count) {
    return (pattern) => {
        if (count <= 0) return attachMethods([]);
        const result = [];
        for (const step of pattern) {
            for (let i = 0; i < count; i++) {
                result.push({ ...step });
            }
        }
        return attachMethods(result);
    };
}

/**
 * Plays each targeted step's audio content backwards.
 * @returns {Operation}
 */
export function reverse() {
    return (pattern) => {
        return attachMethods(pattern.map(step => ({
            ...step,
            reversed: !step.reversed
        })));
    };
}

/**
 * Randomly permutes the order of the targeted steps among themselves.
 * @param {() => number} [rng=Math.random] 
 * @returns {Operation}
 */
export function shuffle(rng = Math.random) {
    return (pattern) => {
        const copy = pattern.map(step => ({ ...step }));
        for (let i = copy.length - 1; i > 0; i--) {
            const j = Math.floor(rng() * (i + 1));
            [copy[i], copy[j]] = [copy[j], copy[i]];
        }
        return attachMethods(copy);
    };
}

/**
 * Mutes the targeted steps (sets muted: true).
 * @returns {Operation}
 */
export function silence() {
    return (pattern) => {
        return attachMethods(pattern.map(step => ({
            ...step,
            muted: true
        })));
    };
}

/**
 * Loops the entire targeted block n times, compressed to fit within that block's original combined duration.
 * @param {number} n 
 * @returns {Operation}
 */
export function repeat(n) {
    return (pattern) => {
        if (n <= 0) return attachMethods([]);
        const result = [];
        for (let i = 0; i < n; i++) {
            for (const step of pattern) {
                result.push({ ...step });
            }
        }
        return attachMethods(result);
    };
}

/**
 * Euclidean rhythm: distributes `hits` onset pulses as evenly as possible
 * across the targeted block of steps using the Björklund algorithm.
 * Steps that don't land on a pulse are muted (silenced).
 * @param {number} hits   Number of active pulses (onsets).
 * @param {number} steps  Total grid length. If omitted, uses the pattern length.
 * @param {number} [offset=0] Rotates the pattern by this many positions.
 * @returns {Operation}
 */
export function euclid(hits, steps, offset = 0) {
    return (pattern) => {
        const L = pattern.length;
        if (L === 0) return attachMethods([]);

        const S = (typeof steps === 'number' && steps > 0) ? steps : L;
        const H = Math.max(0, Math.min(S, Math.round(hits)));

        // Björklund / Toussaint algorithm
        let groups = [];
        for (let i = 0; i < S; i++) groups.push(i < H ? [1] : [0]);

        let remainder = S - H;
        let divisor   = H;
        while (remainder > 1 && divisor > 0) {
            const next = [];
            for (let i = 0; i < divisor; i++) {
                next.push([...groups[i], ...groups[groups.length - 1 - (divisor - 1 - i)]]);
            }
            const leftover = groups.slice(
                groups.length - Math.min(remainder, divisor),
                groups.length - divisor
            );
            groups = [...next, ...leftover];
            const newRemainder = Math.abs(remainder - divisor);
            remainder = divisor;
            divisor   = Math.min(newRemainder, divisor);
        }
        const pulses = [];
        for (const g of groups) for (const v of g) pulses.push(v);

        // Apply offset (positive = rotate right)
        const off = ((offset % S) + S) % S;
        const rotated = [...pulses.slice(S - off), ...pulses.slice(0, S - off)];

        // Map the rhythm onto the block — tile if block is longer than S
        const result = pattern.map((step, i) => ({
            ...step,
            muted: step.muted || rotated[i % S] === 0,
        }));

        return attachMethods(result);
    };
}
/**
 * Palindrome mirror: plays the targeted block forward then backward
 * (without doubling the turnaround point), compressed into the same time window.
 * e.g. [A, B, C] → [A, B, C, B, A]
 * @returns {Operation}
 */
export function mirror() {
    return (pattern) => {
        if (pattern.length <= 1) return attachMethods(pattern.map(s => ({ ...s })));
        const forward  = pattern.map(s => ({ ...s }));
        const backward = [...pattern].reverse().slice(1).map(s => ({ ...s }));
        return attachMethods([...forward, ...backward]);
    };
}

/**
 * Applies an operation only on every n-th cycle of the pattern.
 * For cycles 1..(n-1) the targeted steps play straight; on cycle n the
 * operation fires. The pattern is baked as (n-1) straight copies followed
 * by one operated copy — the whole thing then loops naturally with no
 * worklet changes required.
 * e.g. seq().at("6:8", every(4, stutter(4)))
 *   → steps 6-7 play normally for 3 passes, then stutter on the 4th pass.
 * @param {number} n         Cycle period (must be >= 1).
 * @param {Operation} operation  The operation to fire on the n-th cycle.
 * @returns {Operation}
 */
export function every(n, operation) {
    return (pattern) => {
        const cycles = Math.max(1, Math.round(n));
        const result = [];
        for (let i = 0; i < cycles - 1; i++) {
            for (const step of pattern) result.push({ ...step });
        }
        const operated = operation(pattern.map(s => ({ ...s })));
        for (const step of operated) result.push({ ...step });
        return attachMethods(result);
    };
}

export function slow(mult = 2) {
    return (pat) => {
        const factor = Number(mult) || 1;
        return attachMethods(pat.map(step => ({
            ...step,
            speedMultiplier: (step.speedMultiplier || 1.0) / factor
        })));
    };
}

export function fast(mult = 2) {
    return (pat) => {
        const factor = Number(mult) || 1;
        return attachMethods(pat.map(step => ({
            ...step,
            speedMultiplier: (step.speedMultiplier || 1.0) * factor
        })));
    };
}
