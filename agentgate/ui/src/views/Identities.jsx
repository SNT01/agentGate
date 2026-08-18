import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, UnauthorizedError } from '../api.js';
import { usePolling } from '../usePolling.js';
import { CapabilityList, ToolLabel, Timestamp, ExpiresIn, RevokedBadge, CopyableId } from '../format.jsx';
import { EmptyState, ErrorPanel, TableSkeleton, DataTable } from '../components.jsx';
import { UsersIcon, KeyIcon, AlertTriangleIcon, SearchIcon } from '../icons.jsx';

const HUMAN_COLUMNS = [
  { key: 'name', label: 'Name' },
  { key: 'id', label: 'ID' },
  { key: 'contexts', label: 'Contexts' },
  { key: 'capabilities', label: 'Capabilities' },
  { key: 'enrolled', label: 'Enrolled' },
  { key: 'status', label: 'Status' },
  { key: 'act', label: '', width: '1%' },
];

const AGENT_COLUMNS = [
  { key: 'tool', label: 'Tool' },
  { key: 'id', label: 'ID' },
  { key: 'sponsor', label: 'Sponsor' },
  { key: 'context', label: 'Context' },
  { key: 'branches', label: 'Branches' },
  { key: 'actions', label: 'Actions' },
  { key: 'expires', label: 'Expires' },
  { key: 'status', label: 'Status' },
  { key: 'act', label: '', width: '1%' },
];

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
  const [query, setQuery] = useState('');

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
      if (err instanceof UnauthorizedError) {
        onUnauthorized?.();
        return;
      }
      setActionError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const needle = query.trim().toLowerCase();
  const match = (...fields) =>
    !needle || fields.filter(Boolean).some((f) => String(f).toLowerCase().includes(needle));

  const humans = (data?.humans || []).filter((h) => match(h.name, h.id, ...(h.allowedContexts || [])));
  const agents = (data?.agents || []).filter((a) => match(a.tool?.name, a.id, a.sponsorId, a.context));

  if (loading) return <TableSkeleton rows={7} />;
  if (error) return <ErrorPanel message={error} onRetry={refresh} />;

  return (
    <div className="identities">
      <div className="toolbar">
        <div className="search">
          <SearchIcon />
          <label className="visually-hidden" htmlFor="identity-filter">
            Filter identities
          </label>
          <input
            id="identity-filter"
            type="text"
            placeholder="Filter by name, id, tool, sponsor, or context…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <span className="result-count">
          {humans.length} human{humans.length === 1 ? '' : 's'} · {agents.length} agent card
          {agents.length === 1 ? '' : 's'}
        </span>
      </div>

      <section>
        <div className="section-header">
          <h2>Humans</h2>
          <span className="section-note">Authority originates here — an agent can never exceed its sponsor.</span>
        </div>
        <DataTable
          columns={HUMAN_COLUMNS}
          rows={humans.length}
          empty={
            <EmptyState
              icon={UsersIcon}
              title={needle ? 'No humans match this filter' : 'No humans enrolled'}
              body={needle ? undefined : 'Run `agentgate enroll` to register the first person.'}
            />
          }
        >
          {humans.map((h) => (
            <tr key={h.id} className={h.revoked ? 'is-revoked' : undefined}>
              <td style={{ color: 'var(--text-primary)', fontWeight: 550 }}>{h.name}</td>
              <td>
                <CopyableId value={h.id} />
              </td>
              <td>
                <CapabilityList list={h.allowedContexts} />
              </td>
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
                  <button className="ghost" onClick={() => openConfirm(h.id, h.name, cascadeCountFor(h.id))}>
                    Revoke
                  </button>
                )}
              </td>
            </tr>
          ))}
        </DataTable>
      </section>

      <section>
        <div className="section-header">
          <h2>Agent cards</h2>
          <span className="section-note">Each card is pinned to one context and expires on its own schedule.</span>
        </div>
        <DataTable
          columns={AGENT_COLUMNS}
          rows={agents.length}
          empty={
            <EmptyState
              icon={KeyIcon}
              title={needle ? 'No agent cards match this filter' : 'No agent cards issued'}
              body={needle ? undefined : 'Run `agentgate issue-agent` to give an AI tool its own bounded identity.'}
            />
          }
        >
          {agents.map((a) => (
            <tr key={a.id} className={a.revoked ? 'is-revoked' : undefined}>
              <td className="nowrap">
                <ToolLabel tool={a.tool} />
              </td>
              <td>
                <CopyableId value={a.id} />
              </td>
              <td>
                <CopyableId value={a.sponsorId} />
              </td>
              <td>{a.context}</td>
              <td>
                <CapabilityList list={a.capabilities.branches} />
              </td>
              <td>
                <CapabilityList list={a.capabilities.actions} />
              </td>
              <td>
                <ExpiresIn value={a.expiresAt} />
              </td>
              <td>
                <RevokedBadge revoked={a.revoked} />
              </td>
              <td>
                {!a.revoked && (
                  <button className="ghost" onClick={() => openConfirm(a.id, a.tool?.name || a.id, 0)}>
                    Revoke
                  </button>
                )}
              </td>
            </tr>
          ))}
        </DataTable>
      </section>

      {pending && (
        <RevokeDialog
          pending={pending}
          reason={reason}
          setReason={setReason}
          busy={busy}
          actionError={actionError}
          onCancel={() => setPending(null)}
          onConfirm={confirmRevoke}
        />
      )}
    </div>
  );
}

/**
 * The confirmation for the dashboard's only destructive action.
 *
 * Escape closes it and focus moves to the reason field on open — a dialog
 * that traps a keyboard user is worse than no dialog. The cascade count is
 * stated before the fact, since revoking a sponsor silently disabling four
 * agents is exactly the surprise this screen exists to prevent.
 */
function RevokeDialog({ pending, reason, setReason, busy, actionError, onCancel, onConfirm }) {
  const inputRef = useRef(null);

  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (e) => {
      if (e.key === 'Escape' && !busy) onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onCancel]);

  return (
    <div className="modal-backdrop" onClick={() => !busy && onCancel()}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="revoke-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id="revoke-title">Revoke {pending.name}?</h3>
        <p>
          This removes authority immediately and cannot grant anything back. Live sessions stop verifying at once;
          restoring access means re-enrolling.
        </p>

        {pending.cascadeCount > 0 && (
          <div className="modal-callout">
            <AlertTriangleIcon />
            <span>
              This also cascade-revokes <strong>{pending.cascadeCount}</strong> sponsored agent card
              {pending.cascadeCount === 1 ? '' : 's'}.
            </span>
          </div>
        )}

        <label className="visually-hidden" htmlFor="revoke-reason">
          Reason
        </label>
        <input
          id="revoke-reason"
          ref={inputRef}
          type="text"
          placeholder="Reason (optional, recorded in the audit log)"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />

        {actionError && (
          <p className="error" role="alert" style={{ marginBottom: 'var(--space-3)' }}>
            {actionError}
          </p>
        )}

        <div className="modal-actions">
          <button className="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button className="danger" onClick={onConfirm} disabled={busy}>
            {busy ? 'Revoking…' : 'Revoke'}
          </button>
        </div>
      </div>
    </div>
  );
}
