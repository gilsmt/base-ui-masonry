/**
 * Deterministic scaling probe at 100k items. Reports counts, not timing —
 * wall-clock ms at 100k is environment-dependent in CI; the deterministic
 * signal is how many items are built / rewritten.
 *
 * Previously this was a min-of-N wall-clock sanity check on the mitata
 * numbers; now it logs the deterministic work size
 */
import { OPTIONS_8COL, buildFilled, makeHeights } from "./positioner.ts";

const HEIGHTS = makeHeights(100_000);

const filled = buildFilled(HEIGHTS, OPTIONS_8COL);

// Build at 100k — deterministic count is simply N.
console.log(
    `build 100k:      ${HEIGHTS.length.toLocaleString()} items · ${filled.columnCount} cols (deterministic)`,
);

// Worst-case commit: change top item of every column -> reflows all items
const updates = Array.from({ length: filled.columnCount }, (_, index) => ({
    index,
    height: 350,
}));
let reflowCount = 0;
{
    const firstByColumn = new Map<number, number>();
    for (const u of updates) {
        const item = (filled as any).get(u.index)!;
        firstByColumn.set(item.columnIndex, item.columnItemIndex);
    }
    const columnLengths = new Map<number, number>();
    for (let i = 0; i < filled.size(); i += 1) {
        const it = (filled as any).get(i)!;
        columnLengths.set(it.columnIndex, (columnLengths.get(it.columnIndex) ?? 0) + 1);
    }
    for (const [col, firstIdx] of firstByColumn) {
        reflowCount += (columnLengths.get(col) ?? 0) - firstIdx;
    }
}
console.log(
    `reflow 100k:     ${reflowCount.toLocaleString()} items rewritten · ${updates.length} cols touched (deterministic)`,
);
console.log(`hint: run with mitata locally for wall-clock timing on a quiet machine if needed`);
