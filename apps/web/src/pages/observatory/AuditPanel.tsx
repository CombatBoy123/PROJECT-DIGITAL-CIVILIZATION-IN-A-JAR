import { useMemo } from 'react';
import { useAudit } from '../../api/queries';
import { EmptyState, ErrorMessage, LoadingRegion } from '../../components/Feedback';
import { formatDateTime, formatInteger } from '../../lib/format';
import { useObservatory } from './context';

/*
 * Control-action audit log (who did what, when, at which tick), newest first.
 */

/** Compact JSON for the details column; long values are truncated with a full title. */
export function compactDetails(details: unknown, max = 120): { text: string; full: string } {
  if (details === null || details === undefined) return { text: '', full: '' };
  let full: string;
  try {
    full = typeof details === 'string' ? details : JSON.stringify(details);
  } catch {
    full = String(details);
  }
  return { text: full.length > max ? `${full.slice(0, max - 1)}…` : full, full };
}

export function AuditPanel() {
  const { civilizationId } = useObservatory();
  const audit = useAudit(civilizationId);
  const items = useMemo(() => audit.data?.pages.flatMap((p) => p.items) ?? [], [audit.data]);

  if (audit.isPending) return <LoadingRegion label="Loading audit log" />;
  if (audit.isError) return <ErrorMessage error={audit.error} />;
  if (items.length === 0) return <EmptyState title="No control actions recorded" />;

  return (
    <div className="stack gap-s">
      <div className="table-scroll">
        <table className="table" data-testid="audit-table">
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">Action</th>
              <th scope="col">Actor</th>
              <th scope="col" className="num">
                Tick
              </th>
              <th scope="col">Details</th>
            </tr>
          </thead>
          <tbody>
            {items.map((a) => {
              const d = compactDetails(a.details);
              return (
                <tr key={a.id} data-testid="audit-row">
                  <td className="nowrap">{formatDateTime(a.createdAt)}</td>
                  <td>
                    <code>{a.action}</code>
                  </td>
                  <td>{a.actor}</td>
                  <td className="num">{a.tick === null ? '—' : formatInteger(a.tick)}</td>
                  <td className="mono small" title={d.full}>
                    {d.text}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {audit.hasNextPage && (
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          disabled={audit.isFetchingNextPage}
          onClick={() => void audit.fetchNextPage()}
        >
          {audit.isFetchingNextPage ? 'Loading…' : 'Load older entries'}
        </button>
      )}
    </div>
  );
}
