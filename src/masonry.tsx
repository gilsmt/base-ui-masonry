"use client";

import type { BaseUIComponentProps } from "@base-ui/react/internals/types";
import { useRenderElement } from "@base-ui/react/internals/useRenderElement";
import { addEventListener } from "@base-ui/utils/addEventListener";
import { mergeCleanups } from "@base-ui/utils/mergeCleanups";
import { ownerDocument, ownerWindow } from "@base-ui/utils/owner";
import { useAnimationFrame } from "@base-ui/utils/useAnimationFrame";
import { useForcedRerendering } from "@base-ui/utils/useForcedRerendering";
import { useIsoLayoutEffect } from "@base-ui/utils/useIsoLayoutEffect";
import { useMergedRefs } from "@base-ui/utils/useMergedRefs";
import { useRefWithInit } from "@base-ui/utils/useRefWithInit";
import { useStableCallback } from "@base-ui/utils/useStableCallback";
import { useValueAsRef } from "@base-ui/utils/useValueAsRef";
import { warn } from "@base-ui/utils/warn";
import * as React from "react";
import { flushSync } from "react-dom";

const DEFAULT_COLUMN_WIDTH = 200;

const DEFAULT_GAP = 0;

const DEFAULT_ITEM_HEIGHT = 300;

const DEFAULT_OVERSCAN = 1.5;

const DEFAULT_FORWARD_OVERSCAN = 0.6;

const MINIMUM_COLUMN_WIDTH = 1;

const MasonryDataAttributes = {
    /**
     * Indicates the index of the masonry item. Always present.
     * @type {number}
     */
    index: "data-index",
    /**
     * Identifies the masonry component slot. Always present.
     * @type {string}
     */
    slot: "data-slot",
} as const;

/* ------------------------------------ Shared utils ----------------------------------- */

