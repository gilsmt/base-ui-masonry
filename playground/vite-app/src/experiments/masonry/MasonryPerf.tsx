import * as React from 'react';
import { MasonryRoot, MasonryItem } from '@masonry/masonry';
import PerformanceBenchmark from '../perf/utils/benchmark';
import styles from './masonry.module.css';

function makeItems(count: number, seed = 1) {
  let s = seed;
  const rand = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
  return Array.from({ length: count }, (_, i) => ({
    id: i,
    title: `Item ${i + 1}`,
    height: 120 + Math.floor(rand() * 220),
    tint: Math.floor(rand() * 360),
  }));
}

const PRESETS = [100, 500, 2000, 5000, 10000] as const;

export default function MasonryPerf() {
  const [count, setCount] = React.useState<number>(500);
  const [gap, setGap] = React.useState(12);
  const [columnWidth, setColumnWidth] = React.useState(240);
  const [overscan, setOverscan] = React.useState(2);
  const [keySeed, setKeySeed] = React.useState(1);

  const items = React.useMemo(() => makeItems(count, 7), [count]);

  return (
    <div className={styles.container}>
      <h1>Masonry — virtualization benchmark</h1>
      <p>
        Mounts <code className={styles.kbd}>MasonryRoot</code> with N items and measures{' '}
        <em>mount → DOM settled</em> (quiet-window, same logic as Base UI&apos;s{' '}
        <code className={styles.kbd}>perf/benchmark.tsx</code>). Use it to compare the refactor
        against main: keep props identical and compare Run-20 averages. For commit-level profiling,
        use <code className={styles.kbd}>pnpm build:profile</code> and Chrome Performance → React
        tracks.
      </p>

      <div className={styles.controls}>
        <div className={styles.controlsRow}>
          <div className="flex flex-wrap gap-2">
            {PRESETS.map((n) => (
              <button
                key={n}
                type="button"
                className={styles.button}
                aria-pressed={count === n}
                style={{
                  background: count === n ? 'var(--color-gray-900)' : undefined,
                  color: count === n ? 'white' : undefined,
                  borderColor: count === n ? 'var(--color-gray-900)' : undefined,
                }}
                onClick={() => setCount(n)}
              >
                {n.toLocaleString()}
              </button>
            ))}
            <label className="inline-flex items-center gap-2 text-sm ml-2">
              custom
              <input
                className={styles.controlInput}
                style={{ width: 110 }}
                type="number"
                min={10}
                max={50000}
                step={100}
                value={count}
                onChange={(e) => setCount(Math.max(10, Number(e.target.value) || 0))}
              />
            </label>
          </div>
        </div>

        <div className={styles.controlsRow}>
          <label className={styles.control}>
            <span className={styles.controlLabel}>Column width</span>
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
          <div className="flex items-end gap-2">
            <button type="button" className={styles.button} onClick={() => setKeySeed((k) => k + 1)}>
              Remount
            </button>
            <span className={styles.secondaryText}>
              Change props between benchmark runs to isolate regresssions.
            </span>
          </div>
        </div>
      </div>

      <PerformanceBenchmark>
        {/* key forces full remount when counting outliers across presets */}
        <BenchTree
          key={`${count}-${columnWidth}-${gap}-${overscan}-${keySeed}`}
          items={items}
          columnWidth={columnWidth}
          gap={gap}
          overscan={overscan}
        />
      </PerformanceBenchmark>

      <section className="rounded-lg border border-gray-200 bg-white p-4 text-sm leading-6 mt-6">
        <h2 className="font-semibold">How to interpret</h2>
        <ul className="list-disc pl-5 mt-2 space-y-1 text-gray-700">
          <li>
            <strong>Run 20 / 50</strong> logs an array of durations + average/stddev; with{' '}
            <em>Remove outliers</em> it uses IQR filtering.
          </li>
          <li>Masonry is fully virtualized — DOM node count stays ~ overscan window regardless of N. Expect near-flat timings up to 10k items.</li>
          <li>Compare refactor vs baseline at same <code className={styles.kbd}>count</code>, <code className={styles.kbd}>columnWidth</code>, <code className={styles.kbd}>overscan</code>; record warmup=5, iterations=20 deltas.</li>
          <li>For micro work, check <code className={styles.kbd}>MasonryRoot</code> render + ResizeObserver commit in Performance → React Tracks.</li>
        </ul>
      </section>
    </div>
  );
}

function BenchTree(props: {
  items: ReturnType<typeof makeItems>;
  columnWidth: number;
  gap: number;
  overscan: number;
}) {
  const { items, columnWidth, gap, overscan } = props;
  return (
    <div className={styles.masonryFrame}>
      <MasonryRoot columnWidth={columnWidth} gap={gap} overscan={overscan} itemHeight={200}>
        {items.map((item) => (
          <MasonryItem key={item.id}>
            <article className={styles.card}>
              <div
                aria-hidden
                style={{
                  height: item.height,
                  background: `oklch(76% 0.12 ${item.tint}deg)`,
                }}
              />
              <div className={styles.cardBody}>
                <div className={styles.cardTitle}>{item.title}</div>
                <div className={styles.cardMeta}>{item.height}px · tint {item.tint}°</div>
              </div>
            </article>
          </MasonryItem>
        ))}
      </MasonryRoot>
    </div>
  );
}
