import { describe, expect, test } from "bun:test";
import * as React from "react";
import { areItemSlotPropsEqual } from "../../src/masonry.tsx";
import {
    buildFilled,
    getColumnTops,
    getItem,
    getWindowRange,
    makeHeights,
    OVERSCAN,
    VIEWPORT_HEIGHT,
} from "../performance/fixtures.ts";
import type { WindowRange } from "../performance/fixtures.ts";

/**
 * Deterministic render-count tests for the scroll hysteresis guard and the
 * ItemSlot memo boundary.
 *
 * These are the CI signal: counts are fully deterministic given seeded
 * heights, so any change is meaningful. Wall-clock timing is not asserted
 * here — baseline/head run on different machines, so ms deltas are noise.
 */

const N = 10_000;
const HEIGHTS = makeHeights(N);
const filled = buildFilled(HEIGHTS);
const totalHeight = filled.tallestColumn();

// Reuse fixture builders from the perf probes so tests and probes agree on
// "meaningful" counts.
function findInertPair(shiftPx: number): { rest: WindowRange; shifted: WindowRange } {
    const topsByColumn = getColumnTops(filled);
    const bandHasTop = (y: number) => {
        for (const tops of topsByColumn) {
            let lo = 0;
            let hi = tops.length;
            while (lo < hi) {
                const mid = (lo + hi) >>> 1;
                if (getItem(tops, mid) <= y) lo = mid + 1;
                else hi = mid;
            }
            if (lo < tops.length && getItem(tops, lo) <= y + shiftPx) return true;
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
    throw new Error(`no inert pair for ${shiftPx}px`);
}

function boundaryCrossingRange(
    targetColumn: number,
    boundary: "start" | "end",
): { previous: WindowRange; next: WindowRange } {
    const topsByColumn = getColumnTops(filled);
    const span = VIEWPORT_HEIGHT * (1 + OVERSCAN);
    const lowerCount = (tops: number[], y: number) => {
        let lo = 0;
        let hi = tops.length;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (getItem(tops, mid) < y) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    };
    const upperCount = (tops: number[], y: number) => {
        let lo = 0;
        let hi = tops.length;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (getItem(tops, mid) <= y) lo = mid + 1;
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
        const startY = previous.start;
        const endY = previous.end;
        if (startY < VIEWPORT_HEIGHT * 2 || next.end > totalHeight - VIEWPORT_HEIGHT) continue;
        if (!crossingDiff(boundary === "start" ? startY : endY, targetColumn)) continue;
        let onlyTarget = true;
        for (let col = 0; col < topsByColumn.length; col += 1) {
            if (col === targetColumn) continue;
            if (crossingDiff(startY, col) || crossingDiff(endY, col)) {
                onlyTarget = false;
                break;
            }
        }
        if (!onlyTarget) continue;
        if (filled.isRangeInert(previous.start, previous.end, next.start, next.end)) {
            throw new Error("constructed crossing unexpectedly reported inert");
        }
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
    let inert = 0;
    let nonInert = 0;
    let itemSlotChanges = 0;
    let prevRange = getWindowRange(Math.max(0, 5_000 - VIEWPORT_HEIGHT), VIEWPORT_HEIGHT, OVERSCAN);
    let prevSet = new Set(renderedIndices(prevRange));
    for (let scrollTop = 5_000; scrollTop < totalHeight - VIEWPORT_HEIGHT; scrollTop += step) {
        const nextRange = getWindowRange(scrollTop, VIEWPORT_HEIGHT, OVERSCAN);
        const isInert = filled.isRangeInert(
            prevRange.start,
            prevRange.end,
            nextRange.start,
            nextRange.end,
        );
        if (isInert) {
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

type TestItem = { id: string };
function makeItems(count: number): TestItem[] {
    return Array.from({ length: count }, (_, i) => ({ id: `k-${i}` }));
}

// ---------------------------------------------------------------------------

describe("MasonryRoot · scroll hysteresis render counts", () => {
    test("inert 16px wheel tick skips MasonryRoot commit and 0 ItemSlots rerender", () => {
        expect(
            filled.isRangeInert(
                INERT_16.rest.start,
                INERT_16.rest.end,
                INERT_16.shifted.start,
                INERT_16.shifted.end,
            ),
        ).toBe(true);
        const a = renderedIndices(INERT_16.rest);
        const b = renderedIndices(INERT_16.shifted);
        expect(a).toEqual(b); // no ItemSlot should rerender
    });

    test("inert 64px also skips commit", () => {
        expect(
            filled.isRangeInert(
                INERT_64.rest.start,
                INERT_64.rest.end,
                INERT_64.shifted.start,
                INERT_64.shifted.end,
            ),
        ).toBe(true);
        expect(renderedIndices(INERT_64.rest)).toEqual(renderedIndices(INERT_64.shifted));
    });

    test("boundary crossing in col 0 forces MasonryRoot commit and exactly 1 ItemSlot change", () => {
        expect(
            filled.isRangeInert(
                CROSSING_COL0.previous.start,
                CROSSING_COL0.previous.end,
                CROSSING_COL0.next.start,
                CROSSING_COL0.next.end,
            ),
        ).toBe(false);
        const prev = new Set(renderedIndices(CROSSING_COL0.previous));
        const next = new Set(renderedIndices(CROSSING_COL0.next));
        let changed = 0;
        for (const id of prev) {
            if (!next.has(id)) changed += 1;
        }
        for (const id of next) {
            if (!prev.has(id)) changed += 1;
        }
        expect(changed).toBe(1);
    });

    test("boundary crossing in last column forces commit and exactly 1 ItemSlot change (full scan)", () => {
        expect(
            filled.isRangeInert(
                CROSSING_LAST.previous.start,
                CROSSING_LAST.previous.end,
                CROSSING_LAST.next.start,
                CROSSING_LAST.next.end,
            ),
        ).toBe(false);
        const prev = new Set(renderedIndices(CROSSING_LAST.previous));
        const next = new Set(renderedIndices(CROSSING_LAST.next));
        let changed = 0;
        for (const id of prev) {
            if (!next.has(id)) changed += 1;
        }
        for (const id of next) {
            if (!prev.has(id)) changed += 1;
        }
        expect(changed).toBe(1);
    });

    test("scroll simulation: inert % and commit counts are deterministic snapshots", () => {
        // Snapshots from test/performance/render-count.probe.tsx with seed=42, N=10k, 8col
        const cases: [number, { inert: number; nonInert: number; frames: number }][] = [
            [600, { inert: 24409, nonInert: 15694, frames: 40103 }],
            [1500, { inert: 4545, nonInert: 11497, frames: 16042 }],
            [4000, { inert: 183, nonInert: 5803, frames: 5986 }],
            [10_000, { inert: 7, nonInert: 2395, frames: 2402 }],
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
        // 19746 is the total number of ItemSlot enter+exit across the whole
        // scroll, derived from the perf probe. Any layout change moves this.
        expect(r.itemSlotChanges).toBe(19746);
    });
});

describe("ItemSlot · memoization render counts", () => {
    // Structural mirror of the internal ItemSlotProps; areItemSlotPropsEqual
    // is the memo comparator for exactly this shape.
    interface SlotProps {
        index: number;
        item: unknown;
        itemCount: number;
        left: number;
        register: (node: HTMLElement | null) => (() => void) | undefined;
        render: (item: unknown, index: number) => React.ReactElement;
        top: number;
        width: number;
    }
    const dummyRender: SlotProps["render"] = () => React.createElement("div", null, "x");
    const base: SlotProps = {
        index: 0,
        item: makeItems(1)[0],
        itemCount: N,
        left: 100,
        register: () => undefined,
        render: dummyRender,
        top: 200,
        width: 200,
    };

    test("areItemSlotPropsEqual: memo hits exactly when placement+identity equal", () => {
        // Hit: same placement, same identities → no rerender
        expect(areItemSlotPropsEqual(base, { ...base })).toBe(true);
        // Misses: each is a distinct render cause
        expect(areItemSlotPropsEqual(base, { ...base, left: 101 })).toBe(false);
        expect(areItemSlotPropsEqual(base, { ...base, top: 201 })).toBe(false);
        expect(areItemSlotPropsEqual(base, { ...base, width: 199 })).toBe(false);
        // Content inputs: a different item, render fn, position, or count
        // must re-render the slot
        expect(areItemSlotPropsEqual(base, { ...base, item: { id: "y" } })).toBe(false);
        expect(areItemSlotPropsEqual(base, { ...base, render: () => dummyRender("x", 0) })).toBe(
            false,
        );
        expect(areItemSlotPropsEqual(base, { ...base, index: 1 })).toBe(false);
        expect(areItemSlotPropsEqual(base, { ...base, itemCount: N - 1 })).toBe(false);
        expect(areItemSlotPropsEqual(base, { ...base, register: () => () => {} })).toBe(false);
    });
});
