import { describe, expect, test } from "bun:test";
import * as React from "react";
import { renderToString } from "react-dom/server";
import {
    areItemSlotPropsEqual,
    buildPositioner,
    commitPendingMeasurements,
} from "../src/masonry.tsx";
import { MasonryItem, MasonryRoot } from "../src/masonry.tsx";
import {
    buildFilled,
    getColumnTops,
    getItem,
    getWindowRange,
    makeHeights,
    OVERSCAN,
    VIEWPORT_HEIGHT,
} from "./positioner.ts";
import type { WindowRange } from "./positioner.ts";

/**
 * Deterministic render-count tests for the main hooks and components.
 *
 * These are the CI signal: counts are fully deterministic given seeded
 * heights, so any change is meaningful. Wall-clock timing is not asserted
 * here — baseline/head run on different machines, so ms deltas are noise.
 *
 * Coverage:
 *  - MasonryRoot scroll hysteresis (isWindowShiftInert → skipped commits)
 *  - ItemSlot memoization (areItemSlotPropsEqual / arePlacementsEqual)
 *  - useMeasurements skipUpdatePredicate (flushSync saves)
 *  - commitPendingMeasurements batch dedup
 *  - SSR placeholder batch (initial ItemSlot render count)
 */

const N = 10_000;
const HEIGHTS = makeHeights(N);
const filled = buildFilled(HEIGHTS);
const totalHeight = filled.shortestColumn();

// Reuse fixture builders from bench so tests and benches agree on “meaningful” counts.
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
            if (filled.isWindowShiftInert(rest.start, rest.end, shifted.start, shifted.end)) return { rest, shifted };
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
        if (filled.isWindowShiftInert(previous.start, previous.end, next.start, next.end)) throw new Error("unexpected inert");
        return { previous, next };
    }
    throw new Error(`no isolated ${boundary} crossing for col ${targetColumn}`);
}

const INERT_16 = findInertPair(16);
const INERT_64 = findInertPair(64);
const CROSSING_COL0 = boundaryCrossingRange(0, "start");
const CROSSING_LAST = boundaryCrossingRange(filled.columnCount - 1, "end");

function renderedIndices(range: WindowRange): number[] {
    const out: number[] = [];
    filled.range(range.start, range.end, (index) => out.push(index));
    return out.sort((a, b) => a - b);
}

function simulateMasonryRootScroll(pxPerSecond: number) {
    const step = Math.max(1, Math.round(pxPerSecond / 60));
    let inert = 0,
        nonInert = 0,
        itemSlotChanges = 0;
    let prevRange = getWindowRange(Math.max(0, 5_000 - VIEWPORT_HEIGHT), VIEWPORT_HEIGHT, OVERSCAN);
    let prevSet = new Set(renderedIndices(prevRange));
    for (let scrollTop = 5_000; scrollTop < totalHeight - VIEWPORT_HEIGHT; scrollTop += step) {
        const nextRange = getWindowRange(scrollTop, VIEWPORT_HEIGHT, OVERSCAN);
        const isInert = filled.isWindowShiftInert(prevRange.start, prevRange.end, nextRange.start, nextRange.end);
        if (isInert) inert++;
        else {
            nonInert++;
            const nextSet = new Set(renderedIndices(nextRange));
            for (const id of prevSet) if (!nextSet.has(id)) itemSlotChanges++;
            for (const id of nextSet) if (!prevSet.has(id)) itemSlotChanges++;
            prevSet = nextSet;
        }
        prevRange = nextRange;
    }
    return { step, inert, nonInert, frames: inert + nonInert, itemSlotChanges };
}

function countPlaceholders(html: string) {
    return (html.match(/data-slot="masonry-item"/g) ?? []).length;
}
function makeItems(count: number) {
    return Array.from({ length: count }, (_, i) => (
        <MasonryItem key={`k-${i}`}>item {i}</MasonryItem>
    ));
}

// ---------------------------------------------------------------------------

