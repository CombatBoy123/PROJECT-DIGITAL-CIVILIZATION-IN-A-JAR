import { CivilizationNameSchema, type SnapshotDto } from '@civ/shared';
import { useId, useState, type FormEvent } from 'react';
import { useCreateSnapshot, useRestoreSnapshot, useSnapshots } from '../../api/queries';
import { useAccess } from '../../api/useAccess';
import { AccessNote, EmptyState, ErrorMessage, LoadingRegion } from '../../components/Feedback';
import { TypedConfirmDialog } from '../../components/Modal';
import { useToast } from '../../components/Toasts';
import { formatBytes, formatDateTime, formatInteger, shortHash } from '../../lib/format';
import { useObservatory } from './context';

/*
 * Named snapshots: save the current state, list saved states and rewind to one
 * (confirmed by typing the civilization's name; the server checks it again).
 * Detached snapshots belong to a discarded timeline and cannot be restored. Saving
 * and restoring need operator rights (see useAccess); without them both are disabled
 * and the reason is shown once above the list.
 */

function SaveSnapshotForm({ readOnlyNoteId }: { readOnlyNoteId: string | null }) {
  const { civilizationId } = useObservatory();
  const create = useCreateSnapshot(civilizationId);
  const toast = useToast();
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const nameId = useId();
  const noteId = useId();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    // Each submission reports one outcome: forget the previous attempt's server error.
    create.reset();
    const parsed = CivilizationNameSchema.safeParse(name);
    if (!parsed.success) {
      setNameError(parsed.error.issues[0]?.message ?? 'Invalid name');
      return;
    }
    setNameError(null);
    create.mutate(
      { name: parsed.data, ...(note.trim() ? { note: note.trim() } : {}) },
      {
        onSuccess: (snap) => {
          toast.success('Snapshot saved', `"${snap.name}" at tick ${formatInteger(snap.tick)}.`);
          setName('');
          setNote('');
        },
      },
    );
  };

  return (
    <form className="snapshot-form" onSubmit={submit} noValidate>
      <div className="field">
        <label htmlFor={nameId} className="field-label">
          Snapshot name
        </label>
        <input
          id={nameId}
          value={name}
          maxLength={80}
          autoComplete="off"
          aria-invalid={nameError ? true : undefined}
          aria-describedby={nameError ? `${nameId}-error` : undefined}
          data-testid="snapshot-name"
          onChange={(e) => setName(e.target.value)}
        />
        {nameError && (
          <span id={`${nameId}-error`} className="field-error">
            {nameError}
          </span>
        )}
      </div>
      <div className="field grow">
        <label htmlFor={noteId} className="field-label">
          Note <span className="muted">(optional)</span>
        </label>
        <input
          id={noteId}
          value={note}
          maxLength={500}
          autoComplete="off"
          data-testid="snapshot-note"
          onChange={(e) => setNote(e.target.value)}
        />
      </div>
      <button
        type="submit"
        className="btn btn-primary"
        disabled={create.isPending || !name.trim() || readOnlyNoteId !== null}
        aria-describedby={readOnlyNoteId ?? undefined}
        data-testid="snapshot-save"
      >
        {create.isPending ? 'Saving…' : 'Save snapshot'}
      </button>
      {create.isError && (
        <div className="full-row">
          <ErrorMessage error={create.error} title="Snapshot not saved" />
        </div>
      )}
    </form>
  );
}

export function SnapshotsPanel() {
  const { civilizationId, civilizationName } = useObservatory();
  const list = useSnapshots(civilizationId);
  const restore = useRestoreSnapshot(civilizationId);
  const access = useAccess();
  const toast = useToast();
  const noteId = useId();
  const readOnlyNoteId = access.canOperate ? null : noteId;
  const [target, setTarget] = useState<SnapshotDto | null>(null);

  const close = () => {
    setTarget(null);
    restore.reset();
  };

  return (
    <div className="stack gap-m">
      {!access.canOperate && access.reason && <AccessNote id={noteId} reason={access.reason} />}
      <SaveSnapshotForm readOnlyNoteId={readOnlyNoteId} />
      {list.isPending && <LoadingRegion label="Loading snapshots" />}
      {list.isError && <ErrorMessage error={list.error} />}
      {list.data && list.data.items.length === 0 && (
        <EmptyState title="No snapshots">Save one to be able to rewind to this moment.</EmptyState>
      )}
      {list.data && list.data.items.length > 0 && (
        <div className="table-scroll">
          <table className="table" data-testid="snapshot-table">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col" className="num">
                  Tick
                </th>
                <th scope="col">State hash</th>
                <th scope="col" className="num">
                  Size
                </th>
                <th scope="col">Saved</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {list.data.items.map((s) => (
                <tr key={s.id} data-testid="snapshot-row" data-name={s.name}>
                  <th scope="row">
                    <div>{s.name}</div>
                    {s.note && <div className="muted small">{s.note}</div>}
                  </th>
                  <td className="num">{formatInteger(s.tick)}</td>
                  <td className="mono" title={s.stateHash}>
                    {shortHash(s.stateHash)}
                  </td>
                  <td className="num">{formatBytes(s.sizeBytes)}</td>
                  <td className="nowrap">{formatDateTime(s.createdAt)}</td>
                  <td className="actions">
                    {s.detachedAt ? (
                      <span
                        className="badge"
                        title={`Detached ${formatDateTime(s.detachedAt)}: it belongs to an abandoned timeline (the civilization was rewound to an earlier tick) and cannot be restored.`}
                      >
                        Detached
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={readOnlyNoteId !== null}
                        aria-describedby={readOnlyNoteId ?? undefined}
                        data-testid="snapshot-restore"
                        onClick={() => setTarget(s)}
                      >
                        Restore…
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <TypedConfirmDialog
        open={target !== null}
        title="Restore snapshot"
        testId="restore-dialog"
        expected={civilizationName}
        confirmLabel="Restore snapshot"
        pending={restore.isPending}
        error={restore.error}
        onClose={close}
        description={
          target && (
            <p>
              Rewind <strong>{civilizationName}</strong> to snapshot <strong>{target.name}</strong>{' '}
              (tick {formatInteger(target.tick)}). The simulation pauses, and its current state and
              the history recorded after tick {formatInteger(target.tick)} are erased. Snapshots
              taken after that tick become detached.
            </p>
          )
        }
        onConfirm={(confirm) => {
          if (!target) return;
          const snap = target;
          restore.mutate(
            { snapshotId: snap.id, confirm },
            {
              onSuccess: () => {
                toast.success('Snapshot restored', `Back at tick ${formatInteger(snap.tick)}.`);
                close();
              },
            },
          );
        }}
      />
    </div>
  );
}
