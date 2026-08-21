"use client";

import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { addEventListener } from "@base-ui/utils/addEventListener";
import { mergeCleanups } from "@base-ui/utils/mergeCleanups";
import { ownerDocument, ownerWindow } from "@base-ui/utils/owner";
import { useAnimationFrame } from "@base-ui/utils/useAnimationFrame";
import { useForcedRerendering } from "@base-ui/utils/useForcedRerendering";
import { useIsoLayoutEffect } from "@base-ui/utils/useIsoLayoutEffect";
import { useRefWithInit } from "@base-ui/utils/useRefWithInit";
import { useStableCallback } from "@base-ui/utils/useStableCallback";
import { useTimeout } from "@base-ui/utils/useTimeout";
import * as React from "react";

const DEFAULT_COLUMN_WIDTH = 200;

const DEFAULT_GAP = 0;

const DEFAULT_ITEM_HEIGHT = 300;

const DEFAULT_OVERSCAN = 2;

// content-visibility's paint containment can clip MasonryItem, so the overflow
// clip edge can be widened by this margin
const ITEM_OVERFLOW_CLIP_MARGIN = "0.5rem";

// 100 ms without scroll events ≈ scroll end
// https://developer.mozilla.org/en-US/docs/Web/API/Element/scrollend_event
const SCROLL_TIMEOUT_MS = 100;

// Range queries visit every column, so keep their logarithmic work bounded
const INTERNAL_MAX_COLUMN_COUNT = 16;

// Max excess of the preferred column over the shortest column, in item heights
const MAX_COLUMN_SKEW_RATIO = 2.5;

// Keeps hidden measurement items below all content so they never paint
const HIDDEN_ITEM_Z_INDEX = -1000;

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

interface PositionerItem {
    readonly columnIndex: number;
    readonly columnItemIndex: number;
    readonly height: number;
    readonly index: number;
    readonly left: number;
    readonly top: number;
}

interface PositionerUpdate {
    height: number;
    item: PositionerItem;
}

