import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import { reset as resetWarn } from "@base-ui/utils/warn";
import { MasonryItem, MasonryRoot } from "../../src/masonry.tsx";

// Base UI requires every dev warning to have a test that triggers it.
// One of the four MasonryRoot warnings fires during SSR render and is pinned
// here. The other three are emitted from client-only paths (the item slots
// and measurement flush) and need a real browser:
// - "the `children` render function must return a React element" (slot render)
// - "`items` contains null or undefined entries" (slot render)
// - "measured node is missing data-index" (measurement flush)
let warned: string[];
let originalWarn: typeof console.warn;

beforeEach(() => {
    resetWarn();
    warned = [];
    originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
        warned.push(args.map(String).join(" "));
    };
});

afterEach(() => {
    console.warn = originalWarn;
});

describe("MasonryRoot · dev warnings", () => {
    test("keyless items warn about lost measurements on reorder", () => {
        const html = renderToString(
            <MasonryRoot columnCount={1} gap={0} items={[{ name: "a" }]}>
                {() => <MasonryItem key="a">a</MasonryItem>}
            </MasonryRoot>,
        );
        expect(warned).toEqual([
            "Base UI: MasonryRoot: some `items` have no stable string or number key. Give each item an `id` property or pass `getItemKey`. The index fallback discards measured heights on reorder.",
        ]);
        expect(html).toContain('data-slot="masonry"');
    });

    test("keyed items do not warn", () => {
        renderToString(
            <MasonryRoot columnCount={1} gap={0} items={[{ id: "a" }]}>
                {(item) => <MasonryItem key={item.id}>{item.id}</MasonryItem>}
            </MasonryRoot>,
        );
        expect(warned).toEqual([]);
    });
});
