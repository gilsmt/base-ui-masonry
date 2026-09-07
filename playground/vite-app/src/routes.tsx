import type * as React from 'react';
import MasonryDemo from './experiments/masonry/MasonryDemo';
import SidePanelDemo from './experiments/masonry/SidePanelDemo';
import MasonryPerf from './experiments/masonry/MasonryPerf';
import ScrollPerf from './experiments/masonry/ScrollPerf';

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
  { type: 'header', label: 'Masonry — playground' },
  {
    type: 'route',
    path: '/masonry',
    label: 'Grid',
    description: 'image-only, async heights, practical for benchmarking',
    element: <MasonryDemo />,
    showInNav: true,
  },
  {
    type: 'route',
    path: '/masonry/side-panel',
    label: 'Side-panel resize',
    description: 'panel expands, masonry width shrinks, items reposition',
    element: <SidePanelDemo />,
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
  {
    type: 'route',
    path: '/perf/scroll-hysteresis',
    label: 'Scroll hysteresis',
    description: 'commits & DOM mutations per 1000px scrolled',
    element: <ScrollPerf />,
    showInNav: true,
  },
];
