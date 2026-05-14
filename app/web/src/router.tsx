/**
 * Tiny hash router. Avoids pulling in react-router for one app with
 * three routes. Hash routing keeps reloads safe — fastify's SPA fallback
 * doesn't need to know about new paths.
 *
 * Routes:
 *   #/              → live monitoring (existing experience)
 *   #/runs          → archived run list
 *   #/runs/:runId   → run detail (Phase C+)
 */
import { useEffect, useState } from 'react';

export type Route =
  | { kind: 'live' }
  | { kind: 'runs-list' }
  | { kind: 'run-detail'; runId: string };

function parse(hash: string): Route {
  const clean = hash.replace(/^#/, '').replace(/^\/+/, '');
  if (!clean) return { kind: 'live' };
  const parts = clean.split('/').filter(Boolean);
  if (parts[0] === 'runs') {
    if (parts.length === 1) return { kind: 'runs-list' };
    return { kind: 'run-detail', runId: decodeURIComponent(parts[1]) };
  }
  return { kind: 'live' };
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() =>
    parse(window.location.hash),
  );
  useEffect(() => {
    const onHash = () => setRoute(parse(window.location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return route;
}

export function navigate(to: string): void {
  window.location.hash = to.startsWith('#') ? to : `#${to}`;
}

export function hrefFor(to: string): string {
  return to.startsWith('#') ? to : `#${to}`;
}
