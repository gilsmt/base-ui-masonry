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
| `masonry.tsx` alone (`@base-ui/*` external) — standalone copy/paste cost | 10.14 kB | 4.13 kB | 3.75 kB |
| `masonry.tsx` + tree-shaken `@base-ui` deps                              | 16.97 kB | 6.67 kB | 5.99 kB |

## API reference

### MasonryRoot

Groups all parts of the masonry layout.
Renders a `<div>` element.

**MasonryRoot Props:**

| Prop           | Type                                                                                     | Default    | Description                                                                                                                                                                                                                                  |
| :------------- | :--------------------------------------------------------------------------------------- | :--------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| columnCount    | `number`                                                                                 | -          | The number of columns to render. When unset or non-positive, the column count is derived from `columnWidth` and the container width.                                                                                                         |
| columnWidth    | `number`                                                                                 | `200`      | The preferred width of each column in pixels, used to derive the column count. To render a fixed number of columns, use the `columnCount` prop instead. Items always stretch to fill their column.                                           |
| container      | `HTMLElement \| null`                                                                    | `window`   | The element whose scroll position drives windowing. Pass the element that actually scrolls when the masonry is inside an overflow container.                                                                                                 |
| gap            | `number \| { horizontal: number; vertical: number }`                                     | -          | The gap between columns and rows in pixels. Accepts a single number for both axes or an object to configure them individually. When an object is provided, `vertical` defaults to `horizontal`.                                              |
| itemHeight     | `number`                                                                                 | `300`      | The assumed average item height in pixels, used to estimate the container height and the batch size of unmeasured items.                                                                                                                     |
| maxColumnCount | `number`                                                                                 | `Infinity` | The maximum number of columns that can be derived from `columnWidth`. Non-finite or non-positive values mean the column count is uncapped.                                                                                                   |
| overscan       | `number`                                                                                 | `1.5`      | How far beyond the viewport, as a multiple of its height, items are rendered and unmeasured items are batched. The margin is larger ahead of the scroll direction than behind it. Use `Infinity` to disable windowing and render every item. |
| className      | `string \| ((state: MasonryRootState) => string \| undefined)`                           | -          | CSS class applied to the element, or a function that returns a class based on the component's state.                                                                                                                                         |
| style          | `React.CSSProperties \| ((state: MasonryRootState) => React.CSSProperties \| undefined)` | -          | Style applied to the element, or a function that returns a style object based on the component's state.                                                                                                                                      |
| render         | `ReactElement \| ((props: HTMLProps, state: MasonryRootState) => ReactElement)`          | -          | Allows you to replace the component's HTML element with a different tag, or compose it with another component. Accepts a `ReactElement` or a function that returns the element to render.                                                    |

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

## Scope & trade-offs

Affordances that peer virtualizers (react-window, TanStack Virtual, react-virtuoso) ship, which
this component deliberately lacks. Listed so you can decide whether they matter before vendoring:

- **No imperative API.** For jump-to-item UIs: Rendered items expose `data-index`, so you can find one with `container.querySelector('[data-index="42"]')` and call `scrollIntoView()`. Items outside the rendered window have no DOM node — scroll to an estimated offset derived from `itemHeight` instead, then refine once the item mounts.
- **No RTL support.** Columns are placed left-to-right, so `direction: rtl` does not mirror the layout: the first column remains leftmost even when the reading order is right-to-left. Screen-reader order (`aria-posinset`) follows source order.

## Notes

- Children must be keyed elements (`key={item.id}`). Non-element children (strings, numbers, fragments) are ignored.
- `columnWidth` is a _preferred_ width used to derive the column count. Items will always try to stretch to fill their (equal-width) columns for consistency.
- The rendered window extends further **below** the viewport than above it: scrolling down races the unmeasured frontier (render + measurement lag), while everything above is already placed and only needs render-lag cover.

## Contributing

Open to pull requests & suggestions.

## License

This project is licensed under the MIT License - see the [LICENSE file](LICENSE) for details.
