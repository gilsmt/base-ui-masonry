/**
 * VERBATIM copy of the "Positioner" section (plus getWindowRange/getScrollTop)
 * of src/masonry.tsx as of 2026-08-29, i.e. after scalar range/guard/getHeight
 * (#4) — findShortestColumnIndex, range(index,left,top,height), getHeight,
 * isWindowShiftInert(start,end,start,end) allocation-free.
 *
 * Copied because these internals are only partially exported from the module.
 * The only change: `warn` is stubbed as a noop; it fires only on degenerate
 * configs that benchmarks never produce. If you edit the positioner in
 * src/masonry.tsx, re-copy it here before trusting benchmark results.
 */

const DEFAULT_COLUMN_WIDTH = 200;

const DEFAULT_GAP = 0;

const MINIMUM_COLUMN_WIDTH = 1;

const DEFAULT_FORWARD_OVERSCAN = 0.6;

function warn(_message: string) {}

export type WindowRange = { start: number; end: number };

export function getWindowRange(
    scrollTop: number,
    windowHeight: number,
    overscan: number,
): WindowRange {
    const overscanPixels = windowHeight > 0 ? windowHeight * overscan : 0;
    return {
        start: Math.max(0, scrollTop - overscanPixels * (1 - DEFAULT_FORWARD_OVERSCAN)),
        end: scrollTop + windowHeight + overscanPixels * DEFAULT_FORWARD_OVERSCAN,
    };
}

export function getScrollTop(measurements: Pick<Measurements, "containerOffset" | "scrollY">) {
    return Math.max(0, measurements.scrollY - measurements.containerOffset);
}

interface PositionerItem {
    readonly columnIndex: number;
    readonly columnItemIndex: number;
    readonly height: number;
    readonly index: number;
    readonly left: number;
    readonly top: number;
}

interface PositionerUpdate {
    readonly height: number;
    readonly index: number;
}

interface PositionerOptions {
    columnCount?: number | undefined;
    columnWidth?: number;
    containerWidth: number;
    horizontalGap?: number;
    maxColumnCount?: number;
    verticalGap?: number;
}

interface Measurements {
    containerOffset: number;
    containerWidth: number;
    scrollY: number;
    windowHeight: number;
}

function getItem<T>(items: readonly T[], index: number): T {
    return items[index]!;
}

function findShortestColumnIndex(columnHeights: readonly number[]): number {
    let shortestIndex = 0;
    let shortestHeight = Number.POSITIVE_INFINITY;
    for (const [columnIndex, columnHeight] of columnHeights.entries()) {
        if (columnHeight < shortestHeight) {
            shortestHeight = columnHeight;
            shortestIndex = columnIndex;
        }
    }
    return shortestIndex;
}

function findFirstIndex(values: readonly number[], satisfies: (value: number) => boolean): number {
    let start = 0;
    let end = values.length;
    while (start < end) {
        const middle = (start + end) >>> 1;
        if (satisfies(getItem(values, middle))) {
            end = middle;
        } else {
            start = middle + 1;
        }
    }
    return start;
}

function findFirstOverlappingRow(
    tops: readonly number[],
    items: readonly number[],
    itemHeights: readonly number[],
    low: number,
): number {
    const row = findFirstIndex(tops, (top) => top >= low);
    if (row > 0) {
        const itemAbove = getItem(items, row - 1);
        if (getItem(tops, row - 1) + getItem(itemHeights, itemAbove) >= low) {
            return row - 1;
        }
    }
    return row;
}

function countFittingColumns(containerWidth: number, columnWidth: number, columnGap: number) {
    return Math.floor((containerWidth + columnGap) / (columnWidth + columnGap));
}

function parseFiniteNumber(value: number | undefined, min: number, fallback: number) {
    return typeof value === "number" && Number.isFinite(value) ? Math.max(min, value) : fallback;
}

