/**
 * Deterministic hypothesis check: update() work is governed by the TOPMOST
 * changed item per column (reflow span), not by the number of updates in the
 * batch. Reports deterministic item counts, not timing — ms deltas are
 * environment noise when baseline and head run on different CI machines.
 */
import { buildFilled, makeHeights } from "./positioner.ts";

const HEIGHTS = makeHeights(10_000);

function reflowSpan(indices: number[]): number {
    const filled = buildFilled(HEIGHTS);
    // Map column -> earliest columnItemIndex among the updated items.
    const firstByColumn = new Map<number, number>();
    let totalRewritten = 0;
    for (const index of indices) {
        const item = filled.get(index)!;
        const existing = firstByColumn.get(item.columnIndex);
        if (existing === undefined || item.columnItemIndex < existing) {
            firstByColumn.set(item.columnIndex, item.columnItemIndex);
        }
    }
    // Count items that would be rewritten per column (column length is ~1250 at 10k/8).
    // We infer column lengths from the filled positioner without timing the update.
    const columnLengths = new Map<number, number>();
    for (let i = 0; i < filled.size(); i += 1) {
        const it = filled.get(i)!;
        columnLengths.set(it.columnIndex, (columnLengths.get(it.columnIndex) ?? 0) + 1);
    }
    for (const [col, firstIdx] of firstByColumn) {
        totalRewritten += (columnLengths.get(col) ?? 0) - firstIdx;
    }
    return totalRewritten;
}

function measure(name: string, indices: number[], height: number) {
    void height;
    const span = reflowSpan(indices);
    // columns touched = size of firstByColumn; recompute cheaply via a fresh positioner
    // to avoid coupling reflowSpan internals to the log format
    const probe = buildFilled(HEIGHTS);
    const cols = new Set(indices.map((i) => probe.get(i)!.columnIndex)).size;
    console.log(
        `${name}: ${String(indices.length).padStart(2)} updates · ${String(cols).padStart(1)} cols · ${String(span).padStart(5)} items rewritten (deterministic)`,
    );
}

// 24 updates confined to the last ~3 rows of each column (tail).
measure("24 updates at tail   ", [9_992, 9_993, 9_994, 9_995, 9_996, 9_997, 9_998, 9_999], 350);

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
    350,
);

// Single update at the very top -> still reflows an entire column.
measure("1 update at index 0   ", [0], 350);
