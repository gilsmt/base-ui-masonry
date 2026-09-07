import { describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import { MasonryItem, MasonryRoot } from "../../src/masonry.tsx";

type TestItem = { id: string };

function makeItems(count: number): TestItem[] {
    return Array.from({ length: count }, (_, index) => ({ id: `item-${index}` }));
}

test("test runtime has no DOM globals (keeps these tests honest)", () => {
    expect(typeof window).toBe("undefined");
    expect(typeof document).toBe("undefined");
    expect(typeof globalThis.ResizeObserver).toBe("undefined");
});

describe("determinism", () => {
    test("identical props render byte-identical HTML", () => {
        const items = makeItems(7);
        const element = (
            <MasonryRoot columnCount={2} gap={0} items={items}>
                {(item) => <MasonryItem key={item.id}>item {item.id}</MasonryItem>}
            </MasonryRoot>
        );
        expect(renderToString(element)).toBe(renderToString(element));
    });
});

describe("empty server shell", () => {
    // The item list is synced in a layout effect, so the server cannot know
    // the layout: SSR emits an empty list container and items appear at
    // hydration. Pins that no stale placeholder markup leaks into the shell.
    test("the root renders an empty list container regardless of items", () => {
        const html = renderToString(
            <MasonryRoot columnCount={2} gap={0} items={makeItems(7)}>
                {(item) => <MasonryItem key={item.id}>item {item.id}</MasonryItem>}
            </MasonryRoot>,
        );

        expect(html).toContain('data-slot="masonry"');
        expect(html).toContain('role="list"');
        expect(html).toContain("height:0");
        expect(html).toContain("position:relative");
        // No items are server-rendered: no slots, no positions, no aria counts.
        expect(html).not.toContain('data-slot="masonry-item"');
        expect(html).not.toContain("data-index");
        expect(html).not.toContain("aria-posinset");
        expect(html).not.toContain("item-");
    });

    test("empty and non-empty items produce identical shells", () => {
        const render = (list: TestItem[]) =>
            renderToString(
                <MasonryRoot gap={0} items={list}>
                    {(item) => <MasonryItem key={item.id}>{item.id}</MasonryItem>}
                </MasonryRoot>,
            );
        expect(render([])).toBe(render(makeItems(7)));
    });

    test("root className and style still resolve on the shell", () => {
        const html = renderToString(
            <MasonryRoot
                className="my-masonry"
                gap={0}
                items={makeItems(3)}
                style={{ background: "red" }}
            >
                {(item) => <MasonryItem key={item.id}>{item.id}</MasonryItem>}
            </MasonryRoot>,
        );

        expect(html).toContain('class="my-masonry"');
        expect(html).toContain("background:red");
    });
});

describe("fallback", () => {
    test("non-empty items render the fallback instead of the empty shell", () => {
        const html = renderToString(
            <MasonryRoot fallback={<div className="skeleton">loading</div>} gap={0} items={makeItems(3)}>
                {(item) => <MasonryItem key={item.id}>{item.id}</MasonryItem>}
            </MasonryRoot>,
        );

        expect(html).toContain('class="skeleton"');
        expect(html).toContain("loading");
        expect(html).not.toContain('data-slot="masonry-item"');
        expect(html).not.toContain("height:0");
    });

    test("empty items never render the fallback", () => {
        const html = renderToString(
            <MasonryRoot
                fallback={<div className="skeleton">loading</div>}
                gap={0}
                items={[] as TestItem[]}
            >
                {(item) => <MasonryItem key={item.id}>{item.id}</MasonryItem>}
            </MasonryRoot>,
        );

        expect(html).not.toContain('class="skeleton"');
        expect(html).toContain("height:0");
    });
});