describe("MasonryRoot · scroll hysteresis render counts", () => {
    test("inert 16px wheel tick skips MasonryRoot commit and 0 ItemSlots rerender", () => {
        expect(filled.isWindowShiftInert(INERT_16.rest.start, INERT_16.rest.end, INERT_16.shifted.start, INERT_16.shifted.end)).toBe(true);
        const a = renderedIndices(INERT_16.rest);
        const b = renderedIndices(INERT_16.shifted);
        expect(a).toEqual(b); // no ItemSlot should rerender
    });

    test("inert 64px also skips commit", () => {
        expect(filled.isWindowShiftInert(INERT_64.rest.start, INERT_64.rest.end, INERT_64.shifted.start, INERT_64.shifted.end)).toBe(true);
        expect(renderedIndices(INERT_64.rest)).toEqual(renderedIndices(INERT_64.shifted));
    });

    test("boundary crossing in col 0 forces MasonryRoot commit and exactly 1 ItemSlot change", () => {
        expect(filled.isWindowShiftInert(CROSSING_COL0.previous.start, CROSSING_COL0.previous.end, CROSSING_COL0.next.start, CROSSING_COL0.next.end)).toBe(false);
        const prev = new Set(renderedIndices(CROSSING_COL0.previous));
        const next = new Set(renderedIndices(CROSSING_COL0.next));
        let changed = 0;
        for (const id of prev) if (!next.has(id)) changed++;
        for (const id of next) if (!prev.has(id)) changed++;
        expect(changed).toBe(1);
    });

    test("boundary crossing in last column forces commit and exactly 1 ItemSlot change (full scan)", () => {
        expect(filled.isWindowShiftInert(CROSSING_LAST.previous.start, CROSSING_LAST.previous.end, CROSSING_LAST.next.start, CROSSING_LAST.next.end)).toBe(false);
        const prev = new Set(renderedIndices(CROSSING_LAST.previous));
        const next = new Set(renderedIndices(CROSSING_LAST.next));
        let changed = 0;
        for (const id of prev) if (!next.has(id)) changed++;
        for (const id of next) if (!prev.has(id)) changed++;
        expect(changed).toBe(1);
    });

    test("scroll simulation: inert % and commit counts are deterministic snapshots", () => {
        // Snapshots from bench/masonry-render-count.bench.ts with seed=42, N=10k, 8col
        const cases: [number, { inert: number; nonInert: number; frames: number }][] = [
            [600, { inert: 23501, nonInert: 15743, frames: 39244 }],
            [1500, { inert: 4242, nonInert: 11456, frames: 15698 }],
            [4000, { inert: 135, nonInert: 5723, frames: 5858 }],
            [10_000, { inert: 0, nonInert: 2350, frames: 2350 }],
        ];
        for (const [speed, expected] of cases) {
            const r = simulateMasonryRootScroll(speed);
            expect(r.inert).toBe(expected.inert);
            expect(r.nonInert).toBe(expected.nonInert);
            expect(r.frames).toBe(expected.frames);
        }
    });

    test("scroll 1500 px/s: total ItemSlot churn is deterministic", () => {
        const r = simulateMasonryRootScroll(1500);
        // 19712 is the total number of ItemSlot enter+exit across the whole scroll,
        // derived from the bench probe. Any layout change will move this.
        expect(r.itemSlotChanges).toBe(19712);
    });
});

