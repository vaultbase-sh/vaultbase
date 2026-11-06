--
-- PostgreSQL database dump
--

\restrict aqklceOZWBBVbTWoKUjR3gVJXZjeRu5bPCoWR7sRtXUJz3aqPT90mQKjfHuC2JI

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
    at bigint DEFAULT (EXTRACT(epoch FROM now()))::bigint NOT NULL,
    token_id text,
    token_name text
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
    view_params text,
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
-- Name: vaultbase_install; Type: TABLE; Schema: vbfixture; Owner: -
--

CREATE TABLE vbfixture.vaultbase_install (
    key text NOT NULL,
    id text NOT NULL,
    created_at bigint DEFAULT (EXTRACT(epoch FROM now()))::bigint NOT NULL
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
    at bigint DEFAULT (EXTRACT(epoch FROM now()))::bigint NOT NULL,
    seq bigint
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

INSERT INTO vbfixture.vaultbase_admin (id, email, password_hash, password_reset_at, created_at) VALUES ('f68bde57-e7c0-40e7-bec1-82d6b8b000c0', 'admin@fixture.test', '$argon2id$v=19$m=19456,t=2,p=1$BPiq6/SME9+QDFjoIWu9RLdrFkd+63dy+JiPIONAVLE$X7cdCjVTgBfTRS/FKocfPAXPJ23CFYep5ZLeZqcLFBs', 0, 1793929818);


--
-- Data for Name: vaultbase_admin_sessions; Type: TABLE DATA; Schema: vbfixture; Owner: -
--

INSERT INTO vbfixture.vaultbase_admin_sessions (jti, admin_id, admin_email, issued_at, expires_at, ip, user_agent) VALUES ('8e3bbe63-01bf-4dcb-9d20-2dcfd2b417f3', 'f68bde57-e7c0-40e7-bec1-82d6b8b000c0', 'admin@fixture.test', 1793929819, 1794534619, '127.0.0.1', 'Bun/1.4.4');


--
-- Data for Name: vaultbase_api_tokens; Type: TABLE DATA; Schema: vbfixture; Owner: -
--



--
-- Data for Name: vaultbase_audit_log; Type: TABLE DATA; Schema: vbfixture; Owner: -
--

INSERT INTO vbfixture.vaultbase_audit_log (id, actor_id, actor_email, method, path, action, target, status, ip, summary, at, token_id, token_name) VALUES ('c0a3fa46-9c53-445b-a40a-fa2d6a6250b9', 'f68bde57-e7c0-40e7-bec1-82d6b8b000c0', 'admin@fixture.test', 'PATCH', '/api/v1/admin/settings', 'settings.update', NULL, 200, '127.0.0.1', NULL, 1793929819, NULL, NULL);
INSERT INTO vbfixture.vaultbase_audit_log (id, actor_id, actor_email, method, path, action, target, status, ip, summary, at, token_id, token_name) VALUES ('d10e063c-589b-4479-a077-896f2e5f5ad2', 'f68bde57-e7c0-40e7-bec1-82d6b8b000c0', 'admin@fixture.test', 'POST', '/api/v1/collections', 'collections.create', NULL, 200, '127.0.0.1', NULL, 1793929819, NULL, NULL);
INSERT INTO vbfixture.vaultbase_audit_log (id, actor_id, actor_email, method, path, action, target, status, ip, summary, at, token_id, token_name) VALUES ('13387314-8be1-4b1e-be8c-b654e528bebe', 'f68bde57-e7c0-40e7-bec1-82d6b8b000c0', 'admin@fixture.test', 'POST', '/api/v1/collections', 'collections.create', NULL, 200, '127.0.0.1', NULL, 1793929819, NULL, NULL);
INSERT INTO vbfixture.vaultbase_audit_log (id, actor_id, actor_email, method, path, action, target, status, ip, summary, at, token_id, token_name) VALUES ('6f7cdd70-c754-49c9-b85f-9940eed464e0', 'f68bde57-e7c0-40e7-bec1-82d6b8b000c0', 'admin@fixture.test', 'POST', '/api/v1/admin/hooks', 'hooks.create', NULL, 200, '127.0.0.1', NULL, 1793929819, NULL, NULL);
INSERT INTO vbfixture.vaultbase_audit_log (id, actor_id, actor_email, method, path, action, target, status, ip, summary, at, token_id, token_name) VALUES ('5c36b078-a041-4d3f-85d6-5208df6a2ae6', 'f68bde57-e7c0-40e7-bec1-82d6b8b000c0', 'admin@fixture.test', 'PATCH', '/api/v1/admin/settings', 'settings.update', NULL, 200, '127.0.0.1', NULL, 1793929819, NULL, NULL);


--
-- Data for Name: vaultbase_auth_tokens; Type: TABLE DATA; Schema: vbfixture; Owner: -
--



--
-- Data for Name: vaultbase_collections; Type: TABLE DATA; Schema: vbfixture; Owner: -
--

INSERT INTO vbfixture.vaultbase_collections (id, name, type, fields, view_query, view_params, list_rule, view_rule, create_rule, update_rule, delete_rule, created_at, updated_at, history_enabled) VALUES ('05ada997-b2d0-4f31-a3ce-92016c2f226a', 'members', 'auth', '[{"name":"email","type":"email","required":true,"implicit":true,"options":{"unique":true}},{"name":"verified","type":"bool","required":false,"implicit":true},{"name":"name","type":"text"}]', NULL, NULL, '@request.auth.id != ""', '@request.auth.id != ""', NULL, 'id = @request.auth.id', '', 1793929819, 1793929819, 1);
INSERT INTO vbfixture.vaultbase_collections (id, name, type, fields, view_query, view_params, list_rule, view_rule, create_rule, update_rule, delete_rule, created_at, updated_at, history_enabled) VALUES ('62125c70-37ff-40e1-a698-37233abcd15d', 'posts', 'base', '[{"name":"title","type":"text","required":true},{"name":"views","type":"number"},{"name":"published","type":"bool"},{"name":"published_at","type":"date"},{"name":"status","type":"select","options":{"values":["draft","live"]}},{"name":"meta","type":"json"},{"name":"body","type":"editor"},{"name":"site","type":"url"},{"name":"author","type":"relation","collection":"members"}]', NULL, NULL, NULL, NULL, '@request.auth.id != ""', 'author = @request.auth.id', 'author = @request.auth.id', 1793929819, 1793929819, 1);


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

INSERT INTO vbfixture.vaultbase_hooks (id, name, collection_name, event, code, enabled, created_at, updated_at, origin, file_path, file_error) VALUES ('529acac8-eae5-4232-8068-fdcafe406997', 'stamp', 'posts', 'beforeCreate', 'ctx.record.views = ctx.record.views ?? 0;', 1, 1793929819, 1793929819, 'inline', NULL, NULL);


--
-- Data for Name: vaultbase_install; Type: TABLE DATA; Schema: vbfixture; Owner: -
--

INSERT INTO vbfixture.vaultbase_install (key, id, created_at) VALUES ('install', 'ed033fcc-7eea-4aca-a27d-bdc962e32fc2', 1793929818);


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

INSERT INTO vbfixture.vaultbase_migrations (key, applied_at) VALUES ('v0_29_0_fit_index_names', 1793929818);
INSERT INTO vbfixture.vaultbase_migrations (key, applied_at) VALUES ('v0_26_5_relation_indexes', 1793929818);


--
-- Data for Name: vaultbase_oauth_links; Type: TABLE DATA; Schema: vbfixture; Owner: -
--



--
-- Data for Name: vaultbase_record_history; Type: TABLE DATA; Schema: vbfixture; Owner: -
--

INSERT INTO vbfixture.vaultbase_record_history (id, collection, record_id, op, snapshot, actor_id, actor_type, at, seq) VALUES ('79dc2aa0-1e16-47d5-8318-ec80d493470e', 'posts', '7ae78f2f-cce8-4001-8129-7dd2287910f4', 'create', '{"id":"7ae78f2f-cce8-4001-8129-7dd2287910f4","collectionId":"62125c70-37ff-40e1-a698-37233abcd15d","collectionName":"posts","created":1793929819,"updated":1793929819,"title":"Hello, world","views":10,"published":true,"published_at":1768460400,"status":"live","meta":{"tags":["a","b"]},"body":"<p>First</p>","site":"https://example.com","author":"e4bbd6ae-688e-4148-a09a-fb3b07f312cb"}', 'f68bde57-e7c0-40e7-bec1-82d6b8b000c0', 'admin', 1793929819, 1793929819646000);
INSERT INTO vbfixture.vaultbase_record_history (id, collection, record_id, op, snapshot, actor_id, actor_type, at, seq) VALUES ('2894c748-bf47-4dba-b5e3-005fd897991a', 'posts', 'dc91ce0d-7407-4d0b-ab0c-1eaafcc05cff', 'create', '{"id":"dc91ce0d-7407-4d0b-ab0c-1eaafcc05cff","collectionId":"62125c70-37ff-40e1-a698-37233abcd15d","collectionName":"posts","created":1793929819,"updated":1793929819,"title":"Draft post","views":0,"published":false,"published_at":null,"status":"draft","meta":{"tags":[]},"body":"<p>Second</p>","site":null,"author":"733f4d04-b10d-40ab-ad87-9d134a851679"}', 'f68bde57-e7c0-40e7-bec1-82d6b8b000c0', 'admin', 1793929819, 1793929819649000);
INSERT INTO vbfixture.vaultbase_record_history (id, collection, record_id, op, snapshot, actor_id, actor_type, at, seq) VALUES ('0a12b8fb-244a-4560-9ad7-2b3ed9722539', 'posts', 'ed92f8dc-b1e8-4fbe-b049-82c7ccd292e6', 'create', '{"id":"ed92f8dc-b1e8-4fbe-b049-82c7ccd292e6","collectionId":"62125c70-37ff-40e1-a698-37233abcd15d","collectionName":"posts","created":1793929819,"updated":1793929819,"title":"Unicode — 数据 ✓","views":3,"published":true,"published_at":1769923800,"status":"live","meta":{"n":1},"body":null,"site":null,"author":"e4bbd6ae-688e-4148-a09a-fb3b07f312cb"}', 'f68bde57-e7c0-40e7-bec1-82d6b8b000c0', 'admin', 1793929819, 1793929819652000);


--
-- Data for Name: vaultbase_routes; Type: TABLE DATA; Schema: vbfixture; Owner: -
--



--
-- Data for Name: vaultbase_settings; Type: TABLE DATA; Schema: vbfixture; Owner: -
--

INSERT INTO vbfixture.vaultbase_settings (key, value, updated_at) VALUES ('rate_limit.enabled', '0', 1793929820);
INSERT INTO vbfixture.vaultbase_settings (key, value, updated_at) VALUES ('app.name', 'Fixture v0.40.1', 1793929820);


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

INSERT INTO vbfixture.vb_members (id, name, created_at, updated_at, email, password_hash, email_verified, totp_secret, totp_enabled, is_anonymous, password_reset_at) VALUES ('e4bbd6ae-688e-4148-a09a-fb3b07f312cb', 'Ada', 1793929819, 1793929819, 'ada@fixture.test', '$argon2id$v=19$m=19456,t=2,p=1$kySh62yR2pBdFmJ/52Vra1G1z5jp43VCYPpbL9q1TaE$0YFQ6zNKp9S0xolPyTIAnFxeapX98Iu0yQwIIB/Gsbw', 0, NULL, 0, 0, 0);
INSERT INTO vbfixture.vb_members (id, name, created_at, updated_at, email, password_hash, email_verified, totp_secret, totp_enabled, is_anonymous, password_reset_at) VALUES ('733f4d04-b10d-40ab-ad87-9d134a851679', 'Linus', 1793929819, 1793929819, 'linus@fixture.test', '$argon2id$v=19$m=19456,t=2,p=1$gfbuELYSNlWpwaB/tsTKayd5KIjj14WFCVTm2FXSRXY$XuSk2G54hiIUVgYsacnYtil7U2aYmD8f7x/ZmRkGQr4', 0, NULL, 0, 0, 0);


--
-- Data for Name: vb_posts; Type: TABLE DATA; Schema: vbfixture; Owner: -
--

INSERT INTO vbfixture.vb_posts (id, title, views, published, published_at, status, meta, body, site, author, created_at, updated_at) VALUES ('7ae78f2f-cce8-4001-8129-7dd2287910f4', 'Hello, world', 10, 1, 1768460400, 'live', '{"tags":["a","b"]}', '<p>First</p>', 'https://example.com', 'e4bbd6ae-688e-4148-a09a-fb3b07f312cb', 1793929819, 1793929819);
INSERT INTO vbfixture.vb_posts (id, title, views, published, published_at, status, meta, body, site, author, created_at, updated_at) VALUES ('dc91ce0d-7407-4d0b-ab0c-1eaafcc05cff', 'Draft post', 0, 0, NULL, 'draft', '{"tags":[]}', '<p>Second</p>', NULL, '733f4d04-b10d-40ab-ad87-9d134a851679', 1793929819, 1793929819);
INSERT INTO vbfixture.vb_posts (id, title, views, published, published_at, status, meta, body, site, author, created_at, updated_at) VALUES ('ed92f8dc-b1e8-4fbe-b049-82c7ccd292e6', 'Unicode — 数据 ✓', 3, 1, 1769923800, 'live', '{"n":1}', NULL, NULL, 'e4bbd6ae-688e-4148-a09a-fb3b07f312cb', 1793929819, 1793929819);


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
-- Name: vaultbase_install vaultbase_install_pkey; Type: CONSTRAINT; Schema: vbfixture; Owner: -
--

ALTER TABLE ONLY vbfixture.vaultbase_install
    ADD CONSTRAINT vaultbase_install_pkey PRIMARY KEY (key);


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
-- Name: idx_vaultbase_audit_log_token; Type: INDEX; Schema: vbfixture; Owner: -
--

CREATE INDEX idx_vaultbase_audit_log_token ON vbfixture.vaultbase_audit_log USING btree (token_id, at);


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
-- Name: idx_vaultbase_oauth_links_collection_provider; Type: INDEX; Schema: vbfixture; Owner: -
--

CREATE UNIQUE INDEX idx_vaultbase_oauth_links_collection_provider ON vbfixture.vaultbase_oauth_links USING btree (collection_id, provider, provider_user_id);


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

\unrestrict aqklceOZWBBVbTWoKUjR3gVJXZjeRu5bPCoWR7sRtXUJz3aqPT90mQKjfHuC2JI

