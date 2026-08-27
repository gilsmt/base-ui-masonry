import * as React from 'react';
import { MasonryRoot, MasonryItem } from '@masonry/masonry';
import styles from './masonry.module.css';

function makeItems(count: number, seed = 1) {
  let s = seed;
  const rand = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
  return Array.from({ length: count }, (_, i) => ({
    id: i,
    height: 120 + Math.floor(rand() * 220),
    tint: Math.floor(rand() * 360),
  }));
}

const COUNT_PRESETS = [500, 5000] as const;

interface RunSummary {
  distancePx: number;
  commits: number;
  mutationBatches: number;
  mutationRecords: number;
}

/**
 * Counts React commits (Profiler) and DOM mutations (MutationObserver) while
 * auto-scrolling a fixed distance, normalized per 1000px.
 *
 * Note: in steady state (unchanged rendered item set) React writes nothing to
 * the DOM even without hysteresis — the commit count is the signal to compare
 * against main; mutation counts are tracked to confirm they stay flat.
 */
export default function ScrollPerf() {
  const [count, setCount] = React.useState<number>(500);
  const [distance, setDistance] = React.useState(20000);
  const [step, setStep] = React.useState(40);
  const [summary, setSummary] = React.useState<RunSummary | null>(null);
  const [isRunning, setIsRunning] = React.useState(false);

  const items = React.useMemo(() => makeItems(count, 7), [count]);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const runIdRef = React.useRef(0);
  const isRunningRef = React.useRef(false);
  const commitsRef = React.useRef(0);
  const observerRef = React.useRef<MutationObserver | null>(null);

  const onRender = React.useCallback<React.ProfilerOnRenderCallback>((_, phase) => {
    // Mounts are settled before a run starts; only scroll-driven passes count.
    if (isRunningRef.current && phase !== 'mount') {
      commitsRef.current += 1;
    }
  }, []);

  const stopRun = React.useCallback(() => {
    runIdRef.current += 1;
    isRunningRef.current = false;
    observerRef.current?.disconnect();
    observerRef.current = null;
  }, []);

  React.useEffect(() => stopRun, [stopRun]);

  const run = async () => {
    if (isRunningRef.current) return;
    stopRun();
    setIsRunning(true);
    setSummary(null);

    await nextFrames(2);
    const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
    const targetDistance = Math.min(distance, Math.max(0, maxScroll - 10));

    window.scrollTo(0, Math.min(window.scrollY, 2));
    await nextFrames(30); // let initial measurement batches settle

    let mutationBatches = 0;
    let mutationRecords = 0;
    commitsRef.current = 0;

    const observer = new MutationObserver((records) => {
      mutationBatches += 1;
      mutationRecords += records.length;
    });
    if (rootRef.current) {
      observer.observe(rootRef.current, { attributes: true, childList: true, subtree: true });
    }
    observerRef.current = observer;

    const startY = window.scrollY;
    let y = startY;
    const runId = runIdRef.current;

    const frame = () => {
      if (runIdRef.current !== runId) return; // superseded or unmounted
      y += step;
      window.scrollTo(0, y);
      if (y - startY < targetDistance) {
        requestAnimationFrame(frame);
        return;
      }
      stopRun();
      setIsRunning(false);
      setSummary({
        distancePx: Math.round(y - startY),
        commits: commitsRef.current,
        mutationBatches,
        mutationRecords,
      });
    };

    isRunningRef.current = true;
    requestAnimationFrame(frame);
  };

  return (
    <div className={styles.container}>
      <div className={styles.controls}>
        <div className={styles.controlsRow}>
          <div className="flex flex-wrap gap-2">
            {COUNT_PRESETS.map((n) => (
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
                disabled={isRunning}
              >
                {n.toLocaleString()} items
              </button>
            ))}
            <label className={styles.control}>
              <span className={styles.controlLabel}>Distance px</span>
              <input
                className={styles.controlInput}
                type="number"
                min={1000}
                max={200000}
                step={1000}
                value={distance}
                disabled={isRunning}
                onChange={(e) => setDistance(Math.max(1000, Number(e.target.value) || 0))}
              />
            </label>
            <label className={styles.control}>
              <span className={styles.controlLabel}>px / frame</span>
              <input
                className={styles.controlInput}
                type="number"
                min={1}
                max={500}
                value={step}
                disabled={isRunning}
                onChange={(e) => setStep(Math.max(1, Number(e.target.value) || 1))}
              />
            </label>
            <button type="button" className={styles.button} onClick={run} disabled={isRunning}>
              {isRunning ? 'Scrolling…' : 'Run'}
            </button>
          </div>
        </div>
      </div>

      {summary ? (
        <table className="mt-4 text-sm" cellPadding={8}>
          <thead>
            <tr className="text-left text-gray-500">
              <th>Metric</th>
              <th>Total</th>
              <th>per 1000px</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Distance scrolled</td>
              <td>{Math.round(summary.distancePx).toLocaleString()}px</td>
              <td>—</td>
            </tr>
            <tr>
              <td>React commits</td>
              <td>{summary.commits}</td>
              <td>{((summary.commits / Math.max(1, summary.distancePx)) * 1000).toFixed(2)}</td>
            </tr>
            <tr>
              <td>DOM mutation batches</td>
              <td>{summary.mutationBatches}</td>
              <td>
                {((summary.mutationBatches / Math.max(1, summary.distancePx)) * 1000).toFixed(2)}
              </td>
            </tr>
            <tr>
              <td>DOM mutation records</td>
              <td>{summary.mutationRecords}</td>
              <td>{((summary.mutationRecords / summary.distancePx) * 1000).toFixed(2)}</td>
            </tr>
          </tbody>
        </table>
      ) : null}

      <div ref={rootRef} className={styles.masonryFrame}>
        <React.Profiler id="masonry-scroll" onRender={onRender}>
          <MasonryRoot columnWidth={240} gap={12} overscan={2} itemHeight={200}>
            {items.map((item) => (
              <MasonryItem key={item.id}>
                <article
                  style={{ height: item.height, background: `oklch(76% 0.12 ${item.tint}deg)` }}
                />
              </MasonryItem>
            ))}
          </MasonryRoot>
        </React.Profiler>
      </div>
    </div>
  );
}

function nextFrames(n: number) {
  return new Promise<void>((resolve) => {
    let remaining = n;
    const tick = () => {
      remaining -= 1;
      if (remaining <= 0) resolve();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}
