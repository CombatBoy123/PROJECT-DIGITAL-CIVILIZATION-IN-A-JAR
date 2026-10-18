-- CreateEnum
CREATE TYPE "CivilizationStatus" AS ENUM ('PAUSED', 'RUNNING', 'HALTED');

-- CreateEnum
CREATE TYPE "BuildingKind" AS ENUM ('HOUSE', 'PLAZA', 'PARK');

-- CreateEnum
CREATE TYPE "LifeStage" AS ENUM ('CHILD', 'ADULT', 'ELDER');

-- CreateEnum
CREATE TYPE "Education" AS ENUM ('NONE', 'PRIMARY', 'SECONDARY', 'TERTIARY');

-- CreateEnum
CREATE TYPE "Activity" AS ENUM ('SLEEPING', 'AT_HOME', 'LEISURE', 'TRAVELING');

-- CreateEnum
CREATE TYPE "Skill" AS ENUM ('FARMING', 'BAKING', 'CRAFTING', 'COMMERCE', 'MANAGEMENT');

-- CreateEnum
CREATE TYPE "EntityKind" AS ENUM ('CITIZEN', 'BUILDING', 'HOUSEHOLD');

-- CreateTable
CREATE TABLE "civilization" (
    "id" UUID NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "seed" VARCHAR(64) NOT NULL,
    "status" "CivilizationStatus" NOT NULL DEFAULT 'PAUSED',
    "speed" INTEGER NOT NULL DEFAULT 4,
    "current_tick" INTEGER NOT NULL DEFAULT 0,
    "engine_version" VARCHAR(32) NOT NULL,
    "halt_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "civilization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "simulation_config" (
    "civilization_id" UUID NOT NULL,
    "schema_version" INTEGER NOT NULL,
    "params" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "simulation_config_pkey" PRIMARY KEY ("civilization_id")
);

-- CreateTable
CREATE TABLE "world_checkpoint" (
    "civilization_id" UUID NOT NULL,
    "tick" INTEGER NOT NULL,
    "next_event_seq" BIGINT NOT NULL,
    "state_hash" VARCHAR(64) NOT NULL,
    "state_schema_version" INTEGER NOT NULL,
    "state" BYTEA NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "world_checkpoint_pkey" PRIMARY KEY ("civilization_id")
);

-- CreateTable
CREATE TABLE "snapshot" (
    "id" UUID NOT NULL,
    "civilization_id" UUID NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "note" VARCHAR(500),
    "tick" INTEGER NOT NULL,
    "next_event_seq" BIGINT NOT NULL,
    "state_hash" VARCHAR(64) NOT NULL,
    "state_schema_version" INTEGER NOT NULL,
    "state" BYTEA NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "detached_at" TIMESTAMPTZ(3),

    CONSTRAINT "snapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "building" (
    "civilization_id" UUID NOT NULL,
    "id" INTEGER NOT NULL,
    "kind" "BuildingKind" NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "x" INTEGER NOT NULL,
    "y" INTEGER NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "capacity" INTEGER NOT NULL,
    "as_of_tick" INTEGER NOT NULL,

    CONSTRAINT "building_pkey" PRIMARY KEY ("civilization_id","id")
);

-- CreateTable
CREATE TABLE "household" (
    "civilization_id" UUID NOT NULL,
    "id" INTEGER NOT NULL,
    "home_building_id" INTEGER NOT NULL,
    "as_of_tick" INTEGER NOT NULL,

    CONSTRAINT "household_pkey" PRIMARY KEY ("civilization_id","id")
);

-- CreateTable
CREATE TABLE "citizen" (
    "civilization_id" UUID NOT NULL,
    "id" INTEGER NOT NULL,
    "first_name" VARCHAR(40) NOT NULL,
    "last_name" VARCHAR(40) NOT NULL,
    "household_id" INTEGER NOT NULL,
    "birth_tick" INTEGER NOT NULL,
    "life_stage" "LifeStage" NOT NULL,
    "education" "Education" NOT NULL,
    "home_building_id" INTEGER NOT NULL,
    "openness" DOUBLE PRECISION NOT NULL,
    "conscientiousness" DOUBLE PRECISION NOT NULL,
    "extraversion" DOUBLE PRECISION NOT NULL,
    "agreeableness" DOUBLE PRECISION NOT NULL,
    "neuroticism" DOUBLE PRECISION NOT NULL,
    "balance_cents" BIGINT NOT NULL,
    "energy" DOUBLE PRECISION NOT NULL,
    "activity" "Activity" NOT NULL,
    "location_building_id" INTEGER,
    "destination_id" INTEGER,
    "as_of_tick" INTEGER NOT NULL,

    CONSTRAINT "citizen_pkey" PRIMARY KEY ("civilization_id","id")
);

-- CreateTable
CREATE TABLE "citizen_skill" (
    "civilization_id" UUID NOT NULL,
    "citizen_id" INTEGER NOT NULL,
    "skill" "Skill" NOT NULL,
    "level" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "citizen_skill_pkey" PRIMARY KEY ("civilization_id","citizen_id","skill")
);

-- CreateTable
CREATE TABLE "simulation_event" (
    "civilization_id" UUID NOT NULL,
    "seq" BIGINT NOT NULL,
    "tick" INTEGER NOT NULL,
    "type" VARCHAR(64) NOT NULL,
    "cause_seq" BIGINT,
    "payload" JSONB NOT NULL,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "simulation_event_pkey" PRIMARY KEY ("civilization_id","seq")
);

-- CreateTable
CREATE TABLE "event_entity" (
    "civilization_id" UUID NOT NULL,
    "event_seq" BIGINT NOT NULL,
    "entity_kind" "EntityKind" NOT NULL,
    "entity_id" INTEGER NOT NULL,
    "role" VARCHAR(32) NOT NULL,

    CONSTRAINT "event_entity_pkey" PRIMARY KEY ("civilization_id","event_seq","entity_kind","entity_id","role")
);

-- CreateTable
CREATE TABLE "metric_sample" (
    "civilization_id" UUID NOT NULL,
    "tick" INTEGER NOT NULL,
    "values" JSONB NOT NULL,

    CONSTRAINT "metric_sample_pkey" PRIMARY KEY ("civilization_id","tick")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" BIGSERIAL NOT NULL,
    "civilization_id" UUID,
    "action" VARCHAR(64) NOT NULL,
    "actor" VARCHAR(64) NOT NULL,
    "tick" INTEGER,
    "details" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "civilization_name_key" ON "civilization"("name");

-- CreateIndex
CREATE INDEX "civilization_created_at_idx" ON "civilization"("created_at");

-- CreateIndex
CREATE INDEX "snapshot_civilization_id_tick_idx" ON "snapshot"("civilization_id", "tick");

-- CreateIndex
CREATE UNIQUE INDEX "snapshot_civilization_id_name_key" ON "snapshot"("civilization_id", "name");

-- CreateIndex
CREATE INDEX "building_civilization_id_kind_idx" ON "building"("civilization_id", "kind");

-- CreateIndex
CREATE INDEX "household_civilization_id_home_building_id_idx" ON "household"("civilization_id", "home_building_id");

-- CreateIndex
CREATE INDEX "citizen_civilization_id_last_name_first_name_idx" ON "citizen"("civilization_id", "last_name", "first_name");

-- CreateIndex
CREATE INDEX "citizen_civilization_id_activity_idx" ON "citizen"("civilization_id", "activity");

-- CreateIndex
CREATE INDEX "citizen_civilization_id_life_stage_idx" ON "citizen"("civilization_id", "life_stage");

-- CreateIndex
CREATE INDEX "citizen_civilization_id_balance_cents_idx" ON "citizen"("civilization_id", "balance_cents");

-- CreateIndex
CREATE INDEX "citizen_civilization_id_home_building_id_idx" ON "citizen"("civilization_id", "home_building_id");

-- CreateIndex
CREATE INDEX "citizen_civilization_id_household_id_idx" ON "citizen"("civilization_id", "household_id");

-- CreateIndex
CREATE INDEX "citizen_skill_civilization_id_skill_level_idx" ON "citizen_skill"("civilization_id", "skill", "level");

-- CreateIndex
CREATE INDEX "simulation_event_civilization_id_tick_idx" ON "simulation_event"("civilization_id", "tick");

-- CreateIndex
CREATE INDEX "simulation_event_civilization_id_type_seq_idx" ON "simulation_event"("civilization_id", "type", "seq");

-- CreateIndex
CREATE INDEX "event_entity_civilization_id_entity_kind_entity_id_event_se_idx" ON "event_entity"("civilization_id", "entity_kind", "entity_id", "event_seq");

-- CreateIndex
CREATE INDEX "audit_log_civilization_id_created_at_idx" ON "audit_log"("civilization_id", "created_at");

-- AddForeignKey
ALTER TABLE "simulation_config" ADD CONSTRAINT "simulation_config_civilization_id_fkey" FOREIGN KEY ("civilization_id") REFERENCES "civilization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "world_checkpoint" ADD CONSTRAINT "world_checkpoint_civilization_id_fkey" FOREIGN KEY ("civilization_id") REFERENCES "civilization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "snapshot" ADD CONSTRAINT "snapshot_civilization_id_fkey" FOREIGN KEY ("civilization_id") REFERENCES "civilization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "building" ADD CONSTRAINT "building_civilization_id_fkey" FOREIGN KEY ("civilization_id") REFERENCES "civilization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "household" ADD CONSTRAINT "household_civilization_id_fkey" FOREIGN KEY ("civilization_id") REFERENCES "civilization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "household" ADD CONSTRAINT "household_civilization_id_home_building_id_fkey" FOREIGN KEY ("civilization_id", "home_building_id") REFERENCES "building"("civilization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "citizen" ADD CONSTRAINT "citizen_civilization_id_fkey" FOREIGN KEY ("civilization_id") REFERENCES "civilization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "citizen" ADD CONSTRAINT "citizen_civilization_id_household_id_fkey" FOREIGN KEY ("civilization_id", "household_id") REFERENCES "household"("civilization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "citizen" ADD CONSTRAINT "citizen_civilization_id_home_building_id_fkey" FOREIGN KEY ("civilization_id", "home_building_id") REFERENCES "building"("civilization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "citizen" ADD CONSTRAINT "citizen_civilization_id_location_building_id_fkey" FOREIGN KEY ("civilization_id", "location_building_id") REFERENCES "building"("civilization_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "citizen_skill" ADD CONSTRAINT "citizen_skill_civilization_id_citizen_id_fkey" FOREIGN KEY ("civilization_id", "citizen_id") REFERENCES "citizen"("civilization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "simulation_event" ADD CONSTRAINT "simulation_event_civilization_id_fkey" FOREIGN KEY ("civilization_id") REFERENCES "civilization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_entity" ADD CONSTRAINT "event_entity_civilization_id_event_seq_fkey" FOREIGN KEY ("civilization_id", "event_seq") REFERENCES "simulation_event"("civilization_id", "seq") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "metric_sample" ADD CONSTRAINT "metric_sample_civilization_id_fkey" FOREIGN KEY ("civilization_id") REFERENCES "civilization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_civilization_id_fkey" FOREIGN KEY ("civilization_id") REFERENCES "civilization"("id") ON DELETE SET NULL ON UPDATE CASCADE;
