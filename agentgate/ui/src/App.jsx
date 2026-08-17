import { useState, useCallback } from 'react';
import { api, UnauthorizedError } from './api.js';
import Overview from './views/Overview.jsx';
import AuditTrail from './views/AuditTrail.jsx';
import Identities from './views/Identities.jsx';
import Sessions from './views/Sessions.jsx';

const TABS = [
  { key: 'overview', label: 'Overview', view: Overview },
  { key: 'audit', label: 'Audit Trail', view: AuditTrail },
  { key: 'identities', label: 'Identities', view: Identities },
  { key: 'sessions', label: 'Sessions', view: Sessions },
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
        <h1>AgentGate</h1>
        <p className="muted">Enter the admin token to continue. It is kept in memory for this tab only.</p>
        <form onSubmit={submit}>
          <input
            type="password"
            autoFocus
            placeholder="AGENTGATE_ADMIN_TOKEN"
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
          <button type="submit" disabled={checking || !input.trim()}>
            {checking ? 'Checking…' : 'Sign in'}
          </button>
        </form>
        {error && <p className="error">{error}</p>}
      </div>
    </div>
  );
}

export default function App() {
  const [token, setToken] = useState(null);
  const [activeTab, setActiveTab] = useState('overview');

  const handleUnauthorized = useCallback(() => {
    // The token was accepted at sign-in but stopped working (rotated,
    // expired, or the server restarted with a new one) — drop back to the
    // gate rather than showing a dashboard that silently fails every call.
    setToken(null);
  }, []);

  if (!token) return <SignIn onSignIn={setToken} />;

  const ActiveView = TABS.find((t) => t.key === activeTab).view;

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">AgentGate</span>
        <nav>
          {TABS.map((t) => (
            <button
              key={t.key}
              className={t.key === activeTab ? 'tab active' : 'tab'}
              onClick={() => setActiveTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <button className="signout" onClick={() => setToken(null)}>
          Sign out
        </button>
      </header>
      <main>
        <ActiveView token={token} onUnauthorized={handleUnauthorized} />
      </main>
    </div>
  );
}
