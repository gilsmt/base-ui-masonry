/**
 * Deterministic hypothesis check: measurement commits rewrite the tail of each
 * affected column, from the TOPMOST changed item down. Work is governed by the
 * reflow span, not by the number of updates in the batch. Reports
 * deterministic item counts, not timing — ms deltas are environment noise when
 * baseline and head run on different CI machines.
 */
import { buildFilled, getPlacements, getItem, makeHeights } from "./fixtures.ts";

const HEIGHTS = makeHeights(10_000);
const placements = getPlacements(buildFilled(HEIGHTS));

const columnLengths = new Map<number, number>();
for (const placement of placements) {
    columnLengths.set(placement.column, (columnLengths.get(placement.column) ?? 0) + 1);
}

function reflowSpan(indices: number[]): { cols: number; span: number } {
    // Map column -> earliest row among the updated items.
    const firstRowByColumn = new Map<number, number>();
    for (const index of indices) {
        const item = getItem(placements, index);
        const existing = firstRowByColumn.get(item.column);
        if (existing === undefined || item.row < existing) {
            firstRowByColumn.set(item.column, item.row);
        }
    }
    let span = 0;
    for (const [col, firstRow] of firstRowByColumn) {
        span += (columnLengths.get(col) ?? 0) - firstRow;
    }
    return { cols: firstRowByColumn.size, span };
}

function measure(name: string, indices: number[]) {
    const { cols, span } = reflowSpan(indices);
    console.log(
        `${name}: ${String(indices.length).padStart(2)} updates · ${String(cols).padStart(1)} cols · ${String(span).padStart(5)} items rewritten (deterministic)`,
    );
}

// 24 updates confined to the tail rows of each column (3 rows × 8 columns).
measure(
    "24 updates at tail   ",
    Array.from({ length: 24 }, (_, i) => 9_976 + i),
);

// The same 24 updates scattered across the list.
const rand = (seed: number) => {
    let a = seed;
    return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
};
const r = rand(7);
measure(
    "24 updates scattered  ",
    Array.from({ length: 24 }, () => Math.floor(r() * 9_000)),
);

// Single update at the very top -> still reflows an entire column.
measure("1 update at index 0   ", [0]);
