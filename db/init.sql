CREATE TABLE IF NOT EXISTS repositories (
  id BIGSERIAL PRIMARY KEY,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  full_name TEXT GENERATED ALWAYS AS (owner || '/' || name) STORED,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(owner, name)
);

CREATE TABLE IF NOT EXISTS review_runs (
  id BIGSERIAL PRIMARY KEY,
  repository_owner TEXT NOT NULL,
  repository_name TEXT NOT NULL,
  pull_number INTEGER,
  commit_sha TEXT,
  event_type TEXT NOT NULL DEFAULT 'manual',
  status TEXT NOT NULL DEFAULT 'queued',
  summary TEXT,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_review_runs_repo ON review_runs(repository_owner, repository_name, created_at DESC);

CREATE TABLE IF NOT EXISTS findings (
  id BIGSERIAL PRIMARY KEY,
  review_run_id BIGINT NOT NULL REFERENCES review_runs(id) ON DELETE CASCADE,
  severity TEXT NOT NULL,
  title TEXT NOT NULL,
  file_path TEXT,
  line_number INTEGER,
  body TEXT NOT NULL,
  suggestion TEXT,
  confidence NUMERIC(4,3),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS webhook_events (
  delivery_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  action TEXT,
  repository_full_name TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
