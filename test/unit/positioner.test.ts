import { describe, expect, test } from "bun:test";
import { parseOptions, Positioner } from "../../src/masonry.tsx";
import { buildFilled, getPlacements, getWindowRange } from "../performance/fixtures.ts";

/* The hysteresis decision must never miss a rendered-set change: skipping a
 * scroll update is only safe when the items overlapping the old and new
 * windows are exactly the same. These tests hold `isRangeInert` against the
 * actual `range()` walk for randomized layouts. */

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
    const heights = Array.from(
        { length: itemCount },
        () => minHeight + Math.floor(random() * (maxHeight - minHeight)),
    );
    return buildFilled(heights, {
        columnCount,
        columnWidth: 120,
        containerWidth: columnCount * 132,
        horizontalGap,
        verticalGap,
    });
}

function renderedIndices(positioner: Positioner, range: { start: number; end: number }) {
    const indices: number[] = [];
    positioner.range(range.start, range.end, (index) => {
        indices.push(index);
    });
    return indices.sort((a, b) => a - b);
}

function areIndicesEqual(first: number[], second: number[]) {
    return first.length === second.length && first.every((value, index) => value === second[index]);
}

function totalHeightOf(positioner: Positioner) {
    return Math.max(...getPlacements(positioner).map((p) => p.top + p.height));
}

