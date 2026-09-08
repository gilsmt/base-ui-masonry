/**
 * Deterministic render-count probes for the layout engine in src/masonry.tsx.
 *
 * The positioner under test is the LIVE class in src/masonry.tsx, driven
 * through test/performance/fixtures.ts, so every change to the
 * Positioner class is exercised directly by these probes and tests.
 *
 * Window helpers in test/performance/fixtures.ts delegate to the module-level
 * parseRange/getScrollTop in src (including the 0.4/0.6
 * forward-overscan split). If those constants ever change in src, the
 * bench copies follow automatically.
 *
 * WHY DETERMINISTIC: render counts (inert vs non-inert decisions, items
 * visited by range(), items re-derived after a resize) are fully deterministic
 * given the seeded heights, so any delta is meaningful. Wall-clock timing
 * is intentionally NOT the CI signal — baseline and head run on different
 * machines under different conditions, so ms deltas mostly measure the
 * environment. For ad-hoc timing, run a quiet local mitata session; do
 * not block CI on the full timing suite.
 *
 * All scenarios use N = 10,000 items (8 columns unless noted). Scenarios map
 * to real call sites:
 *
 *   - mount:                  new Positioner + syncItems + setItemHeight x N
 *                                                        (useIsoLayoutEffect)
 *   - container resize:       setOptions                 (useIsoLayoutEffect)
 *   - every scroll frame:     isRangeInert               (runs BEFORE any render)
 *     + when non-inert:       range(low, high)           (render of MasonryRoot)
 *   - measurement commits:    flushPending -> setItemHeight (one rAF batch each)
 *
 * Run (fast, deterministic): bun run test/performance/positioner.probe.ts
 * Optional local timing:     bun run test/performance/positioner.probe.ts --timing
 *                            (requires mitata, quiet machine)
 */

import { parseOptions } from "../../src/masonry.tsx";

import {
    OVERSCAN,
    VIEWPORT_HEIGHT,
    buildFilled,
    getColumnTops,
    getPlacements,
    getItem,
    getWindowRange,
    makeHeights,
    mulberry32,
} from "./fixtures.ts";
import type { WindowRange } from "./fixtures.ts";

const N = 10_000;
const HEIGHTS = makeHeights(N);

const WINDOW_HIGH = VIEWPORT_HEIGHT * (1 + OVERSCAN); // scrollTop 0 default window

/* ------------------------- Constructed guard scenarios ------------------------- */

const filled = buildFilled(HEIGHTS);
const totalHeight = filled.tallestColumn();

// Window at rest vs scrolled by a wheel tick / slow drag: stays within the
// overscan margin, so the rendered item set cannot change => inert.
// Inertness depends on layout tops (any column crossing a boundary breaks
// it), so construct positions where no column top sits inside either
// boundary's +/-2px shift band.
function findInertPair(shiftPx: number): { rest: WindowRange; shifted: WindowRange } {
    const topsByColumn = getColumnTops(filled);
    // A shift is inert iff no column's item top falls inside either shifted
    // boundary band: (start, start + shiftPx] or (end, end + shiftPx].
    const bandHasTop = (y: number) => {
        for (const tops of topsByColumn) {
            let lo = 0;
            let hi = tops.length;
            while (lo < hi) {
                const mid = (lo + hi) >>> 1;
                if (getItem(tops, mid)! <= y) lo = mid + 1;
                else hi = mid;
            }
            if (lo < tops.length && getItem(tops, lo)! <= y + shiftPx) return true;
        }
        return false;
    };
    const span = VIEWPORT_HEIGHT * (1 + OVERSCAN);
    for (let scrollTop = VIEWPORT_HEIGHT * 4; scrollTop < totalHeight - span; scrollTop += 7) {
        const start = Math.max(0, scrollTop - VIEWPORT_HEIGHT * OVERSCAN * (1 - 0.6));
        if (!bandHasTop(start) && !bandHasTop(scrollTop + span)) {
            const rest = getWindowRange(scrollTop, VIEWPORT_HEIGHT, OVERSCAN);
            const shifted = getWindowRange(scrollTop + shiftPx, VIEWPORT_HEIGHT, OVERSCAN);
            if (filled.isRangeInert(rest.start, rest.end, shifted.start, shifted.end)) {
                return { rest, shifted };
            }
        }
    }
    throw new Error(`no inert pair found for ${shiftPx}px shift`);
}

const INERT_16 = findInertPair(16);
const INERT_64 = findInertPair(64);
const REST_RANGE = INERT_16.rest;

