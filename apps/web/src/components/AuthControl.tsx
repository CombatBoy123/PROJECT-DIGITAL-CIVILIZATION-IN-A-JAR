import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useState, type FormEvent } from 'react';
import { useMeta } from '../api/queries';
import { setToken } from '../api/token';
import { useToken } from '../api/useCivilizationStream';
import { Modal } from './Modal';

/*
 * Access-token entry for servers running with AUTH_MODE=token. The server tells us
 * (GET /api/meta) whether tokens are used at all; in disabled mode nothing is shown.
 * The token is never validated client-side — the server's 401/403 responses are
 * surfaced where the failing action happened.
 */

export function AuthControl() {
  const meta = useMeta();
  const token = useToken();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const inputId = useId();
  const tokenMode = meta.data?.authMode === 'token';

  // Ask once on load when the server needs a token and none is stored.
  useEffect(() => {
    if (tokenMode && !token) setOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the mode becomes known
  }, [tokenMode]);

  useEffect(() => {
    if (open) setDraft(token ?? '');
  }, [open, token]);

  if (!tokenMode) return null;

  const apply = (value: string | null) => {
    setToken(value);
    setOpen(false);
    void qc.invalidateQueries();
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    apply(draft);
  };

  return (
    <>
      <button
        type="button"
        className={`btn btn-sm ${token ? 'btn-ghost' : 'btn-primary'}`}
        onClick={() => setOpen(true)}
        data-testid="auth-button"
      >
        {token ? 'Token set' : 'Enter access token'}
      </button>
      <Modal open={open} title="Access token" onClose={() => setOpen(false)}>
        <form className="dialog-body stack gap-m" onSubmit={submit}>
          <p className="muted">
            This server requires a token.{' '}
            {meta.data?.readRequiresToken
              ? 'Reading needs the viewer or operator token.'
              : 'Reading is open; controls need the operator token.'}{' '}
            The token is stored in this browser only.
          </p>
          <div className="field">
            <label className="field-label" htmlFor={inputId}>
              Token
            </label>
            <input
              id={inputId}
              type="password"
              autoComplete="off"
              data-autofocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
          </div>
          <div className="dialog-actions">
            {token && (
              <button type="button" className="btn btn-ghost" onClick={() => apply(null)}>
                Forget token
              </button>
            )}
            <button type="submit" className="btn btn-primary" disabled={!draft.trim()}>
              Save token
            </button>
          </div>
        </form>
      </Modal>
    </>
  );
}
