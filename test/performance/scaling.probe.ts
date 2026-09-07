/**
 * Deterministic scaling probe at 100k items. Reports counts, not timing —
 * wall-clock ms at 100k is environment-dependent in CI; the deterministic
 * signal is how many items are built / rewritten.
 */
import { OPTIONS_8COL, buildFilled, getPlacements, makeHeights } from "./fixtures.ts";

const HEIGHTS = makeHeights(100_000);

const filled = buildFilled(HEIGHTS, OPTIONS_8COL);

// Build at 100k — deterministic count is simply N.
console.log(
    `build 100k:      ${HEIGHTS.length.toLocaleString()} items · ${filled.columnCount} cols (deterministic)`,
);

// Worst-case commit: change the top item of every column -> reflows all items
const placements = getPlacements(filled);
const updates = Array.from({ length: filled.columnCount }, (_, index) => ({
    index,
    height: 350,
}));
const firstRowByColumn = new Map<number, number>();
for (const u of updates) {
    const item = placements[u.index];
    if (item) {
        const existing = firstRowByColumn.get(item.column);
        if (existing === undefined || item.row < existing) {
            firstRowByColumn.set(item.column, item.row);
        }
    }
}
const columnLengths = new Map<number, number>();
for (const placement of placements) {
    columnLengths.set(placement.column, (columnLengths.get(placement.column) ?? 0) + 1);
}
let reflowCount = 0;
for (const [col, firstRow] of firstRowByColumn) {
    reflowCount += (columnLengths.get(col) ?? 0) - firstRow;
}
console.log(
    `reflow 100k:     ${reflowCount.toLocaleString()} items rewritten · ${firstRowByColumn.size} cols touched (deterministic)`,
);
console.log(`hint: run with mitata locally for wall-clock timing on a quiet machine if needed`);