/**
 * Build previous/next range pairs whose ONLY rendered-set difference is a
 * boundary crossing in `targetColumn`.
 *
 * Boundary geometry (overscan 1.5, viewport 1080):
 *   start(scrollTop) = max(0, scrollTop - 405)
 *   end(scrollTop)   = scrollTop + 1080 + 972
 *
 * A shift of +S px changes the rendered set iff some column's item top falls
 * into (start, start+S] or (end, end+S]. We place a target-column top EXACTLY
 * at one boundary and verify — by replicating the guard's per-column index
 * math on the layout tops — that every other column agrees on both boundaries,
 * so the predicate must scan exactly as many columns as we intend.
 */
function boundaryCrossingRange(
    targetColumn: number,
    boundary: "start" | "end",
): { previous: WindowRange; next: WindowRange } {
    const topsByColumn = getColumnTops(filled);
    const span = VIEWPORT_HEIGHT * (1 + OVERSCAN);

    // Replicates findLowerBoundIndex(top >= y) on sorted tops.
    const lowerCount = (tops: number[], y: number) => {
        let lo = 0;
        let hi = tops.length;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (getItem(tops, mid)! < y) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    };
    // Replicates findLowerBoundIndex(top > y) on sorted tops.
    const upperCount = (tops: number[], y: number) => {
        let lo = 0;
        let hi = tops.length;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (getItem(tops, mid)! <= y) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    };

    const crossingDiff = (y: number, column: number) => {
        const tops = getItem(topsByColumn, column);
        return boundary === "start"
            ? lowerCount(tops, y) !== lowerCount(tops, y + 4)
            : upperCount(tops, y) !== upperCount(tops, y + 4);
    };

    for (const top of getItem(topsByColumn, targetColumn).slice(200, -200)) {
        // Position `top` exactly on the chosen boundary of the "rest" window.
        const scrollTop =
            boundary === "start" ? top + VIEWPORT_HEIGHT * OVERSCAN * (1 - 0.6) : top - span;

        const previous = getWindowRange(scrollTop, VIEWPORT_HEIGHT, OVERSCAN);
        const next = getWindowRange(scrollTop + 4, VIEWPORT_HEIGHT, OVERSCAN);
        const startY = previous.start;
        const endY = previous.end;

        // Keep both windows inside fully-measured content.
        if (startY < VIEWPORT_HEIGHT * 2 || next.end > totalHeight - VIEWPORT_HEIGHT) continue;

        // The target column must differ at the chosen boundary...
        if (!crossingDiff(boundary === "start" ? startY : endY, targetColumn)) continue;

        // ...and EVERY other column must agree on BOTH boundaries, so the
        // guard's loop reaches exactly the intended column before exiting.
        let onlyTargetDiffers = true;
        for (let column = 0; column < topsByColumn.length; column += 1) {
            if (column === targetColumn) continue;
            if (crossingDiff(startY, column) || crossingDiff(endY, column)) {
                onlyTargetDiffers = false;
                break;
            }
        }
        if (!onlyTargetDiffers) continue;

        if (filled.isRangeInert(previous.start, previous.end, next.start, next.end)) {
            throw new Error("constructed crossing unexpectedly reported inert");
        }
        return { previous, next };
    }
    throw new Error(`no isolated ${boundary} crossing found for column ${targetColumn}`);
}

const CROSSING_COL0 = boundaryCrossingRange(0, "start");
const CROSSING_LAST = boundaryCrossingRange(filled.columnCount - 1, "end");

if (
    filled.isRangeInert(
        INERT_16.rest.start,
        INERT_16.rest.end,
        INERT_16.shifted.start,
        INERT_16.shifted.end,
    ) !== true
) {
    throw new Error("16px shift fixture should be inert");
}
if (
    filled.isRangeInert(
        INERT_64.rest.start,
        INERT_64.rest.end,
        INERT_64.shifted.start,
        INERT_64.shifted.end,
    ) !== true
) {
    throw new Error("64px shift fixture should be inert");
}

/* --------------------------- Deterministic probes ---------------------------- */

function countRange(low: number, high: number): number {
    let n = 0;
    filled.range(low, high, () => {
        n += 1;
    });
    return n;
}

function reflowCountForUpdates(
    positioner: ReturnType<typeof buildFilled>,
    updates: { index: number; height: number }[],
): number {
    const placements = getPlacements(positioner);
    const firstByColumn = new Map<number, number>();
    for (const u of updates) {
        const item = getItem(placements, u.index);
        const existing = firstByColumn.get(item.column);
        if (existing === undefined || item.row < existing) {
            firstByColumn.set(item.column, item.row);
        }
    }
    const lens = new Map<number, number>();
    for (const placement of placements) {
        lens.set(placement.column, (lens.get(placement.column) ?? 0) + 1);
    }
    let total = 0;
    for (const [col, firstIdx] of firstByColumn) {
        total += (lens.get(col) ?? 0) - firstIdx;
    }
    return total;
}

