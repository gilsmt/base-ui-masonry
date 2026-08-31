import { parseOptions, Positioner } from "../src/masonry.tsx";

(Positioner.prototype as any).get = function (index: number) {
    const h = (this as any).itemHeights;
    if (index < 0 || index >= h.length) return undefined;
    const col = (this as any).itemColumns[index];
    const row = (this as any).itemRows[index];
    return {
        columnIndex: col,
        columnItemIndex: row,
        height: h[index],
        index,
        left: col * (this as any).stride,
        top: (this as any).columnTops[col][row],
    };
};

export { Positioner };

export function buildPositioner(options: any) {
    return new Positioner(parseOptions(options));
}

export function rebuildPositioner(previous: Positioner, options: any): Positioner {
    return Positioner.rebuild(previous, parseOptions(options));
}

export type WindowRange = { start: number; end: number };

export function getWindowRange(
    scrollTop: number,
    windowHeight: number,
    overscan: number,
): WindowRange {
    const overscanPixels = windowHeight > 0 ? windowHeight * overscan : 0;
    return {
        start: Math.max(0, scrollTop - overscanPixels * (1 - 0.6)),
        end: scrollTop + windowHeight + overscanPixels * 0.6,
    };
}

export function getScrollTop(measurements: Pick<any, "containerOffset" | "scrollY">) {
    return Math.max(0, measurements.scrollY - measurements.containerOffset);
}

function getItem<T>(items: readonly T[], index: number): T {
    return items[index]!;
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

export const OPTIONS_8COL: any = { containerWidth: 1600 };
export const OPTIONS_3COL: any = { containerWidth: 600 };

export function buildFilled(heights: readonly number[], options: any = OPTIONS_8COL) {
    const positioner = buildPositioner(options);
    for (let index = 0; index < heights.length; index += 1) {
        positioner.set(getItem(heights, index));
    }
    return positioner;
}

export function getColumnTops(positioner: Positioner): number[][] {
    const topsByColumn: number[][] = Array.from({ length: positioner.columnCount }, () => []);
    for (let index = 0; index < positioner.size(); index += 1) {
        const left = positioner.getLeft(index)!;
        const top = positioner.getTop(index)!;
        const col = Math.round(left / positioner.columnWidth);
        getItem(topsByColumn, col).push(top);
    }
    return topsByColumn.map((tops) => tops.sort((a, b) => a - b));
}

export const VIEWPORT_HEIGHT = 1080;
export const OVERSCAN = 1.5;

export { getItem };
