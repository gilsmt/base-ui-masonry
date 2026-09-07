import * as React from "react";
import { MasonryItem, MasonryRoot, parseOptions } from "@masonry/masonry";
import styles from "./masonry.module.css";

// ---------------------------------------------------------------------------
// Side-panel resize repro — deterministic items, no network images
// ---------------------------------------------------------------------------

type Block = {
  id: string;
  height: number;
  hue: number;
};

function makeBlocks(count: number): Block[] {
  // Deterministic varied heights so repositioning is obvious and stable.
  // Pattern repeats every 8: tall/short mix like a Pinterest feed.
  const pattern = [320, 180, 260, 400, 220, 340, 200, 280];
  return Array.from({ length: count }, (_, i) => ({
    id: `block-${i}`,
    height: pattern[i % pattern.length] + (i % 3) * 20,
    hue: (i * 47) % 360,
  }));
}

const BLOCKS = makeBlocks(48);

const PANEL_GAP = 12;
const PANEL_COLUMN_WIDTH = 220;

function BlockCard({ block, index }: { block: Block; index: number }) {
  return (
    <div
      className="flex flex-col justify-between overflow-hidden rounded-2xl ring-1 ring-black/[0.06]"
      style={{
        height: block.height,
        background: `linear-gradient(180deg, hsl(${block.hue} 70% 88%), hsl(${block.hue} 60% 78%))`,
      }}
    >
      <div className="flex items-center justify-between px-3 pt-2.5 text-xs font-semibold text-gray-800">
        <span>
          #{index} · {block.id}
        </span>
        <span className="rounded-full bg-white/70 px-2 py-0.5 tabular-nums">
          {block.height}px
        </span>
      </div>
      <div className="px-3 pb-2.5 text-[11px] leading-4 text-gray-700">
        Watch me jump columns when the panel opens
      </div>
    </div>
  );
}

function useContainerWidth<T extends HTMLElement>() {
  const ref = React.useRef<T | null>(null);
  const [width, setWidth] = React.useState(0);
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const next = Math.round(entry.contentRect.width);
        setWidth((prev) => (prev === next ? prev : next));
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, width };
}

export default function SidePanelDemo() {
  const [panelOpen, setPanelOpen] = React.useState(false);
  const [panelWidth, setPanelWidth] = React.useState(320);
  const [animated, setAnimated] = React.useState(true);

  const masonryWrap = useContainerWidth<HTMLDivElement>();

  const derivedColumns = parseOptions({
    containerWidth: masonryWrap.width,
    columnWidth: PANEL_COLUMN_WIDTH,
    horizontalGap: PANEL_GAP,
    verticalGap: PANEL_GAP,
  }).columnCount;

  return (
    <div className="space-y-5">
      <div className={styles.controls}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
            Side-panel resize repro
          </h2>
          <button
            type="button"
            className={styles.button}
            onClick={() => setPanelOpen((v) => !v)}
            aria-expanded={panelOpen}
          >
            {panelOpen ? "Close side-panel" : "Open side-panel"}
          </button>
        </div>

        <p className="text-sm leading-6 text-gray-700">
          Toggling the panel shrinks the masonry container from full width to{" "}
          <code className={styles.kbd}>100% − {panelWidth}px</code>, forcing a
          column-count change and item reposition — without a window resize or
          remount. Leave <em>Animate</em> on to also exercise continuous{" "}
          <code className={styles.kbd}>ResizeObserver</code> updates mid-transition.
        </p>

        <div className={styles.controlsRow}>
          <label className={styles.control} style={{ minWidth: 200 }}>
            <span className={styles.controlLabel}>
              Panel width ·{" "}
              <span className={styles.rangeValue}>{panelWidth}px</span>
            </span>
            <input
              type="range"
              min={240}
              max={480}
              step={10}
              value={panelWidth}
              onChange={(e) => setPanelWidth(Number(e.target.value))}
            />
          </label>
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={animated}
              onChange={(e) => setAnimated(e.target.checked)}
            />
            Animate panel (transition width)
          </label>
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={panelOpen}
              onChange={(e) => setPanelOpen(e.target.checked)}
            />
            Panel open
          </label>
        </div>

        <div className="flex flex-wrap gap-2 text-xs">
          <span className="rounded-full bg-gray-100 px-3 py-1.5 tabular-nums ring-1 ring-gray-200">
            masonry width: <strong>{masonryWrap.width}px</strong>
          </span>
          <span className="rounded-full bg-gray-100 px-3 py-1.5 tabular-nums ring-1 ring-gray-200">
            ≈ columns: <strong>{derivedColumns}</strong>
          </span>
          <span className="rounded-full bg-gray-100 px-3 py-1.5 tabular-nums ring-1 ring-gray-200">
            gap: <strong>{PANEL_GAP}</strong> · colWidth: <strong>{PANEL_COLUMN_WIDTH}</strong>
          </span>
        </div>
      </div>

      {/* Row: masonry takes remaining space, panel eats into it when open */}
      <div className="flex items-stretch gap-3 rounded-2xl border border-gray-200 bg-gray-50 p-2 sm:p-3">
        <div
          ref={masonryWrap.ref}
          className="min-w-0 flex-1 rounded-xl border border-dashed border-gray-300 bg-white p-2"
        >
          <MasonryRoot
            items={BLOCKS}
            columnWidth={PANEL_COLUMN_WIDTH}
            gap={PANEL_GAP}
            overscan={Infinity}
          >
            {(block: Block, index: number) => (
              <MasonryItem key={block.id}>
                <BlockCard block={block} index={index} />
              </MasonryItem>
            )}
          </MasonryRoot>
        </div>

        <aside
          aria-hidden={!panelOpen}
          className={`shrink-0 overflow-hidden${animated ? " transition-[width] duration-300 ease-in-out" : ""}`}
          style={{ width: panelOpen ? panelWidth : 0 }}
        >
          <div
            className="flex h-full flex-col gap-2 rounded-xl border border-gray-200 bg-white p-4 text-sm"
            style={{ width: panelWidth, maxWidth: "100%" }}
            inert={!panelOpen}
          >
            <h3 className="font-semibold">Side-panel</h3>
            <p className="leading-6 text-gray-600">
              I&apos;m {panelWidth}px wide. While I&apos;m open the masonry
              container loses {panelWidth + 12}px (plus gap) and must drop a
              column and reposition every item below the fold point.
            </p>
            <label className="mt-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
              Panel width · {panelWidth}px
              <input
                type="range"
                className="mt-1 w-full"
                min={240}
                max={480}
                step={10}
                value={panelWidth}
                onChange={(e) => setPanelWidth(Number(e.target.value))}
              />
            </label>
            <button
              type="button"
              className={styles.button}
              onClick={() => setPanelOpen(false)}
            >
              Close panel
            </button>
          </div>
        </aside>
      </div>

      <p className="text-xs leading-5 text-gray-500">
        Repro steps: 1) note the column count in the readout, 2) open the panel
        — columns should decrease and cards reflow, 3) drag the width slider
        with the panel open — items reposition live, 4) close the panel —
        layout restores without remount or scroll jump.
      </p>
    </div>
  );
}
