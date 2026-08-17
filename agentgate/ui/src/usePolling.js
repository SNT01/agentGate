import { useEffect, useRef, useState, useCallback } from 'react';
import { UnauthorizedError } from './api.js';

/**
 * Poll `fetcher` on an interval. Streaming isn't an option here: the
 * broker's `server.requestTimeout` is 30s (src/broker/server.js), which
 * rules out SSE/long-polling — a fixed interval plus a manual refresh
 * button is the pattern that fits the server as built.
 *
 * On any 401 (token rotated, revoked, or the server restarted with a new
 * one), calls `onUnauthorized` once so the app can drop back to the sign-in
 * gate instead of polling a dead credential forever.
 */
export function usePolling(fetcher, { intervalMs = 10_000, onUnauthorized } = {}) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const refresh = useCallback(async () => {
    try {
      const result = await fetcherRef.current();
      setData(result);
      setError(null);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized?.();
        return;
      }
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [onUnauthorized]);

  useEffect(() => {
    let cancelled = false;
    let timer;

    const tick = async () => {
      if (cancelled) return;
      await refresh();
      if (!cancelled) timer = setTimeout(tick, intervalMs);
    };
    tick();

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [refresh, intervalMs]);

  return { data, error, loading, refresh };
}
