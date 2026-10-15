import type { CivilizationStatus } from '@civ/shared';
import type { ReactNode } from 'react';
import { ApiError, describeError } from '../api/client';

/*
 * Small presentational building blocks: status pill, inline alerts, skeletons, empty
 * states and meters.
 */

const STATUS_LABEL: Record<CivilizationStatus, string> = {
  running: 'Running',
  paused: 'Paused',
  halted: 'HALTED',
};

export function StatusPill({
  status,
  haltReason,
}: {
  status: CivilizationStatus;
  haltReason?: string | null;
}) {
  return (
    <span
      className={`pill pill-${status}`}
      data-testid="status-pill"
      data-status={status}
      title={status === 'halted' && haltReason ? `Halted: ${haltReason}` : undefined}
    >
      <span className="pill-dot" aria-hidden="true" />
      {STATUS_LABEL[status]}
    </span>
  );
}

/** Inline error for a failed query or mutation, with the server's code when known. */
export function ErrorMessage({ error, title }: { error: unknown; title?: string }) {
  const code = error instanceof ApiError ? error.code : null;
  return (
    <div className="alert alert-error" role="alert" data-testid="error-message">
      {title && <strong>{title}</strong>}
      <span>
        {code && <code className="alert-code">{code}</code>}{' '}
        {error instanceof ApiError ? error.message : describeError(error)}
      </span>
      {error instanceof ApiError && error.code === 'UNAUTHORIZED' && (
        <span className="alert-hint">Enter a valid access token (top right).</span>
      )}
      {error instanceof ApiError && error.code === 'FORBIDDEN' && (
        <span className="alert-hint">This action requires the operator token.</span>
      )}
    </div>
  );
}

export function Alert({
  kind = 'info',
  children,
}: {
  kind?: 'info' | 'warn' | 'error';
  children: ReactNode;
}) {
  return (
    <div className={`alert alert-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      {children}
    </div>
  );
}

/**
 * Why the operator-only controls next to it are unavailable (see useAccess). Give the
 * disabled controls `aria-describedby={id}` so the reason is announced with them.
 */
export function AccessNote({ id, reason }: { id: string; reason: string }) {
  return (
    <p id={id} className="access-note" data-testid="access-note">
      {reason}
    </p>
  );
}

/** Placeholder bars shown while data loads. */
export function Skeleton({ lines = 3, height }: { lines?: number; height?: number }) {
  return (
    <div className="skeleton-group" aria-hidden="true">
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="skeleton" style={height ? { height } : undefined} />
      ))}
    </div>
  );
}

export function LoadingRegion({ label, lines = 3 }: { label: string; lines?: number }) {
  return (
    <div role="status" aria-live="polite">
      <span className="visually-hidden">{label}</span>
      <Skeleton lines={lines} />
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty-state">
      <strong>{title}</strong>
      {children && <div className="muted">{children}</div>}
    </div>
  );
}

/**
 * Horizontal bar for a bounded value (traits, skills, energy). `value` is in
 * [min, max]; the numeric value is always printed next to the bar.
 */
export function Meter({
  label,
  value,
  min = 0,
  max = 100,
  display,
  tone = 'accent',
}: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  display: string;
  tone?: 'accent' | 'data' | 'warn';
}) {
  const clamped = Math.min(max, Math.max(min, value));
  const pct = max > min ? ((clamped - min) / (max - min)) * 100 : 0;
  return (
    <div className="meter-row">
      <span className="meter-label">{label}</span>
      <div
        className={`meter meter-${tone}`}
        role="meter"
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={clamped}
        aria-valuetext={display}
      >
        <div className="meter-fill" style={{ width: `${pct}%` }} />
      </div>
      <span className="meter-value num">{display}</span>
    </div>
  );
}
