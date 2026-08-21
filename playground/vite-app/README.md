# Masonry Vite playground

A small Vite + React app for local experimentation and performance benchmarks against the vendored `src/masonry.tsx` in this repo. Mirrors the structure of [`mui/base-ui`'s `playground/vite-app`](https://github.com/mui/base-ui/tree/master/playground/vite-app) so the same workflows (dev, profiling, perf tracks) apply.

## Quick start

From the repo root, any manager works (`npm`/`pnpm`/`bun` — `package.json:5` scripts are manager-agnostic):

```bash
# install playground deps (isolated from root)
cd playground/vite-app
npm install
```

```bash
pnpm install
```

```bash
bun install
```

```bash
npm run dev        # http://localhost:5173
```

```bash
pnpm dev
```

```bash
bun run dev
```

Root `src/masonry.tsx` edits hot-reload inside the playground — no publish step. The playground aliases `@masonry` → `../../src` and allows `fs.allow` to serve the root source (see `vite.config.ts:22`).

Alternatively, use workspace hoisting if you add `playground/vite-app` to a workspaces field and run from the root with `pnpm --filter masonry-playground-vite-app dev` (or `npm`/`bun` equivalent).

## Routes

- `/masonry` — interactive demo: tune `columnWidth`, `columnCount`, `gap`, `maxColumnCount`, `overscan`, item count, and height variance. Useful for eyeballing column balancing + virtualization before/after the `masonry.tsx` refactor.
- `/perf/masonry` — mount → DOM-settled benchmark (quiet-window = 32 ms, same as Base UI). Toggle item counts (100 … 10k), then **Run 20 / 50** and compare console `Average / Std Dev` between branches.

## Scripts

| script | what it does |
|---|---|
| `dev` | `vite` dev server with HMR |
| `build` | `tsc -b && vite build` (type-check + production) |
| `build:profile` | `cross-env REACT_PROFILING=1 vite build` — aliases `react-dom/client` → `react-dom/profiling` |
| `preview` / `serve` | `vite preview` — serve the production build |
| `type-check` | `tsc -b --noEmit` |

## Profiling build & React Performance Tracks

This app supports the same profiling trick as Base UI's playground (`vite.config.ts:8` — `cross-env` sets `REACT_PROFILING` to alias `react-dom/client` → `react-dom/profiling`):

```bash
npm run build:profile
npm run preview   # also aliased as `serve`
```

```bash
pnpm build:profile
pnpm preview
```

```bash
bun run build:profile
bun run preview
```

Then:

1. Install the React DevTools browser extension.
2. Use the profiling build (or `npm run dev` / `pnpm dev` / `bun run dev`) and open the app in a Chromium browser.
3. DevTools → **Performance** → record while interacting (scroll, resize, toggle presets).
4. Look for the **React** tracks in the timeline (scheduling / commit / component timing).

Reference: <https://react.dev/reference/dev-tools/react-performance-tracks>

## Benchmark notes

`src/experiments/perf/utils/benchmark.tsx` is a direct, zero-dep adaptation of Base UI's `perf/utils/benchmark.tsx`:

- Mount is wrapped in `ReactDOM.flushSync(() => setShowBenchmark(true))`.
- A `MutationObserver` on the benchmark root tracks the last mutation time; resolution waits for a 32 ms quiet window (`DOM_SETTLE_QUIET_WINDOW_MS`).
- **Run N** does `warmup + iterations` with `flushSync(false)` between runs, drops warmup, optionally removes outliers via IQR, then logs `[values]`, `Average`, `Std Dev`.

For the masonry refactor, keep props identical (`columnWidth`, `gap`, `overscan`, `count`) and compare warmup=5 / iterations=20 deltas across branches. Because the component is virtualized, timings should stay roughly O(visible window), not O(N).

## Project layout

```
playground/vite-app/
  index.html
  vite.config.ts          # tailwind + react, @ alias, profiling alias, fs.allow
  tsconfig*.json           # path aliases @/*, @masonry/*
  src/
    index.tsx              # BrowserRouter + App shell
    routes.tsx             # central route table (mirrors base-ui pattern)
    Home.tsx
    index.css              # tailwind + color tokens
    experiments/
      masonry/
        MasonryDemo.tsx    # knob-driven demo
        MasonryPerf.tsx    # preset + custom N benchmark harness
        masonry.module.css
      perf/utils/benchmark.tsx
```

## Deployment (optional)

Like Base UI, you can set `PLAYGROUND_BASE` and `PLAYGROUND_OUT_DIR` when building for a sub-path:

```bash
PLAYGROUND_BASE=/masonry-playground/ PLAYGROUND_OUT_DIR=../../dist/playground npm run build
```

```bash
PLAYGROUND_BASE=/masonry-playground/ PLAYGROUND_OUT_DIR=../../dist/playground pnpm build
```

```bash
PLAYGROUND_BASE=/masonry-playground/ PLAYGROUND_OUT_DIR=../../dist/playground bun run build
```

## Troubleshooting

- **Import not found for `@masonry/masonry`**: ensure `tsconfig.app.json` paths and `vite.config.ts` alias match the relative `../../src` layout.
- **Types complain about `src/masonry.tsx`**: run `npm run type-check` / `pnpm type-check` / `bun run type-check` from `playground/vite-app`; root `tsconfig.json` and playground configs are intentionally separate.
