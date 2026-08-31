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
        warn(`MasonryRoot node ${node} does not have a data-index attribute`);
        return null;
    }
    const index = Number(attr);
    return index >>> 0 === index ? index : null;
}

function parseMin(value: number | undefined, min: number, fallback: number) {
    return typeof value === "number" && Number.isFinite(value) ? Math.max(min, value) : fallback;
}

function parsePositive(value: number | undefined, fallback: number) {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function parseNonNegative(value: number | undefined, fallback: number) {
    return typeof value === "number" && value >= 0 ? value : fallback;
}

function parseGap(value: number | { horizontal: number; vertical: number } | undefined) {
    if (value !== null && typeof value === "object") {
        return { horizontalGap: value.horizontal, verticalGap: value.vertical };
    }
    return { horizontalGap: value, verticalGap: value };
}

function getScrollTop(measurements: Measurements) {
    return Math.max(0, measurements.scrollY - measurements.containerOffset);
}

function parseRange(scrollTop: number, windowHeight: number, overscan: number) {
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

function findShortestColumnIndex(heights: number[]) {
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

function findFirstIndex(values: number[], target: number, inclusive: boolean) {
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
    tops: number[],
    items: number[],
    heights: number[],
    low: number,
) {
    const rowIndex = findFirstIndex(tops, low, true);
    if (rowIndex > 0) {
        const previousItemIndex = items[rowIndex - 1];
        if (tops[rowIndex - 1] + heights[previousItemIndex] >= low) {
            return rowIndex - 1;
        }
    }
    return rowIndex;
}

function countFittingColumns(containerWidth: number, columnWidth: number, columnGap: number) {
    return Math.floor((containerWidth + columnGap) / (columnWidth + columnGap));
}

interface PositionerOptions {
    columnCount: number;
    columnGap: number;
    columnWidth: number;
    rowGap: number;
}

export function parseOptions({
    columnCount,
    columnWidth: preferredWidth = DEFAULT_COLUMN_WIDTH,
    containerWidth,
    horizontalGap,
    maxColumnCount,
    verticalGap,
}: {
    columnCount?: number | undefined;
    columnWidth?: number | undefined;
    containerWidth: number;
    horizontalGap?: number | undefined;
    maxColumnCount?: number | undefined;
    verticalGap?: number | undefined;
}): PositionerOptions {
    const width = parsePositive(containerWidth, 0);
    const columnGap = parseMin(horizontalGap, 0, 0);
    const rowGap = parseMin(verticalGap, 0, columnGap);
    const rawWidth = parsePositive(preferredWidth, DEFAULT_COLUMN_WIDTH);
    const itemWidth = Math.max(MINIMUM_COLUMN_WIDTH, rawWidth);
    const maxColumns = parsePositive(maxColumnCount, Number.POSITIVE_INFINITY);
    const requested = parsePositive(
        columnCount,
        Math.min(countFittingColumns(width, itemWidth, columnGap), maxColumns),
    );
    const count = Math.max(1, Math.floor(requested));
    const columnWidth = Math.max(0, Math.floor((width - columnGap * (count - 1)) / count));
    return { columnCount: count, columnGap, columnWidth, rowGap };
}

interface PositionerUpdate {
    height: number;
    index: number;
}

export class Positioner {
    columnCount: number;
    columnWidth: number;
    columnGap: number;
    rowGap: number;
    private readonly stride: number;
    private readonly columns: number[][];
    private readonly columnTops: number[][];
    private readonly columnHeights: number[];
    private readonly itemColumns: number[];
    private readonly itemRows: number[];
    private readonly itemHeights: number[];

    constructor(options: PositionerOptions) {
        const { columnCount, columnGap, columnWidth, rowGap } = options;
        this.columnCount = columnCount;
        this.columnWidth = columnWidth;
        this.columnGap = columnGap;
        this.rowGap = rowGap;
        this.stride = columnWidth + columnGap;
        this.columns = Array.from({ length: columnCount }, () => []);
        this.columnTops = Array.from({ length: columnCount }, () => []);
        this.columnHeights = new Array(columnCount).fill(0);
        this.itemColumns = [];
        this.itemRows = [];
        this.itemHeights = [];
    }

    size(): number {
        return this.itemHeights.length;
    }

    shortestColumn(): number {
        return this.columnHeights[findShortestColumnIndex(this.columnHeights)] ?? 0;
    }

    getHeight(index: number): number | undefined {
        return this.itemHeights[index];
    }

    getTop(index: number): number | undefined {
        const col = this.itemColumns[index];
        return col === undefined ? undefined : this.columnTops[col]?.[this.itemRows[index]];
    }

    getLeft(index: number): number | undefined {
        const col = this.itemColumns[index];
        return col === undefined ? undefined : col * this.stride;
    }

    estimateHeight(itemCount: number, defaultItemHeight: number): number {
        let tallest = 0;
        let sum = 0;
        for (const columnHeight of this.columnHeights) {
            if (columnHeight > tallest) {
                tallest = columnHeight;
            }
            sum += columnHeight;
        }
        const mean = sum / this.columnCount;
        const remaining = Math.max(0, itemCount - this.itemHeights.length);
        const rows = Math.ceil(remaining / this.columnCount);
        const leadingGap = this.itemHeights.length > 0 && rows > 0 ? this.rowGap : 0;
        const remainingHeight =
            leadingGap + rows * defaultItemHeight + Math.max(0, rows - 1) * this.rowGap;
        return Math.max(tallest, mean + remainingHeight);
    }

    range(
        low: number,
        high: number,
        visitItem: (index: number, left: number, top: number, height: number) => void,
    ): void {
        for (let columnIndex = 0; columnIndex < this.columnCount; columnIndex += 1) {
            const columnItems = this.columns[columnIndex];
            const tops = this.columnTops[columnIndex];
            for (
                let rowIndex = findFirstOverlappingRowIndex(
                    tops,
                    columnItems,
                    this.itemHeights,
                    low,
                );
                rowIndex < columnItems.length;
                rowIndex += 1
            ) {
                if (tops[rowIndex] > high) {
                    break;
                }
                const itemIndex = columnItems[rowIndex];
                visitItem(
                    itemIndex,
                    columnIndex * this.stride,
                    tops[rowIndex],
                    this.itemHeights[itemIndex],
                );
            }
        }
    }

    set(height: number) {
        const itemHeight = parsePositive(height, 1);
        const columnIndex = findShortestColumnIndex(this.columnHeights);
        const columnItems = this.columns[columnIndex];
        const top = columnItems.length > 0 ? this.columnHeights[columnIndex] + this.rowGap : 0;
        this.itemColumns.push(columnIndex);
        this.itemRows.push(columnItems.length);
        this.itemHeights.push(itemHeight);
        columnItems.push(this.itemHeights.length - 1);
        this.columnTops[columnIndex].push(top);
        this.columnHeights[columnIndex] = top + itemHeight;
    }

    isWindowShiftInert(
        prevStart: number,
        prevEnd: number,
        nextStart: number,
        nextEnd: number,
    ): boolean {
        if (prevStart === nextStart && prevEnd === nextEnd) {
            return true;
        }
        if (this.size() === 0 || this.shortestColumn() < nextEnd) {
            return false;
        }
        for (let columnIndex = 0; columnIndex < this.columnCount; columnIndex += 1) {
            const tops = this.columnTops[columnIndex];
            const columnItems = this.columns[columnIndex];
            if (
                findFirstOverlappingRowIndex(tops, columnItems, this.itemHeights, prevStart) !==
                    findFirstOverlappingRowIndex(tops, columnItems, this.itemHeights, nextStart) ||
                findFirstIndex(tops, prevEnd, false) !== findFirstIndex(tops, nextEnd, false)
            ) {
                return false;
            }
        }
        return true;
    }

    update(updates: PositionerUpdate[]) {
        if (updates.length === 0) {
            return;
        }
        const firstChanged: number[] = new Array(this.columnCount).fill(-1);
        const lastChanged: number[] = new Array(this.columnCount).fill(-1);
        for (const { index, height } of updates) {
            const itemHeight = parsePositive(height, 1);
            if (this.itemHeights[index] === itemHeight) {
                continue;
            }
            this.itemHeights[index] = itemHeight;
            const columnIndex = this.itemColumns[index];
            const row = this.itemRows[index];
            const current = firstChanged[columnIndex];
            if (current < 0 || row < current) {
                firstChanged[columnIndex] = row;
            }
            if (row > lastChanged[columnIndex]) {
                lastChanged[columnIndex] = row;
            }
        }

        for (let columnIndex = 0; columnIndex < this.columnCount; columnIndex += 1) {
            const startRow = firstChanged[columnIndex];
            if (startRow < 0) {
                continue;
            }
            const columnItems = this.columns[columnIndex];
            const tops = this.columnTops[columnIndex];
            const lastChangedRow = lastChanged[columnIndex];
            let top = tops[startRow];
            for (let rowIndex = startRow; rowIndex < columnItems.length; rowIndex += 1) {
                if (rowIndex > lastChangedRow && tops[rowIndex] === top) {
                    break;
                }
                tops[rowIndex] = top;
                top += this.itemHeights[columnItems[rowIndex]] + this.rowGap;
            }
            const lastRow = columnItems.length - 1;
            this.columnHeights[columnIndex] =
                tops[lastRow] + this.itemHeights[columnItems[lastRow]];
        }
    }

    static rebuild(previous: Positioner, options: PositionerOptions): Positioner {
        const next = new Positioner(options);
        const itemCount = previous.size();
        for (let i = 0; i < itemCount; i += 1) {
            const height = previous.getHeight(i);
            if (height !== undefined) {
                next.set(height);
            }
        }
        return next;
    }

    flushPending(pending: Map<Element, number>): boolean {
        if (pending.size === 0) {
            return false;
        }

        const entries: { height: number; index: number; node: Element }[] = [];
        for (const [node, height] of pending) {
            pending.delete(node);
            if (!node.isConnected) {
                continue;
            }
            const index = getNodeDataIndex(node);
            if (index === null) {
                continue;
            }
            entries.push({ height, index, node });
        }
        entries.sort((a, b) => a.index - b.index);

        const updates: PositionerUpdate[] = [];
        let appended = false;

        for (const { height, index, node } of entries) {
            const currentHeight = this.getHeight(index);
            if (currentHeight === undefined) {
                if (index !== this.size()) {
                    pending.set(node, height);
                    continue;
                }
                this.set(height);
                appended = true;
                continue;
            }
            if (currentHeight !== height) {
                updates.push({ height, index });
            }
        }

        if (updates.length > 0) {
            this.update(updates);
            return true;
        }

        return appended;
    }
}

function useItemResizeObserver(
    callbackProp: (node: Element, height: number) => void,
): ResizeObserver | null {
    const callbackFn = useStableCallback(callbackProp);
    const resizeObserver = useRefWithInit(() => {
        if (typeof ResizeObserver !== "function") {
            return null;
        }

        return new ResizeObserver((entries) => {
            for (const entry of entries) {
                callbackFn(entry.target, entry.borderBoxSize[0].blockSize);
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

const INITIAL_MEASUREMENTS: Measurements = {
    containerOffset: 0,
    containerWidth: 0,
    scrollY: 0,
    windowHeight: 0,
};

interface MasonryItemSlotProps
    extends React.HTMLAttributes<HTMLDivElement>, React.RefAttributes<HTMLDivElement> {
    [MasonryDataAttributes.index]?: number;
}

interface MasonrySlotAttributes extends MasonryItemSlotProps {
    [MasonryDataAttributes.slot]: string;
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
    register: (node: HTMLElement) => (() => void) | undefined;
    resetKey: number;
}

function isMasonryChildElement(
    node: React.ReactNode,
): node is React.ReactElement<MasonryItemSlotProps> {
    return React.isValidElement(node);
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
            return register(node);
        },
        [register, resetKey],
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

type Keys = (React.Key | null)[];

function isKeysPrefix(previous: Keys, next: Keys) {
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
    /**
     * The number of columns to render.
     * When unset or non-positive, the column count is derived from `columnWidth` and the container width.
     */
    columnCount?: number;
    /**
     * The preferred width of each column in pixels, used to derive the column count.
     * To render a fixed number of columns, use the `columnCount` prop instead.
     * @default 200
     */
    columnWidth?: number;
    /**
     * The gap between columns and rows in pixels.
     * Accepts a single number for both axes or an object to configure them individually.
     * When an object is provided, `vertical` defaults to `horizontal`.
     */
    gap: number | { horizontal: number; vertical: number };
    /**
     * The assumed average item height in pixels, used to estimate the container height
     * and the batch size of unmeasured items.
     * @default 300
     */
    itemHeight?: number;
    /**
     * The maximum number of columns that can be derived from `columnWidth`.
     * Non-finite or non-positive values mean the column count is uncapped.
     * @default Infinity
     */
    maxColumnCount?: number;
    /**
     * How far beyond the viewport, as a multiple of its height, items are rendered
     * and unmeasured items are batched. Use `Infinity` to disable windowing and render every item.
     * @default 1.5
     */
    overscan?: number;
    /**
     * The element whose scroll position drives windowing.
     * Pass the element that actually scrolls when the masonry is inside an overflow container.
     * @default window
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
        itemHeight: itemHeightProp = DEFAULT_ITEM_HEIGHT,
        maxColumnCount: maxColumnCountProp,
        overscan: overscanProp = DEFAULT_OVERSCAN,
        container: containerProp = null,
        className,
        render,
        style,
        ...elementProps
    } = componentProps;

    const { horizontalGap, verticalGap } = parseGap(gap);
    const itemHeight = parseMin(itemHeightProp, 1, DEFAULT_ITEM_HEIGHT);
    const overscan = parseNonNegative(overscanProp, DEFAULT_OVERSCAN);

    const containerRef = React.useRef<HTMLDivElement | null>(null);
    const animationFrame = useAnimationFrame();
    const rerender = useForcedRerendering();

    const [measurements, setMeasurements] = React.useState<Measurements>(INITIAL_MEASUREMENTS);
    const measurementsRef = useValueAsRef(measurements);
    const isDirtyRef = React.useRef(true);

    const scrollTop = getScrollTop(measurements);
    const windowHeight = measurements.windowHeight;
    const containerWidth = measurements.containerWidth;

    const currentOptions = React.useMemo(
        () =>
            parseOptions({
                columnCount,
                columnWidth,
                containerWidth,
                horizontalGap,
                maxColumnCount: maxColumnCountProp,
                verticalGap,
            }),
        [columnCount, columnWidth, containerWidth, horizontalGap, maxColumnCountProp, verticalGap],
    );

    const resetKeyRef = React.useRef(0);
    const positionerRef = useRefWithInit(() => new Positioner(currentOptions));
    const keysRef = React.useRef<Keys | null>(null);
    const pendingRef = useRefWithInit(() => new Map<Element, number>());

    const { validChildren, keys } = React.useMemo(() => {
        const filteredChildren: React.ReactElement<MasonryItemSlotProps>[] = [];
        React.Children.forEach(children, (child) => {
            if (isMasonryChildElement(child)) {
                filteredChildren.push(child);
            }
        });
        return {
            validChildren: filteredChildren,
            keys: filteredChildren.map((child) => child.key),
        };
    }, [children]);
    const itemCount = validChildren.length;

    const commit = useStableCallback(() => {
        const layoutMutated = positionerRef.current.flushPending(pendingRef.current);

        const container = containerRef.current;
        if (!container) {
            return;
        }

        const previous = measurementsRef.current;
        const win = ownerWindow(container);
        const scrollY = containerProp?.scrollTop ?? win.scrollY;

        const wasDirty = isDirtyRef.current;
        isDirtyRef.current = false;

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
            : { ...previous, scrollY };

        const hasLayoutChanged =
            previous.containerOffset !== next.containerOffset ||
            previous.containerWidth !== next.containerWidth ||
            previous.windowHeight !== next.windowHeight;
        const previousRange = parseRange(getScrollTop(previous), previous.windowHeight, overscan);
        const nextRange = parseRange(getScrollTop(next), next.windowHeight, overscan);
        const isWindowShiftInert = positionerRef.current.isWindowShiftInert(
            previousRange.start,
            previousRange.end,
            nextRange.start,
            nextRange.end,
        );
        const hasScrollChanged = previous.scrollY !== next.scrollY;
        const shouldCommit = hasLayoutChanged || (hasScrollChanged && !isWindowShiftInert);

        if (shouldCommit || layoutMutated) {
            flushSync(() => {
                if (shouldCommit) setMeasurements(next);
                if (layoutMutated) rerender();
            });
        }
    });

    const requestDirtyCommit = useStableCallback(() => {
        isDirtyRef.current = true;
        animationFrame.request(commit);
    });

    const requestCommit = useStableCallback(() => {
        animationFrame.request(commit);
    });

    const resizeObserver = useItemResizeObserver((node, height) => {
        pendingRef.current.set(node, height);
        requestCommit();
    });

    const registerItemNode = useStableCallback((node: HTMLElement) => {
        resizeObserver?.observe(node);
        return () => {
            resizeObserver?.unobserve(node);
            pendingRef.current.delete(node);
        };
    });

    useIsoLayoutEffect(() => {
        const containerElement = containerRef.current;
        if (!containerElement) {
            return;
        }

        requestDirtyCommit(); // Initial full measurement

        const resizeObserver =
            typeof ResizeObserver === "function" ? new ResizeObserver(requestDirtyCommit) : null;
        if (resizeObserver) {
            resizeObserver.observe(containerElement);
            if (containerProp) {
                resizeObserver.observe(containerProp);
            }
            resizeObserver.observe(ownerDocument(containerElement).body);
        }

        const win = ownerWindow(containerElement);
        return mergeCleanups(
            addEventListener(containerProp ?? win, "scroll", requestCommit, { passive: true }),
            addEventListener(win, "resize", requestDirtyCommit),
            addEventListener(win, "orientationchange", requestDirtyCommit),
            win.visualViewport
                ? addEventListener(win.visualViewport, "resize", requestDirtyCommit)
                : null,
            resizeObserver ? () => resizeObserver.disconnect() : null,
        );
    }, [containerRef, requestDirtyCommit, containerProp]);

    useIsoLayoutEffect(() => {
        const currentKeys = keysRef.current;
        const positioner = positionerRef.current;

        const shouldReset = currentKeys !== null && !isKeysPrefix(currentKeys, keys);
        const shouldRebuild =
            !shouldReset &&
            (positioner.columnCount !== currentOptions.columnCount ||
                positioner.columnWidth !== currentOptions.columnWidth ||
                positioner.columnGap !== currentOptions.columnGap ||
                positioner.rowGap !== currentOptions.rowGap);

        keysRef.current = keys;

        if (shouldReset || shouldRebuild) {
            const nextPositioner = shouldReset
                ? (() => {
                      warn(
                          "MasonryRoot: item keys changed by more than appending (reorder, insertion, or removal). The layout was rebuilt from mounted items; provide stable `key`s to keep reordering cheap.",
                      );
                      pendingRef.current.clear();
                      resetKeyRef.current += 1;
                      return new Positioner(currentOptions);
                  })()
                : Positioner.rebuild(positionerRef.current, currentOptions);

            positionerRef.current = nextPositioner;
            rerender();
            requestDirtyCommit();
        }
    }, [keys, itemCount, currentOptions, rerender, requestDirtyCommit]);

    const { start: rangeStart, end: rangeEnd } = parseRange(scrollTop, windowHeight, overscan);
    const positioner = positionerRef.current; // intentionally read during render before commit
    const unmeasuredStart = positioner.size();
    const minCol = positioner.shortestColumn();

    const windowNeedsMoreItems = unmeasuredStart === 0 || minCol < rangeEnd;
    const measuring = windowNeedsMoreItems && unmeasuredStart < itemCount;
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

    if (measuring) {
        const remaining = itemCount - unmeasuredStart;
        const rowsNeeded = Math.ceil((rangeEnd - minCol) / (itemHeight + currentOptions.rowGap));
        const neededByWindow = rowsNeeded * positioner.columnCount;
        const seed = unmeasuredStart === 0 ? positioner.columnCount : 0;
        const batchSize = Math.min(remaining, Math.max(seed, neededByWindow));

        for (let i = unmeasuredStart, endIndex = i + batchSize; i < endIndex; i += 1) {
            push(i, null, null, null, true);
        }
    }

    const height = Math.ceil(positioner.estimateHeight(itemCount, itemHeight));

    const defaultProps: MasonrySlotAttributes = {
        children: positionedChildren,
        [MasonryDataAttributes.slot]: "masonry",
        role: "list",
        style: { height, maxWidth: "100%", position: "relative", width: "100%" },
    };

    return useRenderElement("div", componentProps, {
        ref: containerRef,
        state: { measuring },
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
