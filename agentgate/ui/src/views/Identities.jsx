import { useCallback, useMemo, useState } from 'react';
import { api } from '../api.js';
import { usePolling } from '../usePolling.js';
import { CapabilityList, ToolLabel, Timestamp, RevokedBadge } from '../format.jsx';
import { ErrorPanel } from './Overview.jsx';

/**
 * Humans and agent cards. The only write action anywhere in the dashboard:
 * revocation, which can only ever remove authority (registry.revoke — never
 * grants). The confirmation dialog shows exactly what will cascade *before*
 * the admin confirms, computed here from the already-loaded agent list
 * rather than waiting on the server's response.
 */
export default function Identities({ token, onUnauthorized }) {
  const fetcher = useCallback(() => api.identities(token), [token]);
  const { data, error, loading, refresh } = usePolling(fetcher, { intervalMs: 15_000, onUnauthorized });
  const [pending, setPending] = useState(null); // { id, name, cascadeCount }
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState(null);

  const cascadeCountFor = useMemo(() => {
    return (humanId) => (data ? data.agents.filter((a) => a.sponsorId === humanId && !a.revoked).length : 0);
  }, [data]);

  const openConfirm = (id, name, cascadeCount) => {
    setActionError(null);
    setReason('');
    setPending({ id, name, cascadeCount });
  };

  const confirmRevoke = async () => {
    setBusy(true);
    setActionError(null);
    try {
      await api.revoke(token, pending.id, reason.trim() || undefined);
      setPending(null);
      await refresh();
    } catch (err) {
      if (err.constructor.name === 'UnauthorizedError') {
        onUnauthorized?.();
        return;
      }
      setActionError(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <p className="muted">Loading…</p>;
  if (error) return <ErrorPanel message={error} onRetry={refresh} />;

  return (
    <div className="identities">
      <section>
        <h2>Humans</h2>
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>ID</th>
              <th>Contexts</th>
              <th>Capabilities</th>
              <th>Enrolled</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {data.humans.map((h) => (
              <tr key={h.id}>
                <td>{h.name}</td>
                <td className="mono">{h.id}</td>
                <td>{h.allowedContexts.join(', ')}</td>
                <td>
                  <CapabilityList list={h.capabilities.actions} />
                </td>
                <td>
                  <Timestamp value={h.enrolledAt} />
                </td>
                <td>
                  <RevokedBadge revoked={h.revoked} />
                </td>
                <td>
                  {!h.revoked && (
                    <button className="danger" onClick={() => openConfirm(h.id, h.name, cascadeCountFor(h.id))}>
                      Revoke
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h2>Agent cards</h2>
        <table>
          <thead>
            <tr>
              <th>Tool</th>
              <th>ID</th>
              <th>Sponsor</th>
              <th>Context</th>
              <th>Branches</th>
              <th>Actions</th>
              <th>Expires</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {data.agents.map((a) => (
              <tr key={a.id}>
                <td>
                  <ToolLabel tool={a.tool} />
                </td>
                <td className="mono">{a.id}</td>
                <td className="mono">{a.sponsorId}</td>
                <td>{a.context}</td>
                <td>
                  <CapabilityList list={a.capabilities.branches} />
                </td>
                <td>
                  <CapabilityList list={a.capabilities.actions} />
                </td>
                <td>
                  <Timestamp value={a.expiresAt} />
                </td>
                <td>
                  <RevokedBadge revoked={a.revoked} />
                </td>
                <td>
                  {!a.revoked && (
                    <button className="danger" onClick={() => openConfirm(a.id, a.id, 0)}>
                      Revoke
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {pending && (
        <div className="modal-backdrop" onClick={() => !busy && setPending(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Revoke {pending.name}?</h3>
            <p>
              This removes authority immediately and cannot grant anything back. It is fully reversible only by
              re-enrolling.
            </p>
            {pending.cascadeCount > 0 && (
              <p className="warn">
                This will also cascade-revoke <strong>{pending.cascadeCount}</strong> sponsored agent card
                {pending.cascadeCount === 1 ? '' : 's'}.
              </p>
            )}
            <input placeholder="Reason (optional, recorded in the audit log)" value={reason} onChange={(e) => setReason(e.target.value)} />
            {actionError && <p className="error">{actionError}</p>}
            <div className="modal-actions">
              <button onClick={() => setPending(null)} disabled={busy}>
                Cancel
              </button>
              <button className="danger" onClick={confirmRevoke} disabled={busy}>
                {busy ? 'Revoking…' : 'Confirm revoke'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
