import { useCallback } from 'react';
import { api } from '../api.js';
import { usePolling } from '../usePolling.js';
import { CapabilityList, ExpiresIn } from '../format.jsx';
import { ErrorPanel } from './Overview.jsx';

/**
 * Live (unexpired) sessions. The server strips `signature` before this data
 * ever reaches the browser (src/broker/adminApi.js, via logger.redact) —
 * there is nothing here for this view to further protect, but it must never
 * render a `signature` field even if one somehow arrived, since it is the
 * literal bearer credential the git credential helper hands to GitHub.
 */
export default function Sessions({ token, onUnauthorized }) {
  const fetcher = useCallback(() => api.sessions(token), [token]);
  const { data, error, loading, refresh } = usePolling(fetcher, { intervalMs: 5_000, onUnauthorized });

  if (loading) return <p className="muted">Loading…</p>;
  if (error) return <ErrorPanel message={error} onRetry={refresh} />;

  return (
    <div className="sessions">
      <div className="toolbar">
        <button onClick={refresh}>Refresh</button>
        <span className="muted">{data.sessions.length} live session{data.sessions.length === 1 ? '' : 's'}</span>
      </div>
      <table>
        <thead>
          <tr>
            <th>Session</th>
            <th>Human</th>
            <th>Agent</th>
            <th>Context</th>
            <th>Branches</th>
            <th>Actions</th>
            <th>Expires in</th>
          </tr>
        </thead>
        <tbody>
          {data.sessions.map((s) => (
            <tr key={s.sessionId}>
              <td className="mono">{s.sessionId}</td>
              <td className="mono">{s.humanId}</td>
              <td className="mono">{s.agentCardId || <span className="muted">—</span>}</td>
              <td>{s.context}</td>
              <td>
                <CapabilityList list={s.scope.branches} />
              </td>
              <td>
                <CapabilityList list={s.scope.actions} />
              </td>
              <td>
                <ExpiresIn value={s.expiresAt} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
