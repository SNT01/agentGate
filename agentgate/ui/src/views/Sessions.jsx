import { useCallback } from 'react';
import { api } from '../api.js';
import { usePolling } from '../usePolling.js';
import { CapabilityList, ExpiryMeter, CopyableId, ToolLabel } from '../format.jsx';
import { EmptyState, ErrorPanel, TableSkeleton, DataTable } from '../components.jsx';
import { KeyIcon, RefreshIcon } from '../icons.jsx';

const COLUMNS = [
  { key: 'session', label: 'Session' },
  { key: 'human', label: 'Human' },
  { key: 'agent', label: 'Acting as' },
  { key: 'context', label: 'Context' },
  { key: 'branches', label: 'Branches' },
  { key: 'actions', label: 'Actions' },
  { key: 'expires', label: 'Expires in', width: '160px' },
];

/**
 * Live (unexpired) sessions. The server strips `signature` before this data
 * ever reaches the browser (src/broker/adminApi.js, via logger.redact) —
 * there is nothing here for this view to further protect, but it must never
 * render a `signature` field even if one somehow arrived, since it is the
 * literal bearer credential.
 *
 * Expiry is the column that matters most, so it is the only one drawn: a
 * meter makes "about to lapse" legible at a glance across many rows, in a
 * way that a column of "12m / 3m / 14m" is not. The figure stays beside it,
 * so the colour is reinforcement rather than the message.
 */
export default function Sessions({ token, onUnauthorized }) {
  const fetcher = useCallback(() => api.sessions(token), [token]);
  const { data, error, loading, refresh } = usePolling(fetcher, { intervalMs: 5_000, onUnauthorized });

  if (loading) return <TableSkeleton rows={5} />;
  if (error) return <ErrorPanel message={error} onRetry={refresh} />;

  // The meter needs a full window to draw against. Sessions carry issuedAt
  // and expiresAt, so the real TTL is derivable per row rather than assumed.
  const ttlFor = (s) =>
    Number.isFinite(s.issuedAt) && Number.isFinite(s.expiresAt) ? s.expiresAt - s.issuedAt : 15 * 60_000;

  return (
    <div className="sessions">
      <div className="toolbar">
        <button className="ghost" onClick={refresh}>
          <RefreshIcon style={{ width: 15, height: 15 }} />
          Refresh
        </button>
        <span className="result-count">
          {data.sessions.length} live session{data.sessions.length === 1 ? '' : 's'}
        </span>
      </div>

      <DataTable
        columns={COLUMNS}
        rows={data.sessions.length}
        empty={
          <EmptyState
            icon={KeyIcon}
            title="No live sessions"
            body="Credentials are short-lived by design, so an empty list is the normal resting state. A session appears the moment one is issued and disappears when it expires."
          />
        }
      >
        {data.sessions.map((s) => (
          <tr key={s.sessionId}>
            <td>
              <CopyableId value={s.sessionId} />
            </td>
            <td>
              <CopyableId value={s.humanId} />
            </td>
            <td>
              {s.agentCardId ? (
                <ToolLabel tool={s.tool} fallbackId={s.agentCardId} />
              ) : (
                <span className="muted">themselves</span>
              )}
            </td>
            <td>{s.context}</td>
            <td>
              <CapabilityList list={s.scope.branches} />
            </td>
            <td>
              <CapabilityList list={s.scope.actions} />
            </td>
            <td>
              <ExpiryMeter value={s.expiresAt} ttlMs={ttlFor(s)} />
            </td>
          </tr>
        ))}
      </DataTable>
    </div>
  );
}
