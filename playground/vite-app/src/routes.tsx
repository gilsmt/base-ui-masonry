import type * as React from 'react';
import MasonryDemo from './experiments/masonry/MasonryDemo';
import MasonryPerf from './experiments/masonry/MasonryPerf';

export type RouteEntry =
  | {
      type: 'route';
      path: string;
      label: string;
      description?: string;
      element: React.ReactElement;
      showInNav?: boolean;
    }
  | {
      type: 'redirect';
      path: string;
      to: string;
    }
  | {
      type: 'header';
      label: string;
    };

export const defaultRoute = '/masonry';

export const routes: RouteEntry[] = [
  { type: 'header', label: 'Masonry — experimentation' },
  {
    type: 'route',
    path: '/masonry',
    label: 'Interactive masonry demo',
    description: 'tweak columns, gaps, item count',
    element: <MasonryDemo />,
    showInNav: true,
  },
  { type: 'header', label: 'Performance benchmarks' },
  { type: 'redirect', path: '/perf', to: '/perf/masonry' },
  {
    type: 'route',
    path: '/perf/masonry',
    label: 'Masonry virtualization perf',
    description: 'mount → settled timing vs item count',
    element: <MasonryPerf />,
    showInNav: true,
  },
];
