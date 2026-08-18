import { AlertCircleIcon, InboxIcon, RefreshIcon } from './icons.jsx';

/**
 * The three states every data view has besides "it worked": loading,
 * nothing to show, and failed.
 *
 * They live together because their job is consistency — an operator should
 * not have to work out whether a bare table means "no sessions" or "the
 * request failed". Previously an empty result rendered as a header row with
 * nothing under it, which reads as a bug.
 */

/**
 * Skeletons rather than a "Loading…" line: they hold the layout at roughly
 * its final size, so switching tabs does not collapse the page and reflow
 * it a moment later.
 */
export function TableSkeleton({ rows = 6 }) {
  return (
    <div className="card">
      <div className="skeleton-rows" aria-hidden="true">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
            <div className="skeleton" style={{ width: '18%' }} />
            <div className="skeleton" style={{ width: '26%' }} />
            <div className="skeleton" style={{ width: '14%' }} />
            <div className="skeleton" style={{ flex: 1 }} />
          </div>
        ))}
      </div>
      <span className="visually-hidden" role="status">
        Loading…
      </span>
    </div>
  );
}

export function OverviewSkeleton() {
  return (
    <div>
      <div className="skeleton" style={{ height: 70, borderRadius: 12, marginBottom: 24 }} aria-hidden="true" />
      <div className="stat-row" aria-hidden="true">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="skeleton skeleton-stat" />
        ))}
      </div>
      <TableSkeleton rows={4} />
    </div>
  );
}

export function EmptyState({ title, body, icon }) {
  const Icon = icon || InboxIcon;
  return (
    <div className="empty">
      <Icon />
      <p className="empty-title">{title}</p>
      {body && <p className="empty-body">{body}</p>}
    </div>
  );
}

export function ErrorPanel({ message, onRetry }) {
  return (
    <div className="error-panel" role="alert">
      <p className="error-title">
        <AlertCircleIcon />
        Could not load this view
      </p>
      <p className="secondary" style={{ fontSize: 'var(--text-sm)' }}>
        {message}
      </p>
      {onRetry && (
        <button className="ghost" onClick={onRetry}>
          <RefreshIcon style={{ width: 15, height: 15 }} />
          Retry
        </button>
      )}
    </div>
  );
}

/**
 * A table plus its own empty state, so no view renders a header row with
 * nothing beneath it.
 */
export function DataTable({ columns, rows, empty, children }) {
  if (rows === 0) return <div className="card">{empty}</div>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key || c.label} style={c.width ? { width: c.width } : undefined}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
