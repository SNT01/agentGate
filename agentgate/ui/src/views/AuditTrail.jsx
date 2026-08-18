import { Fragment, useCallback, useMemo, useState } from 'react';
import { api } from '../api.js';
import { usePolling } from '../usePolling.js';
import { ToolLabel, RelativeTime, OrDash, OutcomeBadge, CopyableId, CapabilityList } from '../format.jsx';
import { EmptyState, ErrorPanel, TableSkeleton, DataTable } from '../components.jsx';
import { SearchIcon, RefreshIcon } from '../icons.jsx';

const OUTCOMES = [
  { key: 'all', label: 'All' },
  { key: 'granted', label: 'Granted' },
  { key: 'denied', label: 'Denied' },
];

/**
 * Human-readable names for the audit chain's `action` values. Raw
 * identifiers like `forge_exchange_failed` are precise but read as internal
 * plumbing; the description column says what actually happened.
 *
 * Keep in step with the `action:` values in src/broker/broker.js and
 * src/registry/registry.js — an unmapped action falls back to its raw name,
 * so a new one degrades to today's behaviour rather than disappearing.
 */
const ACTION_LABELS = {
  token_issued: 'Session token issued',
  token_denied: 'Request denied',
  forge_token_issued: 'GitHub credential minted',
  forge_exchange_failed: 'GitHub exchange failed',
  identity_revoked: 'Identity revoked',
};

const COLUMNS = [
  { key: 'when', label: 'When' },
  { key: 'outcome', label: 'Outcome' },
  { key: 'action', label: 'Action' },
  { key: 'human', label: 'Human' },
  { key: 'agent', label: 'Agent' },
  { key: 'context', label: 'Context' },
  { key: 'detail', label: 'Detail' },
];

/**
 * The reason this dashboard exists: turning the audit chain into the story
 * of who did what. Every row is human → agent (tool@version) → context →
 * what was granted, or the reason it was refused.
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
        [e.humanId, e.agentCardId, e.context, e.reason, e.action, e.repository, e.sessionId]
          .filter(Boolean)
          .some((f) => String(f).toLowerCase().includes(needle))
      );
    }
    return list;
  }, [data, outcomeFilter, textFilter]);

  if (loading) return <TableSkeleton rows={9} />;
  if (error) return <ErrorPanel message={error} onRetry={refresh} />;

  const filtering = outcomeFilter !== 'all' || textFilter.trim() !== '';

  return (
    <div className="audit-trail">
      <div className="toolbar">
        <div className="segmented" role="group" aria-label="Filter by outcome">
          {OUTCOMES.map((o) => (
            <button
              key={o.key}
              className={outcomeFilter === o.key ? 'active' : ''}
              aria-pressed={outcomeFilter === o.key}
              onClick={() => setOutcomeFilter(o.key)}
            >
              {o.label}
            </button>
          ))}
        </div>

        <div className="search">
          <SearchIcon />
          <label className="visually-hidden" htmlFor="audit-filter">
            Filter entries
          </label>
          <input
            id="audit-filter"
            type="text"
            placeholder="Filter by human, agent, context, repository, action, or reason…"
            value={textFilter}
            onChange={(e) => setTextFilter(e.target.value)}
          />
        </div>

        <button className="ghost" onClick={refresh}>
          <RefreshIcon style={{ width: 15, height: 15 }} />
          Refresh
        </button>

        <span className="result-count">
          {entries.length.toLocaleString()} of {data.entries.length.toLocaleString()} entries
        </span>
      </div>

      <DataTable
        columns={COLUMNS}
        rows={entries.length}
        empty={
          filtering ? (
            <EmptyState
              icon={SearchIcon}
              title="No entries match this filter"
              body="Try a different outcome or clear the search box — the chain itself is unaffected by filtering."
            />
          ) : (
            <EmptyState
              title="No decisions recorded yet"
              body="Every grant and denial the broker makes is appended here. Request a token to see the first entry."
            />
          )
        }
      >
        {entries.map((e) => {
          const isOpen = expanded === e.seq;
          return (
            <Fragment key={e.seq}>
              <tr
                className={`clickable outcome-${e.outcome}${isOpen ? ' is-expanded' : ''}`}
                onClick={() => setExpanded(isOpen ? null : e.seq)}
                aria-expanded={isOpen}
              >
                <td>
                  <RelativeTime value={e.timestamp} />
                </td>
                <td>
                  <OutcomeBadge outcome={e.outcome} />
                </td>
                <td className="nowrap" style={{ color: 'var(--text-primary)' }}>
                  {ACTION_LABELS[e.action] || e.action}
                </td>
                <td>{e.humanId ? <CopyableId value={e.humanId} /> : <span className="muted">—</span>}</td>
                <td>
                  {e.agentCardId ? <ToolLabel tool={e.tool} fallbackId={e.agentCardId} /> : <span className="muted">—</span>}
                </td>
                <td>
                  <OrDash value={e.context} />
                </td>
                <td className="reason">
                  <Detail entry={e} />
                </td>
              </tr>
              {isOpen && (
                <tr className="expanded-detail">
                  <td colSpan={COLUMNS.length}>
                    <ExpandedEntry entry={e} />
                  </td>
                </tr>
              )}
            </Fragment>
          );
        })}
      </DataTable>
    </div>
  );
}

/**
 * The one-line summary in the Detail column. Each action has a different
 * "most useful fact": a session grant is about scope, a minted GitHub
 * credential is about which repository, and anything denied is about why.
 */
