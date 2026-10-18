import { useRef, type KeyboardEvent } from 'react';

/*
 * Accessible tab list (WAI-ARIA tabs pattern): roving tabindex, arrow/Home/End keys.
 * Panels are rendered by the caller with `tabPanelProps`.
 */

export interface TabDef<T extends string> {
  id: T;
  label: string;
}

export function tabIds(prefix: string, id: string) {
  return { tab: `${prefix}-tab-${id}`, panel: `${prefix}-panel-${id}` };
}

export function tabPanelProps(prefix: string, id: string) {
  const ids = tabIds(prefix, id);
  return { id: ids.panel, role: 'tabpanel' as const, 'aria-labelledby': ids.tab, tabIndex: 0 };
}

export function Tabs<T extends string>({
  tabs,
  active,
  onChange,
  prefix,
  label,
}: {
  tabs: readonly TabDef<T>[];
  active: T;
  onChange: (id: T) => void;
  prefix: string;
  label: string;
}) {
  const refs = useRef(new Map<string, HTMLButtonElement>());

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const index = tabs.findIndex((t) => t.id === active);
    let next = index;
    if (e.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    else return;
    e.preventDefault();
    const tab = tabs[next];
    if (!tab) return;
    onChange(tab.id);
    refs.current.get(tab.id)?.focus();
  };

  return (
    <div className="tabs" role="tablist" aria-label={label} onKeyDown={onKeyDown}>
      {tabs.map((t) => {
        const ids = tabIds(prefix, t.id);
        const selected = t.id === active;
        return (
          <button
            key={t.id}
            ref={(el) => {
              if (el) refs.current.set(t.id, el);
              else refs.current.delete(t.id);
            }}
            type="button"
            role="tab"
            id={ids.tab}
            aria-selected={selected}
            aria-controls={ids.panel}
            tabIndex={selected ? 0 : -1}
            className="tab"
            data-testid={`tab-${t.id}`}
            onClick={() => onChange(t.id)}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}
