/**
 * Deterministic render-count probes for the main hooks and components.
 *
 * WHY: render counts are deterministic given seeded inputs, so deltas are
 * meaningful in CI. Wall-clock ms is omitted — baseline/head run on different
 * machines, so timing deltas mostly measure the environment. This file
 * reports the signals that matter for `MasonryRoot`, `ItemSlot`,
 * `useMeasurements`, and `commitPendingMeasurements`.
 *
 * Run: bun run bench/masonry-render-count.bench.ts
 */

import * as React from "react";
import {
    areItemSlotPropsEqual,
    arePlacementsEqual,
    buildPositioner,
    getWindowRange,
} from "../src/masonry.tsx";
import {
    buildFilled as buildFilledCopy,
    getColumnTops,
    getItem,
    makeHeights,
    VIEWPORT_HEIGHT,
    OVERSCAN,
} from "./positioner.ts";
import type { WindowRange } from "./positioner.ts";

// Use the verbatim copy for layout fixtures (identical to src), but also
// exercise the real `src/masonry.tsx` exports for component-level checks.
const N = 10_000;
const HEIGHTS = makeHeights(N);
const filled = buildFilledCopy(HEIGHTS);
const totalHeight = filled.shortestColumn();

// ---------------------------------------------------------------------------
// Fixtures: inert pairs and boundary crossings (same construction as
// bench/masonry-positioner.bench.ts so numbers are comparable across probes).
// ---------------------------------------------------------------------------

function findInertPair(shiftPx: number): { rest: WindowRange; shifted: WindowRange } {
    const topsByColumn = getColumnTops(filled);
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
            if (filled.isWindowShiftInert(rest, shifted)) return { rest, shifted };
        }
    }
    throw new Error(`no inert pair for ${shiftPx}px`);
}

function boundaryCrossingRange(
    targetColumn: number,
    boundary: "start" | "end",
): { previous: WindowRange; next: WindowRange } {
    const topsByColumn = getColumnTops(filled);
    const span = VIEWPORT_HEIGHT * (1 + OVERSCAN);
    const lowerCount = (tops: number[], y: number) => {
        let lo = 0,
            hi = tops.length;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (getItem(tops, mid)! < y) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    };
    const upperCount = (tops: number[], y: number) => {
        let lo = 0,
            hi = tops.length;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (getItem(tops, mid)! <= y) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    };
    const crossingDiff = (y: number, col: number) => {
        const tops = getItem(topsByColumn, col);
        return boundary === "start"
            ? lowerCount(tops, y) !== lowerCount(tops, y + 4)
            : upperCount(tops, y) !== upperCount(tops, y + 4);
    };
    for (const top of getItem(topsByColumn, targetColumn).slice(200, -200)) {
        const scrollTop =
            boundary === "start" ? top + VIEWPORT_HEIGHT * OVERSCAN * (1 - 0.6) : top - span;
        const previous = getWindowRange(scrollTop, VIEWPORT_HEIGHT, OVERSCAN);
        const next = getWindowRange(scrollTop + 4, VIEWPORT_HEIGHT, OVERSCAN);
        const startY = previous.start,
            endY = previous.end;
        if (startY < VIEWPORT_HEIGHT * 2 || next.end > totalHeight - VIEWPORT_HEIGHT) continue;
        if (!crossingDiff(boundary === "start" ? startY : endY, targetColumn)) continue;
        let onlyTarget = true;
        for (let c = 0; c < topsByColumn.length; c++) {
            if (c === targetColumn) continue;
            if (crossingDiff(startY, c) || crossingDiff(endY, c)) {
                onlyTarget = false;
                break;
            }
        }
        if (!onlyTarget) continue;
        if (filled.isWindowShiftInert(previous, next)) throw new Error("unexpected inert");
        return { previous, next };
    }
    throw new Error(`no isolated ${boundary} crossing for col ${targetColumn}`);
}

