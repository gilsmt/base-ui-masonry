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

function parseHeight(value: number | undefined) {
    return parsePositiveFiniteNumber(value, 1);
}

function parseGap(value: number | { horizontal: number; vertical: number } | undefined) {
    if (value != null && typeof value === "object") {
        return { horizontalGap: value.horizontal, verticalGap: value.vertical };
    }
    return { horizontalGap: value, verticalGap: value };
}

function getScrollTop(measurements: Measurements) {
    return Math.max(0, measurements.scrollY - measurements.containerOffset);
}

function getWindowRange(scrollTop: number, windowHeight: number, overscan: number) {
    if (!Number.isFinite(overscan)) {
        return { start: 0, end: Number.POSITIVE_INFINITY };
    }
    const pad = windowHeight > 0 ? windowHeight * overscan : 0;
    const behind = 1 - DEFAULT_FORWARD_OVERSCAN;
    return {
        start: Math.max(0, scrollTop - pad * behind),
        end: scrollTop + windowHeight + pad * DEFAULT_FORWARD_OVERSCAN,
    };
}

interface PositionerUpdate {
    readonly height: number;
    readonly index: number;
}

interface PositionerOptions {
    columnCount?: number | undefined;
    columnWidth?: number | undefined;
    containerWidth: number;
    horizontalGap?: number | undefined;
    maxColumnCount?: number | undefined;
    verticalGap?: number | undefined;
}

function findShortestColumnIndex(heights: readonly number[]): number {
    let bestIndex = 0;
    let minHeight = heights[0] ?? Number.POSITIVE_INFINITY;
    for (let i = 1; i < heights.length; i += 1) {
        const height = heights[i];
        if (height < minHeight) {
            minHeight = height;
            bestIndex = i;
        }
    }
    return bestIndex;
}

function findFirstIndex(values: readonly number[], target: number, inclusive: boolean): number {
    let low = 0;
    let high = values.length;
    while (low < high) {
        const mid = (low + high) >>> 1;
        const value = values[mid];
        if (inclusive ? value >= target : value > target) {
            high = mid;
        } else {
            low = mid + 1;
        }
    }
    return low;
}

