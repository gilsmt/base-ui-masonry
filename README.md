# base-ui-masonry

A responsive, highly optimized, unstyled masonry UI layout component. With virtualization, built for being used alongside [BaseUI](https://base-ui.com) in React 19 projects.

This project is meant to be vendored, not treated as a fixed npm dependency. Copy the file into your repository, read it, and change it to match your team's standards and goals.

## Usage

### Install dependencies

```bash
npm install @base-ui/react @base-ui/utils
```

```bash
pnpm add @base-ui/react @base-ui/utils
```

```bash
bun add @base-ui/react @base-ui/utils
```

### Copy and paste the following code into your project

[masonry.tsx](./src/masonry.tsx)

## Anatomy

Import the parts, and assemble them together.

```tsx
import { MasonryRoot, MasonryItem } from "@/components/ui/masonry";

return (
    <MasonryRoot columnCount={6} gap={4}>
        {items.map((item) => (
            <MasonryItem key={item.id}>
                <Card>...</Card>
            </MasonryItem>
        ))}
    </MasonryRoot>
);
```

Use the render prop to compose a part with your own React components.

For example, MasonryItem renders a <div> by default. The code snippet below shows how to use a custom button instead.

```tsx
<MasonryItem key={item.id} render={<MyButton size="md" />}>
    ...
</MasonryItem>
```

The custom component must forward the ref, and spread all the received props on its underlying DOM node. [Learn more](https://base-ui.com/react/handbook/composition)

## Notes

In order to achieve optimal performance these tradeoffs have been made:

- **Scrolling** follows the **window** scroll position (`window.scrollY`), not an inner scrollable container. If your layout scrolls inside an `overflow: auto` element, hook it up yourself or place the masonry inside the page scroller.
- `MasonryRoot` **manages item refs** for measurement and virtualization; refs you pass to items (or to elements rendered inside a slot) are replaced and never receive the node. Forward refs if you need to reach an item's DOM node.
- `columnWidth` is a _preferred_ width used to derive the column count — items always stretch to fill their (equal-width) columns.
- Children must be keyed elements. Non-element children (strings, numbers, fragments) are ignored. Items are kept in DOM order, so tab order and keyboard navigation follow the source order.

## Contributing

Open to pull requests & suggestions.

## License

This project is licensed under the MIT License - see the [LICENSE file](LICENSE) for details.