function parsePositiveFiniteNumber(value: number | undefined, fallback: number) {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function parseMeasuredItemHeight(value: number | undefined) {
    return parsePositiveFiniteNumber(value, 1);
}

function parsePositionerOptions({
    columnCount,
    columnWidth = DEFAULT_COLUMN_WIDTH,
    containerWidth,
    horizontalGap,
    maxColumnCount = Number.POSITIVE_INFINITY,
    verticalGap,
}: PositionerOptions) {
    const normalizedContainerWidth = parsePositiveFiniteNumber(containerWidth, 0);
    const normalizedColumnWidth = parsePositiveFiniteNumber(columnWidth, DEFAULT_COLUMN_WIDTH);
    const columnGap = parseFiniteNumber(horizontalGap, 0, DEFAULT_GAP);
    const rowGap = parseFiniteNumber(verticalGap, 0, columnGap);

    const effectiveColumnWidth = Math.max(MINIMUM_COLUMN_WIDTH, normalizedColumnWidth);
    const derivedColumnCount = Math.min(
        countFittingColumns(normalizedContainerWidth, effectiveColumnWidth, columnGap),
        maxColumnCount,
    );
    const requestedColumnCount = parsePositiveFiniteNumber(columnCount, derivedColumnCount);
    const resolvedColumnCount = Math.max(1, Math.floor(requestedColumnCount));

    const resolvedColumnWidth = Math.max(
        0,
        Math.floor(
            (normalizedContainerWidth - columnGap * (resolvedColumnCount - 1)) /
                resolvedColumnCount,
        ),
    );

    if (resolvedColumnWidth === 0 && normalizedContainerWidth > 0) {
        warn(
            "MasonryRoot: `columnCount` exceeds the container space, collapsing columns to zero width and overlapping items. Increase the container width, reduce `columnCount`, or lower the horizontal gap.",
        );
    }

    return {
        columnCount: resolvedColumnCount,
        columnGap,
        columnWidth: resolvedColumnWidth,
        rowGap,
    };
}

function areResolvedOptionsEqual(
    a: ReturnType<typeof parsePositionerOptions>,
    b: ReturnType<typeof parsePositionerOptions>,
) {
    return (
        a.columnCount === b.columnCount &&
        a.columnGap === b.columnGap &&
        a.columnWidth === b.columnWidth &&
        a.rowGap === b.rowGap
    );
}
void areResolvedOptionsEqual;

export function buildPositioner(options: PositionerOptions) {
    const { columnCount, columnGap, columnWidth, rowGap } = parsePositionerOptions(options);

    const stride = columnWidth + columnGap;

    const columns: number[][] = Array.from({ length: columnCount }, () => []);
    const columnTops: number[][] = Array.from({ length: columnCount }, () => []);
    const columnHeights: number[] = Array.from({ length: columnCount }, () => 0);
    const itemColumns: number[] = [];
    const itemRows: number[] = [];
    const itemHeights: number[] = [];

    function createPlacement(index: number): PositionerItem {
        const columnIndex = getItem(itemColumns, index);
        const row = getItem(itemRows, index);
        return {
            columnIndex,
            columnItemIndex: row,
            height: getItem(itemHeights, index),
            index,
            left: columnIndex * stride,
            top: getItem(getItem(columnTops, columnIndex), row),
        };
    }

    function estimateHeight(itemCount: number, defaultItemHeight: number) {
        const tallestColumn = Math.max(...columnHeights);
        const remainingItemCount = Math.max(0, itemCount - itemHeights.length);
        const remainingRowCount = Math.ceil(remainingItemCount / columnCount);
        const leadingGap = itemHeights.length > 0 && remainingRowCount > 0 ? rowGap : 0;
        const meanColumnHeight =
            columnHeights.reduce((sum, columnHeight) => sum + columnHeight, 0) / columnCount;
        const remainingHeight =
            leadingGap +
            remainingRowCount * defaultItemHeight +
            Math.max(0, remainingRowCount - 1) * rowGap;
        return Math.max(tallestColumn, meanColumnHeight + remainingHeight);
    }

    function get(index: number) {
        return index >= 0 && index < itemHeights.length ? createPlacement(index) : undefined;
    }

    function getHeight(index: number): number | undefined {
        return itemHeights[index];
    }

    function getTop(index: number): number | undefined {
        const col = getItem(itemColumns, index);
        if (col === undefined) return undefined;
        const row = getItem(itemRows, index);
        return getItem(getItem(columnTops, col), row);
    }

    function getLeft(index: number): number | undefined {
        const col = getItem(itemColumns, index);
        if (col === undefined) return undefined;
        return col * stride;
    }

    function range(
        low: number,
        high: number,
        visitItem: (index: number, left: number, top: number, height: number) => void,
    ) {
        for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
            const columnItems = getItem(columns, columnIndex);
            const tops = getItem(columnTops, columnIndex);
            for (
                let row = findFirstOverlappingRow(tops, columnItems, itemHeights, low);
                row < columnItems.length;
                row += 1
            ) {
                if (getItem(tops, row) > high) {
                    break;
                }
                const idx = getItem(columnItems, row);
                visitItem(idx, columnIndex * stride, getItem(tops, row), getItem(itemHeights, idx));
            }
        }
    }

    function set(height: number) {
        const itemHeight = parseMeasuredItemHeight(height);
        const columnIndex = findShortestColumnIndex(columnHeights);
        const columnItems = getItem(columns, columnIndex);
        const top = columnItems.length > 0 ? getItem(columnHeights, columnIndex) + rowGap : 0;
        itemColumns.push(columnIndex);
        itemRows.push(columnItems.length);
        itemHeights.push(itemHeight);
        columnItems.push(itemHeights.length - 1);
        getItem(columnTops, columnIndex).push(top);
        columnHeights[columnIndex] = top + itemHeight;
    }

    function shortestColumn() {
        return getItem(columnHeights, findShortestColumnIndex(columnHeights)) ?? 0;
    }

    function size() {
        return itemHeights.length;
    }

    function isWindowShiftInert(
        prevStart: number,
        prevEnd: number,
        nextStart: number,
        nextEnd: number,
    ): boolean {
        if (prevStart === nextStart && prevEnd === nextEnd) {
            return true;
        }
        if (size() === 0 || !(shortestColumn() >= nextEnd)) {
            return false;
        }
        for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
            const tops = getItem(columnTops, columnIndex);
            const columnItems = getItem(columns, columnIndex);
            const row = findFirstOverlappingRow(tops, columnItems, itemHeights, prevStart);
            if (
                row !== findFirstOverlappingRow(tops, columnItems, itemHeights, nextStart) ||
                findFirstIndex(tops, (top) => top > prevEnd) !==
                    findFirstIndex(tops, (top) => top > nextEnd)
            ) {
                return false;
            }
        }
        return true;
    }

    function update(updates: readonly PositionerUpdate[]) {
        const firstChangedRows: number[] = new Array(columnCount).fill(-1);
        const lastChangedRows: number[] = new Array(columnCount).fill(-1);
        for (const { index, height } of updates) {
            const itemHeight = parseMeasuredItemHeight(height);
            if (getItem(itemHeights, index) === itemHeight) {
                continue;
            }
            itemHeights[index] = itemHeight;
            const columnIndex = getItem(itemColumns, index);
            const row = getItem(itemRows, index);
            const firstChangedRow = getItem(firstChangedRows, columnIndex);
            if (firstChangedRow < 0 || row < firstChangedRow) {
                firstChangedRows[columnIndex] = row;
            }
            if (row > getItem(lastChangedRows, columnIndex)) {
                lastChangedRows[columnIndex] = row;
            }
        }
        for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
            const startRow = getItem(firstChangedRows, columnIndex);
            if (startRow < 0) {
                continue;
            }
            const columnItems = getItem(columns, columnIndex);
            const tops = getItem(columnTops, columnIndex);
            const lastChangedRow = Math.max(startRow, getItem(lastChangedRows, columnIndex));
            let top = getItem(tops, startRow);
            for (let row = startRow; row < columnItems.length; row += 1) {
                if (row > lastChangedRow && getItem(tops, row) === top) {
                    break;
                }
                tops[row] = top;
                top += getItem(itemHeights, getItem(columnItems, row)) + rowGap;
            }
            const lastRow = columnItems.length - 1;
            columnHeights[columnIndex] =
                getItem(tops, lastRow) + getItem(itemHeights, getItem(columnItems, lastRow));
        }
    }

    return {
        columnCount,
        columnWidth,
        estimateHeight,
        get,
        getHeight,
        getLeft,
        getTop,
        isWindowShiftInert,
        range,
        set,
        shortestColumn,
        size,
        update,
    };
}

