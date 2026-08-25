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
    const raw = node.getAttribute(MasonryDataAttributes.index);
    if (raw === null) {
        return null;
    }
    const index = Number(raw);
    return Number.isInteger(index) && index >= 0 ? index : null;
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

function parseFiniteNumber(value: number | undefined, min: number, fallback: number) {
    return typeof value === "number" && Number.isFinite(value) ? Math.max(min, value) : fallback;
}

function parsePositiveFiniteNumber(value: number | undefined, fallback: number) {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function parseMeasuredItemHeight(value: number | undefined) {
    return parsePositiveFiniteNumber(value, 1);
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

function getItem<T>(items: readonly T[], index: number): T {
    return items[index]!;
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

function findLowerBoundIndex(
    items: readonly PositionerItem[],
    predicate: (item: PositionerItem) => boolean,
): number {
    let start = 0;
    let end = items.length;
    while (start < end) {
        const middle = (start + end) >>> 1;
        if (predicate(getItem(items, middle))) {
            end = middle;
        } else {
            start = middle + 1;
        }
    }
    return start;
}

function findFirstOverlappingItemIndex(items: readonly PositionerItem[], low: number): number {
    // First item that begins at or after `low`...
    const startIndex = findLowerBoundIndex(items, (item) => item.top >= low);
    // ...but the item above it may still reach down across `low`.
    if (startIndex > 0) {
        const itemAbove = getItem(items, startIndex - 1);
        if (itemAbove.top + itemAbove.height >= low) {
            return startIndex - 1;
        }
    }
    return startIndex;
}

function countFittingColumns(containerWidth: number, columnWidth: number, columnGap: number) {
    return Math.floor((containerWidth + columnGap) / (columnWidth + columnGap));
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

    const derivedColumnCount = Math.min(
        countFittingColumns(normalizedContainerWidth, normalizedColumnWidth, columnGap),
        countFittingColumns(normalizedContainerWidth, MINIMUM_COLUMN_WIDTH, columnGap),
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

function buildPositioner(options: PositionerOptions) {
    const { columnCount, columnGap, columnWidth, rowGap } = parsePositionerOptions(options);

    const items: PositionerItem[] = [];
    const columns: PositionerItem[][] = Array.from({ length: columnCount }, () => []);
    const columnHeights: number[] = Array.from({ length: columnCount }, () => 0);

    function estimateHeight(itemCount: number, defaultItemHeight: number) {
        const tallestColumn = Math.max(...columnHeights);
        const remainingItemCount = Math.max(0, itemCount - items.length);
        const remainingRowCount = Math.ceil(remainingItemCount / columnCount);
        const leadingGap = items.length > 0 && remainingRowCount > 0 ? rowGap : 0;
        const meanColumnHeight =
            columnHeights.reduce((sum, columnHeight) => sum + columnHeight, 0) / columnCount;
        const remainingHeight =
            leadingGap +
            remainingRowCount * defaultItemHeight +
            Math.max(0, remainingRowCount - 1) * rowGap;
        return Math.max(tallestColumn, meanColumnHeight + remainingHeight);
    }

    function get(index: number) {
        return items[index];
    }

    function range(low: number, high: number, visitItem: (item: PositionerItem) => void) {
        for (const columnItems of columns) {
            const start = findFirstOverlappingItemIndex(columnItems, low);
            for (let index = start; index < columnItems.length; index += 1) {
                const item = getItem(columnItems, index);
                if (item.top > high) {
                    break; // past the visible window
                }
                visitItem(item);
            }
        }
    }

    function set(height: number) {
        const itemHeight = parseMeasuredItemHeight(height);
        const columnIndex = findShortestColumn(columnHeights).index;
        const columnItems = getItem(columns, columnIndex);
        const top = columnItems.length > 0 ? getItem(columnHeights, columnIndex) + rowGap : 0;
        const item: PositionerItem = {
            columnIndex,
            columnItemIndex: columnItems.length,
            height: itemHeight,
            index: items.length,
            left: columnIndex * (columnWidth + columnGap),
            top,
        };
        items.push(item);
        columnItems.push(item);
        columnHeights[columnIndex] = top + itemHeight;
    }

    function shortestColumn() {
        return findShortestColumn(columnHeights).height;
    }

    function size() {
        return items.length;
    }

    function collectUpdates(updates: readonly PositionerUpdate[]) {
        const nextHeightByIndex = new Map<number, number>();
        const firstChangedItemByColumn = new Map<number, PositionerItem>();

        for (const update of updates) {
            nextHeightByIndex.set(update.index, parseMeasuredItemHeight(update.height));
            const changedItem = getItem(items, update.index);
            const firstChangedItem = firstChangedItemByColumn.get(changedItem.columnIndex);
            if (firstChangedItem === undefined || changedItem.index < firstChangedItem.index) {
                firstChangedItemByColumn.set(changedItem.columnIndex, changedItem);
            }
        }

        return { firstChangedItemByColumn, nextHeightByIndex };
    }

    function reflowColumn(
        firstChangedItem: PositionerItem,
        nextHeightByIndex: ReadonlyMap<number, number>,
    ) {
        const columnIndex = firstChangedItem.columnIndex;
        const columnItems = getItem(columns, columnIndex);
        let top = firstChangedItem.top;
        for (
            let itemIndex = firstChangedItem.columnItemIndex;
            itemIndex < columnItems.length;
            itemIndex += 1
        ) {
            const previousItem = getItem(columnItems, itemIndex);
            const height = nextHeightByIndex.get(previousItem.index) ?? previousItem.height;
            const nextItem: PositionerItem = {
                ...previousItem,
                height,
                top,
            };
            columnItems[itemIndex] = nextItem;
            items[previousItem.index] = nextItem;
            top += height + rowGap;
        }
        const lastItem = getItem(columnItems, columnItems.length - 1);
        columnHeights[columnIndex] = lastItem.top + lastItem.height;
    }

    function update(updates: readonly PositionerUpdate[]) {
        const { firstChangedItemByColumn, nextHeightByIndex } = collectUpdates(updates);
        for (const firstChangedItem of firstChangedItemByColumn.values()) {
            reflowColumn(firstChangedItem, nextHeightByIndex);
        }
    }

    return {
        columnCount,
        columnWidth,
        estimateHeight,
        get,
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
        nextPositioner.set(previousPositioner.get(index)!.height);
    }
    return nextPositioner;
}

/* --------------------------------- Measurements --------------------------------- */

function useItemResizeObserver(
    callbackFn: (index: number, node: HTMLElement, height: number) => void,
): ResizeObserver | null {
    const resizeObserver = useRefWithInit(() => {
        if (typeof ResizeObserver !== "function") {
            return null;
        }

        function handleResizeObserver(entries: ResizeObserverEntry[]) {
            for (const entry of entries) {
                const target = entry.target as HTMLElement;
                const attributeIndex = getNodeDataIndex(target);
                if (attributeIndex === null) {
                    continue;
                }
                const blockSize = entry.borderBoxSize?.[0]?.blockSize;
                const height =
                    typeof blockSize === "number" && Number.isFinite(blockSize)
                        ? blockSize
                        : target.offsetHeight;
                callbackFn(attributeIndex, target, height);
            }
        }

        return new ResizeObserver(handleResizeObserver);
    }).current;

    useIsoLayoutEffect(() => () => resizeObserver?.disconnect(), [resizeObserver]);

    return resizeObserver;
}

interface Measurements {
    containerOffset: number;
    containerWidth: number;
    scrollY: number;
    windowHeight: number;
}

function areMeasurementsEqual(first: Measurements, second: Measurements) {
    return (
        first.containerOffset === second.containerOffset &&
        first.containerWidth === second.containerWidth &&
        first.scrollY === second.scrollY &&
        first.windowHeight === second.windowHeight
    );
}

const DEFAULT_MEASUREMENTS: Measurements = {
    containerOffset: 0,
    containerWidth: 0,
    scrollY: 0,
    windowHeight: 0,
};

function useMeasurements(
    containerRef: React.RefObject<HTMLDivElement | null>,
    scrollElement: HTMLElement | null,
) {
    const [measurements, setMeasurements] = React.useState<Measurements>(DEFAULT_MEASUREMENTS);
    const animationFrame = useAnimationFrame();

    const sync = useStableCallback(() => {
        const container = containerRef.current;
        if (!container) {
            return;
        }

        const win = ownerWindow(container);
        const scrollY = scrollElement ? scrollElement.scrollTop : win.scrollY;

        const scrollOriginOffset = scrollElement
            ? scrollElement.getBoundingClientRect().top + scrollElement.clientTop
            : 0;

        const rootNodeRect = container.getBoundingClientRect();
        const next: Measurements = {
            containerOffset: rootNodeRect.top - scrollOriginOffset + scrollY,
            containerWidth: container.clientWidth,
            scrollY,
            windowHeight: scrollElement
                ? scrollElement.clientHeight
                : ownerDocument(container).documentElement.clientHeight,
        };

        if (areMeasurementsEqual(measurements, next)) {
            return;
        }

        flushSync(() => {
            setMeasurements(next);
        });
    });

    const scheduleLayoutSync = useStableCallback(() => {
        animationFrame.request(sync);
    });

    useIsoLayoutEffect(() => {
        const container = containerRef.current;
        if (!container) {
            return;
        }

        scheduleLayoutSync();

        const resizeObserver =
            typeof ResizeObserver === "function" ? new ResizeObserver(scheduleLayoutSync) : null;

        if (resizeObserver) {
            resizeObserver.observe(container);
            if (scrollElement) {
                resizeObserver.observe(scrollElement);
            }
            // Shifts above the container can move it without resizing it,
            // leaving `containerOffset` stale; observe its positioned
            // ancestors so such shifts still trigger a resync.
            const doc = ownerDocument(container);
            resizeObserver.observe(doc.body);
            resizeObserver.observe(doc.documentElement);
            let offsetAncestor = container.offsetParent as HTMLElement | null;
            while (offsetAncestor) {
                resizeObserver.observe(offsetAncestor);
                offsetAncestor = offsetAncestor.offsetParent as HTMLElement | null;
            }
        }

        const win = ownerWindow(container);
        return mergeCleanups(
            addEventListener(scrollElement ?? win, "scroll", scheduleLayoutSync, { passive: true }),
            addEventListener(win, "resize", scheduleLayoutSync),
            addEventListener(win, "orientationchange", scheduleLayoutSync),
            win.visualViewport
                ? addEventListener(win.visualViewport, "resize", scheduleLayoutSync)
                : null,
            resizeObserver ? () => resizeObserver.disconnect() : null,
        );
    }, [containerRef, scheduleLayoutSync, scrollElement]);

    return {
        containerWidth: measurements.containerWidth,
        scrollTop: Math.max(0, measurements.scrollY - measurements.containerOffset),
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
    node: HTMLElement;
}

interface ItemSlotProps {
    child: React.ReactElement<MasonryItemSlotProps>;
    columnWidth: number;
    index: number;
    inert: boolean;
    itemCount: number;
    item: PositionerItem | null;
    register: (index: number, node: HTMLDivElement) => () => void;
    resetKey: number;
}

function isMasonryChildElement(
    node: React.ReactNode,
): node is React.ReactElement<MasonryItemSlotProps> {
    return React.isValidElement(node) && node.type !== React.Fragment;
}

function isSamePlacement(a: PositionerItem | null, b: PositionerItem | null) {
    if (a === null || b === null) {
        return a === b;
    }
    return a.left === b.left && a.top === b.top && a.height === b.height;
}

function areItemSlotPropsEqual(previous: ItemSlotProps, next: ItemSlotProps): boolean {
    return (
        isSamePlacement(previous.item, next.item) &&
        previous.child === next.child &&
        previous.columnWidth === next.columnWidth &&
        previous.index === next.index &&
        previous.inert === next.inert &&
        previous.itemCount === next.itemCount &&
        previous.register === next.register &&
        previous.resetKey === next.resetKey
    );
}

const ItemSlot = React.memo(function ItemSlot({
    child,
    columnWidth,
    index,
    inert,
    itemCount,
    item,
    register,
    resetKey,
}: ItemSlotProps): React.ReactElement {
    const registerNode = React.useCallback(
        (node: HTMLDivElement) => {
            void resetKey; // read deliberately so callback keeps the dep
            return register(index, node);
        },
        [index, register, resetKey],
    );
    const mergedRefs = useMergedRefs(registerNode, child.props.ref);

    const style: React.CSSProperties = {
        position: "absolute",
        width: columnWidth,
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

function commitPendingMeasurements(
    positioner: Positioner,
    pendingMeasurements: ReadonlyMap<number, PendingItemMeasurement>,
): boolean {
    const updates: PositionerUpdate[] = [];
    let didChange = false;

    const indices = Array.from(pendingMeasurements.keys()).sort((a, b) => a - b);
    for (const index of indices) {
        const measurement = pendingMeasurements.get(index)!;
        if (!measurement.node.isConnected || getNodeDataIndex(measurement.node) !== index) {
            continue;
        }

        const item = positioner.get(index);
        if (item === undefined) {
            if (index !== positioner.size()) {
                continue;
            }
            positioner.set(measurement.height);
            didChange = true;
        } else if (item.height !== measurement.height) {
            updates.push({ height: measurement.height, index });
            didChange = true;
        }
    }

    if (updates.length > 0) {
        positioner.update(updates);
        didChange = true;
    }

    return didChange;
}

function areItemKeysPrefixEqual(
    previousKeys: readonly (React.Key | null)[],
    nextKeys: readonly (React.Key | null)[],
) {
    return (
        previousKeys === nextKeys ||
        (previousKeys.length <= nextKeys.length &&
            previousKeys.every((key, index) => key === nextKeys[index]))
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
        itemHeight = DEFAULT_ITEM_HEIGHT,
        maxColumnCount: maxColumnCountProp,
        overscan = DEFAULT_OVERSCAN,
        container = null,
        className,
        render,
        style,
        ...elementProps
    } = componentProps;

    const containerRef = React.useRef<HTMLDivElement | null>(null);
    const { containerWidth, scrollTop, windowHeight } = useMeasurements(containerRef, container);
    const rerender = useForcedRerendering();
    const animationFrame = useAnimationFrame();

    const { horizontalGap, verticalGap } = parseGapDirectionalValues(gap);
    const normalizedItemHeight = parseFiniteNumber(itemHeight, 1, DEFAULT_ITEM_HEIGHT);
    const maxColumnCount = parsePositiveFiniteNumber(maxColumnCountProp, Number.POSITIVE_INFINITY);
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

    const resetCountRef = useRefWithInit(() => ({ value: 0 })); // Bumped on layout reset so every mounted slot re-reports its measurement
    const positionerRef = useRefWithInit(() => buildPositioner(latestOptions));
    const committedResolvedOptionsRef = useRefWithInit(() => parsePositionerOptions(latestOptions));
    const committedItemKeysRef = React.useRef<readonly (React.Key | null)[] | null>(null);
    const pendingMeasurementsRef = useRefWithInit(() => new Map<number, PendingItemMeasurement>());
    const positioner = positionerRef.current;

    // React.Children.toArray is opaque to the React Compiler,
    // so memoize manually to keep both arrays stable
    const validChildren = React.useMemo(
        () => React.Children.toArray(children).filter(isMasonryChildElement),
        [children],
    );
    const currentItemKeys = React.useMemo(
        () => validChildren.map((child) => child.key),
        [validChildren],
    );
    const itemCount = validChildren.length;

    const commitQueuedMeasurements = useStableCallback(() => {
        const didCommit = commitPendingMeasurements(
            positionerRef.current,
            pendingMeasurementsRef.current,
        );
        if (pendingMeasurementsRef.current.size > 0) {
            pendingMeasurementsRef.current = new Map();
        }

        if (didCommit) {
            flushSync(() => {
                rerender();
            });
        }
    });

    const queueMeasurementCommit = useStableCallback(
        (index: number, node: HTMLElement, measuredHeight: number) => {
            pendingMeasurementsRef.current.set(index, {
                height: measuredHeight,
                node,
            });
            animationFrame.request(commitQueuedMeasurements);
        },
    );

    const resizeObserver = useItemResizeObserver(queueMeasurementCommit);

    const registerItemNode = useStableCallback((index: number, node: HTMLDivElement) => {
        resizeObserver?.observe(node);
        queueMeasurementCommit(index, node, node.offsetHeight);
        return () => {
            resizeObserver?.unobserve(node);
            const pendingMeasurement = pendingMeasurementsRef.current.get(index);
            if (pendingMeasurement?.node === node) {
                pendingMeasurementsRef.current.delete(index);
            }
        };
    });

    useIsoLayoutEffect(() => {
        const shouldResetPositioner =
            committedItemKeysRef.current !== null &&
            !areItemKeysPrefixEqual(committedItemKeysRef.current, currentItemKeys);

        const nextResolvedOptions = parsePositionerOptions(latestOptions);
        const committedResolvedOptions = committedResolvedOptionsRef.current;

        const shouldRebuildPositioner =
            !shouldResetPositioner &&
            !areResolvedOptionsEqual(committedResolvedOptions, nextResolvedOptions);

        committedItemKeysRef.current = currentItemKeys;
        committedResolvedOptionsRef.current = nextResolvedOptions;

        if (shouldResetPositioner || shouldRebuildPositioner) {
            let nextPositioner: Positioner;
            if (shouldResetPositioner) {
                warn(
                    "MasonryRoot: item keys changed by more than appending (reorder, insertion, or removal). The layout was rebuilt from mounted items; provide stable `key`s to keep reordering cheap.",
                );
                pendingMeasurementsRef.current.clear();
                resetCountRef.current.value += 1;
                nextPositioner = buildPositioner(latestOptions);
                const container = containerRef.current;
                if (container) {
                    const nodeByIndex = new Map<number, HTMLElement>();
                    for (const child of Array.from(container.children)) {
                        const childIndex = getNodeDataIndex(child);
                        if (childIndex !== null && !nodeByIndex.has(childIndex)) {
                            nodeByIndex.set(childIndex, child as HTMLElement);
                        }
                    }
                    for (let index = 0; index < itemCount; index += 1) {
                        const node = nodeByIndex.get(index);
                        if (!node) {
                            break;
                        }
                        nextPositioner.set(node.offsetHeight);
                    }
                }
            } else {
                nextPositioner = rebuildPositioner(positionerRef.current, latestOptions);
            }

            positionerRef.current = nextPositioner;
            rerender();
        }
    }, [currentItemKeys, itemCount, latestOptions, rerender]);

    const firstUnmeasuredIndex = positioner.size();
    const shortestColumnSize = positioner.shortestColumn();

    const normalizedOverscan =
        overscan === Infinity ? overscan : parseFiniteNumber(overscan, 0, DEFAULT_OVERSCAN);
    const overscanPixels = windowHeight > 0 ? windowHeight * normalizedOverscan : 0;

    const backwardOverscanPixels = overscanPixels * (1 - DEFAULT_FORWARD_OVERSCAN);
    const forwardOverscanPixels = overscanPixels * DEFAULT_FORWARD_OVERSCAN;

    const rangeStart = Math.max(0, scrollTop - backwardOverscanPixels);
    const rangeEnd = scrollTop + windowHeight + forwardOverscanPixels;

    const windowNeedsMoreItems = firstUnmeasuredIndex === 0 || shortestColumnSize < rangeEnd;
    const isLayoutOutdated = windowNeedsMoreItems && firstUnmeasuredIndex < itemCount;

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
                columnWidth={positioner.columnWidth}
                index={index}
                inert={inert}
                itemCount={itemCount}
                item={item}
                register={registerItemNode}
                resetKey={resetCountRef.current.value}
            />,
        );
    };

    positioner.range(rangeStart, rangeEnd, (item) => {
        appendSlot(item.index, item);
    });

    if (isLayoutOutdated) {
        // Before anything is measured, place at least one full row so every
        // column contributes real heights to the layout.
        const minimumBatchSize = firstUnmeasuredIndex === 0 ? positioner.columnCount : 0;
        const estimatedBatchSize = Math.ceil(
            ((rangeEnd - shortestColumnSize) / normalizedItemHeight) * positioner.columnCount,
        );
        const batchSize = Math.min(
            itemCount - firstUnmeasuredIndex,
            Math.max(minimumBatchSize, estimatedBatchSize),
        );
        if (batchSize > 0) {
            const end = firstUnmeasuredIndex + batchSize;
            for (let index = firstUnmeasuredIndex; index < end; index += 1) {
                appendSlot(index, null, true);
            }
        }
    }

    const height = Math.ceil(positioner.estimateHeight(itemCount, normalizedItemHeight));

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
