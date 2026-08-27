/**
 * Deterministic render-count probe for the window-shift inertia guard (#2):
 * simulating a scroll through a 10k-item list at various speeds, how often
 * does isWindowShiftInert reject the update (saving a flushSync render).
 *
 * This is the CI signal: inert % and commits per 1000px are deterministic
 * given the seeded heights, so any delta is meaningful. Wall-clock timing
 * is intentionally omitted — baseline and head run on different machines
 * under different conditions in CI, so ms deltas mostly measure the
 * environment, not the change. Use a quiet local machine with mitata for
 * ad-hoc timing if needed.
 *
 * Frame stepping assumes 60fps (16.7ms per frame).
 */
import {
    OVERSCAN,
    VIEWPORT_HEIGHT,
    buildFilled,
    getWindowRange,
    makeHeights,
} from "./positioner.ts";

const HEIGHTS = makeHeights(10_000);
const filled = buildFilled(HEIGHTS);
const totalHeight = filled.shortestColumn();

function simulate(name: string, pxPerSecond: number) {
    const step = Math.max(1, Math.round(pxPerSecond / 60));
    let inert = 0;
    let nonInert = 0;
    let previous = getWindowRange(Math.max(0, 5_000 - VIEWPORT_HEIGHT), VIEWPORT_HEIGHT, OVERSCAN);

    for (let scrollTop = 5_000; scrollTop < totalHeight - VIEWPORT_HEIGHT; scrollTop += step) {
        const next = getWindowRange(scrollTop, VIEWPORT_HEIGHT, OVERSCAN);
        const isInert = filled.isWindowShiftInert(previous, next);
        if (isInert) {
            inert += 1;
        } else {
            nonInert += 1;
        }
        previous = next;
    }

    const frames = inert + nonInert;
    const totalScrollM = ((totalHeight - VIEWPORT_HEIGHT - 5_000) / 1000 / 1000).toFixed(2);
    const commitsPer1kPx = (nonInert / Math.max(1, totalHeight - VIEWPORT_HEIGHT - 5_000)) * 1000;
    console.log(
        `${name.padEnd(28)} ${String(step).padStart(4)}px/frame · ` +
            `inert ${(inert / frames * 100).toFixed(1).padStart(5)}% · ` +
            `commits ${String(nonInert).padStart(4)}/${String(frames).padStart(4)}` +
            ` (${commitsPer1kPx.toFixed(2)}/1kpx) · ` +
            `(${totalScrollM}M px simulated)`,
    );
}

// Slow drift, normal wheel, fast flick, and instant jump-to-bottom.
simulate("slow scroll (~600 px/s)", 600);
simulate("normal scroll (~1500 px/s)", 1500);
simulate("fast flick (~4000 px/s)", 4000);
simulate("momentum (~10000 px/s)", 10_000);
