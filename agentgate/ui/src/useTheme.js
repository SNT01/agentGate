import { useCallback, useEffect, useState } from 'react';

const KEY = 'agentgate.theme';

/**
 * Light/dark preference.
 *
 * The OS setting is the default; an explicit choice overrides it and is the
 * one thing this dashboard persists. That is deliberate and safe: a theme is
 * not a credential. The admin token is *never* written to storage (see
 * api.js) — keeping that distinction visible is why this hook exists rather
 * than a generic `useLocalStorage`.
 *
 * The value is written to `data-theme` on <html>, which styles.css scopes
 * so a manual choice wins over the media query in both directions.
 */
export function useTheme() {
  const [theme, setTheme] = useState(() => {
    try {
      const saved = localStorage.getItem(KEY);
      if (saved === 'light' || saved === 'dark') return saved;
    } catch (_e) {
      // Storage can throw in private mode or a sandboxed frame. Falling
      // back to the OS preference is the correct behaviour, not an error.
    }
    return null; // follow the OS
  });

  useEffect(() => {
    const root = document.documentElement;
    if (theme) root.setAttribute('data-theme', theme);
    else root.removeAttribute('data-theme');
  }, [theme]);

  const toggle = useCallback(() => {
    setTheme((current) => {
      const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
      const effective = current || (prefersDark ? 'dark' : 'light');
      const next = effective === 'dark' ? 'light' : 'dark';
      try {
        localStorage.setItem(KEY, next);
      } catch (_e) {
        /* preference simply does not persist */
      }
      return next;
    });
  }, []);

  const resolved =
    theme || (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');

  return { theme: resolved, toggle };
}
