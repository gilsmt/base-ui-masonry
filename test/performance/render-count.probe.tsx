/**
 * Deterministic render-count probes for the main hooks and components.
 *
 * WHY: render counts are deterministic given seeded inputs, so deltas are
 * meaningful in CI. Wall-clock ms is omitted — baseline/head run on different
 * machines, so timing deltas mostly measure the environment. This file
 * reports the signals that matter for `MasonryRoot` and `MasonryItemSlot`.
 *
 * Run: bun run test/performance/render-count.probe.tsx
 */

import { areItemSlotPropsEqual } from "../../src/masonry.tsx";
import {
    buildFilled,
    getWindowRange,
    makeHeights,
    OVERSCAN,
    VIEWPORT_HEIGHT,
} from "./fixtures.ts";
import type { WindowRange } from "./fixtures.ts";

const N = 10_000;
const HEIGHTS = makeHeights(N);
const filled = buildFilled(HEIGHTS);
const totalHeight = filled.tallestColumn();

// ---------------------------------------------------------------------------

function countRange(low: number, high: number): number {
    let n = 0;
    filled.range(low, high, () => {
        n += 1;
    });
    return n;
}

function renderedIndices(range: WindowRange): number[] {
    const out: number[] = [];
    filled.range(range.start, range.end, (index) => out.push(index));
    return out.sort((a, b) => a - b);
}

// Simulates a scroll session: each frame first asks the guard, and only a
// non-inert frame pays a render plus ItemSlot enter/exit churn.
function simulateMasonryRootScroll(pxPerSecond: number) {
    const step = Math.max(1, Math.round(pxPerSecond / 60));
    let inert = 0;
    let nonInert = 0;
    let itemSlotChanges = 0;
    let prevRange = getWindowRange(Math.max(0, 5_000 - VIEWPORT_HEIGHT), VIEWPORT_HEIGHT, OVERSCAN);
    let prevSet = new Set(renderedIndices(prevRange));
    for (let scrollTop = 5_000; scrollTop < totalHeight - VIEWPORT_HEIGHT; scrollTop += step) {
        const nextRange = getWindowRange(scrollTop, VIEWPORT_HEIGHT, OVERSCAN);
        if (filled.isRangeInert(prevRange.start, prevRange.end, nextRange.start, nextRange.end)) {
            inert += 1;
        } else {
            nonInert += 1;
            const nextSet = new Set(renderedIndices(nextRange));
            for (const id of prevSet) {
                if (!nextSet.has(id)) itemSlotChanges += 1;
            }
            for (const id of nextSet) {
                if (!prevSet.has(id)) itemSlotChanges += 1;
            }
            prevSet = nextSet;
        }
        prevRange = nextRange;
    }
    return { inert, nonInert, frames: inert + nonInert, itemSlotChanges };
}

const memoBase = {
    index: 0,
    item: { id: "x" } as unknown,
    itemCount: N,
    left: 100,
    register: () => () => {},
    render: (item: unknown) => <div>{String(item)}</div>,
    top: 200,
    width: 200,
};

console.log("masonry render counts · deterministic (N=10k, 8col, seed=42)");
console.log(
    `totalHeight=${totalHeight.toFixed(0)}px · viewport=${VIEWPORT_HEIGHT}px · overscan=${OVERSCAN}`,
);

console.log("\n[render · range() visitation]");
const windowed = countRange(0, VIEWPORT_HEIGHT * (1 + OVERSCAN));
const full = countRange(0, Number.POSITIVE_INFINITY);
console.log(
    `  range() windowed (0..${VIEWPORT_HEIGHT * (1 + OVERSCAN)})   -> ${windowed} items visited`,
);
console.log(`  range() overscan=Infinity (full scan) -> ${full} items visited`);

console.log("\n[scroll · MasonryRoot commits + ItemSlot churn]");
for (const speed of [600, 1500, 4000, 10_000]) {
    const r = simulateMasonryRootScroll(speed);
    const inertPct = ((r.inert / r.frames) * 100).toFixed(1).padStart(5);
    console.log(
        `  ${String(speed).padStart(6)} px/s · inert ${inertPct}% · commits ${String(r.nonInert).padStart(5)}/${r.frames} · ItemSlot enter+exit ${r.itemSlotChanges}`,
    );
}

console.log("\n[memo · areItemSlotPropsEqual]");
console.log(`  identical props -> ${areItemSlotPropsEqual(memoBase, { ...memoBase })} (memo hit)`);
console.log(
    `  moved top       -> ${areItemSlotPropsEqual(memoBase, { ...memoBase, top: 201 })} (memo miss)`,
);

console.log(
    "\nnote: timing omitted by design — compare render counts in CI; run mitata locally on a quiet machine for ms",
);
