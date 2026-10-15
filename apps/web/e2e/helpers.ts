import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';
import type { CivilizationDetail, Page as ApiPage, BuildingListItem } from '@civ/shared';
import type { SimulationConfigInput } from '@civ/sim-core';

/*
 * Shared helpers for the browser tests. Setup and teardown talk to the API server
 * directly; everything under test goes through the UI.
 */

export const API_URL = 'http://127.0.0.1:3101';

/** A civilization name unique to this test run (valid per CivilizationNameSchema). */
export function uniqueName(prefix: string): string {
  return `${prefix} ${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

export async function createCivilization(
  request: APIRequestContext,
  name: string,
  config: SimulationConfigInput = {},
  seed = 'e2e-seed',
): Promise<CivilizationDetail> {
  const res = await request.post(`${API_URL}/api/civilizations`, {
    data: { name, seed, config: { population: 20, ...config } },
  });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()) as CivilizationDetail;
}

/** Best-effort cleanup (the test itself may already have deleted it). */
export async function deleteCivilization(
  request: APIRequestContext,
  civ: { id: string; name: string } | null,
): Promise<void> {
  if (!civ) return;
  await request.delete(`${API_URL}/api/civilizations/${civ.id}`, { data: { confirm: civ.name } });
}

export async function stepViaApi(request: APIRequestContext, id: string, steps: number) {
  const res = await request.post(`${API_URL}/api/civilizations/${id}/control`, {
    data: { action: 'step', steps },
  });
  expect(res.ok(), await res.text()).toBe(true);
}

export async function firstBuilding(
  request: APIRequestContext,
  id: string,
  kind: 'house' | 'plaza' | 'park',
): Promise<BuildingListItem> {
  const res = await request.get(
    `${API_URL}/api/civilizations/${id}/buildings?kind=${kind}&limit=1`,
  );
  expect(res.ok()).toBe(true);
  const page = (await res.json()) as ApiPage<BuildingListItem>;
  const building = page.items[0];
  if (!building) throw new Error(`No ${kind} in this world`);
  return building;
}

/** The live tick shown in the observatory top bar. */
export function liveTick(page: Page): Locator {
  return page.getByTestId('live-tick');
}

export async function readTick(page: Page): Promise<number> {
  const value = await liveTick(page).getAttribute('data-tick');
  return Number(value);
}

export async function expectTick(page: Page, tick: number): Promise<void> {
  await expect(liveTick(page)).toHaveAttribute('data-tick', String(tick));
}

export async function openObservatory(page: Page, id: string): Promise<void> {
  await page.goto(`/civ/${id}`);
  await expect(page.getByTestId('observatory')).toBeVisible();
  // The stream's keyframe has arrived once the calendar is known.
  await expect(page.getByTestId('weather')).not.toHaveText('—');
}
