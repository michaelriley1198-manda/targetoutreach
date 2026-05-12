-- Run this in the Supabase SQL editor (or via psql) once.
-- Idempotent: uses CREATE TABLE IF NOT EXISTS.

create extension if not exists "pgcrypto";

create table if not exists campaigns (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  prompt text not null,
  status text not null default 'paused',
  sequence_config jsonb not null default '[]'::jsonb,
  email_templates jsonb not null default '[]'::jsonb,
  vm_script text default '',
  created_at timestamptz not null default now()
);

create table if not exists leads (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references campaigns(id) on delete cascade,
  company_name text,
  company_url text,
  description text,
  fit_rationale text,
  vertical_signal text,
  flags text,
  fit_score integer,
  priority_score integer default 0,
  pass_fail text,
  contact_name text,
  contact_title text,
  phone text,
  email text,
  industry text,
  revenue text,
  ebitda text,
  employees integer,
  location text,
  ownership text,
  status text default 'new',
  sequence_step integer default 0,
  last_action text,
  last_action_date timestamptz,
  bio_json jsonb,
  created_at timestamptz not null default now()
);

create index if not exists leads_campaign_idx on leads(campaign_id);
create index if not exists leads_status_idx on leads(status);
create index if not exists leads_priority_idx on leads(priority_score desc);

create table if not exists call_logs (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references leads(id) on delete cascade,
  timestamp timestamptz not null default now(),
  duration integer default 0,
  outcome text,
  recording_url text
);

create index if not exists call_logs_lead_idx on call_logs(lead_id);

-- ----------------------------------------------------------------------------
-- Migrations (idempotent — safe to re-run)
-- ----------------------------------------------------------------------------

-- iterative search & quality target
alter table campaigns add column if not exists target_lead_count   integer default 150;
alter table campaigns add column if not exists min_priority_score  integer default 50;
alter table campaigns add column if not exists max_search_batches  integer default 4;

-- Apollo per-campaign sequence + lock
alter table campaigns add column if not exists apollo_sequence_id  text;
alter table campaigns add column if not exists locked_at           timestamptz;
alter table leads     add column if not exists apollo_contact_id   text;

-- Parent / consolidator detection. Populated by Apollo's organization data
-- during enrichment. Non-null parent_company on a lead means the company is
-- owned by another entity — likely a consolidator (e.g. Pave America in paving)
-- or a holding company. Phase 5B uses these fields to FAIL rolled-up leads.
alter table leads     add column if not exists parent_company      text;
alter table leads     add column if not exists acquired_flag       boolean default false;
create index if not exists leads_parent_company_idx on leads(parent_company) where parent_company is not null;

-- Per-campaign acquired-company filtering (Phase 5B).
-- excluded_acquirers: list of consolidator names to FAIL on (e.g. ["Pave America"])
-- require_independent: if true (default), FAIL any lead whose parent_company is non-empty.
alter table campaigns add column if not exists excluded_acquirers  jsonb   default '[]'::jsonb;
alter table campaigns add column if not exists require_independent boolean default true;

-- Per-call voicemail scripts (Phase 3C). One entry per call step in sequence_config,
-- in call-step order. Backfill existing vm_script (singular) into vm_scripts[0]
-- so older campaigns continue to work. The dial route reads vm_scripts[callOrdinal]
-- with a fallback to vm_script for backwards compat.
alter table campaigns add column if not exists vm_scripts jsonb default '[]'::jsonb;
update campaigns
   set vm_scripts = jsonb_build_array(vm_script)
 where (vm_scripts is null or vm_scripts = '[]'::jsonb)
   and vm_script is not null and vm_script <> '';

-- Multi-owner storage. Apollo's title field is unreliable for identifying the
-- actual owner of a company (Apollo merges multi-location businesses, lists
-- people under the wrong title, etc.). Source of truth is the company website's
-- About/Leadership/Team page + LinkedIn. We store every owner-equivalent we
-- find as a contact in this array so the dialer can roll through them if the
-- primary contact doesn't answer.
-- Each contact: { name, first_name, last_name, title, email, phone,
--                  linkedin_url, source: 'website'|'linkedin'|'apollo',
--                  apollo_contact_id, confidence }
-- The legacy contact_name / email / phone columns mirror contacts[primary_idx].
alter table leads add column if not exists contacts        jsonb   default '[]'::jsonb;
alter table leads add column if not exists primary_contact_idx integer default 0;