function Detail({ entry }) {
  if (entry.outcome === 'denied') return <span>{entry.reason}</span>;

  if (entry.action === 'identity_revoked') {
    return (
      <span className="chip-list">
        <span className="chip">{entry.revokedId}</span>
        {entry.cascadedTo?.length > 0 && (
          <span className="badge warning">cascaded to {entry.cascadedTo.length}</span>
        )}
        {entry.reason && <span className="muted">{entry.reason}</span>}
      </span>
    );
  }

  if (entry.action === 'forge_token_issued') {
    return (
      <span className="chip-list">
        <span className="chip accent">{entry.repository}</span>
        {Object.entries(entry.permissions || {}).map(([k, v]) => (
          <span className="chip" key={k}>
            {k}:{v}
          </span>
        ))}
      </span>
    );
  }

  if (entry.scope) {
    return (
      <span className="chip-list">
        {(entry.scope.branches || []).map((b) => (
          <span className="chip" key={`b-${b}`}>
            {b === '*' ? 'any branch' : b}
          </span>
        ))}
        {(entry.scope.actions || []).map((a) => (
          <span className="chip accent" key={`a-${a}`}>
            {a}
          </span>
        ))}
      </span>
    );
  }

  return <span className="muted">—</span>;
}

/**
 * The expanded row. Previously this dumped `JSON.stringify(entry)` — correct
 * but unreadable, and it buried the fields an operator actually needs behind
 * the ones they never read (`prevHash`, `signature`).
 *
 * The named fields come first as a key/value grid; the raw entry stays one
 * disclosure away, because for a tamper-evident log "show me exactly what
 * was signed" is a legitimate and occasionally necessary request.
 */
function ExpandedEntry({ entry }) {
  const items = [];
  const add = (key, value) => {
    if (value === undefined || value === null || value === '') return;
    items.push({ key, value });
  };

  add('Sequence', `#${entry.seq}`);
  add('Recorded at', new Date(entry.timestamp).toLocaleString());
  add('Session', entry.sessionId ? <CopyableId value={entry.sessionId} /> : null);
  add('Human', entry.humanId ? <CopyableId value={entry.humanId} /> : null);
  add('Agent card', entry.agentCardId ? <CopyableId value={entry.agentCardId} /> : null);
  add('Tool', entry.tool ? <ToolLabel tool={entry.tool} /> : null);
  add('Revoked identity', entry.revokedId ? <CopyableId value={entry.revokedId} /> : null);
  add('Cascaded to', entry.cascadedTo?.length ? `${entry.cascadedTo.length} sponsored card(s)` : null);
  add('Context', entry.context);
  add('Repository', entry.repository);
  add('Reason', entry.reason);

  if (entry.scope) {
    add('Branch scope', <CapabilityList list={entry.scope.branches} />);
    add('Action scope', <CapabilityList list={entry.scope.actions} />);
  }

  if (entry.permissions) {
    add(
      'GitHub permissions',
      <span className="chip-list">
        {Object.entries(entry.permissions).map(([k, v]) => (
          <span className="chip" key={k}>
            {k}: {v}
          </span>
        ))}
      </span>
    );
  }

  // Two expiries that genuinely differ: GitHub fixes installation tokens at
  // roughly an hour and accepts no lifetime parameter, so the forge
  // credential outlives the AgentGate session that authorised it. Showing
  // them side by side is the point — see README §6.
  add('Session expires', entry.sessionExpiresAt ? new Date(entry.sessionExpiresAt).toLocaleString() : null);
  add('GitHub token expires', entry.forgeExpiresAt ? new Date(entry.forgeExpiresAt).toLocaleString() : null);

  if (entry.branchScope) {
    add(
      'Branch scope (not enforced by the token)',
      <span>
        <CapabilityList list={entry.branchScope} />
        <span className="muted" style={{ display: 'block', fontSize: 'var(--text-xs)', marginTop: 2 }}>
          GitHub tokens are repository-scoped, never branch-scoped — the enforcer and branch protection carry this.
        </span>
      </span>
    );
  }

  return (
    <div>
      <div className="detail-grid">
        {items.map(({ key, value }) => (
          <div className="detail-item" key={key}>
            <span className="detail-key">{key}</span>
            <span className="detail-value">{value}</span>
          </div>
        ))}
      </div>
      <details className="raw-json">
        <summary>Raw entry (exactly what the chain signed)</summary>
        <pre>{JSON.stringify(entry, null, 2)}</pre>
      </details>
    </div>
  );
}
