import type { ApiRoutePath } from '@civ/shared';
import { useState } from 'react';
import { useResetWorld } from '../../api/queries';
import { TypedConfirmDialog } from '../../components/Modal';
import { useToast } from '../../components/Toasts';
import { downloadExport } from '../../lib/download';
import { useObservatory } from './context';

/*
 * Laboratory tab: the destructive "reset world" experiment control and data exports.
 * Exports are fetched with the auth header and saved as blobs.
 */

const EXPORTS: { path: ApiRoutePath; label: string; description: string; file: string }[] = [
  {
    path: '/api/civilizations/:id/export/config',
    label: 'Configuration (JSON)',
    description: 'Seed, engine version and every parameter needed to recreate genesis.',
    file: 'config.json',
  },
  {
    path: '/api/civilizations/:id/export/metrics.csv',
    label: 'Metrics (CSV)',
    description: 'Every raw metric sample, one row per sampled tick.',
    file: 'metrics.csv',
  },
  {
    path: '/api/civilizations/:id/export/events.ndjson',
    label: 'Events (NDJSON)',
    description: 'The full event log, one JSON event per line, ascending seq.',
    file: 'events.ndjson',
  },
];

function ExportButton({ entry }: { entry: (typeof EXPORTS)[number] }) {
  const { civilizationId, civilizationName } = useObservatory();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const download = async () => {
    setBusy(true);
    try {
      const name = await downloadExport(
        entry.path,
        { id: civilizationId },
        `${civilizationName}-${entry.file}`,
      );
      toast.success('Export downloaded', name);
    } catch (error) {
      toast.error(`${entry.label} export failed`, error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="export-item">
      <div>
        <strong>{entry.label}</strong>
        <div className="muted small">{entry.description}</div>
      </div>
      <button
        type="button"
        className="btn btn-sm"
        disabled={busy}
        data-testid={`export-${entry.file}`}
        onClick={() => void download()}
      >
        {busy ? 'Preparing…' : 'Download'}
      </button>
    </li>
  );
}

export function LabPanel() {
  const { civilizationId, civilizationName } = useObservatory();
  const reset = useResetWorld(civilizationId);
  const toast = useToast();
  const [open, setOpen] = useState(false);

  const close = () => {
    setOpen(false);
    reset.reset();
  };

  return (
    <div className="lab-grid">
      <section className="danger-zone" aria-labelledby="danger-title">
        <h3 id="danger-title" className="section-title">
          Destructive experiments
        </h3>
        <p className="small">
          Resetting regenerates the world from its seed and configuration (tick 0). All history
          after genesis — events, metrics and the current state — is erased. Snapshots taken after
          genesis become detached and can no longer be restored.
        </p>
        <button
          type="button"
          className="btn btn-danger"
          data-testid="reset-world"
          onClick={() => setOpen(true)}
        >
          Reset world…
        </button>
      </section>
      <section aria-labelledby="exports-title">
        <h3 id="exports-title" className="section-title">
          Exports
        </h3>
        <ul className="export-list">
          {EXPORTS.map((e) => (
            <ExportButton key={e.path} entry={e} />
          ))}
        </ul>
      </section>
      <TypedConfirmDialog
        open={open}
        title="Reset world"
        testId="reset-dialog"
        expected={civilizationName}
        confirmLabel="Erase history and reset"
        pending={reset.isPending}
        error={reset.error}
        onClose={close}
        description={
          <p>
            <strong>{civilizationName}</strong> will be regenerated from its seed. Every event,
            metric sample and state change after genesis is permanently erased. Snapshots taken
            after genesis are kept but detached: they can no longer be restored.
          </p>
        }
        onConfirm={(confirm) =>
          reset.mutate(confirm, {
            onSuccess: () => {
              toast.success('World reset', 'The civilization is back at genesis (tick 0).');
              close();
            },
          })
        }
      />
    </div>
  );
}
