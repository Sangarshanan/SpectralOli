const STOPS = {
    matrix:  [[0,[0,0,0]],[0.4,[0,70,0]],[0.75,[0,190,30]],[1,[130,255,100]]],
    ocean:   [[0,[0,0,0]],[0.28,[8,0,115]],[0.62,[0,155,195]],[1,[170,255,255]]],
    plasma:  [[0,[0,0,0]],[0.28,[75,0,155]],[0.58,[215,0,175]],[0.82,[255,175,0]],[1,[255,255,50]]],
    inferno: [[0,[0,0,0]],[0.33,[148,0,12]],[0.64,[255,115,0]],[1,[255,252,165]]],
};

export const LUTS = {};
for (const [name, stops] of Object.entries(STOPS)) {
    const lut = new Uint8Array(256 * 3);
    for (let i = 0; i < 256; i++) {
        const t = i / 255;
        let si = 1;
        while (si < stops.length - 1 && t > stops[si][0]) si++;
        const span = stops[si][0] - stops[si - 1][0] || 1;
        const u    = Math.max(0, Math.min(1, (t - stops[si - 1][0]) / span));
        const [r1, g1, b1] = stops[si - 1][1];
        const [r2, g2, b2] = stops[si][1];
        lut[i * 3]     = Math.round(r1 + (r2 - r1) * u);
        lut[i * 3 + 1] = Math.round(g1 + (g2 - g1) * u);
        lut[i * 3 + 2] = Math.round(b1 + (b2 - b1) * u);
    }
    LUTS[name] = lut;
}
