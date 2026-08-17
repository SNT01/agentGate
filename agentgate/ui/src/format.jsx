/**
 * Rendering helpers that encode the data-shape hazards found when mapping
 * the API: a capability set's `'*'` means "no restriction imposed" (not a
 * literal branch/action name — src/shared/capability.js), `tool` is an
 * object `{name, version, packageHash}` rather than a string
 * (src/registry/registry.js), and denied audit entries carry a
 * non-uniform field set — `humanId`/`agentCardId`/`context` may each be
 * entirely absent (src/broker/broker.js `_deny` call sites).
 */

export function CapabilityList({ list }) {
  if (!list || list.length === 0) return <span className="muted">none</span>;
  if (list.includes('*')) return <span className="badge unrestricted">unrestricted</span>;
  return (
    <span className="chip-list">
      {list.map((item) => (
        <span className="chip" key={item}>
          {item}
        </span>
      ))}
    </span>
  );
}

export function ToolLabel({ tool }) {
  if (!tool) return <span className="muted">—</span>;
  return (
    <span>
      {tool.name}
      {tool.version ? `@${tool.version}` : ''}
    </span>
  );
}

export function Timestamp({ value }) {
  if (!value) return <span className="muted">—</span>;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return <span className="muted">{String(value)}</span>;
  return <span title={d.toISOString()}>{d.toLocaleString()}</span>;
}

/** value may be an ISO string (agent card expiresAt) or ms epoch (session expiresAt). */
export function ExpiresIn({ value }) {
  const target = typeof value === 'number' ? value : new Date(value).getTime();
  if (!Number.isFinite(target)) return <span className="muted">—</span>;
  const deltaMs = target - Date.now();
  if (deltaMs <= 0) return <span className="badge expired">expired</span>;
  const minutes = Math.round(deltaMs / 60000);
  if (minutes < 60) return <span>{minutes}m</span>;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return <span>{hours}h</span>;
  return <span>{Math.round(hours / 24)}d</span>;
}

export function RevokedBadge({ revoked }) {
  return revoked ? <span className="badge revoked">revoked</span> : <span className="badge active">active</span>;
}

/** Denied entries may lack humanId/agentCardId/context entirely. */
export function OrDash({ value }) {
  return value === undefined || value === null || value === '' ? <span className="muted">—</span> : <span>{value}</span>;
}
