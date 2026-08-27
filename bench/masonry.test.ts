import { describe, expect, test } from "bun:test";
import { buildPositioner, getWindowRange } from "../src/masonry.tsx";

/* The hysteresis decision must never miss a rendered-set change: skipping a
 * scroll update is only safe when the items overlapping the old and new
 * windows are exactly the same. These tests hold `isWindowShiftInert`
 * against the actual `range()` walk for randomized layouts. */

function createRandom(seed: number) {
    let state = seed >>> 0;
    return () => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 0xffffffff;
    };
}

interface TestPositionerOptions {
    columnCount: number;
    horizontalGap?: number;
    itemCount: number;
    maxHeight?: number;
    minHeight?: number;
    verticalGap?: number;
}

function buildTestPositioner(random: () => number, options: TestPositionerOptions) {
    const {
        columnCount,
        horizontalGap = 12,
        itemCount,
        maxHeight = 600,
        minHeight = 20,
        verticalGap = horizontalGap,
    } = options;
    const positioner = buildPositioner({
        columnCount,
        columnWidth: 120,
        containerWidth: columnCount * 132,
        horizontalGap,
        verticalGap,
    });
    for (let index = 0; index < itemCount; index += 1) {
        positioner.set(minHeight + Math.floor(random() * (maxHeight - minHeight)));
    }
    return positioner;
}

function renderedIndices(
    positioner: ReturnType<typeof buildPositioner>,
    range: { start: number; end: number },
) {
    const indices: number[] = [];
    positioner.range(range.start, range.end, (item) => {
        indices.push(item.index);
    });
    return indices.sort((a, b) => a - b);
}

function areIndicesEqual(first: number[], second: number[]) {
    return first.length === second.length && first.every((value, index) => value === second[index]);
}

function layoutHeight(positioner: ReturnType<typeof buildPositioner>, itemCount: number) {
    let tallest = 0;
    for (let index = 0; index < itemCount; index += 1) {
        const item = positioner.get(index)!;
        tallest = Math.max(tallest, item.top + item.height);
    }
    return tallest;
}