function findFirstOverlappingRowIndex(
    tops: readonly number[],
    items: readonly number[],
    heights: readonly number[],
    low: number,
): number {
    const row = findFirstIndex(tops, low, true);
    if (row > 0) {
        const previous = items[row - 1];
        if (tops[row - 1] + heights[previous] >= low) {
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
    const rawWidth = parsePositiveFiniteNumber(preferredWidth, DEFAULT_COLUMN_WIDTH);
    const columnGap = parseFiniteNumber(horizontalGap, 0, 0);
    const rowGap = parseFiniteNumber(verticalGap, 0, columnGap);
    const itemWidth = Math.max(MINIMUM_COLUMN_WIDTH, rawWidth);
    const requested = parsePositiveFiniteNumber(
        columnCount,
        Math.min(countFittingColumns(width, itemWidth, columnGap), maxColumnCount),
    );
    const count = Math.max(1, Math.floor(requested));
    const columnWidth = Math.max(0, Math.floor((width - columnGap * (count - 1)) / count));
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

    function estimateHeight(itemCount: number, defaultItemHeight: number) {
        let tallest = 0;
        let sum = 0;
        for (const columnHeight of columnHeights) {
            if (columnHeight > tallest) {
                tallest = columnHeight;
            }
            sum += columnHeight;
        }
        const mean = sum / columnCount;
        const remaining = Math.max(0, itemCount - itemHeights.length);
        const rows = Math.ceil(remaining / columnCount);
        const leadingGap = itemHeights.length > 0 && rows > 0 ? rowGap : 0;
        const remainingHeight =
            leadingGap + rows * defaultItemHeight + Math.max(0, rows - 1) * rowGap;
        return Math.max(tallest, mean + remainingHeight);
    }

    function getHeight(index: number): number | undefined {
        return itemHeights[index];
    }

    function getTop(index: number): number | undefined {
        const col = itemColumns[index];
        return col === undefined ? undefined : columnTops[col]?.[itemRows[index]];
    }

    function getLeft(index: number): number | undefined {
        const col = itemColumns[index];
        return col === undefined ? undefined : col * stride;
    }

    function range(
        low: number,
        high: number,
        visitItem: (index: number, left: number, top: number, height: number) => void,
    ): void {
        for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
            const items = columns[columnIndex];
            const tops = columnTops[columnIndex];
            for (
                let rowIndex = findFirstOverlappingRowIndex(tops, items, itemHeights, low);
                rowIndex < items.length;
                rowIndex += 1
            ) {
                if (tops[rowIndex] > high) {
                    break;
                }
                const itemIndex = items[rowIndex];
                visitItem(itemIndex, columnIndex * stride, tops[rowIndex], itemHeights[itemIndex]);
            }
        }
    }

    function set(height: number) {
        const itemHeight = parseHeight(height);
        const columnIndex = findShortestColumnIndex(columnHeights);
        const items = columns[columnIndex];
        const top = items.length > 0 ? columnHeights[columnIndex] + rowGap : 0;
        itemColumns.push(columnIndex);
        itemRows.push(items.length);
        itemHeights.push(itemHeight);
        items.push(itemHeights.length - 1);
        columnTops[columnIndex].push(top);
        columnHeights[columnIndex] = top + itemHeight;
    }

    function shortestColumn() {
        return columnHeights[findShortestColumnIndex(columnHeights)] ?? 0;
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
        if (size() === 0 || shortestColumn() < nextEnd) {
            return false;
        }
        for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
            const tops = columnTops[columnIndex];
            const items = columns[columnIndex];
            if (
                findFirstOverlappingRowIndex(tops, items, itemHeights, prevStart) !==
                    findFirstOverlappingRowIndex(tops, items, itemHeights, nextStart) ||
                findFirstIndex(tops, prevEnd, false) !== findFirstIndex(tops, nextEnd, false)
            ) {
                return false;
            }
        }
        return true;
    }

    function update(updates: readonly PositionerUpdate[]) {
        if (updates.length === 0) {
            return;
        }

        const firstChanged: number[] = new Array(columnCount).fill(-1);
        const lastChanged: number[] = new Array(columnCount).fill(-1);

        for (const { index, height } of updates) {
            const itemHeight = parseHeight(height);
            if (itemHeights[index] === itemHeight) {
                continue;
            }
            itemHeights[index] = itemHeight;
            const columnIndex = itemColumns[index];
            const rowIndex = itemRows[index];
            const first = firstChanged[columnIndex];
            firstChanged[columnIndex] = first < 0 ? rowIndex : Math.min(first, rowIndex);
            lastChanged[columnIndex] = Math.max(lastChanged[columnIndex], rowIndex);
        }

        for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
            const startRow = firstChanged[columnIndex];
            if (startRow < 0) {
                continue;
            }
            const lastChangedRow = lastChanged[columnIndex];
            const tops = columnTops[columnIndex];
            const items = columns[columnIndex];
            let top = tops[startRow];
            for (let rowIndex = startRow; rowIndex < items.length; rowIndex += 1) {
                if (rowIndex > lastChangedRow && tops[rowIndex] === top) {
                    break;
                }
                tops[rowIndex] = top;
                top += itemHeights[items[rowIndex]] + rowGap;
            }
            const lastRow = items.length - 1;
            columnHeights[columnIndex] = tops[lastRow] + itemHeights[items[lastRow]];
        }
    }

    return {
        columnCount,
        columnWidth,
        estimateHeight,
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
    const itemCount = previousPositioner.size();
    for (let i = 0; i < itemCount; i += 1) {
        const height = previousPositioner.getHeight(i);
        if (height !== undefined) {
            nextPositioner.set(height);
        }
    }
    return nextPositioner;
}

