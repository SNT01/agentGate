import { useCallback } from 'react';
import { api } from '../api.js';
import { usePolling } from '../usePolling.js';
import { OrDash, RelativeTime, CopyableId, ToolLabel } from '../format.jsx';
import { EmptyState, ErrorPanel, OverviewSkeleton, DataTable } from '../components.jsx';
import { CheckCircleIcon, AlertTriangleIcon } from '../icons.jsx';

const DENIAL_COLUMNS = [
  { key: 'when', label: 'When' },
  { key: 'human', label: 'Human' },
  { key: 'agent', label: 'Agent' },
  { key: 'context', label: 'Context' },
  { key: 'reason', label: 'Reason' },
];

/**
 * The headline view.
 *
 * Chain integrity is deliberately the loudest element on the page —
 * `GET /audit/verify` returning `valid: false` means the audit log has been
 * tampered with, which is the single worst thing this dashboard could ever
 * report, and a small badge would bury it.
 *
 * The headline is a *state*, not a number, so it is a status banner rather
 * than a hero figure: the four counts below it are peers of one another and
 * belong in tiles. Both states of the banner carry an icon with a distinct
 * silhouette (check-in-circle vs triangle) and a written title, so "intact"
 * and "FAILURE" are never distinguished by colour alone.
 */
export default function Overview({ token, onUnauthorized }) {
  const fetcher = useCallback(async () => {
    const [verify, identities, sessions, recentAudit] = await Promise.all([
      api.auditVerify(token),
      api.identities(token),
      api.sessions(token),
      api.auditEntries(token, 50),
    ]);
    return { verify, identities, sessions, recentAudit };
  }, [token]);

  const { data, error, loading, refresh } = usePolling(fetcher, { intervalMs: 10_000, onUnauthorized });

  if (loading) return <OverviewSkeleton />;
  if (error) return <ErrorPanel message={error} onRetry={refresh} />;

  const { verify, identities, sessions, recentAudit } = data;
  const denials = recentAudit.entries.filter((e) => e.outcome === 'denied');
  const recentDenials = denials.slice(-8).reverse();
  const revokedCount =
    identities.humans.filter((h) => h.revoked).length + identities.agents.filter((a) => a.revoked).length;

  return (
    <div className="overview">
      {verify.valid ? (
        <div className="chain-status ok" role="status">
          <CheckCircleIcon className="status-icon" />
          <div>
            <p className="chain-status-title">Audit chain intact</p>
            <p className="chain-status-body">
              All {verify.count.toLocaleString()} entries verified against the broker's signing key.
            </p>
          </div>
        </div>
      ) : (
        <div className="chain-status broken" role="alert">
          <AlertTriangleIcon className="status-icon" />
          <div>
            <p className="chain-status-title">Audit chain integrity failure</p>
            <p className="chain-status-body">
              Broken at entry #{verify.brokenAt}: {verify.reason}
            </p>
            <p className="chain-status-body" style={{ marginTop: 6 }}>
              <strong>Investigate immediately.</strong> A past entry was modified, removed, or forged.
            </p>
          </div>
        </div>
      )}

      <div className="stat-row">
        <Stat label="Humans" value={identities.humans.length} note="enrolled in the registry" tone="neutral" />
        <Stat label="Agent cards" value={identities.agents.length} note="sponsored, capability-bounded" tone="neutral" />
        <Stat
          label="Live sessions"
          value={sessions.sessions.length}
          note={sessions.sessions.length === 0 ? 'none outstanding' : 'issued and unexpired'}
          tone={sessions.sessions.length > 0 ? 'good' : 'neutral'}
        />
        <Stat
          label="Revoked"
          value={revokedCount}
          note={revokedCount === 0 ? 'no identities withdrawn' : 'authority withdrawn'}
          tone={revokedCount > 0 ? 'warning' : 'neutral'}
          attention={revokedCount > 0}
        />
      </div>

      <section>
        <div className="section-header">
          <h2>Recent denials</h2>
          <span className="section-note">
            {denials.length} of the last {recentAudit.entries.length} decisions were refused
          </span>
        </div>

        <DataTable
          columns={DENIAL_COLUMNS}
          rows={recentDenials.length}
          empty={
            <EmptyState
              icon={CheckCircleIcon}
              title="Nothing was refused"
              body="Every decision in the recent audit window was granted. Denials appear here as they happen."
            />
          }
        >
          {recentDenials.map((e) => (
            <tr key={e.seq} className="outcome-denied">
              <td>
                <RelativeTime value={e.timestamp} />
              </td>
              <td>{e.humanId ? <CopyableId value={e.humanId} /> : <span className="muted">—</span>}</td>
              <td>
                {e.agentCardId ? <ToolLabel tool={e.tool} fallbackId={e.agentCardId} /> : <span className="muted">—</span>}
              </td>
              <td>
                <OrDash value={e.context} />
              </td>
              <td className="reason">{e.reason}</td>
            </tr>
          ))}
        </DataTable>
      </section>
    </div>
  );
}

/**
 * Stat tile: label (sentence case), value, and a note giving the number its
 * meaning. The dot is a mark beside the label, never the label itself — the
 * note says in words what the colour suggests.
 */
function Stat({ label, value, note, tone = 'neutral', attention = false }) {
  return (
    <div className={attention ? 'stat attention' : 'stat'}>
      <span className="stat-label">
        <span className={`stat-dot ${tone}`} aria-hidden="true" />
        {label}
      </span>
      <span className="stat-value">{value.toLocaleString()}</span>
      <span className="stat-note">{note}</span>
    </div>
  );
}