describe("isWindowShiftInert", () => {
    test("identical windows are always inert, even with nothing measured", () => {
        const positioner = buildPositioner({ columnCount: 2, containerWidth: 264 });
        const range = getWindowRange(500, 800, 1.5);
        expect(positioner.isWindowShiftInert(range, range)).toBe(true);
    });

    test("overscan Infinity produces identical windows for any scroll", () => {
        const positioner = buildTestPositioner(createRandom(3), { columnCount: 2, itemCount: 30 });
        const previous = getWindowRange(0, 800, Infinity);
        const next = getWindowRange(5000, 800, Infinity);
        expect(previous).toEqual(next);
        expect(positioner.isWindowShiftInert(previous, next)).toBe(true);
    });

    test("an empty positioner defers to the batch machinery", () => {
        const positioner = buildPositioner({ columnCount: 2, containerWidth: 264 });
        const previous = getWindowRange(0, 800, 1.5);
        const next = getWindowRange(10, 800, 1.5);
        expect(positioner.isWindowShiftInert(previous, next)).toBe(false);
    });

    test("a window reaching past the measured frontier is never inert", () => {
        // Frontier (shortest column) is 220px; the shifted window ends at 1620px.
        const positioner = buildTestPositioner(createRandom(4), {
            columnCount: 2,
            itemCount: 4,
            maxHeight: 110,
            minHeight: 100,
        });
        const previous = getWindowRange(0, 800, 1.5);
        const next = getWindowRange(40, 800, 1.5);
        expect(positioner.shortestColumn()).toBeLessThan(next.end);
        expect(positioner.isWindowShiftInert(previous, next)).toBe(false);
    });

    test("a shift inside the overscan margin with no boundary crossed is inert", () => {
        // Exact 50px items in one column: every boundary sits at a multiple of
        // 50. A 10px shift cannot reach any boundary, and the measured
        // frontier (60 × 50 = 3000px) covers the shifted window, so the
        // decision must be a skip.
        const positioner = buildTestPositioner(createRandom(5), {
            columnCount: 1,
            horizontalGap: 0,
            itemCount: 60,
            maxHeight: 50,
            minHeight: 50,
        });
        const previous = getWindowRange(500, 800, 0.25);
        const next = getWindowRange(510, 800, 0.25);
        expect(positioner.shortestColumn()).toBeGreaterThanOrEqual(next.end);
        expect(positioner.isWindowShiftInert(previous, next)).toBe(true);
        expect(renderedIndices(positioner, previous)).toEqual(renderedIndices(positioner, next));
    });

    test("a top entering through the leading edge forces an update", () => {
        // Exact 100px items: tops sit at 0, 100, …, 900. Raising the window's
        // high edge from 699 to 700 admits the item whose top is 700.
        const positioner = buildTestPositioner(createRandom(6), {
            columnCount: 1,
            horizontalGap: 0,
            itemCount: 10,
            maxHeight: 100,
            minHeight: 100,
        });
        const previous = getWindowRange(399, 300, 0);
        const next = getWindowRange(400, 300, 0);
        expect(renderedIndices(positioner, previous)).not.toEqual(
            renderedIndices(positioner, next),
        );
        expect(positioner.isWindowShiftInert(previous, next)).toBe(false);
    });

    test("a bottom exiting through the trailing edge forces an update", () => {
        // Exact 100px items: bottoms sit at 100, …, 400. Raising the window's
        // low edge from 100 to 101 drops the first item, whose bottom is 100,
        // and nothing new enters behind it.
        const positioner = buildTestPositioner(createRandom(7), {
            columnCount: 1,
            horizontalGap: 0,
            itemCount: 4,
            maxHeight: 100,
            minHeight: 100,
        });
        const previous = getWindowRange(100, 300, 0);
        const next = getWindowRange(101, 300, 0);
        expect(renderedIndices(positioner, previous)).toEqual([0, 1, 2, 3]);
        expect(renderedIndices(positioner, next)).toEqual([1, 2, 3]);
        expect(positioner.isWindowShiftInert(previous, next)).toBe(false);
    });

    test("property: against range(), true implies equal sets and differing sets imply false", () => {
        const seeds = [1, 7, 42, 1337, 2026, 8675309];
        const overscans = [0, 0.25, 1.5];
        let checked = 0;

        for (const seed of seeds) {
            const random = createRandom(seed);
            const columnCount = 1 + Math.floor(random() * 4);
            const horizontalGap = random() < 0.5 ? 0 : Math.floor(random() * 24);
            const positioner = buildTestPositioner(random, {
                columnCount,
                horizontalGap,
                itemCount: 20 + Math.floor(random() * 60),
                maxHeight: 300 + Math.floor(random() * 400),
            });
            const totalHeight = layoutHeight(positioner, positioner.size());
            const windowHeight = 600 + Math.floor(random() * 400);

            for (const overscan of overscans) {
                for (let trial = 0; trial < 250; trial += 1) {
                    const baseScroll = random() * (totalHeight + windowHeight);
                    const delta = (random() - 0.5) * windowHeight * 3;
                    const previous = getWindowRange(
                        Math.max(0, baseScroll),
                        windowHeight,
                        overscan,
                    );
                    const next = getWindowRange(
                        Math.max(0, baseScroll + delta),
                        windowHeight,
                        overscan,
                    );

                    const setsEqual = areIndicesEqual(
                        renderedIndices(positioner, previous),
                        renderedIndices(positioner, next),
                    );
                    const decision = positioner.isWindowShiftInert(previous, next);

                    // Safety: a "skip" verdict is only ever issued for truly
                    // identical rendered sets, and a real difference is never
                    // skipped (conservative extra updates are allowed).
                    if (decision) {
                        expect(setsEqual).toBe(true);
                    }
                    if (!setsEqual) {
                        expect(decision).toBe(false);
                    }
                    checked += 1;
                }
            }
        }
        expect(checked).toBeGreaterThan(3000);
    });
});
