--
-- PostgreSQL database dump
--

\restrict maOaKlIDTvD3rNYxkz42ozGI8Ib4o4UICOJ2egcchaKqwqzgfiwCl3OHjYnSNtj

-- Dumped from database version 16.15
-- Dumped by pg_dump version 16.15

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: vbfixture; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA vbfixture;


--
-- Name: vb_search_text(text); Type: FUNCTION; Schema: vbfixture; Owner: -
--

CREATE FUNCTION vbfixture.vb_search_text(text) RETURNS text
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $_$ SELECT "public".unaccent('public.unaccent'::regdictionary, $1) $_$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: vaultbase_admin; Type: TABLE; Schema: vbfixture; Owner: -
--

CREATE TABLE vbfixture.vaultbase_admin (
    id text NOT NULL,
    email text NOT NULL,
    password_hash text NOT NULL,
    password_reset_at bigint DEFAULT 0 NOT NULL,
    created_at bigint DEFAULT (EXTRACT(epoch FROM now()))::bigint NOT NULL
);


--
-- Name: vaultbase_admin_sessions; Type: TABLE; Schema: vbfixture; Owner: -
--

CREATE TABLE vbfixture.vaultbase_admin_sessions (
    jti text NOT NULL,
    admin_id text NOT NULL,
    admin_email text NOT NULL,
    issued_at bigint NOT NULL,
    expires_at bigint NOT NULL,
    ip text,
    user_agent text
);


--
-- Name: vaultbase_api_tokens; Type: TABLE; Schema: vbfixture; Owner: -
--

CREATE TABLE vbfixture.vaultbase_api_tokens (
    id text NOT NULL,
    name text NOT NULL,
    scopes text DEFAULT '[]'::text NOT NULL,
    created_by text NOT NULL,
    created_by_email text NOT NULL,
    created_at bigint NOT NULL,
    expires_at bigint NOT NULL,
    revoked_at bigint,
    last_used_at bigint,
    last_used_ip text,
    last_used_ua text,
    use_count bigint DEFAULT 0 NOT NULL
);


--
-- Name: vaultbase_audit_log; Type: TABLE; Schema: vbfixture; Owner: -
--

CREATE TABLE vbfixture.vaultbase_audit_log (
    id text NOT NULL,
    actor_id text,
    actor_email text,
    method text NOT NULL,
    path text NOT NULL,
    action text NOT NULL,
    target text,
    status bigint NOT NULL,
    ip text,
    summary text,
    at bigint DEFAULT (EXTRACT(epoch FROM now()))::bigint NOT NULL
);


--
-- Name: vaultbase_auth_tokens; Type: TABLE; Schema: vbfixture; Owner: -
--

CREATE TABLE vbfixture.vaultbase_auth_tokens (
    id text NOT NULL,
    user_id text NOT NULL,
    collection_id text NOT NULL,
    purpose text NOT NULL,
    code text,
    expires_at bigint NOT NULL,
    used_at bigint,
    created_at bigint DEFAULT (EXTRACT(epoch FROM now()))::bigint NOT NULL,
    attempts bigint DEFAULT 0 NOT NULL,
    payload text,
    issued_ms double precision DEFAULT (EXTRACT(epoch FROM clock_timestamp()) * (1000)::numeric)
);


--
-- Name: vaultbase_collections; Type: TABLE; Schema: vbfixture; Owner: -
--

CREATE TABLE vbfixture.vaultbase_collections (
    id text NOT NULL,
    name text NOT NULL,
    type text DEFAULT 'base'::text NOT NULL,
    fields text DEFAULT '[]'::text NOT NULL,
    view_query text,
    list_rule text,
    view_rule text,
    create_rule text,
    update_rule text,
    delete_rule text,
    created_at bigint DEFAULT (EXTRACT(epoch FROM now()))::bigint NOT NULL,
    updated_at bigint DEFAULT (EXTRACT(epoch FROM now()))::bigint NOT NULL,
    history_enabled bigint DEFAULT 0 NOT NULL
);


--
-- Name: vaultbase_feature_flags; Type: TABLE; Schema: vbfixture; Owner: -
--

CREATE TABLE vbfixture.vaultbase_feature_flags (
    key text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    type text DEFAULT 'bool'::text NOT NULL,
    enabled bigint DEFAULT 1 NOT NULL,
    default_value text DEFAULT 'false'::text NOT NULL,
    variations text DEFAULT '[]'::text NOT NULL,
    rules text DEFAULT '[]'::text NOT NULL,
    created_at bigint DEFAULT (EXTRACT(epoch FROM now()))::bigint NOT NULL,
    updated_at bigint DEFAULT (EXTRACT(epoch FROM now()))::bigint NOT NULL
);


--
-- Name: vaultbase_file_token_uses; Type: TABLE; Schema: vbfixture; Owner: -
--

CREATE TABLE vbfixture.vaultbase_file_token_uses (
    jti text NOT NULL,
    used_at bigint NOT NULL,
    ip text
);


--
-- Name: vaultbase_files; Type: TABLE; Schema: vbfixture; Owner: -
--

CREATE TABLE vbfixture.vaultbase_files (
    id text NOT NULL,
    collection_id text NOT NULL,
    record_id text NOT NULL,
    field_name text NOT NULL,
    filename text NOT NULL,
    original_name text NOT NULL,
    mime_type text NOT NULL,
    size bigint NOT NULL,
    created_at bigint DEFAULT (EXTRACT(epoch FROM now()))::bigint NOT NULL
);


--
-- Name: vaultbase_flag_segments; Type: TABLE; Schema: vbfixture; Owner: -
--

CREATE TABLE vbfixture.vaultbase_flag_segments (
    name text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    conditions text DEFAULT '{}'::text NOT NULL,
    created_at bigint DEFAULT (EXTRACT(epoch FROM now()))::bigint NOT NULL,
    updated_at bigint DEFAULT (EXTRACT(epoch FROM now()))::bigint NOT NULL
);


--
-- Name: vaultbase_hooks; Type: TABLE; Schema: vbfixture; Owner: -
--

