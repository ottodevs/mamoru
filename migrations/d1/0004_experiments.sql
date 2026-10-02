-- Additive to the `mamoru` D1 database. Owned by ottodevs/mamoru: this file
-- is kept here for reference only. The canonical copy to apply lives at
-- migrations/d1/0004_experiments.sql in ottodevs/mamoru, following
-- 0001_sprint.sql and 0003_signin.sql (landing on another branch — hence
-- 0004, not 0003, to avoid a collision). This repo (mamoru-astro / Worker
-- mamoru-lol) only reads and writes exp_events through the MAMORU_DB
-- binding; it never runs migrations itself.

CREATE TABLE exp_events (
  experiment TEXT NOT NULL, variant TEXT NOT NULL, visitor TEXT NOT NULL,
  event TEXT NOT NULL, day TEXT NOT NULL, at TEXT NOT NULL,
  PRIMARY KEY (experiment, visitor, event, day)
);
CREATE INDEX exp_events_by_exp ON exp_events (experiment, event, variant);
