import { useId, type ReactNode } from 'react';
import type { Selection } from '../world/types';
import { useDemo } from './context';

/*
 * Small presentational pieces shared by the demo panels.
 */

/** In-page link to a citizen or building: selects it and centres the map on it. */
export function EntityLink({ selection, children }: { selection: Selection; children: ReactNode }) {
  const { select } = useDemo();
  return (
    <button
      type="button"
      className="link-btn"
      data-entity={`${selection.kind}:${selection.id}`}
      onClick={() => select(selection, { focus: true })}
    >
      {children}
    </button>
  );
}

/**
 * Horizontal bar for a bounded value. The track is a lighter step of the fill's
 * colour; the number is always printed next to the bar.
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

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="kv">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

export function Section({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section className="section" aria-labelledby={id}>
      <h3 id={id} className="section-title">
        {title} {aside && <span className="muted small">{aside}</span>}
      </h3>
      {children}
    </section>
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
 * In-page confirmation (browser dialogs are unavailable in the published page):
 * a message with Confirm and Cancel buttons, shown in place of the action.
 */
export function ConfirmBar({
  message,
  confirmLabel,
  danger = false,
  onConfirm,
  onCancel,
}: {
  message: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const id = useId();
  return (
    <div className="confirm" role="group" aria-labelledby={id}>
      <p id={id} className="confirm-text">
        {message}
      </p>
      <div className="row gap-s wrap">
        <button
          type="button"
          className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`}
          onClick={onConfirm}
          // The confirmation replaces the button that opened it; keep keyboard focus here.
          autoFocus
        >
          {confirmLabel}
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