CREATE TABLE vbfixture.vaultbase_hooks (
    id text NOT NULL,
    name text DEFAULT ''::text NOT NULL,
    collection_name text DEFAULT ''::text NOT NULL,
    event text NOT NULL,
    code text DEFAULT ''::text NOT NULL,
    enabled bigint DEFAULT 1 NOT NULL,
    created_at bigint DEFAULT (EXTRACT(epoch FROM now()))::bigint NOT NULL,
    updated_at bigint DEFAULT (EXTRACT(epoch FROM now()))::bigint NOT NULL,
    origin text DEFAULT 'inline'::text NOT NULL,
    file_path text,
    file_error text
);


--
-- Name: vaultbase_jobs; Type: TABLE; Schema: vbfixture; Owner: -
--

CREATE TABLE vbfixture.vaultbase_jobs (
    id text NOT NULL,
    name text DEFAULT ''::text NOT NULL,
    cron text NOT NULL,
    code text DEFAULT ''::text NOT NULL,
    enabled bigint DEFAULT 1 NOT NULL,
    mode text DEFAULT 'inline'::text NOT NULL,
    last_run_at bigint,
    next_run_at bigint,
    last_status text,
    last_error text,
    created_at bigint DEFAULT (EXTRACT(epoch FROM now()))::bigint NOT NULL,
    updated_at bigint DEFAULT (EXTRACT(epoch FROM now()))::bigint NOT NULL,
    origin text DEFAULT 'inline'::text NOT NULL,
    file_path text,
    file_error text
);


--
-- Name: vaultbase_jobs_log; Type: TABLE; Schema: vbfixture; Owner: -
--

CREATE TABLE vbfixture.vaultbase_jobs_log (
    id text NOT NULL,
    queue text NOT NULL,
    worker_id text,
    payload text DEFAULT '{}'::text NOT NULL,
    unique_key text,
    attempt bigint DEFAULT 1 NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    error text,
    scheduled_at bigint DEFAULT (EXTRACT(epoch FROM now()))::bigint NOT NULL,
    enqueued_at bigint DEFAULT (EXTRACT(epoch FROM now()))::bigint NOT NULL,
    started_at bigint,
    finished_at bigint,
    lease_owner text,
    lease_until bigint,
    retry_max bigint,
    retry_backoff text,
    retry_delay_ms bigint
);


--
-- Name: vaultbase_login_failures; Type: TABLE; Schema: vbfixture; Owner: -
--

CREATE TABLE vbfixture.vaultbase_login_failures (
    id text NOT NULL,
    key text NOT NULL,
    at bigint NOT NULL
);


--
-- Name: vaultbase_mfa_recovery_codes; Type: TABLE; Schema: vbfixture; Owner: -
--

CREATE TABLE vbfixture.vaultbase_mfa_recovery_codes (
    id text NOT NULL,
    user_id text NOT NULL,
    collection_id text NOT NULL,
    code_hash text NOT NULL,
    used_at bigint,
    created_at bigint DEFAULT (EXTRACT(epoch FROM now()))::bigint NOT NULL
);


--
-- Name: vaultbase_mfa_recovery_lookup; Type: TABLE; Schema: vbfixture; Owner: -
--

CREATE TABLE vbfixture.vaultbase_mfa_recovery_lookup (
    hmac text NOT NULL,
    recovery_id text NOT NULL
);


--
-- Name: vaultbase_migrations; Type: TABLE; Schema: vbfixture; Owner: -
--

CREATE TABLE vbfixture.vaultbase_migrations (
    key text NOT NULL,
    applied_at bigint DEFAULT (EXTRACT(epoch FROM now()))::bigint NOT NULL
);


--
-- Name: vaultbase_oauth_links; Type: TABLE; Schema: vbfixture; Owner: -
--

CREATE TABLE vbfixture.vaultbase_oauth_links (
    id text NOT NULL,
    user_id text NOT NULL,
    collection_id text NOT NULL,
    provider text NOT NULL,
    provider_user_id text NOT NULL,
    provider_email text,
    created_at bigint DEFAULT (EXTRACT(epoch FROM now()))::bigint NOT NULL
);


--
-- Name: vaultbase_peer_generation; Type: SEQUENCE; Schema: vbfixture; Owner: -
--

CREATE SEQUENCE vbfixture.vaultbase_peer_generation
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: vaultbase_record_history; Type: TABLE; Schema: vbfixture; Owner: -
--

CREATE TABLE vbfixture.vaultbase_record_history (
    id text NOT NULL,
    collection text NOT NULL,
    record_id text NOT NULL,
    op text NOT NULL,
    snapshot text NOT NULL,
    actor_id text,
    actor_type text,
    at bigint DEFAULT (EXTRACT(epoch FROM now()))::bigint NOT NULL
);


--
-- Name: vaultbase_routes; Type: TABLE; Schema: vbfixture; Owner: -
--

CREATE TABLE vbfixture.vaultbase_routes (
    id text NOT NULL,
    name text DEFAULT ''::text NOT NULL,
    method text NOT NULL,
    path text NOT NULL,
    code text DEFAULT ''::text NOT NULL,
    enabled bigint DEFAULT 1 NOT NULL,
    created_at bigint DEFAULT (EXTRACT(epoch FROM now()))::bigint NOT NULL,
    updated_at bigint DEFAULT (EXTRACT(epoch FROM now()))::bigint NOT NULL,
    require_auth bigint DEFAULT 0 NOT NULL,
    origin text DEFAULT 'inline'::text NOT NULL,
    file_path text,
    file_error text
);


--
-- Name: vaultbase_settings; Type: TABLE; Schema: vbfixture; Owner: -
--

CREATE TABLE vbfixture.vaultbase_settings (
    key text NOT NULL,
    value text NOT NULL,
    updated_at bigint DEFAULT (EXTRACT(epoch FROM now()))::bigint NOT NULL
);


--
-- Name: vaultbase_sql_queries; Type: TABLE; Schema: vbfixture; Owner: -
--

