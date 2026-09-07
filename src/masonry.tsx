"use client";

import type { BaseUIComponentProps } from "@base-ui/react/internals/types";
import { useRenderElement } from "@base-ui/react/internals/useRenderElement";
import { addEventListener } from "@base-ui/utils/addEventListener";
import { getReactElementRef } from "@base-ui/utils/getReactElementRef";
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
const DEFAULT_OVERSCAN = 2;
const DEFAULT_FORWARD_OVERSCAN = 0.8;
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
        warn("MasonryRoot: measured node is missing data-index attribute");
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
    if (typeof value === "object" && value !== null) {
        return { horizontalGap: value.horizontal, verticalGap: value.vertical };
    }
    return { horizontalGap: value, verticalGap: value };
}

export function parseRange(scrollTop: number, windowHeight: number, overscan: number) {
    if (!Number.isFinite(overscan)) {
        return { end: Number.POSITIVE_INFINITY, start: 0 };
    }
    const height = Math.max(0, windowHeight);
    const pad = height * overscan;
    const behind = 1 - DEFAULT_FORWARD_OVERSCAN;
    return {
        end: scrollTop + height + pad * DEFAULT_FORWARD_OVERSCAN,
        start: Math.max(0, scrollTop - pad * behind),
    };
}

function nextMeasurements(
    positioner: Positioner,
    previous: Measurements,
    scrollY: number,
    overscan: number,
    measured: Measurements | null,
): Measurements | null {
    if (
        measured !== null &&
        (measured.containerOffset !== previous.containerOffset ||
            measured.containerWidth !== previous.containerWidth ||
            measured.windowHeight !== previous.windowHeight)
    ) {
        return measured;
    }
    if (scrollY === previous.scrollY) {
        return null;
    }
    const prevTop = Math.max(0, previous.scrollY - previous.containerOffset);
    const nextTop = Math.max(0, scrollY - previous.containerOffset);
    const prevWindow = parseRange(prevTop, previous.windowHeight, overscan);
    const nextWindow = parseRange(nextTop, previous.windowHeight, overscan);
    const windowChanged = !positioner.isRangeInert(
        prevWindow.start,
        prevWindow.end,
        nextWindow.start,
        nextWindow.end,
    );
    return windowChanged ? { ...previous, scrollY } : null;
}

function findShortestColumnIndex(heights: number[]) {
    let bestIndex = 0;
    let [minHeight] = heights;
    for (let i = 1; i < heights.length; i += 1) {
        const height = heights[i];
        if (height < minHeight) {
            minHeight = height;
            bestIndex = i;
        }
    }
    return bestIndex;
}

interface PositionerOptions {
    columnCount: number;
    columnGap: number;
    columnWidth: number;
    rowGap: number;
}

function areOptionsEqual(a: PositionerOptions, b: PositionerOptions): boolean {
    return (
        a.columnCount === b.columnCount &&
        a.columnWidth === b.columnWidth &&
        a.columnGap === b.columnGap &&
        a.rowGap === b.rowGap
    );
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
    const fittingColumns = Math.floor((width + columnGap) / (itemWidth + columnGap));
    const requested = parsePositive(columnCount, Math.min(fittingColumns, maxColumns));
    const count = Math.max(1, Math.floor(requested));
    const columnWidth = Math.max(0, Math.floor((width - columnGap * (count - 1)) / count));
    return { columnCount: count, columnGap, columnWidth, rowGap };
}

function appendToColumn(
    columnHeights: number[],
    col: number,
    height: number,
    rowGap: number,
): number {
    const top = (columnHeights[col] ?? -rowGap) + rowGap;
    columnHeights[col] = top + height;
    return top;
}

interface MasonryLayout {
    readonly columnItems: number[][];
    readonly tallest: number;
    readonly tops: number[];
}

function deriveLayout(
    heights: readonly number[],
    cols: readonly number[],
    columnCount: number,
    rowGap: number,
): MasonryLayout {
    const tops = new Array<number>(heights.length);
    const columnItems: number[][] = Array.from({ length: columnCount }, () => []);
    const columnHeights = new Array<number>(columnCount).fill(-rowGap);
    let tallest = 0;
    for (let i = 0; i < heights.length; i += 1) {
        const height = heights[i];
        const col = cols[i];
        const top = appendToColumn(columnHeights, col, height, rowGap);
        tops[i] = top;
        columnItems[col]?.push(i);
        const bottom = top + height;
        if (bottom > tallest) {
            tallest = bottom;
        }
    }
    return { columnItems, tallest, tops };
}

