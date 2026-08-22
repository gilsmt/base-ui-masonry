# base-ui-masonry

A responsive, highly optimized, unstyled masonry UI layout component. With virtualization, built for being used alongside [BaseUI](https://base-ui.com) in React 19 projects. Made to be highly portable.

This component is meant to be vendored, not treated as a fixed npm dependency. Copy the file into your repository, read it, and change it to match your team's standards and goals.

## Usage

### 1. Install dependencies

```bash
npm install @base-ui/react @base-ui/utils
```

```bash
pnpm add @base-ui/react @base-ui/utils
```

```bash
bun add @base-ui/react @base-ui/utils
```

### 2. Copy and paste the following code into your project

[masonry.tsx](./src/masonry.tsx)

## Anatomy

Import the parts, and assemble them together.

```tsx
import { MasonryRoot, MasonryItem } from "@/components/ui/masonry";

return (
    <MasonryRoot columnCount={6} gap={12}>
        {items.map((item) => (
            <MasonryItem key={item.id}>
                <Card>...</Card>
            </MasonryItem>
        ))}
    </MasonryRoot>
);
```

Use the render prop to compose a part with your own React components.

For example, MasonryItem renders a `<div>` by default. The code snippet below shows how to use a custom button instead.

```tsx
<MasonryItem key={item.id} render={<MyButton size="md" />}>
    ...
</MasonryItem>
```

The custom component must forward the `ref`, and spread all the received props on its underlying DOM node. [Learn more](https://base-ui.com/react/handbook/composition)

## Bundle size

| Bundle                                                                   | Minified | Gzipped | Brotli  |
| ------------------------------------------------------------------------ | -------- | ------- | ------- |
| `masonry.tsx` alone (`@base-ui/*` external) — standalone copy/paste cost | 9.81 kB  | 4.05 kB | 3.68 kB |
| `masonry.tsx` + tree-shaken `@base-ui` deps                              | 16.98 kB | 6.67 kB | 6.03 kB |

For reference, the raw source file is 37.03 kB / ~1,050 lines (8.94 kB gzipped), and `Bun` bundler produces the numbers above (`bun build --minify`, react/react-dom external).

## API reference

### MasonryRoot

Groups all parts of the masonry layout.
Renders a `<div>` element.

**MasonryRoot Props:**

| Prop           | Type                                                                                     | Default    | Description                                                                                                                                                                                                                        |
| :------------- | :--------------------------------------------------------------------------------------- | :--------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| columnCount    | `number`                                                                                 | -          | Fixed number of columns. Ignored when unset; column count is derived from `columnWidth` and the container width.                                                                                                                   |
| columnWidth    | `number`                                                                                 | `200`      | Preferred column width used to derive the column count (unless `columnCount` is set). Items stretch to fill their column.                                                                                                          |
| gap            | `number \| { horizontal: number; vertical: number }`                                     | `0`        | Gap between columns and rows, or directional gaps as an object.                                                                                                                                                                    |
| itemHeight     | `number`                                                                                 | `300`      | Assumed average item height used to estimate container height and batch sizes while items are still being measured.                                                                                                                |
| maxColumnCount | `number`                                                                                 | `Infinity` | Cap on columns derived from `columnWidth`; non-finite or non-positive values mean uncapped.                                                                                                                                        |
| overscan       | `number`                                                                                 | `1.5`      | Viewport-height multiplier controlling how far beyond the visible area items are rendered/unmeasured items are batched. Larger ahead of the scroll direction than behind it. `Infinity` disables windowing and renders every item. |
| className      | `string \| ((state: MasonryRootState) => string \| undefined)`                           | -          | CSS class applied to the element, or a function that returns a class based on the component's state.                                                                                                                               |
| style          | `React.CSSProperties \| ((state: MasonryRootState) => React.CSSProperties \| undefined)` | -          | Style applied to the element, or a function that returns a style object based on the component's state.                                                                                                                            |
| render         | `ReactElement \| ((props: HTMLProps, state: MasonryRootState) => ReactElement)`          | -          | Allows you to replace the component's HTML element with a different tag, or compose it with another component. Accepts a `ReactElement` or a function that returns the element to render.                                          |

**MasonryRoot Data Attributes:**

| Attribute      | Type        | Description                                                       |
| :------------- | :---------- | :---------------------------------------------------------------- |
| data-measuring | `boolean`   | Present while unmeasured items are still batched into the layout. |
| data-slot      | `'masonry'` | Identifies the masonry root slot.                                 |

### MasonryItem

A single item of the masonry layout.
Renders a `<div>` element.

**MasonryItem Props:**

| Prop      | Type                                                                                     | Default | Description                                                                                                                                                                               |
| :-------- | :--------------------------------------------------------------------------------------- | :------ | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| className | `string \| ((state: MasonryItemState) => string \| undefined)`                           | -       | CSS class applied to the element, or a function that returns a class based on the component's state.                                                                                      |
| style     | `React.CSSProperties \| ((state: MasonryItemState) => React.CSSProperties \| undefined)` | -       | Style applied to the element, or a function that returns a style object based on the component's state.                                                                                   |
| render    | `ReactElement \| ((props: HTMLProps, state: MasonryItemState) => ReactElement)`          | -       | Allows you to replace the component's HTML element with a different tag, or compose it with another component. Accepts a `ReactElement` or a function that returns the element to render. |

**MasonryItem Data Attributes:**

| Attribute  | Type             | Description                                           |
| :--------- | :--------------- | :---------------------------------------------------- |
| data-index | `number`         | Indicates the index of the item within the full list. |
| data-slot  | `'masonry-item'` | Identifies the masonry item slot.                     |

**MasonryItem ARIA Attributes:**

| Attribute     | Type     | Description                                |
| :------------ | :------- | :----------------------------------------- |
| aria-posinset | `number` | Position of the item within the full list. |
| aria-setsize  | `number` | Total number of items in the list.         |

## Server-side rendering

`MasonryRoot` is a client component that server-renders safely.

### Known limitations

- Until JS measures the first batch, placeholders are invisible: users without JavaScript see an
  estimated-height empty box, and content beyond the batch isn't in the HTML at all (windowing).
- Replacing the estimate with measured heights can cause minor layout shift on slow connections;
  realistic `itemHeight`/`gap` values minimize it.

### Streaming (RSC / Suspense)

Growing the children list by **appending keys** (the typical streaming pattern) never resets the
layout — already-measured items keep their positions and new items join the unmeasured frontier.
Removing, prepending, or reordering keys resets the measurement caches and rebuilds the positioner,
so keep keys stable and append-only for progressive rendering.

## Scope & trade-offs

Affordances that peer virtualizers (react-window, TanStack Virtual, react-virtuoso) ship, which
this component deliberately lacks. Listed so you can decide whether they matter before vendoring:

- **No imperative API.** For jump-to-item UIs: Rendered items expose `data-index`, so you can find one with `container.querySelector('[data-index="42"]')` and call `scrollIntoView()`. Items outside the rendered window have no DOM node — scroll to an estimated offset derived from `itemHeight` instead, then refine once the item mounts.
- **No RTL support.** Columns are placed left-to-right with physical `left` offsets, so `direction: rtl` does not mirror the layout: the first column remains leftmost even when the reading order is right-to-left. Screen-reader order (`aria-posinset`) still follows source order.

## Notes

- Children must be keyed elements (`key={item.id}`). Non-element children (strings, numbers, fragments) are ignored. Items are kept in DOM order, so tab order and keyboard navigation follow the source order.
- **Scrolling** follows the **window** scroll position (`window.scrollY`), not an inner scrollable container. If your layout scrolls inside an `overflow: auto` element, hook it up yourself or place the masonry inside the page scroller.
- `columnWidth` is a _preferred_ width used to derive the column count. Items will always try to stretch to fill their (equal-width) columns for consistency.
- The rendered window extends further **below** the viewport than above it: scrolling down races the unmeasured frontier (render + measurement lag), while everything above is already placed and only needs render-lag cover.
- The root sets `height`, `position: relative`, `width: 100%`, and `maxWidth: 100%` inline as its layout contract. Your own `style` takes precedence over them (Base UI convention) — overriding `height` or `position` could break virtualization.
- `overscan={0}` restricts rendering to exactly the viewport; `overscan={Infinity}` disables virtualization entirely (every item is mounted and measured).

## Contributing

Open to pull requests & suggestions.

## License

This project is licensed under the MIT License - see the [LICENSE file](LICENSE) for details.
