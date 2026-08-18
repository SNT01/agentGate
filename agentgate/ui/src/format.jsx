import { useState, useCallback, useEffect } from 'react';
import { CopyIcon } from './icons.jsx';

/**
 * Rendering helpers that encode the data-shape hazards found when mapping
 * the API: a capability set's `'*'` means "no restriction imposed" (not a
 * literal branch/action name — src/shared/capability.js), `tool` is an
 * object `{name, version, packageHash}` rather than a string
 * (src/registry/registry.js), and denied audit entries carry a
 * non-uniform field set — `humanId`/`agentCardId`/`context` may each be
 * entirely absent (src/broker/broker.js `_deny` call sites).
 *
 * A note that runs through all of these: every status colour is paired with
 * a word. `unrestricted`, `revoked`, `expired`, `denied` each render their
 * own label, so nothing here depends on a viewer distinguishing hues.
 */

export function CapabilityList({ list }) {
  if (!list || list.length === 0) return <span className="muted">none</span>;
  // '*' is not a pattern to display — it means this set imposes no
  // restriction, which is a materially different (and looser) statement.
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

/**
 * `tool` is present on `token_issued` entries but not on every entry that
 * names an agent (`forge_token_issued` and the denial paths carry the card
 * id alone). Falling back to the id keeps the Agent column meaningful
 * instead of showing a dash where an agent demonstrably acted.
 */
export function ToolLabel({ tool, fallbackId }) {
  if (!tool) return fallbackId ? <CopyableId value={fallbackId} /> : <span className="muted">—</span>;
  return (
    <span style={{ whiteSpace: 'nowrap' }}>
      <strong style={{ fontWeight: 550, color: 'var(--text-primary)' }}>{tool.name}</strong>
      {tool.version ? <span className="muted">@{tool.version}</span> : null}
    </span>
  );
}

export function Timestamp({ value }) {
  if (!value) return <span className="muted">—</span>;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return <span className="muted">{String(value)}</span>;
  return (
    <span title={d.toISOString()} style={{ whiteSpace: 'nowrap' }}>
      {d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
    </span>
  );
}

/**
 * Relative age ("4m ago"), with the absolute time on hover. In an audit
 * trail the question is almost always "how long ago", and a wall-clock
 * timestamp makes the reader do that subtraction on every row.
 */
export function RelativeTime({ value }) {
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  if (!value) return <span className="muted">—</span>;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return <span className="muted">{String(value)}</span>;

  const seconds = Math.round((Date.now() - d.getTime()) / 1000);
  let label;
  if (seconds < 45) label = 'just now';
  else if (seconds < 3600) label = `${Math.round(seconds / 60)}m ago`;
  else if (seconds < 86400) label = `${Math.round(seconds / 3600)}h ago`;
  else label = `${Math.round(seconds / 86400)}d ago`;

  return (
    <span title={d.toISOString()} style={{ whiteSpace: 'nowrap' }}>
      {label}
    </span>
  );
}

const MINUTE = 60_000;

/**
 * Remaining session lifetime as a meter plus a figure.
 *
 * The fill carries severity and the unfilled track is a lighter step of the
 * same ramp, so state reads across the whole bar. The written figure is
 * always present — the colour is reinforcement, never the only signal.
 *
 * `value` may be an ISO string (agent card expiresAt) or ms epoch (session
 * expiresAt); `ttlMs` is the full window the bar represents.
 */
export function ExpiryMeter({ value, ttlMs = 15 * MINUTE }) {
  const target = typeof value === 'number' ? value : new Date(value).getTime();
  if (!Number.isFinite(target)) return <span className="muted">—</span>;

  const remaining = target - Date.now();
  if (remaining <= 0) return <span className="badge expired">expired</span>;

  const fraction = Math.max(0, Math.min(1, remaining / ttlMs));
  const minutes = remaining / MINUTE;
  const severity = minutes < 2 ? 'critical' : minutes < 5 ? 'warning' : '';

  return (
    <span
      className="meter"
      role="meter"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(fraction * 100)}
      aria-label={`${formatDuration(remaining)} remaining`}
    >
      <span className="meter-track">
        <span className={`meter-fill ${severity}`} style={{ width: `${Math.max(3, fraction * 100)}%` }} />
      </span>
      <span className="meter-label">{formatDuration(remaining)}</span>
    </span>
  );
}

function formatDuration(ms) {
  const minutes = Math.round(ms / MINUTE);
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/** Plain remaining-time text, for places with no room for a meter. */
export function ExpiresIn({ value }) {
  const target = typeof value === 'number' ? value : new Date(value).getTime();
  if (!Number.isFinite(target)) return <span className="muted">—</span>;
  const remaining = target - Date.now();
  if (remaining <= 0) return <span className="badge expired">expired</span>;
  return <span>{formatDuration(remaining)}</span>;
}

export function RevokedBadge({ revoked }) {
  return revoked ? <span className="badge revoked">revoked</span> : <span className="badge active">active</span>;
}

export function OutcomeBadge({ outcome }) {
  if (outcome === 'granted') return <span className="badge granted">granted</span>;
  if (outcome === 'denied') return <span className="badge denied">denied</span>;
  return <span className="badge neutral">{outcome || 'unknown'}</span>;
}

/** Denied entries may lack humanId/agentCardId/context entirely. */
export function OrDash({ value }) {
  return value === undefined || value === null || value === '' ? (
    <span className="muted">—</span>
  ) : (
    <span>{value}</span>
  );
}

/**
 * A registry id, truncated with the full value one click away.
 *
 * These are 24 characters of prefixed hex. Rendered in full they set the
 * width of every table that shows one, and an operator comparing two ids
 * reads the tail, not the head — so the tail is what stays visible.
 */
export function CopyableId({ value, prefixLength = 7 }) {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(
    async (e) => {
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(value);
      } catch (_err) {
        // Clipboard is unavailable over plain HTTP on some browsers. The
        // title attribute still carries the full value, so this degrades to
        // select-and-copy rather than failing visibly.
        return;
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    },
    [value]
  );

  if (!value) return <span className="muted">—</span>;

  // Keep the type prefix (human_/agent_/session_) and the distinguishing tail.
  const underscore = value.indexOf('_');
  const head = underscore > 0 ? value.slice(0, underscore + 1) : '';
  const rest = underscore > 0 ? value.slice(underscore + 1) : value;
  const shown = rest.length > prefixLength + 4 ? `${head}…${rest.slice(-6)}` : value;

  return (
    <button className="id" onClick={copy} title={`${value}\n(click to copy)`} type="button">
      <span className="id-text">{shown}</span>
      {copied ? <span className="id-copied">copied</span> : <CopyIcon style={{ width: 11, height: 11, opacity: 0.6 }} />}
    </button>
  );
}
