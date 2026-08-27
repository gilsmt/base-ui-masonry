import { Link } from 'react-router';
import { routes } from './routes';

export function Home() {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Playground</h1>
        <p className="text-sm leading-6 text-gray-700 max-w-prose">
          Local playground for <code className="rounded bg-gray-100 px-1 py-0.5">base-ui-masonry</code>{' '}
          — vendored <code className="rounded bg-gray-100 px-1 py-0.5">src/masonry.tsx</code>. The
          primary demo is a <strong>Pinterest-style image grid</strong> (real async images, variable
          heights, window vs. contained scroll) so virtualization and{' '}
          <code className="rounded bg-gray-100 px-1 py-0.5">ResizeObserver</code> measurement behave
          like production. Benchmarks and profiling use the same pattern as Base UI’s{' '}
          <em>playground/vite-app</em>.
        </p>
      </div>

      <Nav />

      <section className="rounded-lg border border-gray-200 bg-white p-4 text-sm leading-6">
        <h2 className="font-semibold">What’s inside</h2>
        <ul className="list-disc pl-5 mt-2 space-y-1 text-gray-700">
          <li>
            <strong>/masonry</strong> — Pinterest-like grid: real{' '}
            <code className="bg-gray-100 px-1 rounded">&lt;img&gt;</code> via seeded
            picsum.photos, heights vary per image and are unknown until decode. Append-only infinite
            scroll via <code className="bg-gray-100 px-1 rounded">IntersectionObserver</code>{' '}
            sentinel keeps the fast path; toggle <em>Window</em> vs <em>Contained</em> to exercise{' '}
            <code className="bg-gray-100 px-1 rounded">MasonryRoot container</code>.
          </li>
          <li>
            Layout knobs only — <code className="bg-gray-100 px-1 rounded">gap</code>,{' '}
            <code className="bg-gray-100 px-1 rounded">columnWidth</code>,{' '}
            <code className="bg-gray-100 px-1 rounded">maxColumnCount</code>,{' '}
            <code className="bg-gray-100 px-1 rounded">overscan</code>,{' '}
            <code className="bg-gray-100 px-1 rounded">columnCount</code> — no feed chrome (search,
            likes, etc.) to keep the benchmark signal clean.
          </li>
          <li>
            Resize the window — columns reflow without remounting. Edit{' '}
            <code className="bg-gray-100 px-1 rounded">src/masonry.tsx</code> and the playground
            hot-reloads. Profiling:{' '}
            <code className="bg-gray-100 px-1 rounded">pnpm build:profile</code> then Chrome DevTools →
            Performance → React Tracks.
          </li>
        </ul>
      </section>
    </div>
  );
}

function Nav() {
  return (
    <ul className="space-y-2 text-sm">
      {routes.map((entry) => {
        if (entry.type === 'header') {
          return (
            <li
              key={entry.label}
              className="pt-3 text-xs font-semibold uppercase tracking-wide text-gray-500"
            >
              {entry.label}
            </li>
          );
        }

        if (entry.type === 'route' && entry.showInNav) {
          return (
            <li key={entry.path}>
              <Link className="text-gray-800 hover:underline" to={entry.path}>
                {entry.label}
              </Link>
              {entry.description ? (
                <span className="text-gray-500"> — {entry.description}</span>
              ) : null}
            </li>
          );
        }

        return null;
      })}
    </ul>
  );
}