describe("ItemSlot · memoization render counts", () => {
    test("areItemSlotPropsEqual: memo hits exactly when placement+identity equal", () => {
        const dummyChild = React.createElement("div", null, "x") as React.ReactElement<any>;
        const dummyRegister = (() => () => {}) as any;
        const itemA = filled.get(0)!;
        const itemB = { ...itemA };
        const itemC = { ...itemA, top: itemA.top + 1 };

        const base: any = {
            child: dummyChild,
            width: 200,
            index: 0,
            inert: false,
            itemCount: N,
            left: itemA.left,
            top: itemA.top,
            height: itemA.height,
            register: dummyRegister,
            resetKey: 0,
        };

        // Hit: same placement, different object identity → no rerender
        expect(
            areItemSlotPropsEqual(base, { ...base, left: itemB.left, top: itemB.top, height: itemB.height }),
        ).toBe(true);
        // Misses: each is a distinct render cause
        expect(
            areItemSlotPropsEqual(base, { ...base, left: itemC.left, top: itemC.top, height: itemC.height }),
        ).toBe(false);
        expect(
            areItemSlotPropsEqual(base, {
                ...base,
                child: React.createElement("div", null, "y") as any,
            }),
        ).toBe(false);
        expect(areItemSlotPropsEqual(base, { ...base, width: 199 })).toBe(false);
        expect(areItemSlotPropsEqual(base, { ...base, inert: true })).toBe(false);
        expect(areItemSlotPropsEqual(base, { ...base, resetKey: 1 })).toBe(false);
        expect(areItemSlotPropsEqual({ ...base, left: null, top: null, height: null }, base)).toBe(false);
        expect(
            areItemSlotPropsEqual(
                { ...base, left: null, top: null, height: null },
                { ...base, left: null, top: null, height: null },
            ),
        ).toBe(true);
    });

    test("areItemSlotPropsEqual: summary hits/misses is deterministic", () => {
        const dummyChild = React.createElement("div", null, "x") as React.ReactElement<any>;
        const dummyRegister = (() => () => {}) as any;
        const itemA = filled.get(0)!;
        const base: any = {
            child: dummyChild,
            width: 200,
            index: 0,
            inert: false,
            itemCount: N,
            left: itemA.left,
            top: itemA.top,
            height: itemA.height,
            register: dummyRegister,
            resetKey: 0,
        };
        const cases: [any, any, boolean][] = [
            [base, { ...base, left: itemA.left, top: itemA.top, height: itemA.height }, true],
            [base, { ...base, left: itemA.left, top: itemA.top + 1, height: itemA.height }, false],
            [base, { ...base, child: React.createElement("div", null, "y") as any }, false],
            [base, { ...base, width: 199 }, false],
            [base, { ...base, inert: true }, false],
            [base, { ...base, resetKey: 1 }, false],
            [{ ...base, left: null, top: null, height: null }, base, false],
            [
                { ...base, left: null, top: null, height: null },
                { ...base, left: null, top: null, height: null },
                true,
            ],
        ];
        let hits = 0,
            misses = 0;
        for (const [p, n, expectHit] of cases) {
            const hit = areItemSlotPropsEqual(p, n);
            expect(hit).toBe(expectHit);
            if (hit) hits++;
            else misses++;
        }
        expect(hits).toBe(2);
        expect(misses).toBe(6);
    });
});

describe("useMeasurements · skipUpdatePredicate (hook render counts)", () => {
    test("fixtures: 3 skipped flushSync, 2 flushed", () => {
        const cases: [WindowRange, WindowRange, boolean][] = [
            [INERT_16.rest, INERT_16.rest, true],
            [INERT_16.rest, INERT_16.shifted, true],
            [INERT_64.rest, INERT_64.shifted, true],
            [CROSSING_COL0.previous, CROSSING_COL0.next, false],
            [CROSSING_LAST.previous, CROSSING_LAST.next, false],
        ];
        let skipped = 0,
            flushed = 0;
        for (const [prev, next, shouldSkip] of cases) {
            const isInert = filled.isWindowShiftInert(prev.start, prev.end, next.start, next.end);
            expect(isInert).toBe(shouldSkip);
            if (isInert) skipped++;
            else flushed++;
        }
        expect(skipped).toBe(3);
        expect(flushed).toBe(2);
    });

    test("scroll 1500 px/s: skipped == inert count, flushed == commit count", () => {
        const r = simulateMasonryRootScroll(1500);
        // useMeasurements’ skipUpdatePredicate saves exactly the inert frames
        expect(r.inert).toBe(4242);
        expect(r.nonInert).toBe(11456);
    });
});