CREATE TABLE vbfixture.vaultbase_sql_queries (
    id text NOT NULL,
    name text NOT NULL,
    sql text NOT NULL,
    description text,
    owner_admin_id text NOT NULL,
    owner_admin_email text NOT NULL,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL,
    last_run_at bigint,
    last_run_ms bigint,
    last_row_count bigint,
    last_error text
);


--
-- Name: vaultbase_token_revocations; Type: TABLE; Schema: vbfixture; Owner: -
--

CREATE TABLE vbfixture.vaultbase_token_revocations (
    jti text NOT NULL,
    expires_at bigint NOT NULL,
    revoked_at bigint DEFAULT (EXTRACT(epoch FROM now()))::bigint NOT NULL
);


--
-- Name: vaultbase_webhook_deliveries; Type: TABLE; Schema: vbfixture; Owner: -
--

CREATE TABLE vbfixture.vaultbase_webhook_deliveries (
    id text NOT NULL,
    webhook_id text NOT NULL,
    event text NOT NULL,
    payload text NOT NULL,
    attempt bigint DEFAULT 1 NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    response_status bigint,
    response_body text,
    error text,
    scheduled_at bigint NOT NULL,
    delivered_at bigint,
    created_at bigint DEFAULT (EXTRACT(epoch FROM now()))::bigint NOT NULL
);


--
-- Name: vaultbase_webhooks; Type: TABLE; Schema: vbfixture; Owner: -
--

CREATE TABLE vbfixture.vaultbase_webhooks (
    id text NOT NULL,
    name text DEFAULT ''::text NOT NULL,
    url text NOT NULL,
    events text DEFAULT '[]'::text NOT NULL,
    secret text NOT NULL,
    enabled bigint DEFAULT 1 NOT NULL,
    retry_max bigint DEFAULT 3 NOT NULL,
    retry_backoff text DEFAULT 'exponential'::text NOT NULL,
    retry_delay_ms bigint DEFAULT 1000 NOT NULL,
    timeout_ms bigint DEFAULT 30000 NOT NULL,
    custom_headers text DEFAULT '{}'::text NOT NULL,
    created_at bigint DEFAULT (EXTRACT(epoch FROM now()))::bigint NOT NULL,
    updated_at bigint DEFAULT (EXTRACT(epoch FROM now()))::bigint NOT NULL
);


--
-- Name: vaultbase_workers; Type: TABLE; Schema: vbfixture; Owner: -
--

CREATE TABLE vbfixture.vaultbase_workers (
    id text NOT NULL,
    name text DEFAULT ''::text NOT NULL,
    queue text NOT NULL,
    code text DEFAULT ''::text NOT NULL,
    enabled bigint DEFAULT 1 NOT NULL,
    concurrency bigint DEFAULT 1 NOT NULL,
    retry_max bigint DEFAULT 3 NOT NULL,
    retry_backoff text DEFAULT 'exponential'::text NOT NULL,
    retry_delay_ms bigint DEFAULT 1000 NOT NULL,
    created_at bigint DEFAULT (EXTRACT(epoch FROM now()))::bigint NOT NULL,
    updated_at bigint DEFAULT (EXTRACT(epoch FROM now()))::bigint NOT NULL,
    origin text DEFAULT 'inline'::text NOT NULL,
    file_path text,
    file_error text
);


--
-- Name: vb_members; Type: TABLE; Schema: vbfixture; Owner: -
--

CREATE TABLE vbfixture.vb_members (
    id text NOT NULL,
    name text,
    created_at bigint DEFAULT (EXTRACT(epoch FROM now()))::bigint NOT NULL,
    updated_at bigint DEFAULT (EXTRACT(epoch FROM now()))::bigint NOT NULL,
    email text,
    password_hash text,
    email_verified bigint DEFAULT 0 NOT NULL,
    totp_secret text,
    totp_enabled bigint DEFAULT 0 NOT NULL,
    is_anonymous bigint DEFAULT 0 NOT NULL,
    password_reset_at bigint DEFAULT 0 NOT NULL
);


--
-- Name: vb_posts; Type: TABLE; Schema: vbfixture; Owner: -
--

CREATE TABLE vbfixture.vb_posts (
    id text NOT NULL,
    title text NOT NULL,
    views double precision,
    published bigint,
    published_at bigint,
    status text,
    meta text,
    body text,
    site text,
    author text,
    created_at bigint DEFAULT (EXTRACT(epoch FROM now()))::bigint NOT NULL,
    updated_at bigint DEFAULT (EXTRACT(epoch FROM now()))::bigint NOT NULL
);


--
-- Data for Name: vaultbase_admin; Type: TABLE DATA; Schema: vbfixture; Owner: -
--

INSERT INTO vbfixture.vaultbase_admin (id, email, password_hash, password_reset_at, created_at) VALUES ('48a116e6-dd9d-4226-b4ca-f664c9e9090b', 'admin@fixture.test', '$argon2id$v=19$m=19456,t=2,p=1$fimTE3nla9FR84IrjtHZGFnLiBXuj8ZZkTgMvlMA4g8$4GvbF4R+l3sH0yGShk7buyI63FYEZwz3o8vbEgcEHSc', 1793018623, 1793018623);


--
-- Data for Name: vaultbase_admin_sessions; Type: TABLE DATA; Schema: vbfixture; Owner: -
--

INSERT INTO vbfixture.vaultbase_admin_sessions (jti, admin_id, admin_email, issued_at, expires_at, ip, user_agent) VALUES ('8ad861b7-a3a1-430e-9167-0db540b7f20c', '48a116e6-dd9d-4226-b4ca-f664c9e9090b', 'admin@fixture.test', 1793018624, 1793623424, '127.0.0.1', 'Bun/1.4.3');


--
-- Data for Name: vaultbase_api_tokens; Type: TABLE DATA; Schema: vbfixture; Owner: -
--



--
-- Data for Name: vaultbase_audit_log; Type: TABLE DATA; Schema: vbfixture; Owner: -
--

