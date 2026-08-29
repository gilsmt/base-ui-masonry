import { describe, expect, test } from "bun:test";
import { buildPositioner } from "../src/masonry.tsx";
import { getWindowRange } from "./positioner.ts";

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
    positioner.range(range.start, range.end, (index) => {
        indices.push(index);
    });
    return indices.sort((a, b) => a - b);
}

function areIndicesEqual(first: number[], second: number[]) {
    return first.length === second.length && first.every((value, index) => value === second[index]);
}

function layoutHeight(positioner: ReturnType<typeof buildPositioner>, itemCount: number) {
    let tallest = 0;
    for (let index = 0; index < itemCount; index += 1) {
        const top = positioner.getTop(index)!;
        const height = positioner.getHeight(index)!;
        tallest = Math.max(tallest, top + height);
    }
    return tallest;
}

describe("isWindowShiftInert", () => {
    test("identical windows are always inert, even with nothing measured", () => {
        const positioner = buildPositioner({ columnCount: 2, containerWidth: 264 });
        const range = getWindowRange(500, 800, 1.5);
        expect(positioner.isWindowShiftInert(range.start, range.end, range.start, range.end)).toBe(true);
    });

    test("overscan Infinity produces identical windows for any scroll", () => {
        const positioner = buildTestPositioner(createRandom(3), { columnCount: 2, itemCount: 30 });
        const previous = getWindowRange(0, 800, Infinity);
        const next = getWindowRange(5000, 800, Infinity);
        expect(previous).toEqual(next);
        expect(positioner.isWindowShiftInert(previous.start, previous.end, next.start, next.end)).toBe(true);
    });

    test("an empty positioner defers to the batch machinery", () => {
        const positioner = buildPositioner({ columnCount: 2, containerWidth: 264 });
        const previous = getWindowRange(0, 800, 1.5);
        const next = getWindowRange(10, 800, 1.5);
        expect(positioner.isWindowShiftInert(previous.start, previous.end, next.start, next.end)).toBe(false);
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
        expect(positioner.isWindowShiftInert(previous.start, previous.end, next.start, next.end)).toBe(false);
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
        expect(positioner.isWindowShiftInert(previous.start, previous.end, next.start, next.end)).toBe(true);
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
        expect(positioner.isWindowShiftInert(previous.start, previous.end, next.start, next.end)).toBe(false);
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
        expect(positioner.isWindowShiftInert(previous.start, previous.end, next.start, next.end)).toBe(false);
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
                    const decision = positioner.isWindowShiftInert(previous.start, previous.end, next.start, next.end);

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
/* The incremental height reflow (`update`) short-circuits a column reflow when
 * the cumulative delta re-winds to zero below the deepest changed row. These
 * tests pin that optimization: the result must always equal an *in-place*
 * re-flow (masonry never re-balances items between columns on a height change;
 * it only re-stacks each column), and a cancelled batch must leave the
 * untouched tail identical. */

function buildFromHeights(
    heights: readonly number[],
    options: Parameters<typeof buildPositioner>[0],
): ReturnType<typeof buildPositioner> {
    const positioner = buildPositioner(options);
    for (const height of heights) {
        positioner.set(height);
    }
    return positioner;
}

describe("update()", () => {
    test("incremental reflow reproduces an in-place re-stack (randomized)", () => {
        const seeds = [1, 7, 42, 1337, 2026, 987654];
        let itemChecks = 0;
        let expectedChecks = 0;
        for (const seed of seeds) {
            const random = createRandom(seed);
            for (const columnCount of [1, 2, 3]) {
                const itemCount = 30 + Math.floor(random() * 40);
                const horizontalGap = random() < 0.5 ? 0 : Math.floor(random() * 12);
                const verticalGap = random() < 0.5 ? 0 : Math.floor(random() * 16);
                const options = {
                    columnCount,
                    columnWidth: 140,
                    containerWidth: columnCount * 160,
                    horizontalGap,
                    verticalGap,
                };

                // `baseline` records the ORIGINAL (pre-update) per-column
                // membership: masonry never re-balances items between columns on a
                // height change, it only re-stacks each column in place.
                const positioner = buildPositioner(options);
                const baseline = buildPositioner(options);
                // `expectedHeights` is tracked independently of `update`'s internal
                // state, so the oracle would detect a height that never got applied.
                const expectedHeights: number[] = [];
                for (let index = 0; index < itemCount; index += 1) {
                    const height = 20 + Math.floor(random() * 400);
                    positioner.set(height);
                    baseline.set(height);
                    expectedHeights.push(height);
                }

                const updates: Array<{ index: number; height: number }> = [];
                const batchSize = 1 + Math.floor(random() * columnCount * 4);
                for (let u = 0; u < batchSize; u += 1) {
                    const index = Math.floor(random() * itemCount);
                    const height = 20 + Math.floor(random() * 400);
                    updates.push({ index, height });
                    expectedHeights[index] = height;
                }

                positioner.update(updates);

                // In-place oracle: keep each item's original column (baseline
                // records the pre-update placement), re-stack every column
                // bottom-up with the independently tracked NEW heights.
                const columnItemsByLeft = new Map<number, number[]>();
                for (let index = 0; index < itemCount; index += 1) {
                    const left = baseline.getLeft(index)!;
                    let arr = columnItemsByLeft.get(left);
                    if (!arr) {
                        arr = [];
                        columnItemsByLeft.set(left, arr);
                    }
                    arr.push(index);
                }
                let shortestExpected = Number.POSITIVE_INFINITY;
                let expectedChecksThisRun = 0;
                for (const items of columnItemsByLeft.values()) {
                    let cursor = 0;
                    let bottom = 0;
                    for (const index of items) {
                        const height = expectedHeights[index];
                        expect(positioner.getTop(index)!).toBe(cursor);
                        cursor += height + verticalGap;
                        bottom = cursor - verticalGap;
                        itemChecks += 1;
                        expectedChecksThisRun += 1;
                    }
                    shortestExpected = Math.min(shortestExpected, bottom);
                }
                // Every item lives in exactly one column, so coverage must match.
                expect(expectedChecksThisRun).toBe(itemCount);
                // The early-break must not corrupt the per-column `columnHeights`
                // recompute, which drives the next `set()` placement.
                expect(positioner.shortestColumn()).toBe(shortestExpected);
                expectedChecks += expectedChecksThisRun;
            }
        }
        expect(itemChecks).toBe(expectedChecks);
    });

    test("a cancelled batch re-winds the delta and leaves the tail untouched", () => {
        // 1 column, 0 gap: fully deterministic. Item 2 grows by +20, item 3
        // shrinks by -20, so after row 3 the running delta is zero again and
        // rows 4.. keep their old tops.
        const positioner = buildFromHeights([100, 100, 100, 100, 100], {
            columnCount: 1,
            columnWidth: 132,
            containerWidth: 132,
            horizontalGap: 0,
            verticalGap: 0,
        });

        const tailBefore = [positioner.getTop(3)!, positioner.getTop(4)!];
        positioner.update([
            { index: 2, height: 120 },
            { index: 3, height: 80 },
        ]);

        expect(positioner.getTop(2)!).toBe(200);
        expect(positioner.getHeight(2)!).toBe(120);
        expect(positioner.getTop(3)!).toBe(320);
        expect(positioner.getTop(4)!).toBe(tailBefore[1]);
        expect(positioner.size()).toBe(5);
    });

    test("per-column early-break keeps the untouched tail when only the tail changes", () => {
        const positioner = buildFromHeights([100, 100, 100, 100, 100], {
            columnCount: 1,
            columnWidth: 132,
            containerWidth: 132,
            horizontalGap: 0,
            verticalGap: 0,
        });
        const precedingTops = [0, 1, 2, 3].map((index) => positioner.getTop(index)!);
        positioner.update([{ index: 4, height: 500 }]);
        expect([0, 1, 2, 3].map((index) => positioner.getTop(index)!)).toEqual(precedingTops);
        expect(positioner.getTop(4)!).toBe(400);
        expect(positioner.getHeight(4)!).toBe(500);
    });
});
