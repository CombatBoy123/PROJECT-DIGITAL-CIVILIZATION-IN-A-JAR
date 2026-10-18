/*
 * Global keyboard shortcuts must not fire while the user is typing, while a modal
 * dialog is open, or when the focused element already gives the key a meaning
 * (Space activates buttons, links, tabs and checkboxes, and scrolls a focused
 * scrollable container such as a tab panel).
 */

interface TargetLike {
  tagName?: string;
  isContentEditable?: boolean;
  getAttribute?: (name: string) => string | null;
  closest?: (selector: string) => unknown;
  scrollHeight?: number;
  clientHeight?: number;
}

const EDITABLE_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);
const ACTIVATABLE_TAGS = new Set(['BUTTON', 'A', 'SUMMARY']);
const ACTIVATABLE_ROLES = new Set(['button', 'tab', 'link', 'checkbox', 'option', 'menuitem']);
/** Focusable reading containers: Space pages through their content. */
const SCROLL_CONTAINER_ROLES = new Set(['tabpanel', 'region', 'document', 'log', 'feed']);

function asTarget(target: unknown): TargetLike | null {
  return target && typeof target === 'object' ? (target as TargetLike) : null;
}

/** True when the target accepts text input (or is inside an open modal dialog). */
export function isTypingTarget(target: unknown): boolean {
  const t = asTarget(target);
  if (!t) return false;
  if (t.isContentEditable) return true;
  const tag = t.tagName?.toUpperCase();
  if (tag && EDITABLE_TAGS.has(tag)) return true;
  return Boolean(t.closest?.('dialog[open]'));
}

/** True when Space on this target already activates it natively. */
export function isActivatableTarget(target: unknown): boolean {
  const t = asTarget(target);
  if (!t) return false;
  const tag = t.tagName?.toUpperCase();
  if (tag && ACTIVATABLE_TAGS.has(tag)) return true;
  const role = t.getAttribute?.('role');
  return Boolean(role && ACTIVATABLE_ROLES.has(role));
}

/**
 * True when Space on this target scrolls it natively: a focused reading container
 * (tab panel, region, …) or any element whose content overflows vertically.
 */
export function isScrollContainerTarget(target: unknown): boolean {
  const t = asTarget(target);
  if (!t) return false;
  const tag = t.tagName?.toUpperCase();
  // The document itself is the default target when nothing is focused.
  if (tag === 'BODY' || tag === 'HTML') return false;
  const role = t.getAttribute?.('role');
  if (role && SCROLL_CONTAINER_ROLES.has(role)) return true;
  return (
    typeof t.scrollHeight === 'number' &&
    typeof t.clientHeight === 'number' &&
    t.clientHeight > 0 &&
    t.scrollHeight > t.clientHeight
  );
}

export type ShortcutAction = 'togglePlay' | 'step';

/** Map a key event to an observatory shortcut, or null. */
export function shortcutFor(event: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  target: unknown;
  defaultPrevented?: boolean;
  repeat?: boolean;
}): ShortcutAction | null {
  if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return null;
  if (isTypingTarget(event.target)) return null;
  if (event.key === ' ' || event.key === 'Spacebar') {
    if (event.repeat || isActivatableTarget(event.target) || isScrollContainerTarget(event.target))
      return null;
    return 'togglePlay';
  }
  if (event.key === '.') return 'step';
  return null;
}