INSERT INTO vbfixture.vaultbase_audit_log (id, actor_id, actor_email, method, path, action, target, status, ip, summary, at) VALUES ('ebfa6235-b25e-479f-bc74-45d199cc56d2', '48a116e6-dd9d-4226-b4ca-f664c9e9090b', 'admin@fixture.test', 'PATCH', '/api/v1/admin/settings', 'settings.update', NULL, 200, '127.0.0.1', NULL, 1793018624);
INSERT INTO vbfixture.vaultbase_audit_log (id, actor_id, actor_email, method, path, action, target, status, ip, summary, at) VALUES ('23c04ddc-d775-4369-bcd4-4d8458c0b283', '48a116e6-dd9d-4226-b4ca-f664c9e9090b', 'admin@fixture.test', 'POST', '/api/v1/collections', 'collections.create', NULL, 200, '127.0.0.1', NULL, 1793018624);
INSERT INTO vbfixture.vaultbase_audit_log (id, actor_id, actor_email, method, path, action, target, status, ip, summary, at) VALUES ('7cc7bf8a-b803-49e4-b939-23145fdf696b', '48a116e6-dd9d-4226-b4ca-f664c9e9090b', 'admin@fixture.test', 'POST', '/api/v1/collections', 'collections.create', NULL, 200, '127.0.0.1', NULL, 1793018624);
INSERT INTO vbfixture.vaultbase_audit_log (id, actor_id, actor_email, method, path, action, target, status, ip, summary, at) VALUES ('8f895b87-84ee-4672-86d1-5a791fbe98ae', '48a116e6-dd9d-4226-b4ca-f664c9e9090b', 'admin@fixture.test', 'POST', '/api/v1/admin/hooks', 'hooks.create', NULL, 200, '127.0.0.1', NULL, 1793018624);
INSERT INTO vbfixture.vaultbase_audit_log (id, actor_id, actor_email, method, path, action, target, status, ip, summary, at) VALUES ('af5ead6b-456f-426d-8d22-1fccf22e94fa', '48a116e6-dd9d-4226-b4ca-f664c9e9090b', 'admin@fixture.test', 'PATCH', '/api/v1/admin/settings', 'settings.update', NULL, 200, '127.0.0.1', NULL, 1793018624);


--
-- Data for Name: vaultbase_auth_tokens; Type: TABLE DATA; Schema: vbfixture; Owner: -
--



--
-- Data for Name: vaultbase_collections; Type: TABLE DATA; Schema: vbfixture; Owner: -
--

INSERT INTO vbfixture.vaultbase_collections (id, name, type, fields, view_query, list_rule, view_rule, create_rule, update_rule, delete_rule, created_at, updated_at, history_enabled) VALUES ('4b197e77-8de2-48c1-b61b-409acf9870a8', 'members', 'auth', '[{"name":"email","type":"email","required":true,"implicit":true,"options":{"unique":true}},{"name":"verified","type":"bool","required":false,"implicit":true},{"name":"name","type":"text"}]', NULL, '@request.auth.id != ""', '@request.auth.id != ""', NULL, 'id = @request.auth.id', '', 1793018624, 1793018624, 0);
INSERT INTO vbfixture.vaultbase_collections (id, name, type, fields, view_query, list_rule, view_rule, create_rule, update_rule, delete_rule, created_at, updated_at, history_enabled) VALUES ('96599886-1397-4a76-aaba-60e6ec09d2ea', 'posts', 'base', '[{"name":"title","type":"text","required":true},{"name":"views","type":"number"},{"name":"published","type":"bool"},{"name":"published_at","type":"date"},{"name":"status","type":"select","options":{"values":["draft","live"]}},{"name":"meta","type":"json"},{"name":"body","type":"editor"},{"name":"site","type":"url"},{"name":"author","type":"relation","collection":"members"}]', NULL, NULL, NULL, '@request.auth.id != ""', 'author = @request.auth.id', 'author = @request.auth.id', 1793018624, 1793018624, 0);


--
-- Data for Name: vaultbase_feature_flags; Type: TABLE DATA; Schema: vbfixture; Owner: -
--



--
-- Data for Name: vaultbase_file_token_uses; Type: TABLE DATA; Schema: vbfixture; Owner: -
--



--
-- Data for Name: vaultbase_files; Type: TABLE DATA; Schema: vbfixture; Owner: -
--



--
-- Data for Name: vaultbase_flag_segments; Type: TABLE DATA; Schema: vbfixture; Owner: -
--



--
-- Data for Name: vaultbase_hooks; Type: TABLE DATA; Schema: vbfixture; Owner: -
--

INSERT INTO vbfixture.vaultbase_hooks (id, name, collection_name, event, code, enabled, created_at, updated_at, origin, file_path, file_error) VALUES ('f765f71f-eeb5-43cc-9128-4a77ac8a8216', 'stamp', 'posts', 'beforeCreate', 'ctx.record.views = ctx.record.views ?? 0;', 1, 1793018624, 1793018624, 'inline', NULL, NULL);


--
-- Data for Name: vaultbase_jobs; Type: TABLE DATA; Schema: vbfixture; Owner: -
--



--
-- Data for Name: vaultbase_jobs_log; Type: TABLE DATA; Schema: vbfixture; Owner: -
--



--
-- Data for Name: vaultbase_login_failures; Type: TABLE DATA; Schema: vbfixture; Owner: -
--



--
-- Data for Name: vaultbase_mfa_recovery_codes; Type: TABLE DATA; Schema: vbfixture; Owner: -
--



--
-- Data for Name: vaultbase_mfa_recovery_lookup; Type: TABLE DATA; Schema: vbfixture; Owner: -
--



--
-- Data for Name: vaultbase_migrations; Type: TABLE DATA; Schema: vbfixture; Owner: -
--

INSERT INTO vbfixture.vaultbase_migrations (key, applied_at) VALUES ('v0_26_5_relation_indexes', 1793018623);


--
-- Data for Name: vaultbase_oauth_links; Type: TABLE DATA; Schema: vbfixture; Owner: -
--



--
-- Data for Name: vaultbase_record_history; Type: TABLE DATA; Schema: vbfixture; Owner: -
--



