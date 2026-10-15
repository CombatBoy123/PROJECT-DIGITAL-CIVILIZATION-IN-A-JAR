-- Integrity constraints that Prisma's schema language cannot express.
-- They mirror engine invariants so that corrupt data is rejected by the database as well.
ALTER TABLE "civilization"
  ADD CONSTRAINT "civilization_current_tick_nonnegative" CHECK ("current_tick" >= 0),
  ADD CONSTRAINT "civilization_speed_range" CHECK ("speed" BETWEEN 0 AND 1000);

ALTER TABLE "world_checkpoint"
  ADD CONSTRAINT "world_checkpoint_tick_nonnegative" CHECK ("tick" >= 0),
  ADD CONSTRAINT "world_checkpoint_next_event_seq_positive" CHECK ("next_event_seq" >= 1);

ALTER TABLE "snapshot"
  ADD CONSTRAINT "snapshot_tick_nonnegative" CHECK ("tick" >= 0),
  ADD CONSTRAINT "snapshot_next_event_seq_positive" CHECK ("next_event_seq" >= 1);

ALTER TABLE "building"
  ADD CONSTRAINT "building_geometry_valid" CHECK ("x" >= 0 AND "y" >= 0 AND "width" > 0 AND "height" > 0),
  ADD CONSTRAINT "building_capacity_positive" CHECK ("capacity" > 0);

ALTER TABLE "citizen"
  ADD CONSTRAINT "citizen_balance_nonnegative" CHECK ("balance_cents" >= 0),
  ADD CONSTRAINT "citizen_energy_range" CHECK ("energy" BETWEEN 0 AND 100),
  ADD CONSTRAINT "citizen_traits_range" CHECK (
    "openness" BETWEEN 0 AND 1 AND "conscientiousness" BETWEEN 0 AND 1 AND
    "extraversion" BETWEEN 0 AND 1 AND "agreeableness" BETWEEN 0 AND 1 AND "neuroticism" BETWEEN 0 AND 1
  ),
  -- A citizen is either inside a building or travelling, never both or neither.
  ADD CONSTRAINT "citizen_location_xor_travel" CHECK (("location_building_id" IS NULL) = ("activity" = 'TRAVELING')),
  ADD CONSTRAINT "citizen_destination_iff_travel" CHECK (("destination_id" IS NOT NULL) = ("activity" = 'TRAVELING'));

ALTER TABLE "citizen_skill"
  ADD CONSTRAINT "citizen_skill_level_range" CHECK ("level" BETWEEN 0 AND 100);

ALTER TABLE "simulation_event"
  ADD CONSTRAINT "simulation_event_seq_positive" CHECK ("seq" >= 1),
  ADD CONSTRAINT "simulation_event_tick_nonnegative" CHECK ("tick" >= 0),
  -- Causes precede their effects.
  ADD CONSTRAINT "simulation_event_cause_precedes" CHECK ("cause_seq" IS NULL OR "cause_seq" < "seq");

ALTER TABLE "metric_sample"
  ADD CONSTRAINT "metric_sample_tick_nonnegative" CHECK ("tick" >= 0);
