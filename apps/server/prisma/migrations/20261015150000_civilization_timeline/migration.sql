-- Timeline generation of a civilization: incremented by every rewind (snapshot restore
-- or reset) in the rewind's transaction. Streaming exports read history in pages and
-- compare it between pages, so a rewind during an export aborts the export instead of
-- silently truncating it or splicing two timelines into one file.
ALTER TABLE "civilization" ADD COLUMN "timeline" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "civilization"
  ADD CONSTRAINT "civilization_timeline_nonnegative" CHECK ("timeline" >= 0);