--
-- Data for Name: vaultbase_routes; Type: TABLE DATA; Schema: vbfixture; Owner: -
--



--
-- Data for Name: vaultbase_settings; Type: TABLE DATA; Schema: vbfixture; Owner: -
--

INSERT INTO vbfixture.vaultbase_settings (key, value, updated_at) VALUES ('rate_limit.enabled', '0', 1793018625);
INSERT INTO vbfixture.vaultbase_settings (key, value, updated_at) VALUES ('app.name', 'Fixture v0.28.1', 1793018625);


--
-- Data for Name: vaultbase_sql_queries; Type: TABLE DATA; Schema: vbfixture; Owner: -
--



--
-- Data for Name: vaultbase_token_revocations; Type: TABLE DATA; Schema: vbfixture; Owner: -
--



--
-- Data for Name: vaultbase_webhook_deliveries; Type: TABLE DATA; Schema: vbfixture; Owner: -
--



--
-- Data for Name: vaultbase_webhooks; Type: TABLE DATA; Schema: vbfixture; Owner: -
--



--
-- Data for Name: vaultbase_workers; Type: TABLE DATA; Schema: vbfixture; Owner: -
--



--
-- Data for Name: vb_members; Type: TABLE DATA; Schema: vbfixture; Owner: -
--

INSERT INTO vbfixture.vb_members (id, name, created_at, updated_at, email, password_hash, email_verified, totp_secret, totp_enabled, is_anonymous, password_reset_at) VALUES ('e18eb53a-58f4-4ccb-899e-0df541cd9314', 'Ada', 1793018624, 1793018624, 'ada@fixture.test', '$argon2id$v=19$m=19456,t=2,p=1$f54JOgfCsfQ3O4IkuI92AmNarn4YFl+GwYcknwnd7gI$OoQ8YmNFAoeDjjWvdGepeD5VuyVul0Z9dX8zv8TbfNI', 0, NULL, 0, 0, 0);
INSERT INTO vbfixture.vb_members (id, name, created_at, updated_at, email, password_hash, email_verified, totp_secret, totp_enabled, is_anonymous, password_reset_at) VALUES ('53c0f305-40ae-4879-a453-dde438b82a75', 'Linus', 1793018624, 1793018624, 'linus@fixture.test', '$argon2id$v=19$m=19456,t=2,p=1$uHXnqLrQ+y66DGs12ggaWZnBaey5uF8XQR37Lfs5gy8$1Ey30aerwOQt7S2xzGYZIplURzAO8y+gZTfxVQ2M9Qc', 0, NULL, 0, 0, 0);


--
-- Data for Name: vb_posts; Type: TABLE DATA; Schema: vbfixture; Owner: -
--

INSERT INTO vbfixture.vb_posts (id, title, views, published, published_at, status, meta, body, site, author, created_at, updated_at) VALUES ('abd7aece-cda2-45d6-8f8a-a8dbee3c8def', 'Hello, world', 10, 1, 1768460400, 'live', '{"tags":["a","b"]}', '<p>First</p>', 'https://example.com', 'e18eb53a-58f4-4ccb-899e-0df541cd9314', 1793018624, 1793018624);
INSERT INTO vbfixture.vb_posts (id, title, views, published, published_at, status, meta, body, site, author, created_at, updated_at) VALUES ('de43c9a1-6795-49f5-85f7-82da31ce71da', 'Draft post', 0, 0, NULL, 'draft', '{"tags":[]}', '<p>Second</p>', NULL, '53c0f305-40ae-4879-a453-dde438b82a75', 1793018624, 1793018624);
INSERT INTO vbfixture.vb_posts (id, title, views, published, published_at, status, meta, body, site, author, created_at, updated_at) VALUES ('09b98deb-d8f1-4d28-917c-88353fdb9e24', 'Unicode — 数据 ✓', 3, 1, 1769923800, 'live', '{"n":1}', NULL, NULL, 'e18eb53a-58f4-4ccb-899e-0df541cd9314', 1793018624, 1793018624);


--
-- Name: vaultbase_peer_generation; Type: SEQUENCE SET; Schema: vbfixture; Owner: -
--

SELECT pg_catalog.setval('vbfixture.vaultbase_peer_generation', 3, true);


--
-- Name: vaultbase_admin vaultbase_admin_email_key; Type: CONSTRAINT; Schema: vbfixture; Owner: -
--

ALTER TABLE ONLY vbfixture.vaultbase_admin
    ADD CONSTRAINT vaultbase_admin_email_key UNIQUE (email);


--
-- Name: vaultbase_admin vaultbase_admin_pkey; Type: CONSTRAINT; Schema: vbfixture; Owner: -
--

ALTER TABLE ONLY vbfixture.vaultbase_admin
    ADD CONSTRAINT vaultbase_admin_pkey PRIMARY KEY (id);


--
-- Name: vaultbase_admin_sessions vaultbase_admin_sessions_pkey; Type: CONSTRAINT; Schema: vbfixture; Owner: -
--

ALTER TABLE ONLY vbfixture.vaultbase_admin_sessions
    ADD CONSTRAINT vaultbase_admin_sessions_pkey PRIMARY KEY (jti);


--
-- Name: vaultbase_api_tokens vaultbase_api_tokens_pkey; Type: CONSTRAINT; Schema: vbfixture; Owner: -
--

ALTER TABLE ONLY vbfixture.vaultbase_api_tokens
    ADD CONSTRAINT vaultbase_api_tokens_pkey PRIMARY KEY (id);


--
-- Name: vaultbase_audit_log vaultbase_audit_log_pkey; Type: CONSTRAINT; Schema: vbfixture; Owner: -
--

ALTER TABLE ONLY vbfixture.vaultbase_audit_log
    ADD CONSTRAINT vaultbase_audit_log_pkey PRIMARY KEY (id);


--
-- Name: vaultbase_auth_tokens vaultbase_auth_tokens_pkey; Type: CONSTRAINT; Schema: vbfixture; Owner: -
--

ALTER TABLE ONLY vbfixture.vaultbase_auth_tokens
    ADD CONSTRAINT vaultbase_auth_tokens_pkey PRIMARY KEY (id);


