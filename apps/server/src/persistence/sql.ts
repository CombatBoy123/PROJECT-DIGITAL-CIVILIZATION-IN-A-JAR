import { Prisma } from '@prisma/client';

/** Prisma transaction client (interactive transactions). */
export type Tx = Prisma.TransactionClient;

export interface Column {
  name: string;
  /** PostgreSQL cast applied to the parameter, e.g. '"Activity"' or 'uuid'. Static strings only. */
  cast?: string;
}

export interface TableSpec {
  table: string;
  columns: readonly Column[];
  /** Conflict target (primary key columns). */
  key: readonly string[];
}

/** Stay well below PostgreSQL's 65,535 bind-parameter limit. */
const MAX_PARAMS_PER_STATEMENT = 30_000;

const quote = (identifier: string): string => `"${identifier.replace(/"/g, '""')}"`;

/**
 * Batched `INSERT … ON CONFLICT (key) DO UPDATE` with bound parameters. Table and
 * column names come from static TableSpecs in code, never from user input.
 */
export async function upsertRows(
  tx: Tx,
  spec: TableSpec,
  rows: readonly unknown[][],
): Promise<void> {
  if (rows.length === 0) return;
  const width = spec.columns.length;
  const chunkSize = Math.max(1, Math.floor(MAX_PARAMS_PER_STATEMENT / width));
  const columnList = Prisma.raw(spec.columns.map((c) => quote(c.name)).join(', '));
  const conflict = Prisma.raw(spec.key.map(quote).join(', '));
  const updatable = spec.columns.filter((c) => !spec.key.includes(c.name));
  const onConflict =
    updatable.length === 0
      ? Prisma.raw('DO NOTHING')
      : Prisma.raw(
          `DO UPDATE SET ${updatable.map((c) => `${quote(c.name)} = EXCLUDED.${quote(c.name)}`).join(', ')}`,
        );

  for (let start = 0; start < rows.length; start += chunkSize) {
    const chunk = rows.slice(start, start + chunkSize);
    const values = Prisma.join(
      chunk.map((row) => {
        if (row.length !== width)
          throw new Error(
            `upsertRows(${spec.table}): row has ${row.length} values, expected ${width}`,
          );
        return Prisma.sql`(${Prisma.join(
          row.map((value, i) => {
            const cast = spec.columns[i]?.cast;
            return cast ? Prisma.sql`${value}::${Prisma.raw(cast)}` : Prisma.sql`${value}`;
          }),
        )})`;
      }),
    );
    await tx.$executeRaw`INSERT INTO ${Prisma.raw(quote(spec.table))} (${columnList}) VALUES ${values} ON CONFLICT (${conflict}) ${onConflict}`;
  }
}
