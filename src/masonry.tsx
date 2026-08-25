/**
 * @see https://github.com/rortan134/base-ui-masonry
 */
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
    scrollElementOrRef: HTMLElement | undefined | null | React.RefObject<HTMLElement | null>,
) {
    const [measurements, setMeasurements] = React.useState<Measurements>(DEFAULT_MEASUREMENTS);
    const animationFrame = useAnimationFrame();

    const sync = useStableCallback(() => {
        const container = containerRef.current;
        if (!container) {
            return;
        }

        const scrollElement =
            scrollElementOrRef != null && "current" in scrollElementOrRef
                ? scrollElementOrRef.current
                : (scrollElementOrRef as HTMLElement | null);
        const win = ownerWindow(container);
        const scrollY = scrollElement ? scrollElement.scrollTop : win.scrollY;

        const containerRect = container.getBoundingClientRect();
        const next: Measurements = scrollElement
            ? {
                  containerOffset:
                      containerRect.top -
                      scrollElement.getBoundingClientRect().top +
                      scrollY -
                      scrollElement.clientTop,
                  containerWidth: container.clientWidth,
                  scrollY,
                  windowHeight: scrollElement.clientHeight,
              }
            : {
                  containerOffset: containerRect.top + scrollY,
                  containerWidth: container.clientWidth,
                  scrollY,
                  windowHeight: ownerDocument(container).documentElement.clientHeight,
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

        const scrollElement =
            scrollElementOrRef != null && "current" in scrollElementOrRef
                ? scrollElementOrRef.current
                : (scrollElementOrRef as HTMLElement | null);

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
    }, [containerRef, scheduleLayoutSync, scrollElementOrRef]);

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

interface PendingItemMeasurement {
    height: number;
    node: HTMLElement;
}

function isSamePlacement(a: PositionerItem | null, b: PositionerItem | null) {
    if (a === b) {
        return true;
    }
    return (
        a !== null && b !== null && a.left === b.left && a.top === b.top && a.height === b.height
    );
}

function isMasonryChildElement(
    node: React.ReactNode,
): node is React.ReactElement<MasonryItemSlotProps> {
    return React.isValidElement(node) && node.type !== React.Fragment;
}

interface ItemSlotProps {
    /**
     * Bumped whenever item caches are reset. Item re-registration relies on the
     * item ref callback identity changing
     */
    cacheEpoch: number;
    child: React.ReactElement<MasonryItemSlotProps>;
    columnWidth: number;
    index: number;
    inert: boolean;
    itemCount: number;
    item: PositionerItem | null;
    register: (index: number, node: HTMLDivElement | null) => void;
}

function areItemSlotPropsEqual(previous: ItemSlotProps, next: ItemSlotProps): boolean {
    return (
        previous.cacheEpoch === next.cacheEpoch &&
        previous.child === next.child &&
        previous.columnWidth === next.columnWidth &&
        previous.index === next.index &&
        previous.inert === next.inert &&
        previous.itemCount === next.itemCount &&
        previous.register === next.register &&
        isSamePlacement(previous.item, next.item)
    );
}

const ItemSlot = React.memo(function ItemSlot({
    cacheEpoch,
    child,
    columnWidth,
    index,
    inert,
    itemCount,
    item,
    register,
}: ItemSlotProps): React.ReactElement {
    const childRef = child.props.ref;
    const registerNode = React.useCallback(
        (node: HTMLDivElement | null) => {
            // Read deliberately so exhaustive-deps keeps the dep
            void cacheEpoch;
            register(index, node);
        },
        [cacheEpoch, index, register],
    );
    const itemRef = useMergedRefs(registerNode, childRef);
    const style: React.CSSProperties = {
        position: "absolute",
        width: columnWidth,
        writingMode: "horizontal-tb",
        left: 0,
        top: 0,
        ...(item
            ? {
                  contentVisibility: "auto",
                  containIntrinsicHeight: `auto ${Math.max(1, Math.ceil(item.height))}px`,
                  transform: `translateX(${item.left}px) translateY(${item.top}px)`,
              }
            : { visibility: "hidden" }),
    };

    return React.cloneElement(child, {
        [MasonryDataAttributes.index]: index,
        ref: itemRef,
        "aria-posinset": index + 1,
        "aria-setsize": itemCount,
        ...(inert && { inert }),
        style: { ...style, ...child.props.style },
    });
}, areItemSlotPropsEqual);

function commitPendingMeasurements(
    positioner: Positioner,
    registeredNodes: ReadonlyMap<number, HTMLDivElement>,
    pendingMeasurements: ReadonlyMap<number, PendingItemMeasurement>,
): boolean {
    const measuredItemCount = positioner.size();
    const updates: PositionerUpdate[] = [];
    let didChange = false;

    for (let index = measuredItemCount; ; index += 1) {
        const node = registeredNodes.get(index);
        if (!node) {
            break;
        }

        const measurement = pendingMeasurements.get(index);
        positioner.set(
            measurement && measurement.node === node ? measurement.height : node.offsetHeight,
        );
        didChange = true;
    }

    for (const [measurementIndex, measurement] of pendingMeasurements) {
        const item = positioner.get(measurementIndex);
        if (item === undefined || registeredNodes.get(measurementIndex) !== measurement.node) {
            continue;
        }
        if (measurement.height !== item.height) {
            updates.push({ height: measurement.height, index: measurementIndex });
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
     * Scroll container whose scroll position drives windowing. Accepts an element or a ref to one.
     * @default window
     */
    container?: HTMLElement | null | React.RefObject<HTMLElement | null>;
}

/**
 * Groups all parts of the masonry layout.
 * Renders a `<div>` element.
 */
export function MasonryRoot(componentProps: MasonryRootProps): React.ReactElement {
    const {
        children: childrenProp,
        columnCount,
        columnWidth = DEFAULT_COLUMN_WIDTH,
        gap = DEFAULT_GAP,
        itemHeight = DEFAULT_ITEM_HEIGHT,
        maxColumnCount: maxColumnCountProp,
        overscan = DEFAULT_OVERSCAN,
        container,
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

    const committedItemKeysRef = React.useRef<readonly (React.Key | null)[] | null>(null);
    const positionerRef = useRefWithInit(() => buildPositioner(latestOptions));
    const committedOptionsRef = useRefWithInit(() => latestOptions);
    const committedResolvedOptionsRef = useRefWithInit(() => parsePositionerOptions(latestOptions));
    const pendingMeasurementsRef = useRefWithInit(() => new Map<number, PendingItemMeasurement>());
    const registeredNodesRef = useRefWithInit(() => new Map<number, HTMLDivElement>());
    const cacheEpochRef = useRefWithInit(() => ({ value: 0 }));
    const cacheEpoch = cacheEpochRef.current.value;
    const positioner = positionerRef.current;

    // React.Children.toArray is opaque to the React Compiler,
    // so memoize manually to keep both arrays stable
    const validChildren = React.useMemo(
        () => React.Children.toArray(childrenProp).filter(isMasonryChildElement),
        [childrenProp],
    );
    const currentItemKeys = React.useMemo(
        () => validChildren.map((child) => child.key),
        [validChildren],
    );
    const itemCount = validChildren.length;

    const commitQueuedMeasurements = useStableCallback(() => {
        const pendingMeasurements = pendingMeasurementsRef.current;
        pendingMeasurementsRef.current = new Map();

        const didChange = commitPendingMeasurements(
            positionerRef.current,
            registeredNodesRef.current,
            pendingMeasurements,
        );

        if (didChange) {
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

    const itemIndexByNode = useRefWithInit(() => new WeakMap<Element, number>());

    const resizeObserver = useRefWithInit(() =>
        createItemResizeObserver(
            (node) => itemIndexByNode.current.get(node),
            (index) => registeredNodesRef.current.get(index),
            queueMeasurementCommit,
        ),
    ).current;

    useIsoLayoutEffect(() => () => resizeObserver?.disconnect(), [resizeObserver]);

    const unregisterItemNode = (node: HTMLDivElement) => {
        resizeObserver?.unobserve(node);
        itemIndexByNode.current.delete(node);
    };

    const registerItemNode = useStableCallback((index: number, node: HTMLDivElement | null) => {
        const registeredNodes = registeredNodesRef.current;
        const previousNode = registeredNodes.get(index);
        if (node === null) {
            if (previousNode) {
                unregisterItemNode(previousNode);
                registeredNodes.delete(index);
                const pendingMeasurement = pendingMeasurementsRef.current.get(index);
                if (pendingMeasurement?.node === previousNode) {
                    pendingMeasurementsRef.current.delete(index);
                }
            }
            return;
        }

        // The same node can re-attach without having unmounted; only re-measure
        // when the positioner was rebuilt and lost this index.
        if (previousNode === node && positionerRef.current.get(index) !== undefined) {
            return;
        }
        if (previousNode && previousNode !== node) {
            unregisterItemNode(previousNode);
        }
        resizeObserver?.observe(node);
        registeredNodes.set(index, node);
        itemIndexByNode.current.set(node, index);
        queueMeasurementCommit(index, node, node.offsetHeight);
    });

    const resetItemCaches = useStableCallback(() => {
        const registeredNodes = registeredNodesRef.current;
        for (const node of registeredNodes.values()) {
            resizeObserver?.unobserve(node);
            itemIndexByNode.current.delete(node);
        }
        registeredNodes.clear();
        pendingMeasurementsRef.current.clear();
        cacheEpochRef.current.value += 1;
    });

    useIsoLayoutEffect(() => {
        const shouldResetPositioner =
            committedItemKeysRef.current !== null &&
            !areItemKeysPrefixEqual(committedItemKeysRef.current, currentItemKeys);

        const nextResolvedOptions = parsePositionerOptions(latestOptions);
        const committedResolvedOptions = committedResolvedOptionsRef.current;

        const shouldRebuildPositioner =
            !shouldResetPositioner &&
            committedOptionsRef.current !== latestOptions &&
            !areResolvedOptionsEqual(committedResolvedOptions, nextResolvedOptions);

        committedItemKeysRef.current = currentItemKeys;
        committedOptionsRef.current = latestOptions;
        committedResolvedOptionsRef.current = nextResolvedOptions;

        if (shouldResetPositioner || shouldRebuildPositioner) {
            if (shouldResetPositioner) {
                warn(
                    "MasonryRoot: item keys changed by more than appending (reorder, insertion, or removal), so all layout measurements were reset. Provide stable `key`s and limit updates to appending items.",
                );
                resetItemCaches();
            }

            positionerRef.current = shouldResetPositioner
                ? buildPositioner(latestOptions)
                : rebuildPositioner(positionerRef.current, latestOptions);

            rerender();
        }
    }, [currentItemKeys, latestOptions, rerender, resetItemCaches]);

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
                cacheEpoch={cacheEpoch}
                child={child}
                columnWidth={positioner.columnWidth}
                index={index}
                inert={inert}
                itemCount={itemCount}
                item={item}
                register={registerItemNode}
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
