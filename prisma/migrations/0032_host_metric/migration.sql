-- v1.4.16 phase B3: per-minute host-load snapshot table.
--
-- The admin /system-status section now renders a 2-hour host-load chart
-- above the existing facts grid (Marc: "über dem Systemstatus vielleicht
-- nochmal so ein Graf der Auslastung des Hosts der letzten zwei Stunden").
--
-- A pg-boss `host-metric-sample` job inserts one row per minute carrying
-- `os.loadavg()` (1/5/15-minute) + `os.totalmem() - os.freemem()` and,
-- on Linux, a rolling cumulative byte counter from /proc/diskstats.
-- Disk fields are nullable so non-Linux dev hosts keep working.
--
-- Retention: 7 days, enforced inside the sampler at the end of each
-- tick. Indexed by `captured_at` so the API's `WHERE captured_at >=
-- now() - 2h ORDER BY captured_at` query is index-only.

CREATE TABLE "host_metrics" (
  "id"               TEXT    NOT NULL,
  "captured_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "load_avg_1"       DOUBLE PRECISION NOT NULL,
  "load_avg_5"       DOUBLE PRECISION NOT NULL,
  "load_avg_15"      DOUBLE PRECISION NOT NULL,
  "mem_used_bytes"   BIGINT NOT NULL,
  "mem_total_bytes"  BIGINT NOT NULL,
  "disk_read_bytes"  BIGINT,
  "disk_write_bytes" BIGINT,

  CONSTRAINT "host_metrics_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "host_metrics_captured_at_idx"
  ON "host_metrics" ("captured_at");