function findItemWindow(
    items: readonly number[],
    tops: readonly number[],
    heights: readonly number[],
    low: number,
    high: number,
): { end: number; start: number } {
    let startLow = 0;
    let startHigh = items.length;
    while (startLow < startHigh) {
        const mid = (startLow + startHigh) >>> 1;
        const item = items[mid];
        if (tops[item] + heights[item] >= low) {
            startHigh = mid;
        } else {
            startLow = mid + 1;
        }
    }
    let endLow = startLow;
    let endHigh = items.length;
    while (endLow < endHigh) {
        const mid = (endLow + endHigh) >>> 1;
        const item = items[mid];
        if (tops[item] <= high) {
            endLow = mid + 1;
        } else {
            endHigh = mid;
        }
    }
    return { end: endLow, start: startLow };
}

export class Positioner {
    defaultItemHeight: number;
    private options: PositionerOptions;
    private heights: number[];
    private cols: number[];
    private cachedLayout: MasonryLayout | null;

    constructor(options: PositionerOptions, defaultItemHeight = DEFAULT_ITEM_HEIGHT) {
        this.options = { ...options, rowGap: Math.max(0, options.rowGap) };
        this.defaultItemHeight = parsePositive(defaultItemHeight, DEFAULT_ITEM_HEIGHT);
        this.heights = [];
        this.cols = [];
        this.cachedLayout = null;
    }

