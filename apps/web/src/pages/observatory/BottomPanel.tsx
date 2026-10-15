import type { CivilizationStatus } from '@civ/shared';
import { useState } from 'react';
import type { LiveEventMessage } from '../../api/useCivilizationStream';
import { ErrorBoundary } from '../../components/ErrorBoundary';
import { Tabs, tabPanelProps } from '../../components/Tabs';
import { AuditPanel } from './AuditPanel';
import { EventFeed } from './EventFeed';
import { LabPanel } from './LabPanel';
import { PlaybackControls } from './PlaybackControls';
import { SnapshotsPanel } from './SnapshotsPanel';

/*
 * Bottom panel: playback controls (always visible) and tabs for the event feed,
 * snapshots, the lab (destructive actions, exports) and the audit log.
 */

type BottomTab = 'events' | 'snapshots' | 'lab' | 'audit';
const TABS = [
  { id: 'events', label: 'Events' },
  { id: 'snapshots', label: 'Snapshots' },
  { id: 'lab', label: 'Lab' },
  { id: 'audit', label: 'Audit' },
] as const;

export function BottomPanel({
  civilizationId,
  status,
  speed,
  subscribeLive,
}: {
  civilizationId: string;
  status: CivilizationStatus | null;
  speed: number | null;
  subscribeLive: (listener: (message: LiveEventMessage) => void) => () => void;
}) {
  const [tab, setTab] = useState<BottomTab>('events');
  return (
    <section className="obs-bottom" aria-label="Controls and history">
      <PlaybackControls civilizationId={civilizationId} status={status} speed={speed} />
      <Tabs tabs={TABS} active={tab} onChange={setTab} prefix="bottom" label="History and tools" />
      {TABS.map((t) => (
        <div
          key={t.id}
          {...tabPanelProps('bottom', t.id)}
          className="tab-panel obs-bottom-panel"
          hidden={tab !== t.id}
        >
          <ErrorBoundary area={t.label}>
            {/* The feed stays mounted so live events keep accumulating on other tabs. */}
            {t.id === 'events' && <EventFeed subscribeLive={subscribeLive} />}
            {t.id === 'snapshots' && tab === t.id && <SnapshotsPanel />}
            {t.id === 'lab' && tab === t.id && <LabPanel />}
            {t.id === 'audit' && tab === t.id && <AuditPanel />}
          </ErrorBoundary>
        </div>
      ))}
    </section>
  );
}
