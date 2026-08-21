import * as React from 'react';
import { MasonryRoot, MasonryItem } from '@masonry/masonry';
import styles from './masonry.module.css';

type Item = {
  id: number;
  title: string;
  height: number;
  color: string;
};

const LOREM =
  'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed non risus. Suspendisse lectus tortor, dignissim sit amet.';

function makeItems(count: number, seed: number, variableHeights: boolean): Item[] {
  // Deterministic pseudo-random so layout is stable across renders for perf comparison
  let s = seed;
  const rand = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
  return Array.from({ length: count }, (_, i) => ({
    id: i,
    title: `Item ${i + 1}`,
    height: variableHeights ? 120 + Math.floor(rand() * 260) : 180,
    color: `oklch(78% 0.14 ${Math.floor(rand() * 360)}deg)`,
  }));
}

export default function MasonryDemo() {
  const [itemCount, setItemCount] = React.useState(120);
  const [columnWidth, setColumnWidth] = React.useState(240);
  const [gap, setGap] = React.useState(12);
  const [maxColumnCount, setMaxColumnCount] = React.useState(6);
  const [overscan, setOverscan] = React.useState(2);
  const [columnCount, setColumnCount] = React.useState<number | undefined>(undefined);
  const [variableHeights, setVariableHeights] = React.useState(true);
  const [seed, setSeed] = React.useState(42);

  const items = React.useMemo(
    () => makeItems(itemCount, seed, variableHeights),
    [itemCount, seed, variableHeights],
  );

  return (
    <div className={styles.container}>
      <h1>Masonry — interactive demo</h1>
      <p>
        Directly renders <code className={styles.kbd}>src/masonry.tsx</code> with hot reload. Adjust
        props to verify column balancing, virtualization, and resize handling against the refactor.
      </p>

      <div className={styles.controls}>
        <div className={styles.controlsRow}>
          <label className={styles.control}>
            <span className={styles.controlLabel}>Items</span>
            <input
              type="range"
              min={10}
              max={2000}
              step={10}
              value={itemCount}
              onChange={(e) => setItemCount(Number(e.target.value))}
            />
            <span className={styles.rangeLabel}>
              <span className={styles.secondaryText}>10 → 2000</span>
              <span className={styles.rangeValue}>{itemCount}</span>
            </span>
          </label>

          <label className={styles.control}>
            <span className={styles.controlLabel}>Column width (preferred)</span>
            <input
              className={styles.controlInput}
              type="number"
              min={120}
              max={500}
              step={10}
              value={columnWidth}
              onChange={(e) => setColumnWidth(Math.max(120, Number(e.target.value) || 0))}
            />
          </label>

          <label className={styles.control}>
            <span className={styles.controlLabel}>Gap</span>
            <input
              className={styles.controlInput}
              type="number"
              min={0}
              max={32}
              step={1}
              value={gap}
              onChange={(e) => setGap(Math.max(0, Number(e.target.value) || 0))}
            />
          </label>

          <label className={styles.control}>
            <span className={styles.controlLabel}>Max columns</span>
            <input
              className={styles.controlInput}
              type="number"
              min={1}
              max={16}
              step={1}
              value={maxColumnCount}
              onChange={(e) => setMaxColumnCount(Math.max(1, Number(e.target.value) || 0))}
            />
          </label>

          <label className={styles.control}>
            <span className={styles.controlLabel}>Overscan</span>
            <input
              className={styles.controlInput}
              type="number"
              min={0}
              max={6}
              step={0.5}
              value={overscan}
              onChange={(e) => setOverscan(Math.max(0, Number(e.target.value) || 0))}
            />
          </label>

          <label className={styles.control} style={{ minWidth: 180 }}>
            <span className={styles.controlLabel}>Column count (override)</span>
            <select
              className={styles.controlInput}
              value={columnCount ?? ''}
              onChange={(e) => {
                const v = e.target.value;
                setColumnCount(v === '' ? undefined : Number(v));
              }}
            >
              <option value="">auto (from columnWidth)</option>
              {[1, 2, 3, 4, 5, 6, 8, 12].map((n) => (
                <option key={n} value={n}>
                  {n} columns
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <label className="inline-flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={variableHeights}
              onChange={(e) => setVariableHeights(e.target.checked)}
            />
            Variable heights
          </label>
          <button type="button" className={styles.button} onClick={() => setSeed((s) => s + 1)}>
            Shuffle
          </button>
          <span className={styles.secondaryText}>
            Seed {seed} · Virtualized window follows{' '}
            <code className={styles.kbd}>window.scrollY</code>
          </span>
        </div>
      </div>

      <div className={styles.masonryFrame}>
        <MasonryRoot
          columnCount={columnCount}
          columnWidth={columnWidth}
          gap={gap}
          maxColumnCount={maxColumnCount}
          overscan={overscan}
          itemHeight={180}
        >
          {items.map((item) => (
            <MasonryItem key={item.id}>
              <article className={styles.card}>
                <div
                  className={styles.cardMedia}
                  style={{ height: item.height, background: item.color }}
                  aria-hidden
                />
                <div className={styles.cardBody}>
                  <div className="flex items-center justify-between gap-2">
                    <h3 className={styles.cardTitle}>{item.title}</h3>
                    <span className={styles.badge}>{item.height}px</span>
                  </div>
                  <div className={styles.cardMeta}>
                    #{item.id} · columnWidth {columnWidth}px
                  </div>
                  <p className={styles.cardText}>{LOREM}</p>
                </div>
              </article>
            </MasonryItem>
          ))}
        </MasonryRoot>
      </div>

      <div className={styles.stats}>
        <div className={styles.stat}>
          <div className={styles.statLabel}>Total items</div>
          <div className={styles.statValue}>{items.length}</div>
        </div>
        <div className={styles.stat}>
          <div className={styles.statLabel}>Column width (resolved)</div>
          <div className={styles.statValue}>auto (fills column)</div>
        </div>
        <div className={styles.stat}>
          <div className={styles.statLabel}>Tip</div>
          <div className="text-xs leading-5 text-gray-600 mt-1">
            Resize the window — ResizeObserver re-measures columns. Open Performance panel to
            inspect React tracks after <code className={styles.kbd}>pnpm build:profile</code>.
          </div>
        </div>
      </div>
    </div>
  );
}
