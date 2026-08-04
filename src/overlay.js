import { TRACK_SPEC_W, TRACK_SPEC_H, DEFAULT_NYQUIST } from './constants.js';
import { state } from './state.js';
import { tryCompileDSL, serialize } from './dsl.js';
import { getTrackCode, setTrackCode } from './code-editor.js';

const OVERLAY_COLORS = ['#ff3c6e', '#00e5ff', '#aaff00', '#ff9500'];

// Coordinate helpers

const nyquist = () => (state.audioCtx ? state.audioCtx.sampleRate / 2 : DEFAULT_NYQUIST);

function freqToY(hz, h) {
    return h * (1 - Math.max(0, Math.min(hz / nyquist(), 1)));
}

function yToFreq(y, h) {
    return Math.max(0, Math.round((1 - y / h) * nyquist()));
}

function regionGeom(node, h) {
    switch (node.name) {
        case 'band':  return { yTop: freqToY(node.args[1], h), yBot: freqToY(node.args[0], h) };
        case 'low':   return { yTop: freqToY(node.args[0], h), yBot: h };
        case 'high':  return { yTop: 0,                        yBot: freqToY(node.args[0], h) };
        default:      return { yTop: 0, yBot: h };
    }
}

function getHandleDefs(node) {
    switch (node.name) {
        case 'band':  return [{ argIdx: 1, edge: 'top' }, { argIdx: 0, edge: 'bot' }];
        case 'low':   return [{ argIdx: 0, edge: 'top' }];
        case 'high':  return [{ argIdx: 0, edge: 'bot' }];
        default:      return [];
    }
}

// Overlay rendering

export function renderTrackOverlay(track, ast) {
    const svg = track.overlaySvg;
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    track.currentAst = ast;
    if (!ast) return;

    const SW = TRACK_SPEC_W;
    const SH = TRACK_SPEC_H;

    const regions = [{ node: ast.base, chainPos: 'base' }];
    for (let i = 0; i < ast.chain.length; i++) {
        if (ast.chain[i].method === 'add') regions.push({ node: ast.chain[i].args[0], chainPos: i });
    }

    regions.forEach(({ node, chainPos }, ci) => {
        if (node.args.some(a => typeof a !== 'number')) return;

        const color = OVERLAY_COLORS[ci % OVERLAY_COLORS.length];
        const cpStr = String(chainPos);
        const { yTop, yBot } = regionGeom(node, SH);

// Filled region rect
        const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        rect.setAttribute('x', 0);
        rect.setAttribute('y', yTop);
        rect.setAttribute('width', SW);
        rect.setAttribute('height', Math.max(0, yBot - yTop));
        rect.setAttribute('fill', color);
        rect.setAttribute('fill-opacity', '0.08');
        rect.setAttribute('stroke', 'none');
        rect.dataset.chainPos = cpStr;
        svg.appendChild(rect);

// Edge handle lines
        for (const { argIdx, edge } of getHandleDefs(node)) {
            const y = edge === 'top' ? yTop : yBot;

            const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            line.setAttribute('x1', 0); line.setAttribute('x2', SW);
            line.setAttribute('y1', y); line.setAttribute('y2', y);
            line.setAttribute('stroke', color);
            line.setAttribute('stroke-width', '1.5');
            line.setAttribute('stroke-dasharray', '4 3');
            line.style.pointerEvents = 'none';
            line.dataset.chainPos = cpStr;
            svg.appendChild(line);

            const hit = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            hit.setAttribute('x1', 0); hit.setAttribute('x2', SW);
            hit.setAttribute('y1', y); hit.setAttribute('y2', y);
            hit.setAttribute('stroke', 'transparent');
            hit.setAttribute('stroke-width', '16');
            hit.dataset.chainPos = cpStr;
            hit.dataset.argIdx   = argIdx;
            hit.style.cursor = 'ns-resize';
            hit.addEventListener('mousedown', e => {
                e.preventDefault();
                state.activeSvgDrag = { track, ast, chainPos: cpStr, argIdx, line, hit };
            });
            svg.appendChild(hit);
        }
    });
}

// Overlay drag handlers

export function handleSvgDragMove(e) {
    const d      = state.activeSvgDrag;
    const bounds = d.track.overlaySvg.getBoundingClientRect();
    const y  = Math.max(0, Math.min(TRACK_SPEC_H, (e.clientY - bounds.top) / bounds.height * TRACK_SPEC_H));
    const hz = yToFreq(y, TRACK_SPEC_H);

    const target = d.chainPos === 'base' ? d.ast.base : d.ast.chain[d.chainPos].args[0];
    target.args[d.argIdx] = hz;

    setTrackCode(d.track.codeView, serialize(d.ast));

    d.line.setAttribute('y1', y); d.line.setAttribute('y2', y);
    d.hit.setAttribute('y1', y);  d.hit.setAttribute('y2', y);

    const { yTop, yBot } = regionGeom(target, TRACK_SPEC_H);
    const rect = d.track.overlaySvg.querySelector(`rect[data-chain-pos="${d.chainPos}"]`);
    if (rect) {
        rect.setAttribute('y', yTop);
        rect.setAttribute('height', Math.max(0, yBot - yTop));
    }
}

export function handleSvgDragEnd() {
    const d = state.activeSvgDrag;
    d.track.currentAst = d.ast;
    renderTrackOverlay(d.track, d.track.currentAst);
    const { code, blur, requiresCanvasPool, eval2D } = tryCompileDSL(getTrackCode(d.track.codeView));
    d.track.workletNode?.port.postMessage({ type: 'updateCode', code, requiresCanvasPool: !!requiresCanvasPool, eval2D: !!eval2D });
    d.track.workletNode?.port.postMessage({
        type: 'updateBlur',
        freqAmt: blur?.freqAmt ?? 0,
        timeAmt: blur?.timeAmt ?? 0,
        mix: blur?.mix ?? 1,
    });
    state.activeSvgDrag = null;
}
