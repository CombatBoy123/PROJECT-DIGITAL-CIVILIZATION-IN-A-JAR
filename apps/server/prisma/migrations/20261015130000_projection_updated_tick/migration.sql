-- The projection rows record the checkpoint tick at which each row was last rewritten
-- (only changed rows are rewritten), which is not the tick the projection as a whole
-- represents. Rename the column to match schema.prisma and its meaning.
ALTER TABLE "building" RENAME COLUMN "as_of_tick" TO "updated_tick";
ALTER TABLE "household" RENAME COLUMN "as_of_tick" TO "updated_tick";
ALTER TABLE "citizen" RENAME COLUMN "as_of_tick" TO "updated_tick";
