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
    <MasonryRoot items={items} columnCount={6} gap={12}>
        {(item) => (
            <MasonryItem key={item.id}>
                <Card>...</Card>
            </MasonryItem>
        )}
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
| `masonry.tsx` alone (`@base-ui/*` external) — standalone copy/paste cost | 10.16 kB | 4.05 kB | 3.67 kB |
| `masonry.tsx` + tree-shaken `@base-ui` deps                              | 16.97 kB | 6.58 kB | 5.95 kB |

Run `bun run size:update` to refresh.

## API reference

### MasonryRoot

Groups all parts of the masonry layout.
Renders a `<div>` element.

**MasonryRoot Props:**

| Prop           | Type                                                                                     | Default    | Description                                                                                                                                                                                                                                      |
| :------------- | :--------------------------------------------------------------------------------------- | :--------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| children       | `(item: T, index: number) => React.ReactElement`                                         | -          | Render function for each item. Receives the item and its index.                                                                                                                                                                                  |
| columnCount    | `number`                                                                                 | -          | The number of columns to render. When unset, non-positive, or non-finite, the column count is derived from `columnWidth` and the container width.                                                                                                |
| columnWidth    | `number`                                                                                 | `200`      | The preferred width of each column in pixels, used to derive the column count. To render a fixed number of columns, use the `columnCount` prop instead. Items always stretch to fill their column.                                               |
| container      | `HTMLElement \| null`                                                                    | `window`   | The element whose scroll position drives windowing. Pass the element that actually scrolls when the masonry is inside an overflow container.                                                                                                     |
| fallback       | `React.ReactNode`                                                                        | -          | Content rendered before items sync: the server HTML and the pre-hydration render, when `items` is non-empty. The explicit container height is omitted while it renders, so it sizes the box.                                                     |
| gap            | `number \| { horizontal: number; vertical: number }`                                     | -          | The gap between columns and rows in pixels. Accepts a single number for both axes or an object to configure them individually. When an object is provided, `vertical` defaults to `horizontal`.                                                  |
| getItemKey     | `(item: T) => React.Key`                                                                 | `item.id`  | Returns the stable string or number identity of an item, used to keep measured heights attached to their item across reorders. Defaults to the `id` property for objects, or the item itself for strings and numbers.                            |
| itemHeight     | `number`                                                                                 | `300`      | The assumed height in pixels for items before they are measured.                                                                                                                                                                                 |
| items          | `readonly T[]`                                                                           | -          | Data to display. Each item is passed to the `children` render function. Each item needs a stable identity (`id` by default, or `getItemKey`) so measured heights survive reorders. An empty list needs an explicit type: `items={[] as Item[]}`. |
| maxColumnCount | `number`                                                                                 | `Infinity` | The maximum number of columns that can be derived from `columnWidth`. Non-finite or non-positive values mean the column count is uncapped.                                                                                                       |
| overscan       | `number`                                                                                 | `2`        | How far beyond the viewport, as a multiple of its height, items are rendered. The window extends further below the viewport than above it. Use `Infinity` to disable windowing and render every item.                                            |
| className      | `string \| ((state: MasonryRootState) => string \| undefined)`                           | -          | CSS class applied to the element, or a function that returns a class based on the component's state.                                                                                                                                             |
| style          | `React.CSSProperties \| ((state: MasonryRootState) => React.CSSProperties \| undefined)` | -          | Style applied to the element, or a function that returns a style object based on the component's state.                                                                                                                                          |
| render         | `ReactElement \| ((props: HTMLProps, state: MasonryRootState) => ReactElement)`          | -          | Allows you to replace the component's HTML element with a different tag, or compose it with another component. Accepts a `ReactElement` or a function that returns the element to render.                                                        |

**MasonryRoot Data Attributes:**

| Attribute | Type        | Description                       |
| :-------- | :---------- | :-------------------------------- |
| data-slot | `'masonry'` | Identifies the masonry root slot. |

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

| Attribute  | Type             | Description                                       |
| :--------- | :--------------- | :------------------------------------------------ |
| data-index | `number`         | Indicates the index of the item within the items. |
| data-slot  | `'masonry-item'` | Identifies the masonry item slot.                 |

**MasonryItem ARIA Attributes:**

| Attribute     | Type     | Description                                                         |
| :------------ | :------- | :------------------------------------------------------------------ |
| aria-posinset | `number` | Position within the full `items` array. Explicit values always win. |
| aria-setsize  | `number` | Total number of items. Explicit values always win.                  |

Masonry renders a `list` of `listitem` slots by default. Override `role` on either part when the content needs different semantics (for example `role="feed"` / `role="article"`).

## Server-side rendering

`MasonryRoot` is a client component that server-renders safely.

### Known limitations

- Without JavaScript there are no measurements, so the server HTML holds the `fallback`
  prop when `items` is non-empty, or an empty box otherwise.
  Only the rendered window is in the HTML (windowing).
- Replacing the estimate with measured heights can cause minor layout shift;
  realistic `itemHeight`/`gap` values minimize it.

## Scope & trade-offs

Affordances that peer virtualizers (react-window, TanStack Virtual, react-virtuoso) ship, which
this component deliberately lacks. Listed so you can decide whether they matter before vendoring:

- **No imperative API.** For jump-to-item UIs: Rendered items expose `data-index`, so you can find one with `container.querySelector('[data-index="42"]')` and call `scrollIntoView()`. Items outside the rendered window have no DOM node — scroll to an estimated offset derived from `itemHeight` instead, then refine once the item mounts.
- **No RTL support.** Columns are placed left-to-right, so `direction: rtl` does not mirror the layout: the first column remains leftmost even when the reading order is right-to-left. Screen-reader order follows source order.
- **`columnWidth` is a _preferred_ width** used to derive the column count. Items will always try to stretch to fill their (equal-width) columns for consistency.
- **Items need a stable identity.** Each item must have a string or number `id` property (or supply `getItemKey`). The identity keeps measured heights attached to their item across reorders, insertions, and removals; without it, a reorder discards the measured heights and the layout is re-measured. The `key` you set on `MasonryItem` in the render function is for React reconciliation only — the `id`/`getItemKey` identity is what the layout uses.
- The rendered window extends further below the viewport than above it: scrolling down races the unmeasured frontier (render + measurement lag), while everything above is already placed and only needs render-lag cover.

## Contributing

Open to pull requests & suggestions.

## License

This project is licensed under the MIT License - see the [LICENSE file](LICENSE) for details.