type Positioner = ReturnType<typeof buildPositioner>;

function rebuildPositioner(previousPositioner: Positioner, options: PositionerOptions): Positioner {
    const nextPositioner = buildPositioner(options);
    const measuredItemCount = previousPositioner.size();
    for (let index = 0; index < measuredItemCount; index += 1) {
        const height = previousPositioner.getHeight(index);
        if (height !== undefined) {
            nextPositioner.set(height);
        }
    }
    return nextPositioner;
}

/* -------------------------------------- Fixtures ------------------------------------- */

/** Seeded PRNG so every variant measures identical data. */
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

/** Lognormal-ish item heights, mean ~300px — typical card/media content. */
export function makeHeights(count: number, seed = 42): number[] {
    const rand = mulberry32(seed);
    const gaussian = () => {
        // Box-Muller
        const u = Math.max(rand(), Number.EPSILON);
        const v = rand();
        return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    };
    return Array.from({ length: count }, () =>
        Math.min(2000, Math.max(40, Math.round(Math.exp(Math.log(300) + 0.35 * gaussian())))),
    );
}

/** 1600px container at the 200px default column width -> 8 columns. */
export const OPTIONS_8COL: PositionerOptions = { containerWidth: 1600 };
export const OPTIONS_3COL: PositionerOptions = { containerWidth: 600 };

export function buildFilled(heights: readonly number[], options: PositionerOptions = OPTIONS_8COL) {
    const positioner = buildPositioner(options);
    for (let index = 0; index < heights.length; index += 1) {
        positioner.set(getItem(heights, index));
    }
    return positioner;
}

/** Per-column item tops (setup helper for constructing boundary cases). */
export function getColumnTops(positioner: Positioner): number[][] {
    const topsByColumn: number[][] = Array.from({ length: positioner.columnCount }, () => []);
    for (let index = 0; index < positioner.size(); index += 1) {
        const item = positioner.get(index)!;
        getItem(topsByColumn, item.columnIndex).push(item.top);
    }
    return topsByColumn.map((tops) => tops.sort((a, b) => a - b));
}

/* ------------------------------------- Constants ------------------------------------- */

/** Default viewport 1080p, overscan 1.5 => ~2.7 windows worth of pixels. */
export const VIEWPORT_HEIGHT = 1080;
export const OVERSCAN = 1.5;

/* Re-exports for benchmark files (does not alter the verbatim copy above). */
export { getItem, rebuildPositioner };