describe("isRangeInert", () => {
    test("identical windows are always inert, even with nothing measured", () => {
        const positioner = new Positioner(parseOptions({ columnCount: 2, containerWidth: 264 }));
        const range = getWindowRange(500, 800, 1.5);
        expect(positioner.isRangeInert(range.start, range.end, range.start, range.end)).toBe(true);
    });

    test("overscan Infinity produces identical windows for any scroll", () => {
        const positioner = buildTestPositioner(createRandom(3), { columnCount: 2, itemCount: 30 });
        const previous = getWindowRange(0, 800, Infinity);
        const next = getWindowRange(5000, 800, Infinity);
        expect(previous).toEqual(next);
        expect(
            positioner.isRangeInert(previous.start, previous.end, next.start, next.end),
        ).toBe(true);
    });

    test("an empty positioner is inert for any scroll", () => {
        const positioner = new Positioner(parseOptions({ columnCount: 2, containerWidth: 264 }));
        const previous = getWindowRange(0, 800, 1.5);
        const next = getWindowRange(5000, 800, 1.5);
        expect(previous).not.toEqual(next);
        expect(positioner.isRangeInert(previous.start, previous.end, next.start, next.end)).toBe(
            true,
        );
    });

    test("a shift within the overscan margin is inert; past it re-renders", () => {
        // 1 column, 12px row gap: tops are 0, 112, 224, 336.
        const positioner = buildFilled([100, 100, 100, 100], {
            columnCount: 1,
            columnWidth: 120,
            containerWidth: 120,
            horizontalGap: 0,
            verticalGap: 12,
        });
        const rest = getWindowRange(0, 200, 0.5);
        const inert = getWindowRange(40, 200, 0.5);
        const crossing = getWindowRange(80, 200, 0.5);
        // end boundary moves 280 -> 320: no top enters (336 is still outside).
        expect(positioner.isRangeInert(rest.start, rest.end, inert.start, inert.end)).toBe(true);
        // end boundary moves 280 -> 360: the top at 336 enters the window.
        expect(positioner.isRangeInert(rest.start, rest.end, crossing.start, crossing.end)).toBe(
            false,
        );
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
            const totalHeight = totalHeightOf(positioner);
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
                    const decision = positioner.isRangeInert(
                        previous.start,
                        previous.end,
                        next.start,
                        next.end,
                    );

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

/* Measured heights are carried by item key: a reorder keeps every measurement
 * attached to its item, unknown keys fall back to the default item height, and
 * a removal re-balances the survivors from scratch. */

const KEYS_OPTIONS = parseOptions({
    columnWidth: 120,
    containerWidth: 264,
    horizontalGap: 12,
    verticalGap: 12,
});
const DEFAULT_HEIGHT = 999;

function buildMeasured(keys: (string | null)[], heights: number[]) {
    const positioner = new Positioner(KEYS_OPTIONS, DEFAULT_HEIGHT);
    positioner.syncItems([], keys);
    for (let index = 0; index < heights.length; index += 1) {
        positioner.setItemHeight(index, heights[index]);
    }
    return positioner;
}

function measuredHeights(positioner: Positioner) {
    return getPlacements(positioner).map((placement) => placement.height);
}

describe("syncItems", () => {
    test("a reorder carries every measured height onto its new index", () => {
        const positioner = buildMeasured(["a", "b", "c", "d"], [100, 200, 300, 400]);
        positioner.syncItems(["a", "b", "c", "d"], ["c", "a", "d", "b"]);
        expect(measuredHeights(positioner)).toEqual([300, 100, 400, 200]);
        // Placement is recomputed, not carried over: item "c" now leads col 0.
        expect(getPlacements(positioner)[0]).toEqual({
            column: 0,
            height: 300,
            index: 0,
            left: 0,
            row: 0,
            top: 0,
        });
    });

    test("a removal rebalances the surviving keys from their measurements", () => {
        const positioner = buildMeasured(["a", "b", "c"], [100, 200, 300]);
        positioner.syncItems(["a", "b", "c"], ["a", "c"]);
        expect(measuredHeights(positioner)).toEqual([100, 300]);
        // With a removal, columns are re-chosen by shortest first: "a" leads
        // col 0, "c" seeds col 1.
        expect(getPlacements(positioner).map((placement) => placement.column)).toEqual([0, 1]);
    });

    test("an unknown key falls back to the default height; later keys still carry", () => {
        const positioner = buildMeasured(["a", "b", "c"], [100, 200, 300]);
        positioner.syncItems(["a", "b", "c"], ["a", "x", "b", "c"]);
        expect(measuredHeights(positioner)).toEqual([100, DEFAULT_HEIGHT, 200, 300]);
    });

    test("a null key takes the default height; keys after it still carry", () => {
        const positioner = buildMeasured(["a", "b", "c"], [100, 200, 300]);
        positioner.syncItems(["a", "b", "c"], ["a", null, "c"]);
        expect(measuredHeights(positioner)).toEqual([100, DEFAULT_HEIGHT, 300]);
    });

    test("stable keyless items keep their measured heights", () => {
        const positioner = buildMeasured([null, null], [100, 200]);
        expect(positioner.syncItems([null, null], [null, null])).toBe(false);
        expect(measuredHeights(positioner)).toEqual([100, 200]);
    });

    test("appended keyless items keep the prefix heights", () => {
        const positioner = buildMeasured([null, null], [100, 200]);
        positioner.syncItems([null, null], [null, null, null]);
        expect(measuredHeights(positioner)).toEqual([100, 200, DEFAULT_HEIGHT]);
    });

    test("duplicate previous keys keep the last height", () => {
        const positioner = buildMeasured(["a", "a", "b"], [100, 200, 300]);
        positioner.syncItems(["a", "a", "b"], ["b", "a"]);
        expect(measuredHeights(positioner)).toEqual([300, 200]);
    });

    test("duplicate next keys each get their own placement", () => {
        const positioner = buildMeasured(["a", "b"], [100, 200]);
        positioner.syncItems(["a", "b"], ["a", "a", "b"]);
        expect(measuredHeights(positioner)).toEqual([100, 100, 200]);
    });

    test("appended items take the default height", () => {
        const positioner = buildMeasured(["a", "b"], [100, 200]);
        positioner.syncItems(["a", "b"], ["a", "b", "c"]);
        expect(measuredHeights(positioner)).toEqual([100, 200, DEFAULT_HEIGHT]);
    });

    test("a fully stable sync reports no change", () => {
        const positioner = buildMeasured(["a", "b", "c"], [100, 200, 300]);
        expect(positioner.syncItems(["a", "b", "c"], ["a", "b", "c"])).toBe(false);
    });

    test("a fresh positioner places every key through range()", () => {
        const positioner = new Positioner(KEYS_OPTIONS, DEFAULT_HEIGHT);
        expect(positioner.syncItems([], ["k1", "k2"])).toBe(true);
        let visited = 0;
        positioner.range(0, Number.POSITIVE_INFINITY, () => {
            visited += 1;
        });
        expect(visited).toBe(2);
        expect(positioner.tallestColumn()).toBe(DEFAULT_HEIGHT);
    });
});

describe("setOptions", () => {
    const TWO_COL_INPUT = { containerWidth: 264, columnWidth: 120, horizontalGap: 12 };

    test("equal options report no change and keep the placement", () => {
        const positioner = buildFilled([100, 100, 100, 100], TWO_COL_INPUT);
        const before = getPlacements(positioner);
        expect(positioner.setOptions(parseOptions(TWO_COL_INPUT))).toBe(false);
        expect(getPlacements(positioner)).toEqual(before);
    });

    test("a columnWidth change moves the lefts and keeps the stacking", () => {
        const positioner = buildFilled([100, 100, 100, 100], TWO_COL_INPUT);
        expect(getPlacements(positioner).map((placement) => placement.left)).toEqual([
            0, 138, 0, 138,
        ]);
        expect(positioner.setOptions(parseOptions({ containerWidth: 240, columnWidth: 120 }))).toBe(
            true,
        );
        expect(getPlacements(positioner).map((placement) => placement.left)).toEqual([
            0, 120, 0, 120,
        ]);
        expect(getPlacements(positioner).map((placement) => placement.top)).toEqual([
            0, 0, 100, 100,
        ]);
    });

    test("a columnCount change reflows all items into the new columns", () => {
        const positioner = buildFilled([100, 100, 100, 100], TWO_COL_INPUT);
        expect(
            positioner.setOptions(parseOptions({ containerWidth: 396, columnWidth: 120 })),
        ).toBe(true);
        expect(positioner.columnCount).toBe(3);
        expect(new Set(getPlacements(positioner).map((placement) => placement.left))).toEqual(
            new Set([0, 132, 264]),
        );
    });

    test("a rowGap change restacks the columns", () => {
        const positioner = buildFilled([100, 100], {
            columnCount: 1,
            columnWidth: 120,
            containerWidth: 120,
            horizontalGap: 0,
            verticalGap: 12,
        });
        expect(getPlacements(positioner).map((placement) => placement.top)).toEqual([0, 112]);
        expect(
            positioner.setOptions(
                parseOptions({
                    columnCount: 1,
                    columnWidth: 120,
                    containerWidth: 120,
                    horizontalGap: 0,
                    verticalGap: 0,
                }),
            ),
        ).toBe(true);
        expect(getPlacements(positioner).map((placement) => placement.top)).toEqual([0, 100]);
    });
});

describe("setItemHeight", () => {
    test("out-of-range indexes are ignored", () => {
        const positioner = buildFilled([100, 200], {
            containerWidth: 132,
            columnWidth: 120,
            horizontalGap: 0,
        });

        expect(positioner.setItemHeight(5, 50)).toBe(false);
        expect(positioner.setItemHeight(-1, 50)).toBe(false);
        expect(positioner.getItemHeight(0)).toBe(100);
        expect(positioner.getItemHeight(1)).toBe(200);
    });

    test("the same height is a no-op", () => {
        const positioner = buildFilled([100], { containerWidth: 132, columnWidth: 120 });
        expect(positioner.setItemHeight(0, 100)).toBe(false);
    });

    test("zero and negative heights clamp to the 1px minimum", () => {
        const positioner = buildFilled([100, 100], { containerWidth: 132, columnWidth: 120 });
        expect(positioner.setItemHeight(0, 0)).toBe(true);
        expect(positioner.setItemHeight(1, -50)).toBe(true);
        expect(positioner.getItemHeight(0)).toBe(1);
        expect(positioner.getItemHeight(1)).toBe(1);
    });

    test("restacks its column and updates the container height", () => {
        const positioner = buildFilled([100, 100], {
            columnCount: 1,
            columnWidth: 120,
            containerWidth: 120,
            horizontalGap: 0,
            verticalGap: 0,
        });
        expect(positioner.tallestColumn()).toBe(200);
        expect(positioner.setItemHeight(0, 500)).toBe(true);
        expect(positioner.tallestColumn()).toBe(600);
        expect(getPlacements(positioner).map((placement) => placement.top)).toEqual([0, 500]);
    });

    test("incremental updates reproduce a fresh build from the same heights (randomized)", () => {
        const seeds = [1, 7, 42, 1337, 2026, 987654];
        const options = { containerWidth: 396, columnWidth: 120, horizontalGap: 12 };

        for (const seed of seeds) {
            const random = createRandom(seed);
            const itemCount = 10 + Math.floor(random() * 50);
            const heights = Array.from(
                { length: itemCount },
                () => 20 + Math.floor(random() * 500),
            );
            const positioner = buildFilled(heights, options);

            const updated = [...heights];
            for (let change = 0; change < 5; change += 1) {
                const index = Math.floor(random() * itemCount);
                const height = 20 + Math.floor(random() * 500);
                updated[index] = height;
                positioner.setItemHeight(index, height);
            }

            // Height changes restack in place; they must land exactly where a
            // fresh mount with the same heights lands.
            const fresh = buildFilled(updated, options);
            expect(getPlacements(positioner)).toEqual(getPlacements(fresh));
            expect(positioner.tallestColumn()).toBe(fresh.tallestColumn());
        }
    });
});

describe("flushPending", () => {
    function stubNode(index: number | null, connected = true): Element {
        // Measurement flushes only touch getAttribute and isConnected.
        return {
            getAttribute: (name: string) =>
                name === "data-index" && index !== null ? String(index) : null,
            isConnected: connected,
        } as unknown as Element;
    }

    test("two nodes reporting the same index keep only the last height", () => {
        const positioner = buildFilled([100, 200, 300], {
            containerWidth: 408,
            columnWidth: 120,
            horizontalGap: 12,
        });
        const pending = new Map<Element, number>();
        pending.set(stubNode(1), 250);
        pending.set(stubNode(1), 400);

        expect(positioner.flushPending(pending)).toBe(true);
        expect(positioner.getItemHeight(1)).toBe(400);
        expect(pending.size).toBe(0);
    });

    test("unconnected nodes are skipped and dropped", () => {
        const positioner = buildFilled([100, 200], {
            containerWidth: 132,
            columnWidth: 120,
            horizontalGap: 0,
        });
        const pending = new Map<Element, number>([[stubNode(1, false), 400]]);

        expect(positioner.flushPending(pending)).toBe(false);
        expect(positioner.getItemHeight(1)).toBe(200);
        expect(pending.size).toBe(0);
    });

    test("a measurement out of range is dropped, not applied", () => {
        const positioner = buildFilled([100], {
            containerWidth: 132,
            columnWidth: 120,
            horizontalGap: 0,
        });
        const pending = new Map<Element, number>([[stubNode(5), 300]]);

        expect(positioner.flushPending(pending)).toBe(false);
        expect(positioner.getItemHeight(0)).toBe(100);
        expect(pending.size).toBe(0);
    });

    test("a mixed batch applies only the valid entries", () => {
        const positioner = buildFilled([100, 200], {
            containerWidth: 132,
            columnWidth: 120,
            horizontalGap: 0,
        });
        const pending = new Map<Element, number>([
            [stubNode(null), 10],
            [stubNode(5), 20],
            [stubNode(1), 220],
        ]);

        expect(positioner.flushPending(pending)).toBe(true);
        expect(positioner.getItemHeight(0)).toBe(100);
        expect(positioner.getItemHeight(1)).toBe(220);
        expect(pending.size).toBe(0);
    });

    test("an empty map reports no change", () => {
        const positioner = buildFilled([100], { containerWidth: 132, columnWidth: 120 });
        expect(positioner.flushPending(new Map())).toBe(false);
    });
});

describe("placement", () => {
    test("ties go to the first shortest column, so equal heights alternate from the left", () => {
        // 2 columns of 126px + 12px gap: stride is 138px.
        const positioner = buildFilled([100, 100, 100, 100], {
            columnCount: 2,
            columnWidth: 120,
            containerWidth: 264,
            horizontalGap: 12,
        });
        expect(getPlacements(positioner).map((placement) => placement.left)).toEqual([
            0, 138, 0, 138,
        ]);
    });

    test("columns are balanced from the heights known at sync time; measurements re-stack in place", () => {
        // At sync time every item has the default height, so items alternate
        // across columns; the measured 600px does not pull later items into
        // column 0.
        const positioner = buildFilled([100, 600, 100, 100], {
            columnCount: 2,
            columnWidth: 120,
            containerWidth: 264,
            horizontalGap: 12,
        });
        expect(getPlacements(positioner).map((placement) => placement.column)).toEqual([
            0, 1, 0, 1,
        ]);
    });
});

describe("parseOptions", () => {
    test("derives the column count from the container width", () => {
        expect(parseOptions({ containerWidth: 1600 })).toEqual({
            columnCount: 8,
            columnGap: 0,
            columnWidth: 200,
            rowGap: 0,
        });
    });

    test("an explicit columnCount wins and stretches the columns", () => {
        const options = parseOptions({
            columnCount: 2,
            containerWidth: 500,
            horizontalGap: 10,
        });
        expect(options.columnCount).toBe(2);
        expect(options.columnWidth).toBe(245);
    });

    test("maxColumnCount caps the derived count", () => {
        const options = parseOptions({ containerWidth: 1600, maxColumnCount: 3 });
        expect(options.columnCount).toBe(3);
        expect(options.columnWidth).toBe(533);
    });

    test("verticalGap defaults to horizontalGap; a zero container yields safe minimums", () => {
        expect(parseOptions({ containerWidth: 500, horizontalGap: 10 }).rowGap).toBe(10);
        expect(parseOptions({ containerWidth: 0 })).toEqual({
            columnCount: 1,
            columnGap: 0,
            columnWidth: 0,
            rowGap: 0,
        });
    });
});
