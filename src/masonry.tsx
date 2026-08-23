"use client";

import { useRenderElement } from "@base-ui/react/internals/useRenderElement";
import type { BaseUIComponentProps } from "@base-ui/react/internals/types";
import { addEventListener } from "@base-ui/utils/addEventListener";
import { mergeCleanups } from "@base-ui/utils/mergeCleanups";
import { ownerDocument, ownerWindow } from "@base-ui/utils/owner";
import { useAnimationFrame } from "@base-ui/utils/useAnimationFrame";
import { useForcedRerendering } from "@base-ui/utils/useForcedRerendering";
import { useIsoLayoutEffect } from "@base-ui/utils/useIsoLayoutEffect";
import { useRefWithInit } from "@base-ui/utils/useRefWithInit";
import { useStableCallback } from "@base-ui/utils/useStableCallback";
import { useTimeout } from "@base-ui/utils/useTimeout";
import { flushSync } from "react-dom";
import * as React from "react";

const DEFAULT_COLUMN_WIDTH = 200;

const DEFAULT_GAP = 0;

const DEFAULT_ITEM_HEIGHT = 300;

const DEFAULT_OVERSCAN = 1.5;

const DEFAULT_FORWARD_OVERSCAN = 0.6;

// 100 ms without scroll events ≈ scroll end
// https://developer.mozilla.org/en-US/docs/Web/API/Element/scrollend_event
const SCROLL_TIMEOUT_MS = 100;

// Max excess of the round-robin column over the shortest, in item heights
const MAX_COLUMN_SKEW_RATIO = 2.5;

// Caches are pruned only past twice the rendered window plus this slack
const CACHE_PRUNE_SLACK = 32;

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
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 1;
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
    columnCount?: number;
    columnWidth?: number;
    containerWidth: number;
    horizontalGap?: number;
    maxColumnCount?: number;
    verticalGap?: number;
}

function getColumnItem(items: readonly PositionerItem[], index: number): PositionerItem {
    const item = items[index];
    if (!item) {
        throw new Error("Masonry positioner invariant violated: sparse column index.");
    }
    return item;
}

