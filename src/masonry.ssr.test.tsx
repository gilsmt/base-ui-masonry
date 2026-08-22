import { describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import { MasonryItem, MasonryRoot } from "./masonry.tsx";

function makeItems(count: number) {
    return Array.from({ length: count }, (_, index) => (
        <MasonryItem key={`item-${index}`}>item {index}</MasonryItem>
    ));
}

function countPlaceholders(html: string) {
    return (html.match(/data-slot="masonry-item"/g) ?? []).length;
}

test("test runtime has no DOM globals (keeps these tests honest)", () => {
    expect(typeof window).toBe("undefined");
    expect(typeof document).toBe("undefined");
    expect(typeof globalThis.ResizeObserver).toBe("undefined");
});

describe("determinism", () => {
    test("identical props render byte-identical HTML", () => {
        const element = <MasonryRoot columnCount={2}>{makeItems(7)}</MasonryRoot>;
        expect(renderToString(element)).toBe(renderToString(element));
    });
});

describe("placeholder batch", () => {
    test("default render emits exactly one hidden, inert placeholder", () => {
        const html = renderToString(<MasonryRoot>{makeItems(7)}</MasonryRoot>);

        expect(countPlaceholders(html)).toBe(1);
        expect(html).toContain('data-index="0"');
        // Placeholders exist only to be measured after hydration:
        expect(html).toContain("inert=");
        expect(html).toContain("visibility:hidden");
        expect(html).toContain("left:0;top:0");
        // Pre-measurement state is exposed for styling:
        expect(html).toContain("data-measuring=");
        // Windowing metadata is present even on placeholders:
        expect(html).toContain('aria-posinset="1"');
        expect(html).toContain('aria-setsize="7"');
    });

    test("explicit columnCount scales the SSR batch", () => {
        const html = renderToString(<MasonryRoot columnCount={3}>{makeItems(7)}</MasonryRoot>);

        expect(countPlaceholders(html)).toBe(3);
        expect(html).toContain('data-index="2"');
        expect(html).not.toContain('data-index="3"');
    });

    test("aria positions reflect the full list, not the window", () => {
        const html = renderToString(<MasonryRoot columnCount={2}>{makeItems(5)}</MasonryRoot>);

        expect(html).toContain('aria-posinset="2" aria-setsize="5"');
    });
});

describe("estimated container height", () => {
    test("defaults: ceil(rows × itemHeight)", () => {
        // 7 items ÷ 1 derived column × 300px default itemHeight
        const html = renderToString(<MasonryRoot>{makeItems(7)}</MasonryRoot>);
        expect(html).toContain("height:2100px");
    });

    test("directional gaps feed the row-gap part of the estimate", () => {
        // ceil(7 / 2) = 4 rows × 250px + (4 - 1) × 8px vertical gap = 1024
        const html = renderToString(
            <MasonryRoot columnCount={2} itemHeight={250} gap={{ horizontal: 10, vertical: 8 }}>
                {makeItems(7)}
            </MasonryRoot>,
        );
        expect(html).toContain("height:1024px");
    });

    test("empty list renders a zero-height root and skips the measuring state", () => {
        const html = renderToString(<MasonryRoot>{[]}</MasonryRoot>);

        expect(html).toContain("height:0;");
        expect(countPlaceholders(html)).toBe(0);
        expect(html).not.toContain("data-measuring");
    });
});

describe("children handling", () => {
    test("non-element children are ignored by the SSR output", () => {
        const html = renderToString(
            <MasonryRoot columnCount={2}>
                {["string", 42, null, true, <MasonryItem key="only">real</MasonryItem>]}
            </MasonryRoot>,
        );

        expect(countPlaceholders(html)).toBe(1);
        expect(html).toContain(">real</div>");
        expect(html).not.toContain("string");
    });

    test("slots keep their roles and data attributes", () => {
        const html = renderToString(
            <MasonryRoot columnCount={1}>
                <MasonryItem key="a">a</MasonryItem>
            </MasonryRoot>,
        );

        expect(html).toContain('data-slot="masonry" role="list"');
        expect(html).toContain('data-slot="masonry-item" role="listitem"');
    });
});