    get columnCount(): number {
        return this.options.columnCount;
    }
    get columnWidth(): number {
        return this.options.columnWidth;
    }
    private get layout(): MasonryLayout {
        if (!this.cachedLayout) {
            this.cachedLayout = deriveLayout(
                this.heights,
                this.cols,
                this.options.columnCount,
                this.options.rowGap,
            );
        }
        return this.cachedLayout;
    }
    getItemHeight(index: number): number | undefined {
        return this.heights[index];
    }
    private get stride(): number {
        return this.options.columnWidth + this.options.columnGap;
    }
    tallestColumn(): number {
        return this.layout.tallest;
    }
    range(
        low: number,
        high: number,
        visit: (index: number, left: number, top: number) => void,
    ): void {
        const { layout } = this;
        for (let col = 0; col < this.options.columnCount; col += 1) {
            const items = layout.columnItems[col];
            if (items.length === 0) {
                continue;
            }
            const { end, start } = findItemWindow(items, layout.tops, this.heights, low, high);
            for (let row = start; row < end; row += 1) {
                const index = items[row];
                const top = layout.tops[index];
                visit(index, col * this.stride, top);
            }
        }
    }
    setItemHeight(index: number, height: number): boolean {
        if (index < 0 || index >= this.heights.length) {
            return false;
        }
        const h = parsePositive(height, 1);
        if (this.heights[index] === h) {
            return false;
        }
        this.heights[index] = h;
        this.cachedLayout = null;
        return true;
    }
    isRangeInert(prevLow: number, prevHigh: number, nextLow: number, nextHigh: number): boolean {
        if (prevLow === nextLow && prevHigh === nextHigh) {
            return true;
        }
        const { layout } = this;
        for (let col = 0; col < this.options.columnCount; col += 1) {
            const items = layout.columnItems[col];
            if (items.length === 0) {
                continue;
            }
            const prev = findItemWindow(items, layout.tops, this.heights, prevLow, prevHigh);
            const next = findItemWindow(items, layout.tops, this.heights, nextLow, nextHigh);
            if (prev.start !== next.start || prev.end !== next.end) {
                return false;
            }
        }
        return true;
    }
    private reassignAll(): void {
        const { columnCount, rowGap } = this.options;
        const columnHeights = new Array<number>(columnCount).fill(-rowGap);
        for (let i = 0; i < this.heights.length; i += 1) {
            const col = findShortestColumnIndex(columnHeights);
            this.cols[i] = col;
            appendToColumn(columnHeights, col, this.heights[i], rowGap);
        }
    }
    setOptions(options: PositionerOptions): boolean {
        if (areOptionsEqual(this.options, options)) {
            return false;
        }
        this.options = { ...options, rowGap: Math.max(0, options.rowGap) };
        this.reassignAll();
        this.cachedLayout = null;
        return true;
    }
    syncItems(prevKeys: Keys, nextKeys: Keys): boolean {
        const heightByKey = new Map<React.Key, number>();
        const colByKey = new Map<React.Key, number>();
        for (let i = 0; i < prevKeys.length; i += 1) {
            const key = prevKeys[i];
            const height = this.heights[i];
            if (key !== null && height !== undefined) {
                heightByKey.set(key, height);
                const col = this.cols[i];
                if (col !== undefined) {
                    colByKey.set(key, col);
                }
            }
        }
        const nextSet = new Set<React.Key>();
        for (const key of nextKeys) {
            if (key !== null) {
                nextSet.add(key);
            }
        }
        const removed = prevKeys.some((key) => key !== null && !nextSet.has(key));
        const { columnCount, rowGap } = this.options;
        const columnHeights = new Array<number>(columnCount).fill(-rowGap);
        const nextHeights = new Array<number>(nextKeys.length);
        const nextCols = new Array<number>(nextKeys.length);
        for (let i = 0; i < nextKeys.length; i += 1) {
            const key = nextKeys[i];
            let height: number;
            let col: number | undefined;
            if (key === null && prevKeys[i] === null) {
                // Keyless items keep positional identity: the item at this
                // index is the same one, so keep its measurement and column.
                height = this.heights[i] ?? this.defaultItemHeight;
                const kept = this.cols[i];
                if (kept !== undefined && kept >= 0 && kept < columnCount) {
                    col = kept;
                }
            } else {
                height =
                    key === null
                        ? this.defaultItemHeight
                        : (heightByKey.get(key) ?? this.defaultItemHeight);
                if (!removed) {
                    const kept = key === null ? undefined : colByKey.get(key);
                    if (kept !== undefined && kept >= 0 && kept < columnCount) {
                        col = kept;
                    }
                }
            }
            col ??= findShortestColumnIndex(columnHeights);
            nextHeights[i] = height;
            nextCols[i] = col;
            appendToColumn(columnHeights, col, height, rowGap);
        }
        if (
            nextHeights.length === this.heights.length &&
            nextHeights.every((h, i) => h === this.heights[i]) &&
            nextCols.every((c, i) => c === this.cols[i])
        ) {
            return false;
        }
        this.heights = nextHeights;
        this.cols = nextCols;
        this.cachedLayout = null;
        return true;
    }
    flushPending(pending: Map<Element, number>): boolean {
        if (pending.size === 0) {
            return false;
        }
        // entries added during this flush wait for the next pass.
        const snapshot = Array.from(pending);
        pending.clear();

        let didChange = false;
        for (const [node, height] of snapshot) {
            if (!node.isConnected) {
                continue;
            }
            const index = getNodeDataIndex(node);
            if (index === null || index >= this.heights.length) {
                continue;
            }
            if (this.setItemHeight(index, height)) {
                didChange = true;
            }
        }
        return didChange;
    }
}

