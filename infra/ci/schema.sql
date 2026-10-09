-- Postgres (pg-genclass-*, database genclass): one row per nightly CI run against the published npm packages.
create table if not exists ci_results (
  id               bigserial primary key,
  run_date         date        not null,
  run_at           timestamptz not null default now(),
  commit           text,        -- GenClass-lib `runtime` commit of the harness
  runtime_version  text,        -- @genclass/runtime@latest under test
  model_version    text,        -- @genclass/runtime-model@latest under test
  trials           int,         -- out-of-order trials per mode
  guard_fixed      int,         -- guard:balanced trials that end showing the newer query
  observe_detected int,         -- observe:balanced trials with a detection
  clean_calls      int,         -- model calls on clean typing, all modes (must be 0)
  latency_ms       int,         -- median decision latency
  e2e_ok           boolean,
  smoke_ok         boolean,
  ok               boolean      not null default false,
  summary          text,        -- one-sentence AI status (Foundry Models)
  commits_digest   text,        -- AI digest of the last 24 h of commits
  ai_usage         jsonb,
  detail           jsonb        not null  -- the full ci-result.json
);
create index if not exists ci_results_run_at on ci_results (run_at desc);
