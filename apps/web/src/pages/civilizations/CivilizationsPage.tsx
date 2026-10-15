import type { CivilizationSummary } from '@civ/shared';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useCivilizations, useDeleteCivilization } from '../../api/queries';
import { EmptyState, ErrorMessage, LoadingRegion, StatusPill } from '../../components/Feedback';
import { TypedConfirmDialog } from '../../components/Modal';
import { useToast } from '../../components/Toasts';
import { formatDateTime, formatInteger, formatTickCalendar } from '../../lib/format';
import { CreateCivilizationForm } from './CreateCivilizationForm';

/*
 * Home page: every civilization (experiment run) on this server, plus the genesis form.
 */

function CivilizationTable({
  items,
  onDelete,
}: {
  items: CivilizationSummary[];
  onDelete: (civ: CivilizationSummary) => void;
}) {
  return (
    <div className="table-scroll">
      <table className="table" data-testid="civilization-table">
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Seed</th>
            <th scope="col">Status</th>
            <th scope="col">Time</th>
            <th scope="col" className="num">
              Population
            </th>
            <th scope="col">Created</th>
            <th scope="col">
              <span className="visually-hidden">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((c) => (
            <tr key={c.id} data-testid="civilization-row" data-name={c.name}>
              <th scope="row">
                <Link to={`/civ/${c.id}`} className="strong-link">
                  {c.name}
                </Link>
              </th>
              <td className="mono" title={c.seed}>
                {c.seed}
              </td>
              <td>
                <StatusPill status={c.status} haltReason={c.haltReason} />
              </td>
              <td className="num nowrap">{formatTickCalendar(c.tick, c.calendar)}</td>
              <td className="num">{formatInteger(c.population)}</td>
              <td className="nowrap">{formatDateTime(c.createdAt)}</td>
              <td className="actions">
                <Link to={`/civ/${c.id}`} className="btn btn-sm">
                  Open
                </Link>
                <button
                  type="button"
                  className="btn btn-sm btn-danger-ghost"
                  aria-label={`Delete ${c.name}`}
                  data-testid="delete-civilization"
                  onClick={() => onDelete(c)}
                >
                  Delete
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function CivilizationsPage() {
  const list = useCivilizations();
  const remove = useDeleteCivilization();
  const toast = useToast();
  const [target, setTarget] = useState<CivilizationSummary | null>(null);

  const close = () => {
    setTarget(null);
    remove.reset();
  };

  return (
    <div className="page civ-page">
      <section className="panel" aria-labelledby="civs-title">
        <div className="panel-header">
          <h1 id="civs-title" className="panel-title">
            Civilizations
          </h1>
          {list.data && (
            <span className="muted small">{formatInteger(list.data.items.length)} total</span>
          )}
        </div>
        <div className="panel-body">
          {list.isPending && <LoadingRegion label="Loading civilizations" lines={4} />}
          {list.isError && <ErrorMessage error={list.error} title="Could not load civilizations" />}
          {list.data && list.data.items.length === 0 && (
            <EmptyState title="No civilizations yet">
              Create one with the form; its world is generated deterministically from the seed.
            </EmptyState>
          )}
          {list.data && list.data.items.length > 0 && (
            <CivilizationTable items={list.data.items} onDelete={setTarget} />
          )}
        </div>
      </section>
      <CreateCivilizationForm />
      <TypedConfirmDialog
        open={target !== null}
        title="Delete civilization"
        testId="delete-dialog"
        expected={target?.name ?? ''}
        confirmLabel="Delete permanently"
        pending={remove.isPending}
        error={remove.error}
        onClose={close}
        description={
          <p>
            This permanently deletes <strong>{target?.name}</strong> with its state, snapshots,
            event log, metrics and audit trail. It cannot be undone.
          </p>
        }
        onConfirm={(confirm) => {
          if (!target) return;
          const name = target.name;
          remove.mutate(
            { id: target.id, confirm },
            {
              onSuccess: () => {
                toast.success('Civilization deleted', `"${name}" was removed.`);
                close();
              },
            },
          );
        }}
      />
    </div>
  );
}
