/*
 * Global keyboard shortcuts must not fire while the user is typing, while a modal
 * dialog is open, or when the focused control already gives the key a meaning
 * (Space activates buttons, links, tabs and checkboxes).
 */

interface TargetLike {
  tagName?: string;
  isContentEditable?: boolean;
  getAttribute?: (name: string) => string | null;
  closest?: (selector: string) => unknown;
}

const EDITABLE_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);
const ACTIVATABLE_TAGS = new Set(['BUTTON', 'A', 'SUMMARY']);
const ACTIVATABLE_ROLES = new Set(['button', 'tab', 'link', 'checkbox', 'option', 'menuitem']);

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
    if (event.repeat || isActivatableTarget(event.target)) return null;
    return 'togglePlay';
  }
  if (event.key === '.') return 'step';
  return null;
}
