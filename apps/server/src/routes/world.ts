import { buildFrame, buildLayout } from '@civ/sim-core';
import {
  BuildingListQuerySchema,
  CitizenListQuerySchema,
  CivilizationParamsSchema,
  type BuildingDetail,
  type BuildingListItem,
  type CitizenDetail,
  type CitizenListItem,
  type FrameResponse,
  type LayoutResponse,
  type Page,
} from '@civ/shared';
import type { FastifyInstance } from 'fastify';
import { parseInput } from '../http/errors.js';
import {
  getBuilding,
  getCitizen,
  listBuildings,
  listCitizens,
} from '../persistence/world-queries.js';
import { BuildingParamsSchema, CitizenParamsSchema, type AppContext } from './context.js';

/**
 * The current world. Layout and frame come from the loaded in-memory simulation
 * (labelled with the in-memory tick); lists and inspectors come from the
 * projection tables (labelled with the durable tick they represent).
 */
export function registerWorldRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { prisma, runners } = ctx;

  app.get('/api/civilizations/:id/layout', async (request): Promise<LayoutResponse> => {
    const { id } = parseInput(CivilizationParamsSchema, request.params, 'path');
    const { sim } = await runners.get(id);
    return { ...buildLayout(sim.state), asOfTick: sim.tick };
  });

  app.get('/api/civilizations/:id/frame', async (request): Promise<FrameResponse> => {
    const { id } = parseInput(CivilizationParamsSchema, request.params, 'path');
    const { sim } = await runners.get(id);
    const frame = buildFrame(sim.state);
    return {
      tick: frame.tick,
      calendar: frame.calendar,
      weather: frame.weather,
      temperatureC: frame.temperatureC,
      citizens: frame.citizens,
    };
  });

  app.get('/api/civilizations/:id/citizens', async (request): Promise<Page<CitizenListItem>> => {
    const { id } = parseInput(CivilizationParamsSchema, request.params, 'path');
    const query = parseInput(CitizenListQuerySchema, request.query, 'query');
    return listCitizens(prisma, id, query);
  });

  app.get('/api/civilizations/:id/citizens/:citizenId', async (request): Promise<CitizenDetail> => {
    const { id, citizenId } = parseInput(CitizenParamsSchema, request.params, 'path');
    return getCitizen(prisma, id, citizenId);
  });

  app.get('/api/civilizations/:id/buildings', async (request): Promise<Page<BuildingListItem>> => {
    const { id } = parseInput(CivilizationParamsSchema, request.params, 'path');
    const query = parseInput(BuildingListQuerySchema, request.query, 'query');
    return listBuildings(prisma, id, query);
  });

  app.get(
    '/api/civilizations/:id/buildings/:buildingId',
    async (request): Promise<BuildingDetail> => {
      const { id, buildingId } = parseInput(BuildingParamsSchema, request.params, 'path');
      return getBuilding(prisma, id, buildingId);
    },
  );
}
