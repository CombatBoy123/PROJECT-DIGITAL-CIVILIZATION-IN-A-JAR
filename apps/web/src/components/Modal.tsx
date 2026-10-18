import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ErrorMessage } from './Feedback';

/*
 * Modal dialogs built on the native <dialog> element (focus trapping, Escape to
 * close and inert background come from the browser).
 */

interface ModalProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  testId?: string;
}

export function Modal({ open, title, onClose, children, className, testId }: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      // showModal() focuses the first focusable element (the close button); move focus
      // to the field the dialog is about instead.
      dialog.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    }
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className={`dialog ${className ?? ''}`}
      aria-labelledby={titleId}
      data-testid={testId}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      {open && (
        <>
          <header className="dialog-header">
            <h2 id={titleId}>{title}</h2>
            <button type="button" className="icon-btn" aria-label="Close dialog" onClick={onClose}>
              ×
            </button>
          </header>
          {children}
        </>
      )}
    </dialog>
  );
}

interface TypedConfirmProps {
  open: boolean;
  title: string;
  /** What will happen, in plain words. */
  description: ReactNode;
  /** Text the user must type exactly (the civilization's name). */
  expected: string;
  confirmLabel: string;
  pending: boolean;
  error: unknown;
  onConfirm: (typed: string) => void;
  onClose: () => void;
  testId?: string;
}

/**
 * Confirmation for destructive actions: the confirm button stays disabled until the
 * exact expected text is typed. The typed value is sent to the server, which checks it
 * again.
 */
export function TypedConfirmDialog(props: TypedConfirmProps) {
  const { open, expected, pending } = props;
  const [typed, setTyped] = useState('');
  const inputId = useId();
  const hintId = useId();

  useEffect(() => {
    if (open) setTyped('');
  }, [open]);

  const matches = typed === expected;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (matches && !pending) props.onConfirm(typed);
  };

  return (
    <Modal open={open} title={props.title} onClose={props.onClose} testId={props.testId}>
      <form className="dialog-body stack gap-m" onSubmit={submit}>
        <div className="dialog-description">{props.description}</div>
        <div className="field">
          <label htmlFor={inputId} className="field-label">
            Type <strong className="mono">{expected}</strong> to confirm
          </label>
          <input
            id={inputId}
            data-autofocus
            autoComplete="off"
            spellCheck={false}
            value={typed}
            aria-describedby={hintId}
            data-testid="confirm-input"
            onChange={(e) => setTyped(e.target.value)}
          />
          <span id={hintId} className="field-hint">
            {matches
              ? 'Name matches.'
              : 'The action stays disabled until the name matches exactly.'}
          </span>
        </div>
        {props.error !== null && props.error !== undefined && <ErrorMessage error={props.error} />}
        <div className="dialog-actions">
          <button type="button" className="btn btn-ghost" onClick={props.onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="btn btn-danger"
            disabled={!matches || pending}
            data-testid="confirm-submit"
          >
            {pending ? 'Working…' : props.confirmLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
}
