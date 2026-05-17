/**
 * Tiny hash router. Avoids pulling in react-router for one app with
 * three routes. Hash routing keeps reloads safe — fastify's SPA fallback
 * doesn't need to know about new paths.
 *
 * Routes:
 *   #/                        → live monitoring (existing experience)
 *   #/runs                    → archived run list
 *   #/runs/:runId             → run detail
 *   #/runs/:runId?stage=&panel=&mount=&l4=  → deep-linked selection
 *
 * Query params on the run-detail route:
 *   stage  — stage name to open the L2 sidebar for
 *   panel  — L3 panel kind (prompt/initial/command/mounts/diff/turns/
 *            decisions/stream)
 *   mount  — when panel=diff, the rw mount to focus
 *   l4     — info | timeline | decisions | cost | events (overlay)
 */
import { useEffect, useState } from 'react';

export type Route =
  | { kind: 'live' }
  | { kind: 'runs-list' }
  | { kind: 'run-detail'; runId: string; params: URLSearchParams };

function parse(hash: string): Route {
  const clean = hash.replace(/^#/, '').replace(/^\/+/, '');
  if (!clean) return { kind: 'live' };
  const [pathPart, queryPart = ''] = clean.split('?');
  const params = new URLSearchParams(queryPart);
  const parts = pathPart.split('/').filter(Boolean);
  if (parts[0] === 'runs') {
    if (parts.length === 1) return { kind: 'runs-list' };
    return {
      kind: 'run-detail',
      runId: decodeURIComponent(parts[1]),
      params,
    };
  }
  return { kind: 'live' };
}

/**
 * Replace the current URL's query params without firing a hashchange
 * event (the caller already knows the state — no re-parse needed).
 */
export function replaceRunDetailParams(
  runId: string,
  params: Record<string, string | null | undefined>,
): void {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== '') q.set(k, v);
  }
  const qs = q.toString();
  const next = `#/runs/${encodeURIComponent(runId)}${qs ? `?${qs}` : ''}`;
  if (window.location.hash !== next) {
    history.replaceState(null, '', next);
  }
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