function getColumnItems(columns: PositionerItem[][], columnIndex: number): PositionerItem[] {
    const items = columns[columnIndex];
    if (!items) {
        throw new Error("Masonry positioner invariant violated: missing column.");
    }
    return items;
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
    // binary search
    let start = 0;
    let end = items.length;
    while (start < end) {
        const middle = (start + end) >>> 1;
        if (predicate(getColumnItem(items, middle))) {
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
        const itemAbove = getColumnItem(items, startIndex - 1);
        if (itemAbove.top + itemAbove.height >= low) {
            return startIndex - 1;
        }
    }
    return startIndex;
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
    const rowGap = parseFiniteNumber(verticalGap ?? columnGap, 0, DEFAULT_GAP);

    const hasValidColumnCount =
        typeof columnCount === "number" && Number.isFinite(columnCount) && columnCount > 0;

    const derivedColumnCount = Math.min(
        Math.floor((normalizedContainerWidth + columnGap) / (normalizedColumnWidth + columnGap)),
        maxColumnCount,
    );

    const requestedColumnCount = hasValidColumnCount ? columnCount : derivedColumnCount;
    const resolvedColumnCount = Math.max(1, Math.floor(requestedColumnCount));

    const resolvedColumnWidth = Math.max(
        0,
        Math.floor(
            (normalizedContainerWidth - columnGap * (resolvedColumnCount - 1)) /
                resolvedColumnCount,
        ),
    );

    return {
        columnCount: resolvedColumnCount,
        columnGap,
        columnWidth: resolvedColumnWidth,
        rowGap,
    };
}

function buildPositioner(options: PositionerOptions) {
    const { columnCount, columnGap, columnWidth, rowGap } = parsePositionerOptions(options);

    const items: PositionerItem[] = [];
    const columns: PositionerItem[][] = Array.from({ length: columnCount }, () => []);
    const columnHeights: number[] = Array.from({ length: columnCount }, () => 0);

    function getColumnHeight(columnIndex: number): number {
        const height = columnHeights[columnIndex];
        if (height === undefined) {
            throw new Error("Masonry positioner invariant violated: missing column.");
        }
        return height;
    }

    function estimateHeight(itemCount: number, defaultItemHeight: number) {
        const tallestColumn = Math.max(...columnHeights);
        const remainingItemCount = Math.max(0, itemCount - items.length);
        const remainingRowCount = Math.ceil(remainingItemCount / columnCount);
        const leadingGap = items.length > 0 && remainingRowCount > 0 ? rowGap : 0;
        return (
            tallestColumn +
            leadingGap +
            remainingRowCount * defaultItemHeight +
            Math.max(0, remainingRowCount - 1) * rowGap
        );
    }

    function get(index: number) {
        return items[index];
    }

    function range(low: number, high: number, visitItem: (item: PositionerItem) => void) {
        for (const columnItems of columns) {
            const start = findFirstOverlappingItemIndex(columnItems, low);
            for (let index = start; index < columnItems.length; index += 1) {
                const item = getColumnItem(columnItems, index);
                if (item.top > high) {
                    break; // past the visible window
                }
                visitItem(item);
            }
        }
    }

    function pickPlacementColumn(itemHeight: number) {
        const roundRobinColumn = items.length % columnCount;
        const shortest = findShortestColumn(columnHeights);
        const roundRobinColumnHeight = getColumnHeight(roundRobinColumn) + itemHeight;
        const maxAllowedHeight = shortest.height + itemHeight * MAX_COLUMN_SKEW_RATIO;
        return roundRobinColumnHeight <= maxAllowedHeight ? roundRobinColumn : shortest.index;
    }

    function set(height: number) {
        const itemHeight = parseMeasuredItemHeight(height);
        const columnIndex = pickPlacementColumn(itemHeight);
        const columnItems = getColumnItems(columns, columnIndex);
        const top = columnItems.length > 0 ? getColumnHeight(columnIndex) + rowGap : 0;
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
            if (!(update.index >= 0 && update.index < items.length)) {
                throw new Error(
                    `Masonry positioner invariant violated: update referenced index ${update.index}, but only ${items.length} items are placed.`,
                );
            }
            nextHeightByIndex.set(update.index, parseMeasuredItemHeight(update.height));
            const changedItem = getColumnItem(items, update.index);
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
        const columnItems = getColumnItems(columns, columnIndex);
        let top = firstChangedItem.top;
        for (
            let itemIndex = firstChangedItem.columnItemIndex;
            itemIndex < columnItems.length;
            itemIndex += 1
        ) {
            const previousItem = getColumnItem(columnItems, itemIndex);
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
        const lastItem = getColumnItem(columnItems, columnItems.length - 1);
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
        const item = previousPositioner.get(index);
        if (!item) {
            throw new Error(
                "Masonry positioner invariant violated: measured items must be contiguous.",
            );
        }
        nextPositioner.set(item.height);
    }
    return nextPositioner;
}

/* --------------------------------- Measurement --------------------------------- */

function createItemResizeObserver(
    getIndexByNode: (node: Element) => number | undefined,
    getRegisteredNode: (index: number) => Element | undefined,
    onMeasurementUpdate: (index: number, node: HTMLElement, height: number) => void,
): ResizeObserver | null {
    if (typeof ResizeObserver !== "function") {
        return null;
    }

    function handleResizeObserver(entries: ResizeObserverEntry[]) {
        for (const entry of entries) {
            const target = entry.target as HTMLElement;
            const entryIndex = getIndexByNode(target);
            if (entryIndex === undefined || getRegisteredNode(entryIndex) !== target) {
                continue;
            }

            const blockSize = entry.borderBoxSize?.[0]?.blockSize;
            const height =
                typeof blockSize === "number" && Number.isFinite(blockSize)
                    ? Math.round(blockSize)
                    : target.offsetHeight;

            onMeasurementUpdate(entryIndex, target, height);
        }
    }

    return new ResizeObserver(handleResizeObserver);
}

function findVerticalScrollParent(element: HTMLElement): HTMLElement | null {
    let current = element.parentElement;
    const doc = ownerDocument(element);
    const win = ownerWindow(element);
    while (current && current !== doc.documentElement && current !== doc.body) {
        const { overflowY } = win.getComputedStyle(current);
        if (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") {
            return current;
        }
        current = current.parentElement;
    }
    return null;
}

interface Measurements {
    containerOffset: number;
    containerWidth: number;
    scrollY: number;
    windowHeight: number;
}

interface Layout {
    containerOffset: number;
    containerWidth: number;
    windowHeight: number;
}

const DEFAULT_MEASUREMENTS: Measurements = {
    containerOffset: 0,
    containerWidth: 0,
    scrollY: 0,
    windowHeight: 0,
};

function areMeasurementsEqual(first: Measurements, second: Measurements) {
    return (
        first.containerOffset === second.containerOffset &&
        first.containerWidth === second.containerWidth &&
        first.scrollY === second.scrollY &&
        first.windowHeight === second.windowHeight
    );
}

function useMeasurements(containerRef: React.RefObject<HTMLDivElement | null>) {
    const [measurements, setMeasurements] = React.useState<Measurements>(DEFAULT_MEASUREMENTS);
    const isScrollingRef = React.useRef(false);
    const shouldReadLayoutRef = React.useRef(true);
    const scrollElementRef = React.useRef<HTMLElement | null>(null);

    const scrollYTimeout = useTimeout();
    const animationFrame = useAnimationFrame();

    const sync = useStableCallback(() => {
        const container = containerRef.current;
        if (!container) {
            return;
        }

        const shouldReadLayout = shouldReadLayoutRef.current;
        shouldReadLayoutRef.current = false;

        const scrollElement = scrollElementRef.current;
        const win = ownerWindow(container);
        const scrollY = scrollElement ? scrollElement.scrollTop : win.scrollY;

        let layout: Layout | null = null;
        if (shouldReadLayout) {
            const containerRect = container.getBoundingClientRect();
            layout = scrollElement
                ? {
                      containerOffset:
                          containerRect.top -
                          scrollElement.getBoundingClientRect().top +
                          scrollY -
                          (parseFloat(win.getComputedStyle(scrollElement).borderTopWidth) || 0),
                      containerWidth: container.clientWidth,
                      windowHeight: scrollElement.clientHeight,
                  }
                : {
                      containerOffset: containerRect.top + scrollY,
                      containerWidth: container.clientWidth,
                      windowHeight: ownerDocument(container).documentElement.clientHeight,
                  };
        }

        const next: Measurements = {
            containerOffset: layout?.containerOffset ?? measurements.containerOffset,
            containerWidth: layout?.containerWidth ?? measurements.containerWidth,
            scrollY,
            windowHeight: layout?.windowHeight ?? measurements.windowHeight,
        };

        if (areMeasurementsEqual(measurements, next)) {
            return;
        }

        flushSync(() => {
            setMeasurements(next);
        });
    });

    const scheduleLayoutSync = useStableCallback(() => {
        shouldReadLayoutRef.current = true;
        animationFrame.request(sync);
    });

    const finishScrolling = useStableCallback(() => {
        isScrollingRef.current = false;
        scheduleLayoutSync();
    });

    const handleScroll = useStableCallback(() => {
        const wasScrolling = isScrollingRef.current;
        isScrollingRef.current = true;

        if (wasScrolling) {
            animationFrame.request(sync);
        } else {
            // First event of a gesture: geometry may have changed since the
            // previous scroll ended, so take a full reading.
            scheduleLayoutSync();
        }
        scrollYTimeout.start(SCROLL_TIMEOUT_MS, finishScrolling);
    });

    useIsoLayoutEffect(() => {
        const container = containerRef.current;
        if (!container) {
            return;
        }

        const win = ownerWindow(container);
        const scrollElement = findVerticalScrollParent(container);
        scrollElementRef.current = scrollElement;

        scheduleLayoutSync();

        const resizeObserver =
            typeof ResizeObserver === "function" ? new ResizeObserver(scheduleLayoutSync) : null;

        if (resizeObserver) {
            resizeObserver.observe(container);
            if (scrollElement) {
                resizeObserver.observe(scrollElement);
            }
            // Shifts originating outside the container (e.g. siblings growing)
            // move it without resizing it, leaving `containerOffset` stale.
            // Observe the full `offsetParent` chain above the container: a shift
            // displacing it almost always resizes one of these ancestors.
            let offsetAncestor = container.offsetParent as HTMLElement | null;
            if (!offsetAncestor) {
                // Not laid out yet (hidden) or fixed-positioned: keep a root sentinel
                // so late layout changes are still reported.
                offsetAncestor = ownerDocument(container).scrollingElement as HTMLElement | null;
            }
            while (offsetAncestor) {
                resizeObserver.observe(offsetAncestor);
                // Terminates at `<body>`/`<html>`, whose `offsetParent` is `null`.
                offsetAncestor = offsetAncestor.offsetParent as HTMLElement | null;
            }
        }

        return mergeCleanups(
            addEventListener(scrollElement ?? win, "scroll", handleScroll, { passive: true }),
            addEventListener(win, "resize", scheduleLayoutSync),
            addEventListener(win, "orientationchange", scheduleLayoutSync),
            win.visualViewport
                ? addEventListener(win.visualViewport, "resize", scheduleLayoutSync)
                : null,
            resizeObserver ? () => resizeObserver.disconnect() : null,
            () => {
                scrollElementRef.current = null;
                isScrollingRef.current = false;
            },
        );
    }, [containerRef, handleScroll, scheduleLayoutSync]);

    return {
        containerWidth: measurements.containerWidth,
        scrollTop: Math.max(0, measurements.scrollY - measurements.containerOffset),
        windowHeight: measurements.windowHeight,
    };
}

/* -------------------- Binding: registries, caches, and components -------------------- */

interface MasonryItemSlotProps
    extends React.HTMLAttributes<HTMLDivElement>, React.RefAttributes<HTMLDivElement> {
    [MasonryDataAttributes.index]?: number;
}

interface MasonrySlotAttributes extends MasonryItemSlotProps {
    [MasonryDataAttributes.slot]: string;
}

type ItemRefFork = ReturnType<typeof createItemRefFork>;

interface ItemRegistrationCache {
    callbacks: Map<number, ItemRefFork>;
    nodes: Map<number, HTMLDivElement>;
}

interface CachedItemElement {
    child: React.ReactElement<MasonryItemSlotProps>;
    cloned: React.ReactElement<MasonryItemSlotProps>;
    columnWidth: number;
    inert: boolean;
    item: PositionerItem | null;
    itemCount: number;
}

interface PendingItemMeasurement {
    height?: number;
    node: HTMLElement;
}

function isMasonryChildElement(
    node: React.ReactNode,
): node is React.ReactElement<MasonryItemSlotProps> {
    return React.isValidElement(node) && node.type !== React.Fragment;
}

function attachForkedRef(
    ref: React.Ref<HTMLDivElement> | undefined,
    node: HTMLDivElement,
): (() => void) | null {
    if (!ref) {
        return null;
    }
    if (typeof ref === "function") {
        const cleanup = ref(node);
        return typeof cleanup === "function" ? cleanup : () => ref(null);
    }
    ref.current = node;
    return () => {
        ref.current = null;
    };
}

function createItemRefFork(
    register: React.RefCallback<HTMLDivElement>,
    childRef: React.Ref<HTMLDivElement> | undefined,
) {
    let detach: (() => void) | null = null;
    const callback = (node: HTMLDivElement | null) => {
        detach?.();
        detach = null;
        if (node !== null) {
            detach = mergeCleanups(
                attachForkedRef(register, node),
                attachForkedRef(childRef, node),
            );
        }
    };
    return { callback, childRef };
}

function getMeasuredHeight(
    node: HTMLElement,
    measurement: PendingItemMeasurement | undefined,
): number {
    return measurement?.node === node && measurement.height !== undefined
        ? measurement.height
        : node.offsetHeight;
}

function commitPendingMeasurements(
    positioner: Positioner,
    registeredNodes: ReadonlyMap<number, HTMLDivElement>,
    pendingMeasurements: ReadonlyMap<number, PendingItemMeasurement>,
): boolean {
    const measuredItemCount = positioner.size();
    const updates: PositionerUpdate[] = [];
    let didChange = false;

    // Nodes register in order, so registrations consecutive to the measured
    // prefix are newly mounted items awaiting placement.
    for (let index = measuredItemCount; ; index += 1) {
        const node = registeredNodes.get(index);
        if (!node) {
            break;
        }

        positioner.set(getMeasuredHeight(node, pendingMeasurements.get(index)));
        didChange = true;
    }

    // Remaining updates target already-placed items; entries whose node was
    // unregistered or replaced in the meantime are stale and skipped.
    for (const [measurementIndex, measurement] of pendingMeasurements) {
        if (measurementIndex >= measuredItemCount) {
            continue;
        }
        if (registeredNodes.get(measurementIndex) !== measurement.node) {
            continue;
        }

        const item = positioner.get(measurementIndex);
        if (item === undefined) {
            continue;
        }

        const height = parseMeasuredItemHeight(getMeasuredHeight(measurement.node, measurement));
        if (height !== Math.round(item.height)) {
            updates.push({ height, index: measurementIndex });
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

function pruneMapEntries<K, V>(map: Map<K, V>, retainedKeys: ReadonlySet<K>) {
    for (const key of map.keys()) {
        if (!retainedKeys.has(key)) {
            map.delete(key);
        }
    }
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
}

/**
 * Groups all parts of the masonry layout.
 * Renders a `<div>` element.
 */
export function MasonryRoot(componentProps: MasonryRootProps): React.ReactElement {
    const {
        columnWidth = DEFAULT_COLUMN_WIDTH,
        columnCount,
        maxColumnCount: maxColumnCountProp,
        gap = DEFAULT_GAP,
        itemHeight = DEFAULT_ITEM_HEIGHT,
        overscan = DEFAULT_OVERSCAN,
        children: childrenProp,
        className,
        style: styleProp,
        render,
        ...elementProps
    } = componentProps;
    const containerRef = React.useRef<HTMLDivElement | null>(null);
    const { containerWidth, scrollTop, windowHeight } = useMeasurements(containerRef);

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

    const positionerRef = useRefWithInit(() => buildPositioner(latestOptions));
    const committedOptionsRef = useRefWithInit(() => latestOptions);
    const rerender = useForcedRerendering();
    const animationFrame = useAnimationFrame();
    const itemRegistrationCacheRef = useRefWithInit<ItemRegistrationCache>(() => ({
        callbacks: new Map(),
        nodes: new Map(),
    }));
    const pendingMeasurementsRef = React.useRef(new Map<number, PendingItemMeasurement>());
    const elementCacheRef = useRefWithInit<Map<number, CachedItemElement>>(() => new Map());
    const committedItemKeysRef = React.useRef<readonly (React.Key | null)[] | null>(null);
    const positioner = positionerRef.current;

    const commitQueuedMeasurements = useStableCallback(() => {
        const pendingMeasurements = pendingMeasurementsRef.current;
        pendingMeasurementsRef.current = new Map();

        const didChange = commitPendingMeasurements(
            positionerRef.current,
            itemRegistrationCacheRef.current.nodes,
            pendingMeasurements,
        );

        if (didChange) {
            flushSync(() => {
                rerender();
            });
        }
    });

    const queueMeasurementCommit = useStableCallback(
        (index: number, node: HTMLElement, measuredHeight?: number) => {
            pendingMeasurementsRef.current.set(index, {
                height: measuredHeight,
                node,
            });
            animationFrame.request(commitQueuedMeasurements);
        },
    );

    const itemIndexByNode = useRefWithInit(() => new WeakMap<Element, number>());

    const resizeObserver = useRefWithInit(() =>
        createItemResizeObserver(
            (node) => itemIndexByNode.current.get(node),
            (index) => itemRegistrationCacheRef.current.nodes.get(index),
            queueMeasurementCommit,
        ),
    ).current;

    useIsoLayoutEffect(() => () => resizeObserver?.disconnect(), [resizeObserver]);

    const unregisterItemNode = (node: HTMLDivElement) => {
        resizeObserver?.unobserve(node);
        itemIndexByNode.current.delete(node);
    };

    // React.Children.toArray is opaque to the React Compiler
    // so memoize manually to keep both arrays stable
    const validChildren = React.useMemo(
        () => React.Children.toArray(childrenProp).filter(isMasonryChildElement),
        [childrenProp],
    );
    const currentItemKeys = React.useMemo(
        () => validChildren.map((child) => child.key),
        [validChildren],
    );

    const registerItemNode = useStableCallback((index: number, node: HTMLDivElement | null) => {
        const registrationCache = itemRegistrationCacheRef.current;
        const previousNode = registrationCache.nodes.get(index);
        if (node === null) {
            if (previousNode) {
                unregisterItemNode(previousNode);
                registrationCache.nodes.delete(index);
                const pendingMeasurement = pendingMeasurementsRef.current.get(index);
                if (pendingMeasurement?.node === previousNode) {
                    pendingMeasurementsRef.current.delete(index);
                }
            }
            return;
        }

        // The same node can re-attach (e.g. restored from the element cache);
        // only re-measure when the positioner was rebuilt and lost this index.
        if (previousNode === node && positionerRef.current.get(index) !== undefined) {
            return;
        }
        if (previousNode && previousNode !== node) {
            unregisterItemNode(previousNode);
        }
        resizeObserver?.observe(node);
        registrationCache.nodes.set(index, node);
        itemIndexByNode.current.set(node, index);
        queueMeasurementCommit(index, node);
    });

    const onItemRegister = (index: number, childRef: React.Ref<HTMLDivElement> | undefined) => {
        const registrationCache = itemRegistrationCacheRef.current;
        const existingFork = registrationCache.callbacks.get(index);
        if (!existingFork || existingFork.childRef !== childRef) {
            const fork = createItemRefFork((node) => registerItemNode(index, node), childRef);
            registrationCache.callbacks.set(index, fork);
            return fork.callback;
        }
        return existingFork.callback;
    };

    const resetItemCaches = useStableCallback(() => {
        const registrationCache = itemRegistrationCacheRef.current;
        for (const node of registrationCache.nodes.values()) {
            resizeObserver?.unobserve(node);
            itemIndexByNode.current.delete(node);
        }
        registrationCache.callbacks.clear();
        registrationCache.nodes.clear();
        pendingMeasurementsRef.current.clear();
        elementCacheRef.current.clear();
    });

    useIsoLayoutEffect(() => {
        const shouldResetPositioner =
            committedItemKeysRef.current !== null &&
            !areItemKeysPrefixEqual(committedItemKeysRef.current, currentItemKeys);

        const shouldRebuildPositioner = committedOptionsRef.current !== latestOptions;

        committedItemKeysRef.current = currentItemKeys;
        committedOptionsRef.current = latestOptions;

        if (shouldResetPositioner || shouldRebuildPositioner) {
            if (shouldResetPositioner) {
                resetItemCaches();
            }

            positionerRef.current = shouldResetPositioner
                ? buildPositioner(latestOptions)
                : rebuildPositioner(positionerRef.current, latestOptions);

            rerender();
        }
    }, [resetItemCaches, currentItemKeys, latestOptions, rerender]);

    const firstUnmeasuredIndex = positioner.size();
    const shortestColumnSize = positioner.shortestColumn();

    const itemCount = validChildren.length;
    const normalizedOverscan =
        overscan === Infinity ? overscan : parseFiniteNumber(overscan, 0, DEFAULT_OVERSCAN);
    const overscanPixels = windowHeight > 0 ? windowHeight * normalizedOverscan : 0;

    const backwardOverscanPixels = overscanPixels * (1 - DEFAULT_FORWARD_OVERSCAN);
    const forwardOverscanPixels = overscanPixels * DEFAULT_FORWARD_OVERSCAN;

    const rangeStart = Math.max(0, scrollTop - backwardOverscanPixels);
    const rangeEnd = scrollTop + windowHeight + forwardOverscanPixels;

    // Items remain to batch in while the layout doesn't cover the window:
    // either nothing is placed yet, or the placed columns stop short of the
    // window's bottom edge.
    const windowNeedsMoreItems = firstUnmeasuredIndex === 0 || shortestColumnSize < rangeEnd;
    const isLayoutOutdated = windowNeedsMoreItems && firstUnmeasuredIndex < itemCount;

    const getItemStyle = (item: PositionerItem | null): React.CSSProperties => ({
        position: "absolute",
        width: positioner.columnWidth,
        writingMode: "horizontal-tb", // Match measurements to a horizontal axis under vertical-writing ancestors
        ...(item
            ? {
                  contentVisibility: "auto",
                  containIntrinsicHeight: `auto ${Math.max(1, Math.ceil(item.height))}px`,
                  left: item.left,
                  top: item.top,
              }
            : {
                  left: 0,
                  top: 0,
                  visibility: "hidden",
              }),
    });

    const positionedChildren: React.ReactElement[] = [];
    const appendedIndices = new Set<number>();

    const appendPositionedChild = (
        index: number,
        item: PositionerItem | null,
        options?: { inert?: boolean },
    ) => {
        const child = validChildren[index];
        if (!child) {
            return;
        }

        const elementCache = elementCacheRef.current;
        const inert = options?.inert === true;
        const cached = elementCache.get(index);
        if (
            !cached ||
            cached.child !== child ||
            cached.item !== item ||
            cached.columnWidth !== positioner.columnWidth ||
            cached.inert !== inert ||
            cached.itemCount !== itemCount
        ) {
            const cloned = React.cloneElement(child, {
                [MasonryDataAttributes.index]: index,
                ref: onItemRegister(index, child.props.ref),
                // The window is a slice of the list; keep the announced size/position intact
                "aria-posinset": index + 1,
                "aria-setsize": itemCount,
                ...(inert && { inert }),
                style: {
                    ...child.props.style,
                    ...getItemStyle(item),
                },
            });
            elementCache.set(index, {
                child,
                cloned,
                columnWidth: positioner.columnWidth,
                inert,
                item,
                itemCount,
            });
            positionedChildren.push(cloned);
        } else {
            positionedChildren.push(cached.cloned);
        }
        appendedIndices.add(index);
    };

    positioner.range(rangeStart, rangeEnd, (item) => {
        appendPositionedChild(item.index, item);
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
            const end = Math.min(itemCount, firstUnmeasuredIndex + batchSize);
            for (let index = firstUnmeasuredIndex; index < end; index += 1) {
                appendPositionedChild(index, null, { inert: true });
            }
        }
    }

    useIsoLayoutEffect(() => {
        if (elementCacheRef.current.size > positionedChildren.length * 2 + CACHE_PRUNE_SLACK) {
            pruneMapEntries(elementCacheRef.current, appendedIndices);
            pruneMapEntries(itemRegistrationCacheRef.current.callbacks, appendedIndices);
        }
    });

    const height = Math.ceil(positioner.estimateHeight(itemCount, normalizedItemHeight));

    const rootProps: MasonrySlotAttributes = {
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
        props: [rootProps, elementProps],
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

    const itemProps: MasonrySlotAttributes = {
        [MasonryDataAttributes.slot]: "masonry-item",
        role: "listitem",
    };

    return useRenderElement("div", componentProps, {
        props: [itemProps, elementProps],
    });
}