interface PositionerOptions {
    columnCount?: number;
    columnWidth?: number;
    containerWidth: number;
    horizontalGap?: number;
    maxColumnCount: number;
    verticalGap?: number;
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
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

function getColumnHeight(columns: PositionerItem[][], columnIndex: number): number {
    const items = getColumnItems(columns, columnIndex);
    const lastItem = items.at(-1);
    return lastItem ? lastItem.top + lastItem.height : 0;
}

function findLowerBound(
    items: readonly PositionerItem[],
    predicate: (item: PositionerItem) => boolean,
): number {
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

function findFirstOverlappingItem(items: readonly PositionerItem[], low: number): number {
    // Nonnegative heights and gaps keep item tops sorted within each column
    const start = findLowerBound(items, (item) => item.top >= low);
    const previousItem = items[start - 1];
    return previousItem !== undefined && previousItem.top + previousItem.height >= low
        ? start - 1
        : start;
}

function buildPositioner({
    columnCount,
    horizontalGap,
    columnWidth = DEFAULT_COLUMN_WIDTH,
    containerWidth,
    maxColumnCount,
    verticalGap,
}: PositionerOptions) {
    const normalizedColumnGap = parseFiniteNumber(horizontalGap, 0, DEFAULT_GAP);
    const normalizedRowGap = parseFiniteNumber(verticalGap ?? normalizedColumnGap, 0, DEFAULT_GAP);
    const normalizedContainerWidth = parsePositiveFiniteNumber(containerWidth, 0);
    const normalizedColumnWidth = parsePositiveFiniteNumber(columnWidth, DEFAULT_COLUMN_WIDTH);
    const derivedColumnCount = Math.min(
        Math.floor(
            (normalizedContainerWidth + normalizedColumnGap) /
                (normalizedColumnWidth + normalizedColumnGap),
        ),
        maxColumnCount,
    );
    const requestedColumnCount =
        (typeof columnCount === "number" && Number.isFinite(columnCount) && columnCount !== 0
            ? columnCount
            : derivedColumnCount) || 1;
    const resolvedColumnCount = clamp(
        Math.floor(requestedColumnCount),
        1,
        INTERNAL_MAX_COLUMN_COUNT,
    );
    const resolvedColumnWidth = Math.max(
        0,
        Math.floor(
            (normalizedContainerWidth - normalizedColumnGap * (resolvedColumnCount - 1)) /
                resolvedColumnCount,
        ),
    );

    const items: PositionerItem[] = [];
    const columnItems: PositionerItem[][] = Array.from({ length: resolvedColumnCount }, () => []);

    const getColumnHeights = () =>
        columnItems.map((_, columnIndex) => getColumnHeight(columnItems, columnIndex));

    return {
        columnCount: resolvedColumnCount,
        columnWidth: resolvedColumnWidth,
        estimateHeight: (itemCount: number, defaultItemHeight: number) => {
            const tallestColumn = Math.max(...getColumnHeights());

            const remainingItemCount = Math.max(0, itemCount - items.length);
            const remainingRowCount = Math.ceil(remainingItemCount / resolvedColumnCount);
            return tallestColumn + remainingRowCount * (defaultItemHeight + normalizedRowGap);
        },
        get: (index: number) => items[index],
        range: (low: number, high: number, visitItem: (item: PositionerItem) => void) => {
            for (const columnItemsList of columnItems) {
                const start = findFirstOverlappingItem(columnItemsList, low);
                for (let index = start; index < columnItemsList.length; index += 1) {
                    const item = getColumnItem(columnItemsList, index);
                    if (item.top > high) {
                        break;
                    }
                    visitItem(item);
                }
            }
        },
        reset: () => {
            items.length = 0;
            for (const columnItemsList of columnItems) {
                columnItemsList.length = 0;
            }
        },
        set: (height: number) => {
            const itemHeight = parsePositiveFiniteNumber(height, 0);
            const preferredColumn = items.length % resolvedColumnCount;
            const columnHeights = getColumnHeights();

            let shortestHeight = Number.POSITIVE_INFINITY;
            let shortestIndex = 0;
            for (const [columnIndex, columnHeight] of columnHeights.entries()) {
                if (columnHeight < shortestHeight) {
                    shortestHeight = columnHeight;
                    shortestIndex = columnIndex;
                }
            }

            const preferredHeight = getColumnHeight(columnItems, preferredColumn) + itemHeight;
            const maxAllowedHeight = shortestHeight + itemHeight * MAX_COLUMN_SKEW_RATIO;
            const columnIndex =
                preferredHeight <= maxAllowedHeight ? preferredColumn : shortestIndex;
            const columnItemsList = getColumnItems(columnItems, columnIndex);
            const top =
                columnItemsList.length > 0
                    ? getColumnHeight(columnItems, columnIndex) + normalizedRowGap
                    : 0;

            const item: PositionerItem = {
                columnIndex,
                columnItemIndex: columnItemsList.length,
                height: itemHeight,
                index: items.length,
                left: columnIndex * (resolvedColumnWidth + normalizedColumnGap),
                top,
            };
            items.push(item);
            columnItemsList.push(item);
        },
        shortestColumn: () => Math.min(...getColumnHeights()),
        size: () => items.length,
        update: (updates: readonly PositionerUpdate[]) => {
            const nextHeights = new Map<number, number>();
            const firstChangedIndexByColumn = new Map<number, number>();

            for (const update of updates) {
                const previousItem = update.item;
                if (items[previousItem.index] !== previousItem) {
                    continue;
                }
                const itemHeight = parsePositiveFiniteNumber(update.height, 0);
                nextHeights.set(previousItem.index, itemHeight);
                const previousFirstChangedIndex = firstChangedIndexByColumn.get(
                    previousItem.columnIndex,
                );
                if (
                    previousFirstChangedIndex === undefined ||
                    previousItem.index < previousFirstChangedIndex
                ) {
                    firstChangedIndexByColumn.set(previousItem.columnIndex, previousItem.index);
                }
            }

            for (const [columnIndex, firstChangedIndex] of firstChangedIndexByColumn) {
                const columnItemsList = getColumnItems(columnItems, columnIndex);
                const firstItem = getColumnItem(items, firstChangedIndex);
                let top = firstItem.top;
                for (
                    let itemIndex = firstItem.columnItemIndex;
                    itemIndex < columnItemsList.length;
                    itemIndex += 1
                ) {
                    const previousItem = getColumnItem(columnItemsList, itemIndex);
                    const height = nextHeights.get(previousItem.index) ?? previousItem.height;
                    const nextItem: PositionerItem = {
                        ...previousItem,
                        height,
                        top,
                    };
                    columnItemsList[itemIndex] = nextItem;
                    items[previousItem.index] = nextItem;
                    top += height + normalizedRowGap;
                }
            }
        },
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

function arePositionerOptionsEqual(first: PositionerOptions, second: PositionerOptions) {
    return (
        first.columnCount === second.columnCount &&
        first.horizontalGap === second.horizontalGap &&
        first.columnWidth === second.columnWidth &&
        first.containerWidth === second.containerWidth &&
        first.maxColumnCount === second.maxColumnCount &&
        first.verticalGap === second.verticalGap
    );
}

function createResizeObserver(
    getRegisteredNode: (index: number) => Element | undefined,
    onMeasurementUpdate: (index: number, node: HTMLElement, height: number) => void,
): ResizeObserver | null {
    if (typeof ResizeObserver !== "function") {
        return null;
    }

    function handleResizeObserver(entries: ResizeObserverEntry[]) {
        const targetWindow = ownerWindow(entries[0]?.target);

        for (const entry of entries) {
            if (!(entry.target instanceof targetWindow.HTMLElement)) {
                continue;
            }

            // Mirrors MasonryDataAttributes.index written onto items by MasonryRoot
            const entryIndex = Number.parseInt(entry.target.dataset.index ?? "", 10);
            if (Number.isNaN(entryIndex) || getRegisteredNode(entryIndex) !== entry.target) {
                continue;
            }

            const blockSize = entry.borderBoxSize?.[0]?.blockSize;
            const height =
                typeof blockSize === "number" && Number.isFinite(blockSize)
                    ? Math.round(blockSize)
                    : entry.target.offsetHeight;

            onMeasurementUpdate(entryIndex, entry.target, height);
        }
    }

    return new ResizeObserver(handleResizeObserver);
}

interface Measurements {
    containerOffset: number;
    containerWidth: number;
    isScrolling: boolean;
    scrollY: number;
    windowHeight: number;
}

const INITIAL_MEASUREMENTS: Measurements = {
    containerOffset: 0,
    containerWidth: 0,
    isScrolling: false,
    scrollY: 0,
    windowHeight: 0,
};

function areMeasurementsEqual(first: Measurements, second: Measurements) {
    return (
        first.isScrolling === second.isScrolling &&
        first.containerOffset === second.containerOffset &&
        first.containerWidth === second.containerWidth &&
        first.scrollY === second.scrollY &&
        first.windowHeight === second.windowHeight
    );
}

function useMeasurements(containerRef: React.RefObject<RootElement | null>) {
    const [measurements, setMeasurements] = React.useState<Measurements>(INITIAL_MEASUREMENTS);
    const scrollYTimeout = useTimeout();
    const animationFrame = useAnimationFrame();
    const isScrollingRef = React.useRef(false);
    const shouldReadLayoutRef = React.useRef(true);

    const syncMeasurements = useStableCallback(() => {
        const container = containerRef.current;
        if (!container) {
            return;
        }

        const shouldReadLayout = shouldReadLayoutRef.current;
        shouldReadLayoutRef.current = false;

        const isScrolling = isScrollingRef.current;
        const scrollY =
            ownerWindow(container).scrollY ?? ownerDocument(container).documentElement.scrollTop;

        // Layout reads stay outside the state updater, which React may invoke twice
        const layoutFields = shouldReadLayout
            ? {
                  containerOffset: container.getBoundingClientRect().top + scrollY,
                  containerWidth: container.clientWidth,
                  windowHeight: ownerDocument(container).documentElement.clientHeight,
              }
            : null;

        setMeasurements((previous) => {
            const next: Measurements = {
                containerOffset: layoutFields?.containerOffset ?? previous.containerOffset,
                containerWidth: layoutFields?.containerWidth ?? previous.containerWidth,
                isScrolling,
                scrollY,
                windowHeight: layoutFields?.windowHeight ?? previous.windowHeight,
            };
            return areMeasurementsEqual(previous, next) ? previous : next;
        });
    });

    const scheduleScrollSync = useStableCallback(() => {
        animationFrame.request(syncMeasurements);
    });

    const scheduleLayoutSync = useStableCallback(() => {
        shouldReadLayoutRef.current = true;
        scheduleScrollSync();
    });

    const finishScrolling = useStableCallback(() => {
        isScrollingRef.current = false;
        scheduleLayoutSync();
    });

    const handleScroll = useStableCallback(() => {
        const wasScrolling = isScrollingRef.current;
        isScrollingRef.current = true;

        if (wasScrolling) {
            scheduleScrollSync();
        } else {
            scheduleLayoutSync();
        }
        scrollYTimeout.start(SCROLL_TIMEOUT_MS, finishScrolling);
    });

    const handleResize = useStableCallback(() => {
        scheduleLayoutSync();
    });

    useIsoLayoutEffect(() => {
        const container = containerRef.current;
        if (!container) {
            return;
        }
        scheduleLayoutSync();

        const resizeObserver =
            typeof ResizeObserver === "function" ? new ResizeObserver(handleResize) : null;

        if (resizeObserver) {
            resizeObserver.observe(container);
            const offsetParent =
                container.offsetParent ?? ownerDocument(container).scrollingElement;
            if (offsetParent && offsetParent !== container) {
                resizeObserver.observe(offsetParent);
            }
        }

        const win = ownerWindow(container);
        return mergeCleanups(
            addEventListener(win, "scroll", handleScroll, { passive: true }),
            addEventListener(win, "resize", handleResize),
            addEventListener(win, "orientationchange", handleResize),
            win.visualViewport
                ? addEventListener(win.visualViewport, "resize", handleResize)
                : null,
            resizeObserver ? () => resizeObserver.disconnect() : null,
        );
    }, [
        animationFrame,
        containerRef,
        handleResize,
        handleScroll,
        scheduleLayoutSync,
        scheduleScrollSync,
    ]);

    return {
        containerWidth: measurements.containerWidth,
        isScrolling: measurements.isScrolling,
        scrollTop: Math.max(0, measurements.scrollY - measurements.containerOffset),
        windowHeight: measurements.windowHeight,
    };
}

type RootElement = HTMLDivElement;

type ItemElement = HTMLDivElement;

interface MasonryChildProps extends React.ComponentProps<"div"> {
    [MasonryDataAttributes.index]?: number;
}

interface ItemRegistrationCache {
    callbacks: Map<number, React.RefCallback<ItemElement>>;
    nodes: Map<number, ItemElement>;
}

interface PendingItemMeasurement {
    height?: number;
    node: HTMLElement;
}

type MasonrySlotProps = useRender.ElementProps<"div"> & {
    [MasonryDataAttributes.slot]: string;
};

function isMasonryChildElement(
    node: React.ReactNode,
): node is React.ReactElement<MasonryChildProps> {
    return React.isValidElement(node);
}

function commitPendingMeasurements(
    positioner: Positioner,
    registeredNodes: ReadonlyMap<number, ItemElement>,
    pendingMeasurements: ReadonlyMap<number, PendingItemMeasurement>,
): boolean {
    const measuredItemCount = positioner.size();
    const updates: PositionerUpdate[] = [];
    let didChange = false;

    // Newly registered nodes are contiguous by index; a gap simply ends the
    // batch and later items are picked up once their predecessors register
    for (let index = measuredItemCount; registeredNodes.has(index); index += 1) {
        const node = registeredNodes.get(index);
        if (!node) {
            break;
        }

        const measurement = pendingMeasurements.get(index);
        const height =
            measurement?.node === node && measurement.height !== undefined
                ? measurement.height
                : node.offsetHeight;
        positioner.set(height);
        didChange = true;
    }

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
        const height = measurement.height ?? measurement.node.offsetHeight;
        if (height !== Math.round(item.height)) {
            updates.push({ height, item });
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
    if (previousKeys === nextKeys) {
        return true;
    }
    if (previousKeys.length > nextKeys.length) {
        return false;
    }
    for (let i = 0; i < previousKeys.length; i += 1) {
        if (previousKeys[i] !== nextKeys[i]) {
            return false;
        }
    }
    return true;
}

function parseGapDirectionalValues(gap?: number | { horizontal: number; vertical: number }) {
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

interface MasonryRootProps extends useRender.ComponentProps<"div"> {
    /** Fixed number of columns. Ignored when unset; column count is derived from `columnWidth` and the container width. */
    columnCount?: number;
    /** Preferred column width used to derive the column count (unless `columnCount` is set). Items always stretch to fill their column. */
    columnWidth?: number;
    gap?: number | { horizontal: number; vertical: number };
    /** Assumed average item height used to estimate container height and batch sizes while items are still being measured. */
    itemHeight?: number;
    /** Maximum number of columns derived from `columnWidth`. Non-finite or non-positive values are treated as uncapped; the internal cap always applies. */
    maxColumnCount?: number;
    /** Viewport-height multiplier controlling how far beyond the visible area items are rendered/unmeasured items are batched. */
    overscan?: number;
}

export function MasonryRoot({
    columnWidth = DEFAULT_COLUMN_WIDTH,
    columnCount,
    maxColumnCount,
    gap = DEFAULT_GAP,
    itemHeight = DEFAULT_ITEM_HEIGHT,
    overscan = DEFAULT_OVERSCAN,
    children: childrenProp,
    style: styleProp,
    render,
    ...props
}: MasonryRootProps): React.ReactElement {
    const containerRef = React.useRef<RootElement | null>(null);
    const { containerWidth, isScrolling, scrollTop, windowHeight } = useMeasurements(containerRef);

    const { horizontalGap, verticalGap } = parseGapDirectionalValues(gap);
    const normalizedItemHeight = parseFiniteNumber(itemHeight, 1, DEFAULT_ITEM_HEIGHT);
    const normalizedMaxColumnCount = parsePositiveFiniteNumber(
        maxColumnCount,
        Number.POSITIVE_INFINITY,
    );

    const latestOptions: PositionerOptions = {
        columnCount,
        columnWidth,
        containerWidth,
        horizontalGap,
        maxColumnCount: normalizedMaxColumnCount,
        verticalGap,
    };

    const positionerRef = useRefWithInit(() => buildPositioner(latestOptions));
    const committedOptionsRef = useRefWithInit(() => latestOptions);
    const rerender = useForcedRerendering();
    const animationFrame = useAnimationFrame();
    const itemRegistrationCacheRef = useRefWithInit<ItemRegistrationCache>(() => ({
        callbacks: new Map(),
        nodes: new Map(),
    }));
    const pendingMeasurementsRef = React.useRef(new Map<number, PendingItemMeasurement>());
    const shouldRerenderRef = React.useRef(false);
    const committedItemKeysRef = React.useRef<readonly (React.Key | null)[] | null>(null);

    const positioner = positionerRef.current;

    const commitMeasurements = useStableCallback(() => {
        const pendingMeasurements = pendingMeasurementsRef.current;
        pendingMeasurementsRef.current = new Map();

        const didChange = commitPendingMeasurements(
            positionerRef.current,
            itemRegistrationCacheRef.current.nodes,
            pendingMeasurements,
        );

        const shouldRerender = shouldRerenderRef.current;
        shouldRerenderRef.current = false;

        if (didChange || shouldRerender) {
            rerender();
        }
    });

    const scheduleMeasurementsChanged = useStableCallback((shouldRerender = false) => {
        shouldRerenderRef.current ||= shouldRerender;
        animationFrame.request(commitMeasurements);
    });

    const getRegisteredNode = useStableCallback((index: number) =>
        itemRegistrationCacheRef.current.nodes.get(index),
    );

    const queueItemMeasurement = useStableCallback(
        (index: number, node: HTMLElement, measuredHeight?: number) => {
            pendingMeasurementsRef.current.set(index, {
                height: measuredHeight,
                node,
            });
            scheduleMeasurementsChanged();
        },
    );

    const resizeObserver = useRefWithInit(() =>
        createResizeObserver(getRegisteredNode, queueItemMeasurement),
    ).current;

    useIsoLayoutEffect(() => () => resizeObserver?.disconnect(), [resizeObserver]);

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

    const registerItemNode = useStableCallback((index: number, node: ItemElement | null) => {
        const registrationCache = itemRegistrationCacheRef.current;
        const previousNode = registrationCache.nodes.get(index);
        if (node === null) {
            if (previousNode) {
                resizeObserver?.unobserve(previousNode);
                registrationCache.nodes.delete(index);
                const pendingMeasurement = pendingMeasurementsRef.current.get(index);
                if (pendingMeasurement?.node === previousNode) {
                    pendingMeasurementsRef.current.delete(index);
                }
            }
            return;
        }

        const position = positionerRef.current.get(index);
        if (previousNode === node && position !== undefined) {
            return;
        }
        if (previousNode && previousNode !== node) {
            resizeObserver?.unobserve(previousNode);
        }
        resizeObserver?.observe(node);
        registrationCache.nodes.set(index, node);
        queueItemMeasurement(index, node);
    });

    const onItemRegister = (index: number) => {
        const existingCallback = itemRegistrationCacheRef.current.callbacks.get(index);
        if (existingCallback) {
            return existingCallback;
        }
        const nextCallback: React.RefCallback<ItemElement> = (node) => {
            registerItemNode(index, node);
        };
        itemRegistrationCacheRef.current.callbacks.set(index, nextCallback);
        return nextCallback;
    };

    const resetPositioner = useStableCallback(() => {
        resizeObserver?.disconnect();
        positionerRef.current.reset();
        itemRegistrationCacheRef.current.callbacks.clear();
        itemRegistrationCacheRef.current.nodes.clear();
        pendingMeasurementsRef.current.clear();
    });

    useIsoLayoutEffect(() => {
        const shouldResetPositioner =
            committedItemKeysRef.current !== null &&
            !areItemKeysPrefixEqual(committedItemKeysRef.current, currentItemKeys);

        const shouldRebuildPositioner = !arePositionerOptionsEqual(
            committedOptionsRef.current,
            latestOptions,
        );

        committedItemKeysRef.current = currentItemKeys;
        committedOptionsRef.current = latestOptions;

        if (shouldResetPositioner) {
            resetPositioner();
        }

        if (shouldRebuildPositioner) {
            positionerRef.current = shouldResetPositioner
                ? buildPositioner(latestOptions)
                : rebuildPositioner(positionerRef.current, latestOptions);
        }

        if (shouldResetPositioner || shouldRebuildPositioner) {
            scheduleMeasurementsChanged(true);
        }
    }, [currentItemKeys, latestOptions, resetPositioner, scheduleMeasurementsChanged]);

    const firstUnmeasuredIndex = positioner.size();
    const shortestColumnSize = positioner.shortestColumn();

    const itemCount = validChildren.length;
    const normalizedOverscan = parseFiniteNumber(overscan, 0, DEFAULT_OVERSCAN);
    const overscanPixels = windowHeight * normalizedOverscan;
    const rangeStart = Math.max(0, scrollTop - overscanPixels / 2);
    const rangeEnd = scrollTop + overscanPixels;

    const isLayoutOutdated =
        (firstUnmeasuredIndex === 0 || shortestColumnSize < rangeEnd) &&
        firstUnmeasuredIndex < itemCount;

    const visibleItemStyle: React.CSSProperties = {
        contentVisibility: "auto",
        overflowClipMargin: ITEM_OVERFLOW_CLIP_MARGIN,
        position: "absolute",
        transform: isScrolling ? "translateZ(0)" : undefined,
        visibility: "visible",
        width: positioner.columnWidth,
        willChange: isScrolling ? "transform" : undefined,
        writingMode: "horizontal-tb",
    };

    const hiddenItemStyle: React.CSSProperties = {
        position: "absolute",
        visibility: "hidden",
        width: positioner.columnWidth,
        writingMode: "horizontal-tb",
        zIndex: HIDDEN_ITEM_Z_INDEX,
    };

    const positionedChildren: React.ReactElement[] = [];

    const appendPositionedChild = (
        index: number,
        itemStyle: React.CSSProperties,
        extraProps?: Pick<MasonryChildProps, "inert">,
    ) => {
        const child = validChildren[index];
        if (!child) {
            return;
        }
        positionedChildren.push(
            React.cloneElement(child, {
                [MasonryDataAttributes.index]: index,
                ref: onItemRegister(index),
                style: {
                    ...child.props.style,
                    ...itemStyle,
                },
                ...extraProps,
            }),
        );
    };

    positioner.range(rangeStart, rangeEnd, (position) => {
        appendPositionedChild(position.index, {
            ...visibleItemStyle,
            containIntrinsicHeight: `auto ${Math.max(1, Math.ceil(position.height))}px`,
            left: position.left,
            top: position.top,
        });
    });

    if (isLayoutOutdated) {
        const batchSize = Math.min(
            itemCount - firstUnmeasuredIndex,
            Math.max(
                firstUnmeasuredIndex === 0 ? positioner.columnCount : 0,
                Math.ceil(
                    ((scrollTop + overscanPixels - shortestColumnSize) / normalizedItemHeight) *
                        positioner.columnCount,
                ),
            ),
        );

        if (batchSize > 0) {
            const end = Math.min(itemCount, firstUnmeasuredIndex + batchSize);
            for (let index = firstUnmeasuredIndex; index < end; index += 1) {
                appendPositionedChild(index, hiddenItemStyle, { inert: true });
            }
        }
    }

    const height = Math.ceil(positioner.estimateHeight(itemCount, normalizedItemHeight));

    const style: React.CSSProperties = {
        ...styleProp,
        height,
        maxHeight: height,
        maxWidth: "100%",
        position: "relative",
        width: "100%",
        willChange: isScrolling ? "contents" : styleProp?.willChange,
    };

    const defaultProps: MasonrySlotProps = {
        children: positionedChildren,
        [MasonryDataAttributes.slot]: "masonry",
        role: "list",
        style,
    };

    return useRender({
        defaultTagName: "div",
        props: mergeProps<"div">(defaultProps, props),
        ref: containerRef,
        render,
    });
}

export function MasonryItem({ render, ...props }: useRender.ComponentProps<"div">) {
    const defaultProps: MasonrySlotProps = {
        [MasonryDataAttributes.slot]: "masonry-item",
        role: "listitem",
    };

    return useRender({
        defaultTagName: "div",
        props: mergeProps<"div">(defaultProps, props),
        render,
    });
}