function useItemResizeObserver(
    callbackFnProp: (index: number, node: Element, height: number) => void,
): ResizeObserver | null {
    const callbackFn = useStableCallback(callbackFnProp);
    const resizeObserver = useRefWithInit(() => {
        if (typeof ResizeObserver !== "function") {
            return null;
        }

        return new ResizeObserver((entries) => {
            for (const entry of entries) {
                const itemIndex = getNodeDataIndex(entry.target);
                if (itemIndex === null) {
                    continue;
                }
                callbackFn(itemIndex, entry.target, entry.borderBoxSize[0].blockSize);
            }
        });
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
    predicate?: (committed: Measurements, next: Measurements) => boolean,
): boolean {
    const isLayoutSame =
        committed.containerOffset === next.containerOffset &&
        committed.containerWidth === next.containerWidth &&
        committed.windowHeight === next.windowHeight;
    if (!isLayoutSame) {
        return false;
    }
    if (committed.scrollY === next.scrollY) {
        return true;
    }
    return !!predicate?.(committed, next);
}

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
    left: number | null;
    top: number | null;
    height: number | null;
    register: (index: number, node: HTMLElement) => (() => void) | undefined;
    resetKey: number;
}

function isMasonryChildElement(
    node: React.ReactNode,
): node is React.ReactElement<MasonryItemSlotProps> {
    return React.isValidElement(node) && node.type !== React.Fragment;
}

export function areItemSlotPropsEqual(previous: ItemSlotProps, next: ItemSlotProps): boolean {
    return (
        previous.left === next.left &&
        previous.top === next.top &&
        previous.height === next.height &&
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
    left,
    top,
    height,
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

    const hasPlacement = left !== null && top !== null && height !== null;
    const style: React.CSSProperties = {
        position: "absolute",
        width,
        writingMode: "horizontal-tb",
        left: 0,
        top: 0,
        ...(hasPlacement
            ? {
                  contentVisibility: "auto",
                  containIntrinsicHeight: `auto ${height}px`,
                  transform: `translateX(${left}px) translateY(${top}px)`,
              }
            : { visibility: "hidden" }),
    };

    return React.cloneElement(child, {
        [MasonryDataAttributes.index]: index,
        ref: mergedRefs,
        "aria-posinset": index + 1,
        "aria-setsize": itemCount,
        ...(inert ? { inert: true } : null),
        style: { ...style, ...child.props.style },
    });
}, areItemSlotPropsEqual);

export function commitPendingMeasurements(
    positioner: Positioner,
    pending: Map<number, PendingItemMeasurement>,
): boolean {
    if (pending.size === 0) {
        return false;
    }

    const updates: PositionerUpdate[] = [];
    let appended = false;

    const indices = Array.from(pending.keys()).sort((a, b) => a - b);
    for (const index of indices) {
        const measurement = pending.get(index);
        if (!measurement?.node.isConnected || getNodeDataIndex(measurement.node) !== index) {
            pending.delete(index);
            continue;
        }

        const currentHeight = positioner.getHeight(index);
        if (currentHeight === undefined) {
            if (index !== positioner.size()) continue;
            positioner.set(measurement.height);
            pending.delete(index);
            appended = true;
            continue;
        }

        if (currentHeight !== measurement.height) {
            updates.push({ height: measurement.height, index });
        }
        pending.delete(index);
    }

    if (updates.length > 0) {
        positioner.update(updates);
        return true;
    }
    return appended;
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
     */
    gap: number | { horizontal: number; vertical: number };
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
        gap,
        itemHeight: rawItemHeight = DEFAULT_ITEM_HEIGHT,
        maxColumnCount: maxColumnCountProp,
        overscan: overscanProp = DEFAULT_OVERSCAN,
        container: containerProp = null,
        className,
        render,
        style,
        ...elementProps
    } = componentProps;

    const containerRef = React.useRef<HTMLDivElement | null>(null);
    const rerender = useForcedRerendering();

    const { horizontalGap, verticalGap } = parseGap(gap);
    const itemAvg = parseFiniteNumber(rawItemHeight, 1, DEFAULT_ITEM_HEIGHT);
    const maxColumnCount = parsePositiveFiniteNumber(maxColumnCountProp, Number.POSITIVE_INFINITY);
    const overscanValue =
        overscanProp === Infinity ? Infinity : parseFiniteNumber(overscanProp, 0, DEFAULT_OVERSCAN);
    const overscanRef = useValueAsRef(overscanValue);

    const isScrollUpdateRedundant = useStableCallback(
        (previous: Measurements, next: Measurements) => {
            const previousRange = getWindowRange(
                getScrollTop(previous),
                previous.windowHeight,
                overscanRef.current,
            );
            const nextRange = getWindowRange(
                getScrollTop(next),
                next.windowHeight,
                overscanRef.current,
            );
            return positionerRef.current.isWindowShiftInert(
                previousRange.start,
                previousRange.end,
                nextRange.start,
                nextRange.end,
            );
        },
    );

    const animationFrame = useAnimationFrame();
    const [measurements, setMeasurements] = React.useState<Measurements>(DEFAULT_MEASUREMENTS);
    const measurementsRef = useValueAsRef(measurements);
    const isDirtyRef = React.useRef(true);
    const prevScrollElementRef = React.useRef(containerProp);
    if (prevScrollElementRef.current !== containerProp) {
        isDirtyRef.current = true;
        prevScrollElementRef.current = containerProp;
    }

    const commit = useStableCallback(() => {
        const didMutateLayout =
            commitPendingMeasurements(positionerRef.current, pendingRef.current) ?? false;

        const container = containerRef.current;
        if (!container) {
            return;
        }
        const previous = measurementsRef.current;
        const win = ownerWindow(container);
        const scrollY = containerProp?.scrollTop ?? win.scrollY;
        const wasDirty = isDirtyRef.current;
        if (wasDirty) isDirtyRef.current = false;

        const next: Measurements = wasDirty
            ? {
                  containerOffset:
                      container.getBoundingClientRect().top -
                      (containerProp
                          ? containerProp.getBoundingClientRect().top + containerProp.clientTop
                          : 0) +
                      scrollY,
                  containerWidth: container.clientWidth,
                  scrollY,
                  windowHeight:
                      containerProp?.clientHeight ??
                      ownerDocument(container).documentElement.clientHeight,
              }
            : {
                  containerOffset: previous.containerOffset,
                  containerWidth: previous.containerWidth,
                  scrollY,
                  windowHeight: previous.windowHeight,
              };

        const shouldCommit = !canSkipUpdate(previous, next, isScrollUpdateRedundant);
        if (!shouldCommit && !didMutateLayout) {
            return;
        }
        flushSync(() => {
            if (shouldCommit) setMeasurements(next);
            if (didMutateLayout) rerender();
        });
    });

    const scheduleSync = useStableCallback(() => {
        isDirtyRef.current = true;
        animationFrame.request(commit);
    });

    const requestSync = useStableCallback(() => {
        animationFrame.request(commit);
    });

    useIsoLayoutEffect(() => {
        const containerElement = containerRef.current;
        if (!containerElement) {
            return;
        }

        scheduleSync();

        const resizeObserver =
            typeof ResizeObserver === "function" ? new ResizeObserver(scheduleSync) : null;

        if (resizeObserver) {
            resizeObserver.observe(containerElement);
            if (containerProp) {
                resizeObserver.observe(containerProp);
            }
            resizeObserver.observe(ownerDocument(containerElement).body);
        }

        const win = ownerWindow(containerElement);
        return mergeCleanups(
            addEventListener(containerProp ?? win, "scroll", requestSync, { passive: true }),
            addEventListener(win, "resize", scheduleSync),
            addEventListener(win, "orientationchange", scheduleSync),
            win.visualViewport
                ? addEventListener(win.visualViewport, "resize", scheduleSync)
                : null,
            resizeObserver ? () => resizeObserver.disconnect() : null,
        );
    }, [containerRef, scheduleSync, containerProp]);

    const containerWidth = measurements.containerWidth;
    const scrollTop = getScrollTop(measurements);
    const windowHeight = measurements.windowHeight;

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
    const currentOptions = React.useMemo(
        () => parsePositionerOptions(latestOptions),
        [latestOptions],
    );
    const rowGap = currentOptions.rowGap;

    const resetKeyRef = React.useRef(0);
    const positionerRef = useRefWithInit(() => buildPositioner(latestOptions));
    const optionsRef = useRefWithInit(() => currentOptions);
    const keysRef = React.useRef<Keys | null>(null);
    const pendingRef = useRefWithInit(() => new Map<number, PendingItemMeasurement>());
    const positioner = positionerRef.current;

    const { validChildren, keys } = React.useMemo(() => {
        const filteredChildren = React.Children.toArray(children).filter(isMasonryChildElement);
        return {
            validChildren: filteredChildren,
            keys: filteredChildren.map((child) => child.key),
        };
    }, [children]);
    const itemCount = validChildren.length;

    const queueMeasurementCommit = useStableCallback(
        (index: number, node: Element, height: number) => {
            pendingRef.current.set(index, { height, node });
            requestSync();
        },
    );

    const resizeObserver = useItemResizeObserver(queueMeasurementCommit);

    const registerItemNode = useStableCallback((index: number, node: HTMLElement) => {
        resizeObserver?.observe(node);
        return () => {
            // Cleanup callback
            resizeObserver?.unobserve(node);
            if (pendingRef.current.get(index)?.node === node) {
                pendingRef.current.delete(index);
            }
        };
    });

    useIsoLayoutEffect(() => {
        const committedKeys = keysRef.current;
        const shouldReset = committedKeys !== null && !areKeysAppendOnly(committedKeys, keys);
        const shouldRebuild = !shouldReset && !areOptionsEqual(optionsRef.current, currentOptions);

        keysRef.current = keys;
        optionsRef.current = currentOptions;

        if (shouldReset || shouldRebuild) {
            const nextPositioner = shouldReset
                ? (() => {
                      warn(
                          "MasonryRoot: item keys changed by more than appending (reorder, insertion, or removal). The layout was rebuilt from mounted items; provide stable `key`s to keep reordering cheap.",
                      );
                      pendingRef.current.clear();
                      resetKeyRef.current += 1;
                      return buildPositioner(latestOptions);
                  })()
                : rebuildPositioner(positionerRef.current, latestOptions);

            positionerRef.current = nextPositioner;
            rerender();
            scheduleSync();
        }
    }, [keys, itemCount, latestOptions, currentOptions, rerender, scheduleSync]);

    const { start: rangeStart, end: rangeEnd } = getWindowRange(
        scrollTop,
        windowHeight,
        overscanValue,
    );
    const unmeasuredStart = positioner.size();
    const minCol = positioner.shortestColumn();
    const windowNeedsMoreItems = unmeasuredStart === 0 || minCol < rangeEnd;
    const isLayoutOutdated = windowNeedsMoreItems && unmeasuredStart < itemCount;

    const positionedChildren: React.ReactElement[] = [];

    const push = (
        index: number,
        left: number | null,
        top: number | null,
        height: number | null,
        inert = false,
    ) => {
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
                left={left}
                top={top}
                height={height}
                register={registerItemNode}
                resetKey={resetKeyRef.current}
            />,
        );
    };

    positioner.range(rangeStart, rangeEnd, push);

    if (isLayoutOutdated) {
        const remaining = itemCount - unmeasuredStart;
        const rowsNeeded = Math.ceil((rangeEnd - minCol) / (itemAvg + rowGap));
        const neededByWindow = rowsNeeded * positioner.columnCount;
        const seed = unmeasuredStart === 0 ? positioner.columnCount : 0;
        const batchSize = Math.min(remaining, Math.max(seed, neededByWindow));

        for (let i = unmeasuredStart, endIndex = i + batchSize; i < endIndex; i += 1) {
            push(i, null, null, null, true);
        }
    }

    const height = Math.ceil(positioner.estimateHeight(itemCount, itemAvg));

    const defaultProps: MasonrySlotAttributes = {
        children: positionedChildren,
        [MasonryDataAttributes.slot]: "masonry",
        role: "list",
        style: { height, maxWidth: "100%", position: "relative", width: "100%" },
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