interface Measurements {
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

interface ItemSlotProps<T = unknown> {
    index: number;
    item: T;
    itemCount: number;
    left: number;
    register: (node: HTMLElement | null) => (() => void) | undefined;
    render: MasonryRenderFn<T>;
    top: number;
    width: number;
}

export function areItemSlotPropsEqual(
    prev: ItemSlotProps<unknown>,
    next: ItemSlotProps<unknown>,
): boolean {
    return (
        prev.item === next.item &&
        prev.render === next.render &&
        prev.left === next.left &&
        prev.top === next.top &&
        prev.width === next.width &&
        prev.index === next.index &&
        prev.itemCount === next.itemCount &&
        prev.register === next.register
    );
}

const MasonryItemSlot = React.memo(function MasonryItemSlotInner<T>({
    item,
    render,
    width,
    index,
    itemCount,
    left,
    top,
    register,
}: ItemSlotProps<T>): React.ReactElement | null {
    let element: React.ReactElement<MasonryItemSlotProps> | null = null;
    if (typeof render === "function") {
        const rendered = item === null || item === undefined ? null : render(item, index);
        if (React.isValidElement<MasonryItemSlotProps>(rendered)) {
            element = rendered;
        } else {
            warn(
                item === null || item === undefined
                    ? "MasonryRoot: `items` contains null or undefined entries; they render as empty placeholders."
                    : "MasonryRoot: the `children` render function must return a React element; an empty placeholder is rendered instead.",
            );
        }
    }

    const mergedRefs = useMergedRefs(register, element ? getReactElementRef(element) : null);

    const defaultStyle: React.CSSProperties = {
        contain: "layout",
        left: 0,
        position: "absolute",
        top: 0,
        transform: `translateX(${left}px) translateY(${top}px)`,
        width,
        writingMode: "horizontal-tb",
    };

    if (!element) {
        element = React.createElement<MasonryItemSlotProps>(MasonryItem);
    }

    return React.cloneElement(element, {
        [MasonryDataAttributes.index]: index,
        ref: mergedRefs,
        ...("aria-posinset" in element.props ? {} : { "aria-posinset": index + 1 }),
        ...("aria-setsize" in element.props ? {} : { "aria-setsize": itemCount }),
        style: { ...defaultStyle, ...element.props.style },
    });
}, areItemSlotPropsEqual) as <T>(props: ItemSlotProps<T>) => React.ReactElement | null;

type Keys = (React.Key | null)[];

function getItemKeys<T>(
    items: readonly T[],
    getItemKey: ((item: T) => React.Key) | undefined,
): Keys {
    const keys: Keys = new Array(items.length);
    let hasNull = false;

    for (let i = 0; i < items.length; i += 1) {
        const item = items[i];
        let key: React.Key | null;

        if (getItemKey && item !== null && item !== undefined) {
            const id = getItemKey(item);
            key = typeof id === "string" || typeof id === "number" ? id : null;
        } else {
            const source: unknown = item;
            if (typeof source === "object" && source !== null && "id" in source) {
                const id = source.id;
                key = typeof id === "string" || typeof id === "number" ? id : null;
            } else {
                key = typeof source === "string" || typeof source === "number" ? source : null;
            }
        }

        keys[i] = key;

        if (key === null) {
            hasNull = true;
        }
    }
    if (hasNull) {
        warn(
            "MasonryRoot: some `items` have no stable string or number key. Give each item an `id` property or pass `getItemKey`. The index fallback discards measured heights on reorder.",
        );
    }

    return keys;
}

export type MasonryRootState = {};

export type MasonryRenderFn<T> = (item: T, index: number) => React.ReactElement;

export interface MasonryRootProps<T = unknown> extends Omit<
    BaseUIComponentProps<"div", MasonryRootState>,
    "children"
> {
    /**
     * Render function for each item.
     * @example <MasonryRoot items={itemsArray}>{(item) => <MasonryItem key={item.id}>...</MasonryItem>}</MasonryRoot>
     */
    children: MasonryRenderFn<T>;
    /**
     * The number of columns to render.
     * When unset, non-positive, or non-finite, the column count is derived from `columnWidth` and the container width.
     */
    columnCount?: number;
    /**
     * The preferred width of each column in pixels, used to derive the column count.
     * To render a fixed number of columns, use the `columnCount` prop instead.
     * Items stretch to fill their column.
     * @default `200`
     */
    columnWidth?: number;
    /**
     * The element whose scroll position drives windowing.
     * @default `window`
     */
    container?: HTMLElement | null;
    /**
     * Content rendered before items sync: the server HTML and the pre-hydration
     * render, when `items` is non-empty. The explicit container height is omitted
     * while it renders, so it sizes the box.
     */
    fallback?: React.ReactNode;
    /**
     * The gap between columns and rows in pixels.
     * Accepts a single number for both axes or an object to configure them individually.
     * When an object is provided, `vertical` defaults to `horizontal`.
     */
    gap: number | { horizontal: number; vertical: number };
    /**
     * Returns the stable string or number identity of an item, used to keep measured
     * heights attached to their item across reorders.
     * Defaults to the `id` property for objects, or the item itself for strings and numbers.
     */
    getItemKey?: (item: T) => React.Key;
    /**
     * The assumed height in pixels for items before they are measured.
     * Closer values settle faster; measured heights always win.
     * @default `300`
     */
    itemHeight?: number;
    /**
     * Data to display. Each item is passed to the `children` render function.
     * Each item needs a stable identity (`id` by default, or `getItemKey`) so measured
     * heights survive reorders.
     * An empty list needs an explicit type: `items={[] as Item[]}`.
     */
    items: readonly T[];
    /**
     * The maximum number of columns that can be derived from `columnWidth`.
     * Non-finite or non-positive values mean the column count is uncapped.
     * @default `Infinity`
     */
    maxColumnCount?: number;
    /**
     * How far beyond the viewport, as a multiple of its height, items are rendered.
     * The window extends further below the viewport than above it.
     * Use `Infinity` to disable windowing and render every item.
     * @default `2`
     */
    overscan?: number;
}

/**
 * Groups all parts of the masonry layout.
 * Renders a `<div>` element.
 */
export function MasonryRoot<T>(componentProps: MasonryRootProps<T>): React.ReactElement {
    const {
        children,
        items,
        columnCount,
        columnWidth = DEFAULT_COLUMN_WIDTH,
        gap,
        getItemKey,
        itemHeight: itemHeightProp = DEFAULT_ITEM_HEIGHT,
        maxColumnCount: maxColumnCountProp,
        overscan: overscanProp = DEFAULT_OVERSCAN,
        container = null,
        fallback = null,
        className,
        render,
        style,
        ...elementProps
    } = componentProps;

    const { horizontalGap, verticalGap } = parseGap(gap);
    const itemHeight = parseMin(itemHeightProp, 1, DEFAULT_ITEM_HEIGHT);
    const overscan = parseNonNegative(overscanProp, DEFAULT_OVERSCAN);

    const rootRef = React.useRef<HTMLDivElement | null>(null);
    const animationFrame = useAnimationFrame();
    const rerender = useForcedRerendering();

    const [measurements, setMeasurements] = React.useState<Measurements>(INITIAL_MEASUREMENTS);
    const measurementsRef = useValueAsRef(measurements);
    const isDirtyRef = React.useRef(true);

    const scrollTop = Math.max(0, measurements.scrollY - measurements.containerOffset);

    const buildOptions = React.useCallback(
        (containerWidth: number) =>
            parseOptions({
                columnCount,
                columnWidth,
                containerWidth,
                horizontalGap,
                maxColumnCount: maxColumnCountProp,
                verticalGap,
            }),
        [columnCount, columnWidth, horizontalGap, maxColumnCountProp, verticalGap],
    );
    const { windowHeight, containerWidth } = measurements;
    const currentOptions = React.useMemo(
        () => buildOptions(containerWidth),
        [buildOptions, containerWidth],
    );
    const positioner = useRefWithInit(() => new Positioner(currentOptions, itemHeight)).current;
    const pendingMap = useRefWithInit(() => new Map<Element, number>()).current;
    const keysRef = React.useRef<Keys | null>(null);

    const itemCount = items.length;
    const shouldShowFallback = itemCount > 0 && keysRef.current === null && !!fallback;
    const keys = React.useMemo(() => getItemKeys(items, getItemKey), [items, getItemKey]);

    const flush = useStableCallback(() => {
        const root = rootRef.current;
        if (!root) {
            return;
        }

        const previous = measurementsRef.current;
        const scrollY = container ? container.scrollTop : ownerWindow(root).scrollY;

        const wasDirty = isDirtyRef.current;
        if (!wasDirty && scrollY === previous.scrollY && pendingMap.size === 0) {
            return;
        }

        const layoutMutated = positioner.flushPending(pendingMap);
        isDirtyRef.current = false;

        let measured: Measurements | null = null;
        let didSyncPositioner = false;

        if (wasDirty) {
            const containerOffset =
                root.getBoundingClientRect().top -
                (container ? container.getBoundingClientRect().top + container.clientTop : 0) +
                scrollY;
            const containerWidth = root.clientWidth;
            const windowHeight = container
                ? container.clientHeight
                : ownerDocument(root).documentElement.clientHeight;

            const nextOptions = buildOptions(containerWidth);
            didSyncPositioner = positioner.setOptions(nextOptions);

            measured = {
                containerOffset,
                containerWidth,
                scrollY,
                windowHeight,
            };
        }

        const next = nextMeasurements(positioner, previous, scrollY, overscan, measured);
        if (next === null && !layoutMutated && !didSyncPositioner) {
            return;
        }
        flushSync(() => {
            if (next !== null) {
                setMeasurements(next);
            } else if (layoutMutated || didSyncPositioner) {
                rerender();
            }
        });
    });

    const requestFlush = useStableCallback(() => {
        animationFrame.request(flush);
    });

    const requestDirtyFlush = useStableCallback(() => {
        isDirtyRef.current = true;
        requestFlush();
    });

    const itemResizeObserver = useRefWithInit(() => {
        if (typeof ResizeObserver !== "function") {
            return null;
        }
        return new ResizeObserver((entries) => {
            for (const entry of entries) {
                pendingMap.set(entry.target, entry.borderBoxSize[0].blockSize);
            }
            requestFlush();
        });
    }).current;

    useIsoLayoutEffect(() => () => itemResizeObserver?.disconnect(), [itemResizeObserver]);

    const registerItem = useStableCallback((node: HTMLElement | null) => {
        if (node === null) {
            return;
        }
        itemResizeObserver?.observe(node);
        return () => {
            // Unregister
            itemResizeObserver?.unobserve(node);
            pendingMap.delete(node);
        };
    });

    useIsoLayoutEffect(
        function observeContainer() {
            const root = rootRef.current;
            if (!root) {
                return;
            }
            requestDirtyFlush();

            const resizeObserver = new ResizeObserver(requestDirtyFlush);
            resizeObserver.observe(root);
            resizeObserver.observe(ownerDocument(root).body);
            if (container) {
                resizeObserver.observe(container);
            }

            const win = ownerWindow(root);
            return mergeCleanups(
                addEventListener(container ?? win, "scroll", requestFlush, {
                    passive: true,
                }),
                addEventListener(win, "resize", requestDirtyFlush),
                win.visualViewport
                    ? addEventListener(win.visualViewport, "resize", requestFlush)
                    : null,
                () => resizeObserver.disconnect(),
            );
        },
        [requestFlush, requestDirtyFlush, container],
    );

    useIsoLayoutEffect(
        function syncPositioner() {
            const prevKeys = keysRef.current;
            keysRef.current = keys;

            positioner.defaultItemHeight = itemHeight;

            let didChange = positioner.syncItems(prevKeys ?? [], keys);
            didChange = positioner.setOptions(currentOptions) || didChange;

            if (didChange) {
                rerender();
                requestDirtyFlush();
            }
        },
        [keys, currentOptions, itemHeight, rerender, requestDirtyFlush],
    );

    const { start: rangeStart, end: rangeEnd } = parseRange(scrollTop, windowHeight, overscan);
    const positionedChildren: React.ReactElement[] = [];

    const push = (index: number, left: number, top: number) => {
        if (index < 0 || index >= itemCount) {
            return;
        }
        positionedChildren.push(
            <MasonryItemSlot
                index={index}
                item={items[index]}
                itemCount={itemCount}
                key={keys[index] ?? index}
                left={left}
                register={registerItem}
                render={children}
                top={top}
                width={positioner.columnWidth}
            />,
        );
    };

    positioner.range(rangeStart, rangeEnd, push);

    const defaultProps: MasonrySlotAttributes = {
        children: shouldShowFallback ? fallback : positionedChildren,
        [MasonryDataAttributes.slot]: "masonry",
        role: "list",
        style: {
            height: shouldShowFallback ? undefined : Math.ceil(positioner.tallestColumn()),
            maxWidth: "100%",
            position: "relative",
            width: "100%",
        },
    };

    return useRenderElement("div", componentProps, {
        props: [defaultProps, elementProps],
        ref: rootRef,
    });
}

export type MasonryItemState = {};

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
