import { useState, useCallback, useRef, useEffect } from 'react';
import { api, UnauthorizedError } from './api.js';
import { useTheme } from './useTheme.js';
import Overview from './views/Overview.jsx';
import AuditTrail from './views/AuditTrail.jsx';
import Identities from './views/Identities.jsx';
import Sessions from './views/Sessions.jsx';
import {
  GaugeIcon,
  ListIcon,
  UsersIcon,
  KeyIcon,
  LockIcon,
  ShieldIcon,
  SunIcon,
  MoonIcon,
  SignOutIcon,
} from './icons.jsx';

const TABS = [
  {
    key: 'overview',
    label: 'Overview',
    icon: GaugeIcon,
    view: Overview,
    title: 'Overview',
    subtitle: 'Chain integrity, identity counts, and what was refused recently.',
  },
  {
    key: 'audit',
    label: 'Audit Trail',
    icon: ListIcon,
    view: AuditTrail,
    title: 'Audit trail',
    subtitle: 'Every decision the broker made, in the order it made them.',
  },
  {
    key: 'identities',
    label: 'Identities',
    icon: UsersIcon,
    view: Identities,
    title: 'Identities',
    subtitle: 'Enrolled humans and the agent cards they sponsor.',
  },
  {
    key: 'sessions',
    label: 'Sessions',
    icon: KeyIcon,
    view: Sessions,
    title: 'Live sessions',
    subtitle: 'Credentials issued and not yet expired.',
  },
];

/**
 * The token gate. The admin token lives only in this component's state —
 * never in localStorage/sessionStorage — so it disappears the moment the
 * tab closes and cannot be read by any storage-scraping script.
 */
function SignIn({ onSignIn }) {
  const [input, setInput] = useState('');
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState(null);

  const submit = useCallback(
    async (e) => {
      e.preventDefault();
      if (!input.trim()) return;
      setChecking(true);
      setError(null);
      try {
        // /admin/identities is the cheapest authenticated call available —
        // used purely to validate the token before entering the dashboard.
        await api.identities(input.trim());
        onSignIn(input.trim());
      } catch (err) {
        setError(err instanceof UnauthorizedError ? 'That token was rejected.' : err.message);
      } finally {
        setChecking(false);
      }
    },
    [input, onSignIn]
  );

  return (
    <div className="signin">
      <div className="signin-card">
        <span className="mark">
          <ShieldIcon />
        </span>
        <h1>AgentGate</h1>
        <p className="muted" style={{ fontSize: 'var(--text-sm)' }}>
          Sign in with the broker's admin token to view the audit trail, identities, and live sessions.
        </p>

        <form onSubmit={submit}>
          <label className="visually-hidden" htmlFor="admin-token">
            Admin token
          </label>
          <input
            id="admin-token"
            type="password"
            autoFocus
            autoComplete="off"
            spellCheck="false"
            placeholder="AGENTGATE_ADMIN_TOKEN"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            aria-describedby={error ? 'signin-error' : undefined}
            aria-invalid={error ? 'true' : undefined}
          />
          <button type="submit" disabled={checking || !input.trim()}>
            {checking ? 'Checking…' : 'Sign in'}
          </button>
        </form>

        {error && (
          <p className="error" id="signin-error" role="alert" style={{ marginTop: 'var(--space-3)' }}>
            {error}
          </p>
        )}

        <p className="signin-hint">
          <LockIcon style={{ width: 12, height: 12, verticalAlign: '-2px', marginRight: 4 }} />
          Held in memory for this tab only — never written to browser storage.
        </p>
      </div>
    </div>
  );
}

export default function App() {
  const [token, setToken] = useState(null);
  const [activeTab, setActiveTab] = useState('overview');
  const { theme, toggle } = useTheme();
  const tabRefs = useRef({});

  const handleUnauthorized = useCallback(() => {
    // The token was accepted at sign-in but stopped working (rotated,
    // expired, or the server restarted with a new one) — drop back to the
    // gate rather than showing a dashboard that silently fails every call.
    setToken(null);
  }, []);

  // Keep the document title in step with the view, so several broker tabs
  // are distinguishable from the tab strip alone.
  const active = TABS.find((t) => t.key === activeTab);
  useEffect(() => {
    document.title = token ? `${active.title} · AgentGate` : 'AgentGate — Admin';
  }, [token, active]);

  /**
   * Arrow-key navigation between tabs, as the tablist role promises. A
   * roving tabstop would be more literal, but every tab here is a real
   * button that is independently reachable, and moving focus on arrow press
   * is the behaviour that matters to a keyboard user.
   */
  const onTabKeyDown = useCallback(
    (e) => {
      const delta = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
      if (!delta) return;
      e.preventDefault();
      const index = TABS.findIndex((t) => t.key === activeTab);
      const next = TABS[(index + delta + TABS.length) % TABS.length];
      setActiveTab(next.key);
      tabRefs.current[next.key]?.focus();
    },
    [activeTab]
  );

  if (!token) return <SignIn onSignIn={setToken} />;

  const ActiveView = active.view;

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="mark">
            <ShieldIcon />
          </span>
          <span className="brand-name">
            AgentGate
            <span className="brand-sub">Admin</span>
          </span>
        </div>

        <nav role="tablist" aria-label="Dashboard sections" onKeyDown={onTabKeyDown}>
          {TABS.map((t) => {
            const Icon = t.icon;
            const selected = t.key === activeTab;
            return (
              <button
                key={t.key}
                ref={(el) => (tabRefs.current[t.key] = el)}
                role="tab"
                aria-selected={selected}
                aria-controls="view-panel"
                tabIndex={selected ? 0 : -1}
                className={selected ? 'tab active' : 'tab'}
                onClick={() => setActiveTab(t.key)}
                title={t.label}
              >
                <Icon className="tab-icon" />
                <span className="tab-label">{t.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="sidebar-footer">
          <button className="subtle" onClick={toggle} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}>
            {theme === 'dark' ? <SunIcon className="tab-icon" /> : <MoonIcon className="tab-icon" />}
            <span className="tab-label">{theme === 'dark' ? 'Light' : 'Dark'}</span>
          </button>
          <button className="subtle" onClick={() => setToken(null)}>
            <SignOutIcon className="tab-icon" />
            <span className="tab-label">Sign out</span>
          </button>
        </div>
      </aside>

      <div className="content">
        <header className="page-header">
          <div>
            <h1 className="page-title">{active.title}</h1>
            <p className="page-subtitle">{active.subtitle}</p>
          </div>
        </header>

        <main id="view-panel" role="tabpanel" aria-label={active.title} tabIndex={-1}>
          <ActiveView token={token} onUnauthorized={handleUnauthorized} />
        </main>
      </div>
    </div>
  );
}