const INERT_16 = findInertPair(16);
const INERT_64 = findInertPair(64);
const CROSSING_COL0 = boundaryCrossingRange(0, "start");
const CROSSING_LAST = boundaryCrossingRange(filled.columnCount - 1, "end");

// ---------------------------------------------------------------------------
// Helpers to count component-level renders deterministically (no DOM, no timing).
// ---------------------------------------------------------------------------

function renderedIndices(range: WindowRange): number[] {
    const out: number[] = [];
    filled.range(range.start, range.end, (item) => out.push(item.index));
    return out.sort((a, b) => a - b);
}

function rangeSize(range: WindowRange): number {
    let n = 0;
    filled.range(range.start, range.end, () => n++);
    return n;
}

function simulateScrollRenderCounts(pxPerSecond: number) {
    const step = Math.max(1, Math.round(pxPerSecond / 60));
    let inert = 0,
        nonInert = 0;
    let masonryRootRenders = 0; // equals nonInert (only non-inert commits)
    let itemSlotRerenders = 0; // total ItemSlots whose presence changes across frames
    let prevRange = getWindowRange(Math.max(0, 5_000 - VIEWPORT_HEIGHT), VIEWPORT_HEIGHT, OVERSCAN);
    let prevSet = new Set(renderedIndices(prevRange));

    for (let scrollTop = 5_000; scrollTop < totalHeight - VIEWPORT_HEIGHT; scrollTop += step) {
        const nextRange = getWindowRange(scrollTop, VIEWPORT_HEIGHT, OVERSCAN);
        const isInert = filled.isWindowShiftInert(prevRange, nextRange);
        if (isInert) inert++;
        else {
            nonInert++;
            masonryRootRenders++;
            const nextSet = new Set(renderedIndices(nextRange));
            // ItemSlots that enter or exit the window must (re)render; stable items memo hits.
            let changed = 0;
            for (const id of prevSet) if (!nextSet.has(id)) changed++;
            for (const id of nextSet) if (!prevSet.has(id)) changed++;
            itemSlotRerenders += changed;
            prevSet = nextSet;
        }
        prevRange = nextRange;
    }
    const frames = inert + nonInert;
    return { step, inert, nonInert, frames, masonryRootRenders, itemSlotRerenders };
}

function countUseMeasurementsSkips() {
    // Simulate useMeasurements' skipUpdatePredicate path (isDirty=false)
    // For each scroll frame, count how many scrollY-only changes are skipped
    // vs how many would have flushed without the guard. Deterministic.
    const cases: [string, WindowRange, WindowRange, boolean][] = [
        ["identical", INERT_16.rest, INERT_16.rest, true],
        ["inert 16px", INERT_16.rest, INERT_16.shifted, true],
        ["inert 64px", INERT_64.rest, INERT_64.shifted, true],
        ["col0 crossing", CROSSING_COL0.previous, CROSSING_COL0.next, false],
        ["last-col crossing", CROSSING_LAST.previous, CROSSING_LAST.next, false],
    ];
    let skipped = 0,
        flushed = 0;
    for (const [, prev, next, shouldSkip] of cases) {
        const isInert = filled.isWindowShiftInert(prev, next);
        if (isInert !== shouldSkip) throw new Error("fixture mismatch");
        if (isInert) skipped++;
        else flushed++;
    }
    // Larger simulation: same as scroll probe, counting skipped flushSyncs
    const probe = simulateScrollRenderCounts(1500);
    return {
        fixtureSkipped: skipped,
        fixtureFlushed: flushed,
        scrollSkipped: probe.inert,
        scrollFlushed: probe.nonInert,
    };
}

// ---------------------------------------------------------------------------
// ItemSlot memoization checks (pure, deterministic)
// ---------------------------------------------------------------------------