describe("commitPendingMeasurements · batch dedup render counts", () => {
    test("duplicate index in same batch: last write wins, update reflows once per column", () => {
        const p = buildPositioner({ containerWidth: 1600 });
        for (let i = 0; i < 100; i++) p.set(300);
        const before = p.getHeight(5)!;
        expect(before).toBe(300);
        p.update([
            { index: 5, height: 200 },
            { index: 5, height: 400 },
            { index: 20, height: 250 },
        ]);
        expect(p.getHeight(5)!).toBe(400);
        expect(p.getHeight(20)!).toBe(250);
    });

    test("commitPendingMeasurements: unconnected or wrong-index nodes do not trigger renders", () => {
        const p = buildPositioner({ containerWidth: 1600 });
        for (let i = 0; i < 5; i++) p.set(100);
        const unconnected = { isConnected: false, getAttribute: () => "2" } as any;
        const wrongIndex = { isConnected: true, getAttribute: () => "999" } as any;
        const map = new Map<number, any>([
            [2, { height: 200, node: unconnected }],
            [1, { height: 200, node: wrongIndex }],
        ]);
        const didChange = commitPendingMeasurements(p as any, map as any);
        expect(didChange).toBe(false);
        expect(p.getHeight(2)!).toBe(100);
    });

    test("commitPendingMeasurements: valid new index appends and valid update reflows", () => {
        const p = buildPositioner({ containerWidth: 1600 });
        for (let i = 0; i < 3; i++) p.set(100);
        const mkNode = (idx: number) =>
            ({ isConnected: true, getAttribute: () => String(idx) }) as any;
        // Append at size (index === size) triggers set
        const appendMap = new Map<number, any>([[3, { height: 150, node: mkNode(3) }]]);
        expect(commitPendingMeasurements(p as any, appendMap as any)).toBe(true);
        expect(p.size()).toBe(4);
        expect(p.getHeight(3)!).toBe(150);

        // Update existing height at index 1 triggers update
        const updateMap = new Map<number, any>([[1, { height: 220, node: mkNode(1) }]]);
        expect(commitPendingMeasurements(p as any, updateMap as any)).toBe(true);
        expect(p.getHeight(1)!).toBe(220);
    });
});

describe("MasonryRoot · SSR placeholder render counts", () => {
    test("default derived columnCount renders exactly 1 placeholder ItemSlot", () => {
        const html = renderToString(<MasonryRoot gap={0}>{makeItems(7)}</MasonryRoot>);
        expect(countPlaceholders(html)).toBe(1);
    });

    test("columnCount=3 renders 3 placeholders", () => {
        const html = renderToString(<MasonryRoot columnCount={3} gap={0}>{makeItems(7)}</MasonryRoot>);
        expect(countPlaceholders(html)).toBe(3);
    });

    test("columnCount=8 with 100 items renders 8 placeholders (one per column)", () => {
        const html = renderToString(<MasonryRoot columnCount={8} gap={0}>{makeItems(100)}</MasonryRoot>);
        expect(countPlaceholders(html)).toBe(8);
    });

    test("empty children renders 0 placeholders and zero-height container", () => {
        const html = renderToString(<MasonryRoot gap={0}>{[]}</MasonryRoot>);
        expect(countPlaceholders(html)).toBe(0);
        expect(html).toContain("height:0;");
    });

    test("placeholder count equals min(itemCount, columnCount) for SSR", () => {
        // SSR batch before any measurement: one full row
        const cases: [number, number, number][] = [
            [1, 7, 1],
            [3, 7, 3],
            [8, 100, 8],
            [4, 2, 2],
        ];
        for (const [cols, items, expected] of cases) {
            const html = renderToString(
                <MasonryRoot columnCount={cols} gap={0}>{makeItems(items)}</MasonryRoot>,
            );
            expect(countPlaceholders(html)).toBe(expected);
        }
    });
});