--
-- Name: vaultbase_collections vaultbase_collections_name_key; Type: CONSTRAINT; Schema: vbfixture; Owner: -
--

ALTER TABLE ONLY vbfixture.vaultbase_collections
    ADD CONSTRAINT vaultbase_collections_name_key UNIQUE (name);


--
-- Name: vaultbase_collections vaultbase_collections_pkey; Type: CONSTRAINT; Schema: vbfixture; Owner: -
--

ALTER TABLE ONLY vbfixture.vaultbase_collections
    ADD CONSTRAINT vaultbase_collections_pkey PRIMARY KEY (id);


--
-- Name: vaultbase_feature_flags vaultbase_feature_flags_pkey; Type: CONSTRAINT; Schema: vbfixture; Owner: -
--

ALTER TABLE ONLY vbfixture.vaultbase_feature_flags
    ADD CONSTRAINT vaultbase_feature_flags_pkey PRIMARY KEY (key);


--
-- Name: vaultbase_file_token_uses vaultbase_file_token_uses_pkey; Type: CONSTRAINT; Schema: vbfixture; Owner: -
--

ALTER TABLE ONLY vbfixture.vaultbase_file_token_uses
    ADD CONSTRAINT vaultbase_file_token_uses_pkey PRIMARY KEY (jti);


--
-- Name: vaultbase_files vaultbase_files_pkey; Type: CONSTRAINT; Schema: vbfixture; Owner: -
--

ALTER TABLE ONLY vbfixture.vaultbase_files
    ADD CONSTRAINT vaultbase_files_pkey PRIMARY KEY (id);


--
-- Name: vaultbase_flag_segments vaultbase_flag_segments_pkey; Type: CONSTRAINT; Schema: vbfixture; Owner: -
--

ALTER TABLE ONLY vbfixture.vaultbase_flag_segments
    ADD CONSTRAINT vaultbase_flag_segments_pkey PRIMARY KEY (name);


--
-- Name: vaultbase_hooks vaultbase_hooks_pkey; Type: CONSTRAINT; Schema: vbfixture; Owner: -
--

ALTER TABLE ONLY vbfixture.vaultbase_hooks
    ADD CONSTRAINT vaultbase_hooks_pkey PRIMARY KEY (id);


--
-- Name: vaultbase_jobs_log vaultbase_jobs_log_pkey; Type: CONSTRAINT; Schema: vbfixture; Owner: -
--

ALTER TABLE ONLY vbfixture.vaultbase_jobs_log
    ADD CONSTRAINT vaultbase_jobs_log_pkey PRIMARY KEY (id);


--
-- Name: vaultbase_jobs vaultbase_jobs_pkey; Type: CONSTRAINT; Schema: vbfixture; Owner: -
--

ALTER TABLE ONLY vbfixture.vaultbase_jobs
    ADD CONSTRAINT vaultbase_jobs_pkey PRIMARY KEY (id);


--
-- Name: vaultbase_login_failures vaultbase_login_failures_pkey; Type: CONSTRAINT; Schema: vbfixture; Owner: -
--

ALTER TABLE ONLY vbfixture.vaultbase_login_failures
    ADD CONSTRAINT vaultbase_login_failures_pkey PRIMARY KEY (id);


--
-- Name: vaultbase_mfa_recovery_codes vaultbase_mfa_recovery_codes_pkey; Type: CONSTRAINT; Schema: vbfixture; Owner: -
--

ALTER TABLE ONLY vbfixture.vaultbase_mfa_recovery_codes
    ADD CONSTRAINT vaultbase_mfa_recovery_codes_pkey PRIMARY KEY (id);


--
-- Name: vaultbase_mfa_recovery_lookup vaultbase_mfa_recovery_lookup_pkey; Type: CONSTRAINT; Schema: vbfixture; Owner: -
--

ALTER TABLE ONLY vbfixture.vaultbase_mfa_recovery_lookup
    ADD CONSTRAINT vaultbase_mfa_recovery_lookup_pkey PRIMARY KEY (hmac);


--
-- Name: vaultbase_migrations vaultbase_migrations_pkey; Type: CONSTRAINT; Schema: vbfixture; Owner: -
--

ALTER TABLE ONLY vbfixture.vaultbase_migrations
    ADD CONSTRAINT vaultbase_migrations_pkey PRIMARY KEY (key);


--
-- Name: vaultbase_oauth_links vaultbase_oauth_links_pkey; Type: CONSTRAINT; Schema: vbfixture; Owner: -
--

ALTER TABLE ONLY vbfixture.vaultbase_oauth_links
    ADD CONSTRAINT vaultbase_oauth_links_pkey PRIMARY KEY (id);


--
-- Name: vaultbase_record_history vaultbase_record_history_pkey; Type: CONSTRAINT; Schema: vbfixture; Owner: -
--

ALTER TABLE ONLY vbfixture.vaultbase_record_history
    ADD CONSTRAINT vaultbase_record_history_pkey PRIMARY KEY (id);


--
-- Name: vaultbase_routes vaultbase_routes_pkey; Type: CONSTRAINT; Schema: vbfixture; Owner: -
--

ALTER TABLE ONLY vbfixture.vaultbase_routes
    ADD CONSTRAINT vaultbase_routes_pkey PRIMARY KEY (id);


--
-- Name: vaultbase_settings vaultbase_settings_pkey; Type: CONSTRAINT; Schema: vbfixture; Owner: -
--

ALTER TABLE ONLY vbfixture.vaultbase_settings
    ADD CONSTRAINT vaultbase_settings_pkey PRIMARY KEY (key);


--
-- Name: vaultbase_sql_queries vaultbase_sql_queries_pkey; Type: CONSTRAINT; Schema: vbfixture; Owner: -
--

ALTER TABLE ONLY vbfixture.vaultbase_sql_queries
    ADD CONSTRAINT vaultbase_sql_queries_pkey PRIMARY KEY (id);


--
-- Name: vaultbase_token_revocations vaultbase_token_revocations_pkey; Type: CONSTRAINT; Schema: vbfixture; Owner: -
--

