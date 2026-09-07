import { parseOptions, parseRange, Positioner } from "../../src/masonry.tsx";

type ParseOptionsInput = Parameters<typeof parseOptions>[0];

export function buildPositioner(options: ParseOptionsInput) {
    return new Positioner(parseOptions(options));
}

// Client-mount path: items sync by key with default heights, then measured
// heights land item by item. Keys are the indexes themselves; placement only
// depends on heights and order, so this reproduces any key naming.
export function buildFilled(heights: readonly number[], options: ParseOptionsInput = OPTIONS_8COL) {
    const positioner = buildPositioner(options);
    positioner.syncItems([], Array.from(heights, (_, index) => index));
    for (let index = 0; index < heights.length; index += 1) {
        positioner.setItemHeight(index, getItem(heights, index));
    }
    return positioner;
}

export interface Placement {
    column: number;
    height: number;
    index: number;
    left: number;
    row: number;
    top: number;
}

// One range walk over the whole layout, per column in visitation order.
// `row` is the item's position within its column; column identity comes from
// the visitation `left` value (equal lefts belong to the same column).
export function getPlacements(positioner: Positioner): Placement[] {
    const byIndex = new Map<number, Placement>();
    const rowsByLeft = new Map<number, number>();
    positioner.range(0, Number.POSITIVE_INFINITY, (index, left, top) => {
        const height = positioner.getItemHeight(index);
        if (height === undefined) {
            throw new Error(`getPlacements: index ${index} has no measured height`);
        }
        const row = rowsByLeft.get(left) ?? 0;
        rowsByLeft.set(left, row + 1);
        let column = 0;
        for (const seenLeft of rowsByLeft.keys()) {
            if (seenLeft === left) break;
            column += 1;
        }
        byIndex.set(index, { column, height, index, left, row, top });
    });
    return Array.from(byIndex.values()).sort((a, b) => a.index - b.index);
}

export function getColumnTops(positioner: Positioner): number[][] {
    const topsByLeft = new Map<number, number[]>();
    positioner.range(0, Number.POSITIVE_INFINITY, (_index, left, top) => {
        const tops = topsByLeft.get(left);
        if (tops) {
            tops.push(top);
        } else {
            topsByLeft.set(left, [top]);
        }
    });
    return Array.from(topsByLeft.values()).map((tops) => tops.sort((a, b) => a - b));
}

export type WindowRange = { start: number; end: number };

export function getWindowRange(
    scrollTop: number,
    windowHeight: number,
    overscan: number,
): WindowRange {
    return parseRange(scrollTop, windowHeight, overscan);
}

export function getItem<T>(items: readonly T[], index: number): T {
    if (index < 0 || index >= items.length) {
        throw new Error(`getItem: index ${index} out of bounds (length ${items.length})`);
    }
    return items[index];
}

export function mulberry32(seed: number) {
    let a = seed;
    return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export function makeHeights(count: number, seed = 42): number[] {
    const rand = mulberry32(seed);
    const gaussian = () => {
        const u = Math.max(rand(), Number.EPSILON);
        const v = rand();
        return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    };
    return Array.from({ length: count }, () =>
        Math.min(2000, Math.max(40, Math.round(Math.exp(Math.log(300) + 0.35 * gaussian())))),
    );
}

export const OPTIONS_8COL: ParseOptionsInput = { containerWidth: 1600 };
export const OPTIONS_3COL: ParseOptionsInput = { containerWidth: 600 };

export const VIEWPORT_HEIGHT = 1080;
export const OVERSCAN = 1.5;
