import { ConfirmRequestSchema } from '@civ/shared';
import { AppError, parseInput } from '../http/errors.js';

/**
 * Destructive actions must repeat the civilization's exact name in `{ confirm }`.
 * A missing confirmation or a different name is CONFIRMATION_REQUIRED; a body of
 * the wrong shape (unknown fields, non-string) is a VALIDATION_ERROR.
 */
export function requireConfirmation(body: unknown, civilizationName: string): void {
  const hasConfirm = typeof body === 'object' && body !== null && Object.hasOwn(body, 'confirm');
  if (!hasConfirm) {
    throw new AppError(
      'CONFIRMATION_REQUIRED',
      'This action is destructive: send { "confirm": "<exact civilization name>" }',
    );
  }
  const { confirm } = parseInput(ConfirmRequestSchema, body, 'request body');
  if (confirm !== civilizationName) {
    throw new AppError(
      'CONFIRMATION_REQUIRED',
      'The confirmation does not match the civilization name exactly',
    );
  }
}