ALTER TABLE ONLY vbfixture.vaultbase_token_revocations
    ADD CONSTRAINT vaultbase_token_revocations_pkey PRIMARY KEY (jti);


--
-- Name: vaultbase_webhook_deliveries vaultbase_webhook_deliveries_pkey; Type: CONSTRAINT; Schema: vbfixture; Owner: -
--

ALTER TABLE ONLY vbfixture.vaultbase_webhook_deliveries
    ADD CONSTRAINT vaultbase_webhook_deliveries_pkey PRIMARY KEY (id);


--
-- Name: vaultbase_webhooks vaultbase_webhooks_pkey; Type: CONSTRAINT; Schema: vbfixture; Owner: -
--

ALTER TABLE ONLY vbfixture.vaultbase_webhooks
    ADD CONSTRAINT vaultbase_webhooks_pkey PRIMARY KEY (id);


--
-- Name: vaultbase_workers vaultbase_workers_pkey; Type: CONSTRAINT; Schema: vbfixture; Owner: -
--

ALTER TABLE ONLY vbfixture.vaultbase_workers
    ADD CONSTRAINT vaultbase_workers_pkey PRIMARY KEY (id);


--
-- Name: vb_members vb_members_pkey; Type: CONSTRAINT; Schema: vbfixture; Owner: -
--

ALTER TABLE ONLY vbfixture.vb_members
    ADD CONSTRAINT vb_members_pkey PRIMARY KEY (id);


--
-- Name: vb_posts vb_posts_pkey; Type: CONSTRAINT; Schema: vbfixture; Owner: -
--

ALTER TABLE ONLY vbfixture.vb_posts
    ADD CONSTRAINT vb_posts_pkey PRIMARY KEY (id);


--
-- Name: idx_vaultbase_admin_email; Type: INDEX; Schema: vbfixture; Owner: -
--

CREATE UNIQUE INDEX idx_vaultbase_admin_email ON vbfixture.vaultbase_admin USING btree (email);


--
-- Name: idx_vaultbase_admin_sessions_admin; Type: INDEX; Schema: vbfixture; Owner: -
--

CREATE INDEX idx_vaultbase_admin_sessions_admin ON vbfixture.vaultbase_admin_sessions USING btree (admin_id);


--
-- Name: idx_vaultbase_admin_sessions_exp; Type: INDEX; Schema: vbfixture; Owner: -
--

CREATE INDEX idx_vaultbase_admin_sessions_exp ON vbfixture.vaultbase_admin_sessions USING btree (expires_at);


--
-- Name: idx_vaultbase_api_tokens_created_by; Type: INDEX; Schema: vbfixture; Owner: -
--

CREATE INDEX idx_vaultbase_api_tokens_created_by ON vbfixture.vaultbase_api_tokens USING btree (created_by);


--
-- Name: idx_vaultbase_api_tokens_expires; Type: INDEX; Schema: vbfixture; Owner: -
--

CREATE INDEX idx_vaultbase_api_tokens_expires ON vbfixture.vaultbase_api_tokens USING btree (expires_at);


--
-- Name: idx_vaultbase_audit_log_action; Type: INDEX; Schema: vbfixture; Owner: -
--

CREATE INDEX idx_vaultbase_audit_log_action ON vbfixture.vaultbase_audit_log USING btree (action, at);


--
-- Name: idx_vaultbase_audit_log_actor; Type: INDEX; Schema: vbfixture; Owner: -
--

CREATE INDEX idx_vaultbase_audit_log_actor ON vbfixture.vaultbase_audit_log USING btree (actor_id, at);


--
-- Name: idx_vaultbase_audit_log_at; Type: INDEX; Schema: vbfixture; Owner: -
--

CREATE INDEX idx_vaultbase_audit_log_at ON vbfixture.vaultbase_audit_log USING btree (at);


--
-- Name: idx_vaultbase_auth_tokens_code; Type: INDEX; Schema: vbfixture; Owner: -
--

CREATE INDEX idx_vaultbase_auth_tokens_code ON vbfixture.vaultbase_auth_tokens USING btree (code, purpose);


--
-- Name: idx_vaultbase_auth_tokens_user; Type: INDEX; Schema: vbfixture; Owner: -
--

CREATE INDEX idx_vaultbase_auth_tokens_user ON vbfixture.vaultbase_auth_tokens USING btree (user_id, purpose);


--
-- Name: idx_vaultbase_file_token_uses_used_at; Type: INDEX; Schema: vbfixture; Owner: -
--

CREATE INDEX idx_vaultbase_file_token_uses_used_at ON vbfixture.vaultbase_file_token_uses USING btree (used_at);


--
-- Name: idx_vaultbase_files_filename; Type: INDEX; Schema: vbfixture; Owner: -
--

CREATE INDEX idx_vaultbase_files_filename ON vbfixture.vaultbase_files USING btree (filename);


--
-- Name: idx_vaultbase_files_record; Type: INDEX; Schema: vbfixture; Owner: -
--

CREATE INDEX idx_vaultbase_files_record ON vbfixture.vaultbase_files USING btree (collection_id, record_id, field_name);


--
-- Name: idx_vaultbase_hooks_file_path; Type: INDEX; Schema: vbfixture; Owner: -
--

CREATE UNIQUE INDEX idx_vaultbase_hooks_file_path ON vbfixture.vaultbase_hooks USING btree (file_path) WHERE (file_path IS NOT NULL);


--
-- Name: idx_vaultbase_jobs_file_path; Type: INDEX; Schema: vbfixture; Owner: -
--

CREATE UNIQUE INDEX idx_vaultbase_jobs_file_path ON vbfixture.vaultbase_jobs USING btree (file_path) WHERE (file_path IS NOT NULL);


--
-- Name: idx_vaultbase_jobs_log_status; Type: INDEX; Schema: vbfixture; Owner: -
--

CREATE INDEX idx_vaultbase_jobs_log_status ON vbfixture.vaultbase_jobs_log USING btree (queue, status, scheduled_at);


