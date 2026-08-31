import * as React from "react";
import { MasonryRoot, MasonryItem } from "@masonry/masonry";
import styles from "./masonry.module.css";

// ---------------------------------------------------------------------------
// Pinterest-style data — images only, variable height, async decode
// ---------------------------------------------------------------------------

type Pin = {
    id: string;
    seed: string;
    height: number;
};

function mulberry32(seed: number) {
    let s = seed >>> 0;
    return () => {
        s |= 0;
        s = (s + 0x6d2b79f5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function makePin(index: number, seed: number): Pin {
    const rand = mulberry32(seed + index * 1013904223);
    // Pinterest heights vary widely — this drives ResizeObserver re-measure
    // when the <img> decodes, exactly like production image grids.
    const height = 180 + Math.floor(rand() * 360); // 180–540
    return {
        id: `pin-${index}-${seed}`,
        seed: `${seed}-${index}`,
        height,
    };
}

function createPins(count: number, seed: number, offset: number): Pin[] {
    return Array.from({ length: count }, (_, i) => makePin(offset + i, seed));
}

const INITIAL_COUNT = 60;
const BATCH_SIZE = 30;

// ---------------------------------------------------------------------------
// Pin card — image only, Pinterest-like
// ---------------------------------------------------------------------------

function PinCard({ pin }: { pin: Pin }) {
    const [loaded, setLoaded] = React.useState(false);
    const [error, setError] = React.useState(false);
    const src = `https://picsum.photos/seed/${pin.seed}/600/${pin.height}`;

    return (
        <div className="group overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-black/[0.06]">
            <div className="relative overflow-hidden bg-gray-100">
                {!error ? (
                    <img
                        src={src}
                        alt=""
                        width={600}
                        height={pin.height}
                        loading="lazy"
                        decoding="async"
                        onLoad={() => setLoaded(true)}
                        onError={() => setError(true)}
                        className={`block h-auto w-full object-cover transition-opacity duration-300 ${
                            loaded ? "opacity-100" : "opacity-0"
                        }`}
                        style={{ aspectRatio: `600 / ${pin.height}` }}
                    />
                ) : null}

                {/* skeleton until decode — keeps height realistic for measurement */}
                {!loaded && !error ? (
                    <div
                        className="absolute inset-0 animate-pulse bg-[linear-gradient(100deg,var(--color-gray-100)_30%,white_50%,var(--color-gray-100)_70%)] bg-[length:200%_100%]"
                        style={{ height: pin.height }}
                        aria-hidden
                    />
                ) : null}

                {error ? (
                    <div
                        className="flex items-center justify-center bg-gray-50 text-xs text-gray-500"
                        style={{ height: pin.height, minHeight: 180 }}
                    >
                        Failed to load
                    </div>
                ) : null}

                {/* Pinterest-style save affordance — hover only, no extra chrome */}
                <button
                    type="button"
                    className="absolute right-2 top-2 hidden rounded-full bg-[#e60023] px-3.5 py-1.5 text-xs font-semibold text-white shadow-sm transition hover:bg-[#cc0000] group-hover:inline-flex"
                >
                    Save
                </button>

                {/* subtle gradient on hover */}
                <div className="pointer-events-none absolute inset-0 rounded-2xl opacity-0 transition group-hover:opacity-100 bg-gradient-to-b from-black/10 via-transparent to-transparent" />
            </div>
        </div>
    );
}

// ---------------------------------------------------------------------------
// Demo — practical Pinterest grid for benchmarking
// ---------------------------------------------------------------------------

export default function MasonryDemo() {
    const [seed] = React.useState(42);
    const [pins, setPins] = React.useState<Pin[]>(() => createPins(INITIAL_COUNT, 42, 0));
    const [isLoadingMore, setIsLoadingMore] = React.useState(false);
    const [scrollMode, setScrollMode] = React.useState<"window" | "contained">("window");

    // Layout props — the knobs that matter for benchmark / real usage
    const [gap, setGap] = React.useState(12);
    const [columnWidth, setColumnWidth] = React.useState(260);
    const [maxColumnCount, setMaxColumnCount] = React.useState(6);
    const [overscan, setOverscan] = React.useState(1.5);
    const [columnCount, setColumnCount] = React.useState<number | undefined>(undefined);

    const [scrollContainer, setScrollContainer] = React.useState<HTMLDivElement | null>(null);
    const sentinelRef = React.useRef<HTMLDivElement | null>(null);

    const loadMore = React.useCallback(async () => {
        if (isLoadingMore) return;
        if (pins.length >= 900) return;
        setIsLoadingMore(true);
        await new Promise((r) => setTimeout(r, 350));
        setPins((prev) => [...prev, ...createPins(BATCH_SIZE, seed, prev.length)]);
        setIsLoadingMore(false);
    }, [isLoadingMore, pins.length, seed]);

    // Infinite sentinel — root is scroll container in "contained" mode, viewport otherwise.
    // Exercises MasonryRoot's `container` prop with real images (+ ResizeObserver).
    React.useEffect(() => {
        const el = sentinelRef.current;
        if (!el) return;
        const root = scrollMode === "contained" ? scrollContainer : null;
        const obs = new IntersectionObserver(
            (entries) => {
                for (const e of entries) if (e.isIntersecting) loadMore();
            },
            { root, rootMargin: "600px 0px", threshold: 0 },
        );
        obs.observe(el);
        return () => obs.disconnect();
    }, [loadMore, scrollContainer, scrollMode]);

    return (
        <div className="space-y-5">
            {/* Controls — only what matters for layout / perf */}
            <div className={styles.controls}>
                <div className="flex flex-wrap items-center justify-between gap-3">
                    <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                        Layout
                    </h2>
                    <div className="flex items-center gap-1 rounded-full bg-gray-100 p-1 text-xs font-medium">
                        {(["window", "contained"] as const).map((m) => (
                            <button
                                key={m}
                                type="button"
                                onClick={() => setScrollMode(m)}
                                className={`rounded-full px-3 py-1.5 capitalize transition ${
                                    scrollMode === m
                                        ? "bg-white text-gray-900 shadow-sm ring-1 ring-gray-200"
                                        : "text-gray-600 hover:text-gray-900"
                                }`}
                            >
                                {m}
                            </button>
                        ))}
                    </div>
                </div>

                <div className={styles.controlsRow}>
                    <label className={styles.control}>
                        <span className={styles.controlLabel}>Gap</span>
                        <input
                            className={styles.controlInput}
                            type="number"
                            min={0}
                            max={24}
                            step={1}
                            value={gap}
                            onChange={(e) => setGap(Math.max(0, Number(e.target.value) || 0))}
                        />
                    </label>
                    <label className={styles.control}>
                        <span className={styles.controlLabel}>Column width</span>
                        <input
                            className={styles.controlInput}
                            type="number"
                            min={160}
                            max={360}
                            step={10}
                            value={columnWidth}
                            onChange={(e) =>
                                setColumnWidth(Math.max(120, Number(e.target.value) || 0))
                            }
                        />
                    </label>
                    <label className={styles.control}>
                        <span className={styles.controlLabel}>Max columns</span>
                        <input
                            className={styles.controlInput}
                            type="number"
                            min={1}
                            max={12}
                            step={1}
                            value={maxColumnCount}
                            onChange={(e) =>
                                setMaxColumnCount(Math.max(1, Number(e.target.value) || 0))
                            }
                        />
                    </label>
                    <label className={styles.control}>
                        <span className={styles.controlLabel}>Overscan</span>
                        <input
                            className={styles.controlInput}
                            type="number"
                            min={0}
                            max={4}
                            step={0.5}
                            value={overscan}
                            onChange={(e) => setOverscan(Math.max(0, Number(e.target.value) || 0))}
                        />
                    </label>
                    <label className={styles.control} style={{ minWidth: 180 }}>
                        <span className={styles.controlLabel}>Column count</span>
                        <select
                            className={styles.controlInput}
                            value={columnCount ?? ""}
                            onChange={(e) => {
                                const v = e.target.value;
                                setColumnCount(v === "" ? undefined : Number(v));
                            }}
                        >
                            <option value="">auto (from columnWidth)</option>
                            {[2, 3, 4, 5, 6].map((n) => (
                                <option key={n} value={n}>
                                    {n}
                                </option>
                            ))}
                        </select>
                    </label>
                </div>

                <div className="flex flex-wrap gap-2">
                    <button
                        type="button"
                        className={styles.button}
                        onClick={() => loadMore()}
                        disabled={isLoadingMore}
                    >
                        {isLoadingMore ? "Loading…" : `Load ${BATCH_SIZE} more`}
                    </button>
                    <button
                        type="button"
                        className={styles.button}
                        onClick={() => {
                            setPins(
                                createPins(
                                    INITIAL_COUNT,
                                    seed + Math.floor(Math.random() * 1000),
                                    0,
                                ),
                            );
                            window.scrollTo(0, 0);
                            scrollContainer?.scrollTo(0, 0);
                        }}
                    >
                        Shuffle
                    </button>
                    <button
                        type="button"
                        className={styles.button}
                        onClick={() => {
                            setGap(12);
                            setColumnWidth(260);
                            setMaxColumnCount(6);
                            setOverscan(1.5);
                            setColumnCount(undefined);
                        }}
                    >
                        Reset
                    </button>
                    <span className={styles.secondaryText}>
                        Images: <code className={styles.kbd}>picsum.photos/seed</code>
                    </span>
                </div>
            </div>

            {/* Masonry */}
            {scrollMode === "contained" ? (
                <div
                    ref={setScrollContainer}
                    className="overflow-auto rounded-2xl border border-gray-200 bg-gray-50 p-2 sm:p-3"
                    style={{ height: "72vh", maxHeight: 860 }}
                >
                    <div className={`${styles.masonryFrame} !border-0 !bg-white`}>
                        <MasonryRoot
                            columnWidth={columnWidth}
                            gap={gap}
                            maxColumnCount={maxColumnCount}
                            overscan={overscan}
                            columnCount={columnCount}
                            itemHeight={320}
                            container={scrollContainer}
                        >
                            {pins.map((pin) => (
                                <MasonryItem key={pin.id}>
                                    <PinCard pin={pin} />
                                </MasonryItem>
                            ))}
                        </MasonryRoot>
                    </div>
                    <Sentinel
                        ref={sentinelRef}
                        isLoading={isLoadingMore}
                        onLoadMore={loadMore}
                        hasMore={pins.length < 900}
                    />
                </div>
            ) : (
                <>
                    <div className={styles.masonryFrame}>
                        <MasonryRoot
                            columnWidth={columnWidth}
                            gap={gap}
                            maxColumnCount={maxColumnCount}
                            overscan={overscan}
                            columnCount={columnCount}
                            itemHeight={320}
                        >
                            {pins.map((pin) => (
                                <MasonryItem key={pin.id}>
                                    <PinCard pin={pin} />
                                </MasonryItem>
                            ))}
                        </MasonryRoot>
                    </div>
                    <Sentinel
                        ref={sentinelRef}
                        isLoading={isLoadingMore}
                        onLoadMore={loadMore}
                        hasMore={pins.length < 900}
                    />
                </>
            )}
        </div>
    );
}

const Sentinel = React.forwardRef<
    HTMLDivElement,
    { isLoading: boolean; onLoadMore: () => void; hasMore: boolean }
>(function Sentinel({ isLoading, onLoadMore, hasMore }, ref) {
    return (
        <div ref={ref} className="flex flex-col items-center gap-3 px-4 py-8">
            {hasMore ? (
                <>
                    <button
                        type="button"
                        onClick={onLoadMore}
                        disabled={isLoading}
                        className="inline-flex items-center gap-2 rounded-full bg-gray-900 px-5 py-2.5 text-sm font-medium text-white shadow-sm hover:bg-black disabled:opacity-60"
                    >
                        {isLoading ? (
                            <>
                                <span
                                    className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white"
                                    aria-hidden
                                />
                                Loading…
                            </>
                        ) : (
                            <>Load {BATCH_SIZE} more</>
                        )}
                    </button>
                </>
            ) : (
                <span className="rounded-full bg-white px-3 py-1.5 text-xs font-medium text-gray-600 ring-1 ring-gray-200">
                    You’re all caught up
                </span>
            )}
        </div>
    );
});
