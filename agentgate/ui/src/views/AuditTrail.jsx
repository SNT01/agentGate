import { Fragment, useCallback, useMemo, useState } from 'react';
import { api } from '../api.js';
import { usePolling } from '../usePolling.js';
import { ToolLabel, Timestamp, OrDash } from '../format.jsx';
import { ErrorPanel } from './Overview.jsx';

const OUTCOMES = ['all', 'granted', 'denied'];

/**
 * The reason this dashboard exists: turning the audit chain into the story
 * of who did what. Every row is human -> agent (tool@version) -> context ->
 * scope granted, or the reason it was refused.
 */
export default function AuditTrail({ token, onUnauthorized }) {
  const [outcomeFilter, setOutcomeFilter] = useState('all');
  const [textFilter, setTextFilter] = useState('');
  const [expanded, setExpanded] = useState(null);

  const fetcher = useCallback(() => api.auditEntries(token, 200), [token]);
  const { data, error, loading, refresh } = usePolling(fetcher, { intervalMs: 8_000, onUnauthorized });

  const entries = useMemo(() => {
    if (!data) return [];
    let list = [...data.entries].reverse(); // newest first
    if (outcomeFilter !== 'all') list = list.filter((e) => e.outcome === outcomeFilter);
    if (textFilter.trim()) {
      const needle = textFilter.trim().toLowerCase();
      list = list.filter((e) =>
        [e.humanId, e.agentCardId, e.context, e.reason, e.action]
          .filter(Boolean)
          .some((f) => String(f).toLowerCase().includes(needle))
      );
    }
    return list;
  }, [data, outcomeFilter, textFilter]);

  if (loading) return <p className="muted">Loading…</p>;
  if (error) return <ErrorPanel message={error} onRetry={refresh} />;

  return (
    <div className="audit-trail">
      <div className="toolbar">
        <select value={outcomeFilter} onChange={(e) => setOutcomeFilter(e.target.value)}>
          {OUTCOMES.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
        <input
          placeholder="Filter by human, agent, context, action, or reason…"
          value={textFilter}
          onChange={(e) => setTextFilter(e.target.value)}
        />
        <button onClick={refresh}>Refresh</button>
        <span className="muted">{entries.length} shown</span>
      </div>

      <table>
        <thead>
          <tr>
            <th>When</th>
            <th>Outcome</th>
            <th>Action</th>
            <th>Human</th>
            <th>Agent</th>
            <th>Context</th>
            <th>Detail</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => (
            <Fragment key={e.seq}>
              <tr
                className={`clickable outcome-${e.outcome}`}
                onClick={() => setExpanded(expanded === e.seq ? null : e.seq)}
              >
                <td>
                  <Timestamp value={e.timestamp} />
                </td>
                <td>
                  <span className={`badge ${e.outcome === 'granted' ? 'active' : 'revoked'}`}>{e.outcome}</span>
                </td>
                <td>{e.action}</td>
                <td>
                  <OrDash value={e.humanId} />
                </td>
                <td>
                  {e.agentCardId ? <ToolLabel tool={e.tool} /> : <span className="muted">—</span>}
                </td>
                <td>
                  <OrDash value={e.context} />
                </td>
                <td className="reason">
                  {e.outcome === 'granted' ? (
                    <span>
                      scope: {e.scope?.branches?.join(', ') || '—'} / {e.scope?.actions?.join(', ') || '—'}
                    </span>
                  ) : (
                    e.reason
                  )}
                </td>
              </tr>
              {expanded === e.seq && (
                <tr className="expanded-detail">
                  <td colSpan={7}>
                    <pre>{JSON.stringify(e, null, 2)}</pre>
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}