--
-- Name: idx_vaultbase_jobs_log_unique; Type: INDEX; Schema: vbfixture; Owner: -
--

CREATE INDEX idx_vaultbase_jobs_log_unique ON vbfixture.vaultbase_jobs_log USING btree (unique_key, status);


--
-- Name: idx_vaultbase_jobs_log_unique_active; Type: INDEX; Schema: vbfixture; Owner: -
--

CREATE UNIQUE INDEX idx_vaultbase_jobs_log_unique_active ON vbfixture.vaultbase_jobs_log USING btree (unique_key) WHERE ((unique_key IS NOT NULL) AND (status = ANY (ARRAY['queued'::text, 'running'::text])));


--
-- Name: idx_vaultbase_login_failures_at; Type: INDEX; Schema: vbfixture; Owner: -
--

CREATE INDEX idx_vaultbase_login_failures_at ON vbfixture.vaultbase_login_failures USING btree (at);


--
-- Name: idx_vaultbase_login_failures_key; Type: INDEX; Schema: vbfixture; Owner: -
--

CREATE INDEX idx_vaultbase_login_failures_key ON vbfixture.vaultbase_login_failures USING btree (key, at);


--
-- Name: idx_vaultbase_mfa_recovery_codes_user; Type: INDEX; Schema: vbfixture; Owner: -
--

CREATE INDEX idx_vaultbase_mfa_recovery_codes_user ON vbfixture.vaultbase_mfa_recovery_codes USING btree (user_id, collection_id);


--
-- Name: idx_vaultbase_oauth_links_provider; Type: INDEX; Schema: vbfixture; Owner: -
--

CREATE UNIQUE INDEX idx_vaultbase_oauth_links_provider ON vbfixture.vaultbase_oauth_links USING btree (provider, provider_user_id);


--
-- Name: idx_vaultbase_oauth_links_user; Type: INDEX; Schema: vbfixture; Owner: -
--

CREATE INDEX idx_vaultbase_oauth_links_user ON vbfixture.vaultbase_oauth_links USING btree (user_id);


--
-- Name: idx_vaultbase_record_history_at; Type: INDEX; Schema: vbfixture; Owner: -
--

CREATE INDEX idx_vaultbase_record_history_at ON vbfixture.vaultbase_record_history USING btree (at);


--
-- Name: idx_vaultbase_record_history_lookup; Type: INDEX; Schema: vbfixture; Owner: -
--

CREATE INDEX idx_vaultbase_record_history_lookup ON vbfixture.vaultbase_record_history USING btree (collection, record_id, at);


--
-- Name: idx_vaultbase_routes_file_path; Type: INDEX; Schema: vbfixture; Owner: -
--

CREATE UNIQUE INDEX idx_vaultbase_routes_file_path ON vbfixture.vaultbase_routes USING btree (file_path) WHERE (file_path IS NOT NULL);


--
-- Name: idx_vaultbase_sql_queries_owner; Type: INDEX; Schema: vbfixture; Owner: -
--

CREATE INDEX idx_vaultbase_sql_queries_owner ON vbfixture.vaultbase_sql_queries USING btree (owner_admin_id, updated_at DESC);


--
-- Name: idx_vaultbase_token_revocations_exp; Type: INDEX; Schema: vbfixture; Owner: -
--

CREATE INDEX idx_vaultbase_token_revocations_exp ON vbfixture.vaultbase_token_revocations USING btree (expires_at);


--
-- Name: idx_vaultbase_webhook_deliveries_status; Type: INDEX; Schema: vbfixture; Owner: -
--

CREATE INDEX idx_vaultbase_webhook_deliveries_status ON vbfixture.vaultbase_webhook_deliveries USING btree (status, scheduled_at);


--
-- Name: idx_vaultbase_webhook_deliveries_webhook; Type: INDEX; Schema: vbfixture; Owner: -
--

CREATE INDEX idx_vaultbase_webhook_deliveries_webhook ON vbfixture.vaultbase_webhook_deliveries USING btree (webhook_id, created_at);


--
-- Name: idx_vaultbase_workers_file_path; Type: INDEX; Schema: vbfixture; Owner: -
--

CREATE UNIQUE INDEX idx_vaultbase_workers_file_path ON vbfixture.vaultbase_workers USING btree (file_path) WHERE (file_path IS NOT NULL);


--
-- Name: idx_vaultbase_workers_queue; Type: INDEX; Schema: vbfixture; Owner: -
--

CREATE INDEX idx_vaultbase_workers_queue ON vbfixture.vaultbase_workers USING btree (queue);


--
-- Name: idx_vb_members_created_at; Type: INDEX; Schema: vbfixture; Owner: -
--

CREATE INDEX idx_vb_members_created_at ON vbfixture.vb_members USING btree (created_at, id);


--
-- Name: idx_vb_members_email; Type: INDEX; Schema: vbfixture; Owner: -
--

CREATE UNIQUE INDEX idx_vb_members_email ON vbfixture.vb_members USING btree (email);


--
-- Name: idx_vb_members_updated_at; Type: INDEX; Schema: vbfixture; Owner: -
--

CREATE INDEX idx_vb_members_updated_at ON vbfixture.vb_members USING btree (updated_at, id);


--
-- Name: idx_vb_posts_author; Type: INDEX; Schema: vbfixture; Owner: -
--

CREATE INDEX idx_vb_posts_author ON vbfixture.vb_posts USING btree (author, id);


--
-- Name: idx_vb_posts_created_at; Type: INDEX; Schema: vbfixture; Owner: -
--

CREATE INDEX idx_vb_posts_created_at ON vbfixture.vb_posts USING btree (created_at, id);


--
-- Name: idx_vb_posts_updated_at; Type: INDEX; Schema: vbfixture; Owner: -
--

CREATE INDEX idx_vb_posts_updated_at ON vbfixture.vb_posts USING btree (updated_at, id);


--
-- PostgreSQL database dump complete
--

\unrestrict maOaKlIDTvD3rNYxkz42ozGI8Ib4o4UICOJ2egcchaKqwqzgfiwCl3OHjYnSNtj