function getNodeDataIndex(node: Element): number | null {
    const attr = node.getAttribute(MasonryDataAttributes.index);
    if (!attr) {
        throw new Error(`MasonryRoot node ${node} does not have a data-index attribute`);
    }
    const index = Number(attr);
    return index >>> 0 === index ? index : null;
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

function parseGapDirectionalValues(gap: number | { horizontal: number; vertical: number }) {
    if (gap && typeof gap === "object") {
        return {
            horizontalGap: gap.horizontal,
            verticalGap: gap.vertical,
        };
    }
    return { horizontalGap: gap, verticalGap: gap };
}

interface WindowRange {
    start: number;
    end: number;
}

export function getWindowRange(scrollY: number, viewHeight: number, overscan: number): WindowRange {
    const overscanPixels = viewHeight > 0 ? viewHeight * overscan : 0;
    return {
        start: Math.max(0, scrollY - overscanPixels * (1 - DEFAULT_FORWARD_OVERSCAN)),
        end: scrollY + viewHeight + overscanPixels * DEFAULT_FORWARD_OVERSCAN,
    };
}

function getScrollTop(measurements: Measurements) {
    return Math.max(0, measurements.scrollY - measurements.containerOffset);
}

/* ------------------------------------- Positioner ------------------------------------ */

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

function findShortestColumn(columnHeights: readonly number[]): { height: number; index: number } {
    let shortestIndex = 0;
    let shortestHeight = Number.POSITIVE_INFINITY;
    for (const [columnIndex, columnHeight] of columnHeights.entries()) {
        if (columnHeight < shortestHeight) {
            shortestHeight = columnHeight;
            shortestIndex = columnIndex;
        }
    }
    return { height: shortestHeight, index: shortestIndex };
}

function findFirstIndex(values: readonly number[], target: number, inclusive: boolean): number {
    let start = 0;
    let end = values.length;
    while (start < end) {
        const middle = (start + end) >>> 1;
        if (inclusive ? values[middle] >= target : values[middle] > target) {
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
    const row = findFirstIndex(tops, low, true);
    if (row > 0) {
        const itemAbove = items[row - 1];
        if (tops[row - 1] + itemHeights[itemAbove] >= low) {
            return row - 1;
        }
    }
    return row;
}

function countFittingColumns(containerWidth: number, columnWidth: number, columnGap: number) {
    return Math.floor((containerWidth + columnGap) / (columnWidth + columnGap));
}

function parsePositionerOptions({
    columnCount,
    columnWidth: preferredWidth = DEFAULT_COLUMN_WIDTH,
    containerWidth,
    horizontalGap,
    maxColumnCount = Number.POSITIVE_INFINITY,
    verticalGap,
}: PositionerOptions) {
    const width = parsePositiveFiniteNumber(containerWidth, 0);
    const rawItemWidth = parsePositiveFiniteNumber(preferredWidth, DEFAULT_COLUMN_WIDTH);
    const columnGap = parseFiniteNumber(horizontalGap, 0, DEFAULT_GAP);
    const rowGap = parseFiniteNumber(verticalGap, 0, columnGap);

    const itemWidth = Math.max(MINIMUM_COLUMN_WIDTH, rawItemWidth);
    const requested = parsePositiveFiniteNumber(
        columnCount,
        Math.min(countFittingColumns(width, itemWidth, columnGap), maxColumnCount),
    );
    const count = Math.max(1, Math.floor(requested));
    const columnWidth = Math.max(0, Math.floor((width - columnGap * (count - 1)) / count));

    if (columnWidth === 0 && width > 0) {
        warn(
            "MasonryRoot: `columnCount` exceeds the container space, collapsing columns to zero width and overlapping items. Increase the container width, reduce `columnCount`, or lower the horizontal gap.",
        );
    }

    return { columnCount: count, columnGap, columnWidth, rowGap };
}

type ResolvedPositionerOptions = ReturnType<typeof parsePositionerOptions>;

function areOptionsEqual(previous: ResolvedPositionerOptions, next: ResolvedPositionerOptions) {
    return (
        previous.columnCount === next.columnCount &&
        previous.columnGap === next.columnGap &&
        previous.columnWidth === next.columnWidth &&
        previous.rowGap === next.rowGap
    );
}

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
        const columnIndex = itemColumns[index];
        const row = itemRows[index];
        return {
            columnIndex,
            columnItemIndex: row,
            height: itemHeights[index],
            index,
            left: columnIndex * stride,
            top: columnTops[columnIndex][row],
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

    function range(low: number, high: number, visitItem: (item: PositionerItem) => void) {
        for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
            const columnItems = columns[columnIndex];
            const tops = columnTops[columnIndex];
            for (
                let row = findFirstOverlappingRow(tops, columnItems, itemHeights, low);
                row < columnItems.length;
                row += 1
            ) {
                if (tops[row] > high) {
                    break;
                }
                visitItem(createPlacement(columnItems[row]));
            }
        }
    }

    function set(height: number) {
        const itemHeight = parseMeasuredItemHeight(height);
        const columnIndex = findShortestColumn(columnHeights).index;
        const columnItems = columns[columnIndex];
        const top = columnItems.length > 0 ? columnHeights[columnIndex] + rowGap : 0;
        itemColumns.push(columnIndex);
        itemRows.push(columnItems.length);
        itemHeights.push(itemHeight);
        columnItems.push(itemHeights.length - 1);
        columnTops[columnIndex].push(top);
        columnHeights[columnIndex] = top + itemHeight;
    }

    function shortestColumn() {
        return findShortestColumn(columnHeights).height;
    }

    function size() {
        return itemHeights.length;
    }

    function isWindowShiftInert(previous: WindowRange, next: WindowRange) {
        if (previous.start === next.start && previous.end === next.end) {
            return true;
        }
        if (size() === 0 || shortestColumn() < next.end) {
            return false;
        }
        for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
            const tops = columnTops[columnIndex];
            const columnItems = columns[columnIndex];
            if (
                findFirstOverlappingRow(tops, columnItems, itemHeights, previous.start) !==
                    findFirstOverlappingRow(tops, columnItems, itemHeights, next.start) ||
                findFirstIndex(tops, previous.end, false) !== findFirstIndex(tops, next.end, false)
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
            if (itemHeights[index] === itemHeight) {
                continue;
            }
            itemHeights[index] = itemHeight;
            const columnIndex = itemColumns[index];
            const row = itemRows[index];
            const current = firstChangedRows[columnIndex];
            if (current < 0 || row < current) {
                firstChangedRows[columnIndex] = row;
            }
            if (row > lastChangedRows[columnIndex]) {
                lastChangedRows[columnIndex] = row;
            }
        }
        for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
            const startRow = firstChangedRows[columnIndex];
            if (startRow < 0) {
                continue;
            }
            const columnItems = columns[columnIndex];
            const tops = columnTops[columnIndex];
            const lastChangedRow = lastChangedRows[columnIndex];
            let top = tops[startRow];
            for (let row = startRow; row < columnItems.length; row += 1) {
                if (row > lastChangedRow && tops[row] === top) {
                    break;
                }
                tops[row] = top;
                top += itemHeights[columnItems[row]] + rowGap;
            }
            const lastRow = columnItems.length - 1;
            columnHeights[columnIndex] = tops[lastRow] + itemHeights[columnItems[lastRow]];
        }
    }

    return {
        columnCount,
        columnWidth,
        estimateHeight,
        get,
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
        const item = previousPositioner.get(index);
        if (item) {
            nextPositioner.set(item.height);
        }
    }
    return nextPositioner;
}

/* --------------------------------- Measurements --------------------------------- */

function useItemResizeObserver(
    callbackFn: (index: number, node: Element, height: number) => void,
): ResizeObserver | null {
    const resizeObserver = useRefWithInit(() => {
        if (typeof ResizeObserver !== "function") {
            return null;
        }

        function handleResizeObserver(entries: ResizeObserverEntry[]) {
            for (const entry of entries) {
                const attrIndex = getNodeDataIndex(entry.target);
                if (attrIndex === null) {
                    continue;
                }
                callbackFn(attrIndex, entry.target, entry.borderBoxSize[0].blockSize);
            }
        }

        return new ResizeObserver(handleResizeObserver);
    }).current;

    useIsoLayoutEffect(() => () => resizeObserver?.disconnect(), [resizeObserver]);

    return resizeObserver;
}

export interface Measurements {
    containerOffset: number;
    containerWidth: number;
    scrollY: number;
    windowHeight: number;
}

const DEFAULT_MEASUREMENTS: Measurements = {
    containerOffset: 0,
    containerWidth: 0,
    scrollY: 0,
    windowHeight: 0,
};

function canSkipUpdate(
    committed: Measurements,
    next: Measurements,
    skipUpdatePredicate?: (committed: Measurements, next: Measurements) => boolean,
): boolean {
    const sameOffset = next.containerOffset === committed.containerOffset;
    const sameWidth = next.containerWidth === committed.containerWidth;
    const sameHeight = next.windowHeight === committed.windowHeight;
    if (sameOffset && sameWidth && sameHeight && next.scrollY === committed.scrollY) {
        return true; // unchanged, nothing to paint
    }
    if (sameOffset && sameWidth && sameHeight) {
        return !!skipUpdatePredicate?.(committed, next); // scroll-only: hysteresis decides
    }
    return false; // layout changed, commit
}

function useMeasurements(
    containerRef: React.RefObject<HTMLDivElement | null>,
    scrollElement: HTMLElement | null,
    skipUpdatePredicate?: (committed: Measurements, next: Measurements) => boolean,
    onSyncPrepare?: () => boolean,
    onExternalLayoutChange?: () => void,
) {
    const animationFrame = useAnimationFrame();
    const [measurements, setMeasurements] = React.useState<Measurements>(DEFAULT_MEASUREMENTS);
    const measurementsRef = useValueAsRef(measurements);
    const isDirtyRef = React.useRef(true);
    const prevScrollElementRef = React.useRef(scrollElement);
    if (prevScrollElementRef.current !== scrollElement) {
        isDirtyRef.current = true;
        prevScrollElementRef.current = scrollElement;
    }

    const sync = useStableCallback(() => {
        const didMutateLayout = onSyncPrepare ? onSyncPrepare() : false;

        const container = containerRef.current;
        if (!container) {
            return;
        }

        const previous = measurementsRef.current;
        const win = ownerWindow(container);
        const scrollY = scrollElement ? scrollElement.scrollTop : win.scrollY;
        let nextMeasurements: Measurements | null = null;

        if (!isDirtyRef.current) {
            const next: Measurements = {
                containerOffset: previous.containerOffset,
                containerWidth: previous.containerWidth,
                scrollY,
                windowHeight: previous.windowHeight,
            };
            if (!canSkipUpdate(previous, next, skipUpdatePredicate)) {
                nextMeasurements = next;
            }
        } else {
            isDirtyRef.current = false;

            const containerRect = container.getBoundingClientRect();
            const scrollOriginOffset = scrollElement
                ? scrollElement.getBoundingClientRect().top + scrollElement.clientTop
                : 0;
            const next: Measurements = {
                containerOffset: containerRect.top - scrollOriginOffset + scrollY,
                containerWidth: container.clientWidth,
                scrollY,
                windowHeight: scrollElement
                    ? scrollElement.clientHeight
                    : ownerDocument(container).documentElement.clientHeight,
            };

            if (!canSkipUpdate(previous, next, skipUpdatePredicate)) {
                nextMeasurements = next;
            }
        }

        if (nextMeasurements !== null || didMutateLayout) {
            // One synchronous, pre-paint commit per frame
            flushSync(() => {
                if (nextMeasurements !== null) {
                    setMeasurements(nextMeasurements);
                }
                if (didMutateLayout) {
                    onExternalLayoutChange?.();
                }
            });
        }
    });

    const scheduleSync = useStableCallback(() => {
        isDirtyRef.current = true;
        animationFrame.request(sync);
    });

    const requestSync = useStableCallback(() => {
        animationFrame.request(sync);
    });

    useIsoLayoutEffect(() => {
        const container = containerRef.current;
        if (!container) {
            return;
        }

        scheduleSync();

        const resizeObserver =
            typeof ResizeObserver === "function" ? new ResizeObserver(scheduleSync) : null;

        if (resizeObserver) {
            resizeObserver.observe(container);
            if (scrollElement) {
                resizeObserver.observe(scrollElement);
            }
            resizeObserver.observe(ownerDocument(container).body);
        }

        const win = ownerWindow(container);
        return mergeCleanups(
            addEventListener(scrollElement ?? win, "scroll", requestSync, { passive: true }),
            addEventListener(win, "resize", scheduleSync),
            addEventListener(win, "orientationchange", scheduleSync),
            win.visualViewport
                ? addEventListener(win.visualViewport, "resize", scheduleSync)
                : null,
            resizeObserver ? () => resizeObserver.disconnect() : null,
        );
    }, [containerRef, scheduleSync, scrollElement]);

    return {
        containerWidth: measurements.containerWidth,
        scheduleSync,
        requestSync,
        scrollTop: getScrollTop(measurements),
        windowHeight: measurements.windowHeight,
    };
}

/* ----------------------- Binding: slots and measurement flow ----------------------- */

interface MasonryItemSlotProps
    extends React.HTMLAttributes<HTMLDivElement>, React.RefAttributes<HTMLDivElement> {
    [MasonryDataAttributes.index]?: number;
}

interface MasonrySlotAttributes extends MasonryItemSlotProps {
    [MasonryDataAttributes.slot]: string;
}

interface PendingItemMeasurement {
    height: number;
    node: Element;
}

export interface ItemSlotProps {
    child: React.ReactElement<MasonryItemSlotProps>;
    width: number;
    index: number;
    inert: boolean;
    itemCount: number;
    item: PositionerItem | null;
    register: (index: number, node: HTMLElement) => (() => void) | undefined;
    resetKey: number;
}

function isMasonryChildElement(
    node: React.ReactNode,
): node is React.ReactElement<MasonryItemSlotProps> {
    return React.isValidElement(node) && node.type !== React.Fragment;
}

export function arePlacementsEqual(previous: PositionerItem | null, next: PositionerItem | null) {
    if (previous === null || next === null) {
        return previous === next;
    }
    return (
        previous.left === next.left && previous.top === next.top && previous.height === next.height
    );
}

export function areItemSlotPropsEqual(previous: ItemSlotProps, next: ItemSlotProps): boolean {
    return (
        arePlacementsEqual(previous.item, next.item) &&
        previous.child === next.child &&
        previous.width === next.width &&
        previous.index === next.index &&
        previous.inert === next.inert &&
        previous.itemCount === next.itemCount &&
        previous.register === next.register &&
        previous.resetKey === next.resetKey
    );
}

export const ItemSlot = React.memo(function ItemSlot({
    child,
    width,
    index,
    inert,
    itemCount,
    item,
    register,
    resetKey,
}: ItemSlotProps): React.ReactElement {
    const registerNode = React.useCallback(
        (node: HTMLDivElement | null) => {
            void resetKey; // read deliberately so callback keeps the dep
            if (node === null) {
                return undefined;
            }
            return register(index, node);
        },
        [index, register, resetKey],
    );
    const mergedRefs = useMergedRefs(registerNode, child.props.ref);

    const style: React.CSSProperties = {
        position: "absolute",
        width,
        writingMode: "horizontal-tb",
        left: 0,
        top: 0,
        ...(item
            ? {
                  contentVisibility: "auto",
                  containIntrinsicHeight: `auto ${item.height}px`,
                  transform: `translateX(${item.left}px) translateY(${item.top}px)`,
              }
            : { visibility: "hidden" }),
    };

    return React.cloneElement(child, {
        [MasonryDataAttributes.index]: index,
        ref: mergedRefs,
        "aria-posinset": index + 1,
        "aria-setsize": itemCount,
        ...(inert && { inert }),
        style: { ...style, ...child.props.style },
    });
}, areItemSlotPropsEqual);

export function commitPendingMeasurements(
    positioner: Positioner,
    pendingMeasurements: Map<number, PendingItemMeasurement>,
): boolean {
    const updates: PositionerUpdate[] = [];
    let didChange = false;

    const indices = Array.from(pendingMeasurements.keys()).sort((a, b) => a - b);
    for (const index of indices) {
        const measurement = pendingMeasurements.get(index);
        if (!measurement?.node.isConnected || getNodeDataIndex(measurement.node) !== index) {
            pendingMeasurements.delete(index);
            continue;
        }

        const item = positioner.get(index);
        if (item === undefined) {
            if (index !== positioner.size()) {
                continue;
            }
            positioner.set(measurement.height);
            pendingMeasurements.delete(index);
            didChange = true;
        } else if (item.height !== measurement.height) {
            updates.push({ height: measurement.height, index });
            pendingMeasurements.delete(index);
            didChange = true;
        } else {
            pendingMeasurements.delete(index);
        }
    }

    if (updates.length > 0) {
        positioner.update(updates);
        didChange = true;
    }

    return didChange;
}

type Keys = readonly (React.Key | null)[];

function areKeysAppendOnly(previous: Keys, next: Keys) {
    return (
        previous === next ||
        (previous.length <= next.length && previous.every((key, index) => key === next[index]))
    );
}

export interface MasonryRootState {
    /**
     * Whether unmeasured items are still being batched into the layout.
     */
    measuring: boolean;
}

export interface MasonryRootProps extends BaseUIComponentProps<"div", MasonryRootState> {
    /** Fixed number of columns. Ignored when unset or non-positive; column count is derived from `columnWidth` and the container width. */
    columnCount?: number;
    /**
     * Preferred column width used to derive the column count (unless `columnCount` is
     * set). Items always stretch to fill their column. @default 200
     */
    columnWidth?: number;
    /**
     * Gap between columns and rows, or directional gaps as an object. When an
     * object is provided, `vertical` defaults to `horizontal`.
     * @default 0
     */
    gap?: number | { horizontal: number; vertical: number };
    /**
     * Assumed average item height for container-height and batch-size estimates while
     * items are still being measured. @default 300
     */
    itemHeight?: number;
    /**
     * Cap on columns derived from `columnWidth`; non-finite/non-positive means uncapped.
     * @default Infinity
     */
    maxColumnCount?: number;
    /**
     * Viewport-height multiplier controlling how far beyond the visible area items are
     * rendered/unmeasured items are batched. The margin is larger ahead of the scroll
     * direction than behind it. `Infinity` disables windowing and renders every item.
     * @default 1.5
     */
    overscan?: number;
    /**
     * Scroll container element whose scroll position drives windowing. Pass the
     * element that actually scrolls when the masonry sits inside an overflow
     * container. @default window
     */
    container?: HTMLElement | null;
}

/**
 * Groups all parts of the masonry layout.
 * Renders a `<div>` element.
 */
export function MasonryRoot(componentProps: MasonryRootProps): React.ReactElement {
    const {
        children,
        columnCount,
        columnWidth = DEFAULT_COLUMN_WIDTH,
        gap = DEFAULT_GAP,
        itemHeight: rawItemHeight = DEFAULT_ITEM_HEIGHT,
        maxColumnCount: maxColumnCountProp,
        overscan: overscanProp = DEFAULT_OVERSCAN,
        container = null,
        className,
        render,
        style,
        ...elementProps
    } = componentProps;

    const containerRef = React.useRef<HTMLDivElement | null>(null);
    const rerender = useForcedRerendering();

    const { horizontalGap, verticalGap } = parseGapDirectionalValues(gap);
    const itemAvg = parseFiniteNumber(rawItemHeight, 1, DEFAULT_ITEM_HEIGHT);
    const maxColumnCount = parsePositiveFiniteNumber(maxColumnCountProp, Number.POSITIVE_INFINITY);

    const overscanValue =
        overscanProp === Infinity
            ? overscanProp
            : parseFiniteNumber(overscanProp, 0, DEFAULT_OVERSCAN);
    const overscanRef = useValueAsRef(overscanValue);

    const isScrollUpdateRedundant = useStableCallback((prev: Measurements, next: Measurements) =>
        positionerRef.current.isWindowShiftInert(
            getWindowRange(getScrollTop(prev), prev.windowHeight, overscanRef.current),
            getWindowRange(getScrollTop(next), next.windowHeight, overscanRef.current),
        ),
    );

    const commit = useStableCallback(() =>
        commitPendingMeasurements(positionerRef.current, pendingRef.current),
    );

    const { containerWidth, scheduleSync, requestSync, scrollTop, windowHeight } = useMeasurements(
        containerRef,
        container,
        isScrollUpdateRedundant,
        commit,
        rerender,
    );

    const latestOptions: PositionerOptions = React.useMemo(
        () => ({
            columnCount,
            columnWidth,
            containerWidth,
            horizontalGap,
            maxColumnCount,
            verticalGap,
        }),
        [columnCount, columnWidth, containerWidth, horizontalGap, maxColumnCount, verticalGap],
    );
    const currentOptions = parsePositionerOptions(latestOptions);
    const rowGap = currentOptions.rowGap;

    const resetKeyRef = useRefWithInit(() => ({ value: 0 }));
    const positionerRef = useRefWithInit(() => buildPositioner(latestOptions));
    const optionsRef = useRefWithInit(() => currentOptions);
    const keysRef = React.useRef<readonly (React.Key | null)[] | null>(null);
    const pendingRef = useRefWithInit(() => new Map<number, PendingItemMeasurement>());
    const positioner = positionerRef.current;

    // React.Children.toArray is opaque to the React Compiler,
    // so memoize manually to keep both arrays stable
    const validChildren = React.useMemo(
        () => React.Children.toArray(children).filter(isMasonryChildElement),
        [children],
    );
    const keys = React.useMemo(() => validChildren.map((child) => child.key), [validChildren]);
    const itemCount = validChildren.length;

    const queueMeasurementCommit = useStableCallback(
        (index: number, node: Element, height: number) => {
            pendingRef.current.set(index, { height, node });
            requestSync(); // Item-height events never flag DOM geometry dirty
        },
    );

    const resizeObserver = useItemResizeObserver(queueMeasurementCommit);

    const registerItemNode = useStableCallback((index: number, node: HTMLElement) => {
        if (resizeObserver) {
            resizeObserver.observe(node);
        } else {
            queueMeasurementCommit(index, node, node.getBoundingClientRect().height);
        }
        return () => {
            resizeObserver?.unobserve(node);
            if (pendingRef.current.get(index)?.node === node) {
                pendingRef.current.delete(index);
            }
        };
    });

    useIsoLayoutEffect(() => {
        const committedKeys = keysRef.current;
        const shouldReset = committedKeys !== null && !areKeysAppendOnly(committedKeys, keys);

        const prevOptions = optionsRef.current;
        const shouldRebuild = !shouldReset && !areOptionsEqual(prevOptions, currentOptions);

        keysRef.current = keys;
        optionsRef.current = currentOptions;

        if (shouldReset || shouldRebuild) {
            let nextPositioner: Positioner;
            if (shouldReset) {
                warn(
                    "MasonryRoot: item keys changed by more than appending (reorder, insertion, or removal). The layout was rebuilt from mounted items; provide stable `key`s to keep reordering cheap.",
                );
                pendingRef.current.clear();
                resetKeyRef.current.value += 1;
                nextPositioner = buildPositioner(latestOptions);
            } else {
                nextPositioner = rebuildPositioner(positionerRef.current, latestOptions);
            }

            positionerRef.current = nextPositioner;
            rerender();
            scheduleSync();
        }
    }, [keys, itemCount, latestOptions, currentOptions, rerender, scheduleSync]);

    const unmeasuredStart = positioner.size();
    const minCol = positioner.shortestColumn();
    const { start: rangeStart, end: rangeEnd } = getWindowRange(
        scrollTop,
        windowHeight,
        overscanValue,
    );

    const windowNeedsMoreItems = unmeasuredStart === 0 || minCol < rangeEnd;
    const isLayoutOutdated = windowNeedsMoreItems && unmeasuredStart < itemCount;

    const positionedChildren: React.ReactElement[] = [];

    const appendSlot = (index: number, item: PositionerItem | null, inert = false) => {
        const child = validChildren[index];
        if (!child) {
            return;
        }
        positionedChildren.push(
            <ItemSlot
                key={child.key}
                child={child}
                width={positioner.columnWidth}
                index={index}
                inert={inert}
                itemCount={itemCount}
                item={item}
                register={registerItemNode}
                resetKey={resetKeyRef.current.value}
            />,
        );
    };

    positioner.range(rangeStart, rangeEnd, (item) => {
        appendSlot(item.index, item);
    });

    if (isLayoutOutdated) {
        const batchSize = Math.min(
            itemCount - unmeasuredStart,
            Math.max(
                unmeasuredStart === 0 ? positioner.columnCount : 0,
                Math.ceil(((rangeEnd - minCol) / (itemAvg + rowGap)) * positioner.columnCount),
            ),
        );
        if (batchSize > 0) {
            const end = unmeasuredStart + batchSize;
            for (let index = unmeasuredStart; index < end; index += 1) {
                appendSlot(index, null, true);
            }
        }
    }

    const height = Math.ceil(positioner.estimateHeight(itemCount, itemAvg));

    const defaultProps: MasonrySlotAttributes = {
        children: positionedChildren,
        [MasonryDataAttributes.slot]: "masonry",
        role: "list",
        style: {
            height,
            maxWidth: "100%",
            position: "relative",
            width: "100%",
        },
    };

    return useRenderElement("div", componentProps, {
        ref: containerRef,
        state: { measuring: isLayoutOutdated },
        props: [defaultProps, elementProps],
    });
}

export interface MasonryItemState {}

export interface MasonryItemProps extends BaseUIComponentProps<"div", MasonryItemState> {}

/**
 * A single item of the masonry layout.
 * Renders a `<div>` element.
 */
export function MasonryItem(componentProps: MasonryItemProps): React.ReactElement {
    const { className, render, style, ...elementProps } = componentProps;

    const defaultProps: MasonrySlotAttributes = {
        [MasonryDataAttributes.slot]: "masonry-item",
        role: "listitem",
    };

    return useRenderElement("div", componentProps, {
        props: [defaultProps, elementProps],
    });
}
