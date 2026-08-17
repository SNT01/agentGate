import { useCallback } from 'react';
import { api } from '../api.js';
import { usePolling } from '../usePolling.js';
import { OrDash } from '../format.jsx';

/**
 * The headline view. Chain integrity is deliberately the most visually
 * loud element on the page — `GET /audit/verify` returning `valid: false`
 * means the audit log has been tampered with, which is the single worst
 * thing this dashboard could ever report, and a small badge would bury it.
 */
export default function Overview({ token, onUnauthorized }) {
  const fetcher = useCallback(async () => {
    const [verify, identities, sessions, recentAudit] = await Promise.all([
      api.auditVerify(token),
      api.identities(token),
      api.sessions(token),
      api.auditEntries(token, 10),
    ]);
    return { verify, identities, sessions, recentAudit };
  }, [token]);

  const { data, error, loading, refresh } = usePolling(fetcher, { intervalMs: 10_000, onUnauthorized });

  if (loading) return <p className="muted">Loading…</p>;
  if (error) return <ErrorPanel message={error} onRetry={refresh} />;

  const { verify, identities, sessions, recentAudit } = data;
  const recentDenials = recentAudit.entries.filter((e) => e.outcome === 'denied').slice(-5).reverse();

  return (
    <div className="overview">
      {verify.valid ? (
        <div className="chain-status ok">
          <strong>Audit chain intact</strong> — {verify.count} entries verified.
        </div>
      ) : (
        <div className="chain-status broken">
          <strong>AUDIT CHAIN INTEGRITY FAILURE</strong>
          <p>
            Broken at entry #{verify.brokenAt}: {verify.reason}
          </p>
          <p>Investigate immediately — this means a past entry was modified, removed, or forged.</p>
        </div>
      )}

      <div className="stat-row">
        <Stat label="Humans" value={identities.humans.length} />
        <Stat label="Agent cards" value={identities.agents.length} />
        <Stat label="Revoked" value={identities.humans.filter((h) => h.revoked).length + identities.agents.filter((a) => a.revoked).length} />
        <Stat label="Live sessions" value={sessions.sessions.length} />
      </div>

      <section>
        <h2>Recent denials</h2>
        {recentDenials.length === 0 ? (
          <p className="muted">No denials in the recent audit window.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Human</th>
                <th>Agent</th>
                <th>Context</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {recentDenials.map((e) => (
                <tr key={e.seq}>
                  <td>{new Date(e.timestamp).toLocaleTimeString()}</td>
                  <td>
                    <OrDash value={e.humanId} />
                  </td>
                  <td>
                    <OrDash value={e.agentCardId} />
                  </td>
                  <td>
                    <OrDash value={e.context} />
                  </td>
                  <td className="reason">{e.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div className="stat">
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

export function ErrorPanel({ message, onRetry }) {
  return (
    <div className="error-panel">
      <p>{message}</p>
      <button onClick={onRetry}>Retry</button>
    </div>
  );
}