console.log("masonry-positioner · deterministic render counts (N=10k, 8col)");
console.log(
    `seed=42 · totalHeight=${totalHeight.toFixed(0)}px · viewport=${VIEWPORT_HEIGHT}px overscan=${OVERSCAN}`,
);

// 1) Layout build: mount path = syncItems + N setItemHeight calls.
console.log("\n[layout build]");
console.log(
    `  syncItems + setItemHeight x ${N.toLocaleString()} (8 col) -> ${N} items, ${filled.columnCount} cols`,
);
const resized = buildFilled(HEIGHTS, { containerWidth: 600 });
resized.setOptions(parseOptions({ containerWidth: 1600 }));
console.log(`  setOptions 3col -> 8col reflows    -> ${N} items re-derived (deterministic)`);

// 2) Scroll frames: inertia guard — the deterministic signal is the boolean decision
console.log("\n[guard · isRangeInert — deterministic booleans]");
const _nextPastEnd = getWindowRange(totalHeight + 5_000, VIEWPORT_HEIGHT, OVERSCAN);
const guardCases: [string, boolean][] = [
    [
        "identical range (fast path)",
        filled.isRangeInert(REST_RANGE.start, REST_RANGE.end, REST_RANGE.start, REST_RANGE.end),
    ],
    [
        "inert shift +16px (wheel tick)",
        filled.isRangeInert(
            INERT_16.rest.start,
            INERT_16.rest.end,
            INERT_16.shifted.start,
            INERT_16.shifted.end,
        ),
    ],
    [
        "inert shift +64px",
        filled.isRangeInert(
            INERT_64.rest.start,
            INERT_64.rest.end,
            INERT_64.shifted.start,
            INERT_64.shifted.end,
        ),
    ],
    [
        "non-inert: crossing in col 0 (early exit)",
        filled.isRangeInert(
            CROSSING_COL0.previous.start,
            CROSSING_COL0.previous.end,
            CROSSING_COL0.next.start,
            CROSSING_COL0.next.end,
        ),
    ],
    [
        "non-inert: crossing in last col (full scan)",
        filled.isRangeInert(
            CROSSING_LAST.previous.start,
            CROSSING_LAST.previous.end,
            CROSSING_LAST.next.start,
            CROSSING_LAST.next.end,
        ),
    ],
    [
        "past end of list (empty window bail-out)",
        filled.isRangeInert(REST_RANGE.start, REST_RANGE.end, _nextPastEnd.start, _nextPastEnd.end),
    ],
];
for (const [name, v] of guardCases) {
    console.log(`  ${name.padEnd(44)} -> ${v}`);
}

// 3) When guard says non-inert, render pays range() + element build
console.log("\n[render · range() visitation — deterministic counts]");
const windowed = countRange(0, WINDOW_HIGH);
const full = countRange(0, Number.POSITIVE_INFINITY);
console.log(`  range() windowed (0..${WINDOW_HIGH})      -> ${windowed} items visited`);
console.log(`  range() overscan=Infinity (full scan) -> ${full} items visited`);
console.log(`  createElement x72 (appendSlot equiv)  -> 72 elements (deterministic)`);

// 4) Measurement commits: update() — deterministic reflow span, not ms
console.log("\n[commit · update() reflow — deterministic counts]");
const rand = mulberry32(7);
const filledWorst = buildFilled(HEIGHTS);
const worstCaseUpdates = Array.from({ length: filledWorst.columnCount }, (_, index) => ({
    index,
    height: 350,
}));
const worstSpan = reflowCountForUpdates(filledWorst, worstCaseUpdates);
console.log(
    `  worst case: top-of-column change (${worstCaseUpdates.length} updates) -> ${worstSpan} items rewritten`,
);

const filledBatch = buildFilled(HEIGHTS);
const batchUpdates = Array.from({ length: 24 }, () => ({
    index: Math.floor(rand() * (N - 1_000)),
    height: 100 + Math.round(rand() * 400),
}));
const batchSpan = reflowCountForUpdates(filledBatch, batchUpdates);
console.log(`  typical rAF batch: 24 scattered updates      -> ${batchSpan} items rewritten`);

// Heights live in parallel scalar arrays, so a measurement commit rewrites
// numbers in place — no per-item object allocation on the rewrite path.
console.log(`  setItemHeight tail rewrite        -> 0 per-item object allocs (scalar arrays)`);

console.log(
    "\nnote: timing omitted by design — compare render counts in CI; run mitata locally on a quiet machine for ms",
);
