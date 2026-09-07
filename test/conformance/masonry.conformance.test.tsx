import { describe, expect, test } from "bun:test";
import * as React from "react";
import { renderToString } from "react-dom/server";
import { MasonryItem, MasonryRoot } from "../../src/masonry.tsx";

type TestItem = { id: string };

function makeItems(count: number): TestItem[] {
    return Array.from({ length: count }, (_, index) => ({ id: `item-${index}` }));
}

function renderRoot(props?: Partial<React.ComponentProps<typeof MasonryRoot<TestItem>>>) {
    return renderToString(
        <MasonryRoot gap={0} items={makeItems(3)} {...props}>
            {(item) => <MasonryItem key={item.id}>item {item.id}</MasonryItem>}
        </MasonryRoot>,
    );
}

// Base UI conformance subset that holds without a DOM. Ref forwarding,
// pointer/focus interaction, and layout measurement need a real browser;
// SSR covers props spread, className/style resolution, and the render prop.
// The layout state is empty in SSR (`MasonryRootState = {}`): measurements
// only exist after hydration.
describe("MasonryRoot · Base UI conformance (SSR-coverable)", () => {
    test("forwards extra props to the root element", () => {
        const html = renderRoot({ id: "masonry-root", "data-testid": "root" } as object);
        expect(html).toContain('id="masonry-root"');
        expect(html).toContain('data-testid="root"');
    });

    test("className accepts a string", () => {
        expect(renderRoot({ className: "my-masonry" })).toContain('class="my-masonry"');
    });

    test("className accepts a state function receiving the (empty) state", () => {
        let seen: unknown;
        const html = renderRoot({
            className: (state) => {
                seen = state;
                return "from-state";
            },
        });
        expect(seen).toEqual({});
        expect(html).toContain('class="from-state"');
    });

    test("style accepts an object and keeps default geometry", () => {
        const html = renderRoot({ style: { background: "red" } });
        expect(html).toContain("background:red");
        expect(html).toContain("position:relative");
    });

    test("style accepts a state function", () => {
        let seen: unknown;
        const html = renderRoot({
            style: (state) => {
                seen = state;
                return { opacity: 0.5 };
            },
        });
        expect(seen).toEqual({});
        expect(html).toContain("opacity:0.5");
    });

    test("render accepts an element to replace the tag", () => {
        const html = renderRoot({ render: <section data-testid="custom" /> });
        expect(html).toContain("<section");
        expect(html).toContain('data-slot="masonry"');
        expect(html).toContain('data-testid="custom"');
    });

    test("render accepts a function receiving (props, state)", () => {
        let seen: unknown;
        const html = renderRoot({
            render: (props, state) => {
                seen = state;
                return <section {...props} data-from-fn="yes" />;
            },
        });
        expect(seen).toEqual({});
        expect(html).toContain("<section");
        expect(html).toContain('data-from-fn="yes"');
        expect(html).toContain('data-slot="masonry"');
    });
});

// Item slots are client-only (the item list syncs in a layout effect), so the
// item conformance suite renders MasonryItem standalone instead of through a
// mounted root.
describe("MasonryItem · Base UI conformance (SSR-coverable)", () => {
    test("forwards extra props, className, and style", () => {
        const html = renderToString(
            <MasonryItem key="a" data-testid="card" className="card" style={{ color: "blue" }}>
                x
            </MasonryItem>,
        );
        expect(html).toContain('data-testid="card"');
        expect(html).toContain('class="card"');
        expect(html).toContain("color:blue");
    });

    test("render prop replaces the item tag and keeps slot semantics", () => {
        const html = renderToString(
            <MasonryItem key="a" render={<article data-testid="article" />}>
                x
            </MasonryItem>,
        );
        expect(html).toContain("<article");
        expect(html).toContain('data-slot="masonry-item"');
    });

    test("renders as a listitem by default", () => {
        const html = renderToString(<MasonryItem key="a">x</MasonryItem>);
        expect(html).toContain('role="listitem"');
    });

    test("author-provided semantics pass through", () => {
        const html = renderToString(
            <MasonryItem key="a" role="listitem" aria-posinset={99} aria-setsize={99}>
                x
            </MasonryItem>,
        );
        expect(html).toContain('role="listitem"');
        expect(html).toContain('aria-posinset="99"');
        expect(html).toContain('aria-setsize="99"');
    });
});