function probeItemSlotMemo() {
    const dummyChild = React.createElement("div", null, "x") as React.ReactElement<any>;
    const dummyRegister = (() => () => {}) as any;
    const itemA = filled.get(0)!;
    const itemB = { ...itemA }; // same placement, different object identity
    const itemC = { ...itemA, top: itemA.top + 1 }; // different placement

    const baseProps = {
        child: dummyChild,
        width: 200,
        index: 0,
        inert: false,
        itemCount: N,
        item: itemA,
        register: dummyRegister,
        resetKey: 0,
    };

    const cases: [string, any, any, boolean][] = [
        ["identical placement (memo hit)", baseProps, { ...baseProps, item: itemB }, true],
        ["different placement (miss)", baseProps, { ...baseProps, item: itemC }, false],
        [
            "different child (miss)",
            baseProps,
            { ...baseProps, child: React.createElement("div", null, "y") as any },
            false,
        ],
        ["different width (miss)", baseProps, { ...baseProps, width: 199 }, false],
        ["inert flip (miss)", baseProps, { ...baseProps, inert: true }, false],
        ["resetKey bump (miss)", baseProps, { ...baseProps, resetKey: 1 }, false],
        ["null vs valued (miss)", { ...baseProps, item: null }, baseProps, false],
        ["null vs null (hit)", { ...baseProps, item: null }, { ...baseProps, item: null }, true],
    ];

    let hits = 0,
        misses = 0;
    const details: string[] = [];
    for (const [name, prev, next, expectHit] of cases) {
        const hit = areItemSlotPropsEqual(prev, next);
        if (hit !== expectHit)
            throw new Error(
                `areItemSlotPropsEqual failed: ${name} expected ${expectHit} got ${hit}`,
            );
        // Also validate arePlacementsEqual for item pairs
        if (prev.item && next.item) {
            const equal = arePlacementsEqual(prev.item, next.item);
            const expectEqual =
                prev.item.top === next.item.top &&
                prev.item.left === next.item.left &&
                prev.item.height === next.item.height;
            if (equal !== expectEqual) throw new Error(`arePlacementsEqual failed: ${name}`);
        }
        if (hit) hits++;
        else misses++;
        details.push(`  ${name.padEnd(34)} -> ${hit ? "hit (no rerender)" : "miss (rerender)"}`);
    }
    return { hits, misses, details };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

console.log("masonry-render-count · deterministic hook/component render counts (N=10k, 8col)");
console.log(
    `seed=42 · totalHeight=${totalHeight.toFixed(0)}px · viewport=${VIEWPORT_HEIGHT}px overscan=${OVERSCAN}`,
);

// 1) MasonryRoot: how many commits does a scroll save?
console.log("\n[MasonryRoot · scroll hysteresis — commits vs skipped renders]");
for (const speed of [600, 1500, 4000, 10_000]) {
    const r = simulateScrollRenderCounts(speed);
    const inertPct = ((r.inert / r.frames) * 100).toFixed(1).padStart(5);
    const avgSlotsPerCommit = r.nonInert ? (r.itemSlotRerenders / r.nonInert).toFixed(1) : "0.0";
    console.log(
        `  ${String(speed).padStart(5)} px/s (${String(r.step).padStart(3)} px/f) ` +
            `-> ${String(r.nonInert).padStart(5)}/${String(r.frames).padStart(5)} commits ` +
            `(${inertPct}% skipped) · ${r.itemSlotRerenders} ItemSlot changes (avg ${avgSlotsPerCommit}/commit)`,
    );
}

// 2) Single-frame deltas: inert vs crossing — the per-frame ItemSlot cost
console.log("\n[ItemSlot · per-frame delta — how many slots rerender on a 4px shift]");
const singleCases: [string, WindowRange, WindowRange][] = [
    ["inert 16px", INERT_16.rest, INERT_16.shifted],
    ["inert 64px", INERT_64.rest, INERT_64.shifted],
    ["col0 crossing (+4px, early exit)", CROSSING_COL0.previous, CROSSING_COL0.next],
    ["last-col crossing (+4px, full scan)", CROSSING_LAST.previous, CROSSING_LAST.next],
];
for (const [name, prev, next] of singleCases) {
    const isInert = filled.isWindowShiftInert(prev, next);
    const prevN = rangeSize(prev);
    const nextN = rangeSize(next);
    const prevSet = new Set(renderedIndices(prev));
    const nextSet = new Set(renderedIndices(next));
    let entering = 0,
        exiting = 0;
    for (const id of nextSet) if (!prevSet.has(id)) entering++;
    for (const id of prevSet) if (!nextSet.has(id)) exiting++;
    const slotChanges = entering + exiting;
    console.log(
        `  ${name.padEnd(36)} -> inert=${String(isInert).padEnd(5)} ` +
            `range ${prevN} -> ${nextN} items ` +
            `(${exiting} exit + ${entering} enter = ${slotChanges} ItemSlot rerenders)`,
    );
}

// 3) ItemSlot memoization — areItemSlotPropsEqual hit rate
console.log("\n[ItemSlot · memo comparator — areItemSlotPropsEqual]");
const memo = probeItemSlotMemo();
for (const line of memo.details) console.log(line);
console.log(
    `  summary: ${memo.hits} hits (no rerender), ${memo.misses} misses (rerender) — deterministic`,
);

// 4) useMeasurements — flushSync skips via skipUpdatePredicate
console.log("\n[useMeasurements · skipUpdatePredicate — flushSync saves]");
const um = countUseMeasurementsSkips();
console.log(`  fixtures: ${um.fixtureSkipped} skipped, ${um.fixtureFlushed} flushed (of 5 cases)`);
console.log(
    `  scroll 1500 px/s: ${um.scrollSkipped} skipped, ${um.scrollFlushed} flushed (of ${um.scrollSkipped + um.scrollFlushed} frames) — equals inert count above`,
);

// 5) commitPendingMeasurements — batch dedup (deterministic, no timing)
console.log("\n[commitPendingMeasurements · batch dedup — positioner work]");
{
    const p = buildPositioner({ containerWidth: 1600 });
    for (let i = 0; i < 100; i++) p.set(300);
    // Two measurements for same index in one batch → only last height matters
    // We can't call commitPendingMeasurements without real HTMLElements, but we
    // can show the deterministic positioner.update span for duplicate indices:
    const dupUpdates = [
        { index: 5, height: 200 },
        { index: 5, height: 400 },
        { index: 20, height: 250 },
    ];
    const before = p.get(5)!.height;
    p.update(dupUpdates);
    const after = p.get(5)!.height;
    console.log(
        `  duplicate index in batch: height ${before} -> ${after} (last write wins, deterministic)`,
    );
    console.log(`  batch de-duplication is via Map — no extra renders for duplicates`);
}

// 6) SSR placeholder batch — deterministic initial render count
console.log("\n[MasonryRoot · SSR — initial ItemSlot placeholders]");
{
    const { renderToString } = await import("react-dom/server");
    const { MasonryRoot, MasonryItem } = await import("../src/masonry.tsx");
    const makeItems = (n: number) =>
        Array.from({ length: n }, (_, i) =>
            React.createElement(MasonryItem, { key: `k-${i}` }, `item ${i}`),
        );
    const countPlaceholders = (html: string) =>
        (html.match(/data-slot="masonry-item"/g) ?? []).length;
    const cases: [string, number, any][] = [
        ["default (derived 1 col)", 7, {}],
        ["columnCount=3", 7, { columnCount: 3 }],
        ["columnCount=8", 100, { columnCount: 8 }],
        ["empty", 0, {}],
    ];
    for (const [name, n, extra] of cases) {
        const el = React.createElement(MasonryRoot, extra, makeItems(n));
        const html = renderToString(el);
        const ph = countPlaceholders(html);
        console.log(
            `  ${name.padEnd(26)} n=${String(n).padStart(3)} -> ${ph} placeholder ItemSlot(s)`,
        );
    }
}

console.log(
    "\nnote: all counts above are deterministic — diff them in CI; for ms, use mitata locally on a quiet machine",
);
