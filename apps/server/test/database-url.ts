/** The integration-test database. Its tables are truncated by the tests. */
export const DEFAULT_TEST_DATABASE_URL = 'postgresql://civ:civ@localhost:5432/civ_test';

export function testDatabaseUrl(): string {
  return process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL;
}