-- Multi-source lead acquisition. The wizard lets the user combine Exa + Apollo
-- Search + Apollo Saved List + CSV upload. Each lead is tagged with where it
-- came from; firmographics_source / enrichment_source distinguish "filled by
-- Claude inference" from "filled by Apollo's authoritative data" so future
-- backfills can target the soft sources.
alter table campaigns add column if not exists lead_sources       jsonb default '["exa"]'::jsonb;
alter table campaigns add column if not exists apollo_filter_json jsonb;
alter table campaigns add column if not exists apollo_list_id     text;
alter table campaigns add column if not exists apollo_list_name   text;
alter table campaigns add column if not exists csv_upload_meta    jsonb;

alter table leads add column if not exists lead_source          text;
alter table leads add column if not exists external_ref         jsonb;
alter table leads add column if not exists firmographics_source text;
alter table leads add column if not exists enrichment_source    text;
alter table leads add column if not exists email_status         text;
alter table leads add column if not exists phone_status         text;
create index if not exists leads_lead_source_idx on leads(lead_source);

-- Browser-based WebRTC dialer: call_logs is keyed off the Twilio dialed-leg
-- SID so the post-call modal (which fires from the browser) can PATCH the
-- correct row. amd_result captures the raw AnsweredBy classifier; outcome_label
-- is the user-selected disposition; talk_seconds is bridge time (distinct from
-- total call duration).
alter table call_logs add column if not exists twilio_call_sid text;
alter table call_logs add column if not exists parent_call_sid text;
alter table call_logs add column if not exists amd_result      text;
alter table call_logs add column if not exists outcome_label   text;
alter table call_logs add column if not exists notes           text;
alter table call_logs add column if not exists talk_seconds    integer;
alter table call_logs add column if not exists campaign_id     uuid references campaigns(id) on delete cascade;
create unique index if not exists call_logs_twilio_sid_idx on call_logs(twilio_call_sid) where twilio_call_sid is not null;
create index if not exists call_logs_campaign_idx on call_logs(campaign_id);

-- CSV staging: between the wizard's "preview upload" step and "launch", we
-- keep the parsed rows server-side keyed by a uuid the wizard carries forward.
-- Rows expire after 24h so abandoned uploads don't bloat the table.
create table if not exists csv_uploads (
  id uuid primary key default gen_random_uuid(),
  rows jsonb not null,
  headers jsonb not null,
  column_map jsonb,
  filename text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '24 hours')
);

-- ----------------------------------------------------------------------------
-- Extended firmographics from Apollo / LeadMagic / Claude web-search.
-- Each is nullable; populated by the pipeline's Apollo enrichment stage and
-- displayed alongside the company profile in the dashboard.
-- ----------------------------------------------------------------------------
alter table leads add column if not exists keywords                   jsonb;
alter table leads add column if not exists technologies               jsonb;
alter table leads add column if not exists founded_year               integer;
alter table leads add column if not exists linkedin_url               text;
alter table leads add column if not exists twitter_url                text;
alter table leads add column if not exists facebook_url               text;
alter table leads add column if not exists naics_codes                jsonb;
alter table leads add column if not exists sic_codes                  jsonb;
alter table leads add column if not exists annual_revenue_printed     text;
alter table leads add column if not exists estimated_num_employees    integer;
alter table leads add column if not exists funding_events             jsonb;
alter table leads add column if not exists total_funding              numeric;
alter table leads add column if not exists latest_funding_round_date  date;
alter table leads add column if not exists short_description          text;

-- ----------------------------------------------------------------------------
-- lead_owners: one row per discovered owner-equivalent at a company. Stage
-- tracking (status, sequence_step) lives here, not on leads, so every owner
-- can be in a different position of the sequence and the dashboard's Owners
-- tab can edit each individually. stage_overridden_at is set when the user
-- manually edits step/status; the Apollo sync respects this and won't clobber
-- a manual override.
--
-- The legacy `leads.contacts[]` JSON stays as a discovery cache, and
-- `leads.contact_name/email/phone/apollo_contact_id` mirror the primary
-- lead_owner so the existing dialer + voicemail synth keep working unchanged.
-- ----------------------------------------------------------------------------
create table if not exists lead_owners (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references leads(id) on delete cascade,
  name text,
  first_name text,
  last_name text,
  title text,
  email text,
  phone text,
  linkedin_url text,
  sources jsonb default '[]'::jsonb,
  confidence text,
  apollo_contact_id text,
  apollo_sequence_member_id text,
  email_status text,
  phone_status text,
  enrichment_source text,
  status text default 'new',
  sequence_step integer default 0,
  last_action text,
  last_action_date timestamptz,
  stage_overridden_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists lead_owners_lead_id_idx           on lead_owners(lead_id);
create index if not exists lead_owners_apollo_contact_id_idx on lead_owners(apollo_contact_id) where apollo_contact_id is not null;
