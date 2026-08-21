import { Link } from 'react-router';
import { routes } from './routes';

export function Home() {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Home</h1>
        <p className="text-sm leading-6 text-gray-700 max-w-prose">
          Local playground for <code className="rounded bg-gray-100 px-1 py-0.5">base-ui-masonry</code>{' '}
          — vendored <code className="rounded bg-gray-100 px-1 py-0.5">src/masonry.tsx</code>. Use it to
          iterate on layout behavior, spot regressions, and run the masonry virtualization
          benchmarks with the same pattern Base UI uses for <em>playground/vite-app</em>.
        </p>
      </div>

      <Nav />

      <section className="rounded-lg border border-gray-200 bg-white p-4 text-sm leading-6">
        <h2 className="font-semibold">Tips</h2>
        <ul className="list-disc pl-5 mt-2 space-y-1 text-gray-700">
          <li>
            Edit <code className="bg-gray-100 px-1 rounded">src/masonry.tsx</code> and the playground
            hot-reloads via Vite. No publish step.
          </li>
          <li>
            For profiling: <code className="bg-gray-100 px-1 rounded">pnpm build:profile</code> then
            Chrome DevTools → Performance → React Tracks (requires React DevTools extension).
          </li>
          <li>
            Benchmark pages use a DOM-quiet-window timer (same as Base UI) to measure mount →
            layout-settled time.
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
