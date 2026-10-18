import type { ReactNode } from 'react';
import type { Selection } from '../../world/types';
import { useObservatory } from './context';

/*
 * In-page link to another entity: selects it in the inspector and focuses the map.
 * Rendered as a button because it changes page state rather than navigating away.
 */

export function EntityLink({
  selection,
  children,
  testId,
}: {
  selection: Selection;
  children: ReactNode;
  testId?: string;
}) {
  const { select } = useObservatory();
  return (
    <button
      type="button"
      className="link-btn"
      data-testid={testId}
      data-entity={`${selection.kind}:${selection.id}`}
      onClick={() => select(selection, { focus: true })}
    >
      {children}
    </button>
  );
}
