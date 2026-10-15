import type { CivilizationStatus as ApiStatus } from '@civ/shared';
import type { CivilizationStatus as DbStatus, EntityKind as DbEntityKind } from '@prisma/client';
import type { EntityKind } from '@civ/sim-core';

/*
 * The engine uses lower_snake_case enum values; the database uses PostgreSQL enums
 * in UPPER_SNAKE_CASE. These helpers convert between them in one place.
 */

export function toDbEnum<T extends string>(value: string): T {
  return value.toUpperCase() as T;
}

export function fromDbEnum<T extends string>(value: string): T {
  return value.toLowerCase() as T;
}

export function statusToDb(status: ApiStatus): DbStatus {
  return toDbEnum<DbStatus>(status);
}

export function statusFromDb(status: DbStatus): ApiStatus {
  return fromDbEnum<ApiStatus>(status);
}

export function entityKindToDb(kind: EntityKind): DbEntityKind {
  return toDbEnum<DbEntityKind>(kind);
}

/** BigInt columns that hold values within Number.MAX_SAFE_INTEGER. */
export function toNumber(value: bigint | number): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n))
    throw new RangeError(`Value ${value} exceeds the safe integer range`);
  return n;
}
