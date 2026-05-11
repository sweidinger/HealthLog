-- v1.4.23 H5 — schema drift fix for medication_schedules.days_of_week.
--
-- Up to v1.4.22 the column was declared in `schema.prisma` but never
-- migrated. Code paths in src/components/medications/*,
-- src/app/api/medications/*, src/app/api/admin/notifications/reminder-check/*
-- and src/app/api/gamification/achievements/route.ts all reference the
-- field. Pre-v1.4.23 deploys silently relied on Prisma's selecting
-- a non-existent column being tolerated by Postgres for SELECT * style
-- queries — but `prisma.medicationSchedule.create({ data: { daysOfWeek }})`
-- would fail loudly the moment a user supplied a non-default
-- recurrence string.
--
-- Add the column nullable + default NULL so existing rows mean "daily"
-- (matches the in-code semantics: `parseScheduleRecurrence(null)`
-- returns the all-7-days set).
ALTER TABLE "medication_schedules"
ADD COLUMN IF NOT EXISTS "days_of_week" TEXT;
