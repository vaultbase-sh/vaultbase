/**
 * Type declarations for `ctx.helpers` and `ctx.auth`, as text. One copy for
 * the two places that show them: the admin's code editor (autocomplete and
 * hovers) and the `vaultbase.d.ts` written into a hooks folder. No imports,
 * so the admin bundle can include it.
 *
 * helper-types.test.ts checks the names here against the helpers the server
 * builds: a helper added there without a declaration here fails that test.
 */
export const HELPER_TYPES = `
interface AuthContext {
  /** Id of the signed-in user or admin. */
  id: string;
  type: "user" | "admin";
  /** The account's email, when the token carries one. */
  email?: string;
  /** Users: the auth collection the account belongs to. */
  collection?: string;
  /** Users: a guest session from /auth/:collection/anonymous. */
  anonymous?: boolean;
  /** Users: the account's email is verified (as of this request). */
  verified?: boolean;
}

interface HookHelpers {
  /** Slugify a string: 'Hello World' -> 'hello-world'. */
  slug(s: string): string;
  /** Stop the operation: the caller gets a 422 with this message. */
  abort(message: string): never;
  /** A new UUID (v4). */
  uuid(): string;
  /** Same as uuid(). */
  id(): string;
  /** Look up one record by id, or null. */
  find<T = Record<string, any>>(collection: string, id: string): Promise<T | null>;
  /** List records in a collection. */
  query<T = Record<string, any>>(
    collection: string,
    opts?: { filter?: string; sort?: string; perPage?: number }
  ): Promise<{ data: T[]; totalItems: number }>;
  /**
   * Write records the way the API does: validation, hooks, record history,
   * realtime and webhooks (helpers.sql skips all of these). No API rules
   * apply. Nesting past 5 levels throws, so a hook can't loop forever.
   */
  records: {
    create<T = Record<string, any>>(collection: string, data: Record<string, any>): Promise<T>;
    /** Update fields of a record (a partial patch). */
    update<T = Record<string, any>>(collection: string, id: string, data: Record<string, any>): Promise<T>;
    /** Delete a record, with the collection's cascade rules. */
    delete(collection: string, id: string): Promise<void>;
  };
  /** Outbound HTTP (Web Fetch API), through the same address checks as helpers.http. */
  fetch(input: string | URL, init?: RequestInit): Promise<Response>;
  /** Write a line to the server log (stdout and the log files). */
  log(...args: unknown[]): void;
  /** Send an email through the configured SMTP settings. */
  email(opts: { to: string; subject: string; body: string }): Promise<void>;
  /**
   * Enqueue a job onto a named queue. Returns the new job id, or the existing
   * one when uniqueKey matched a job that hasn't finished (deduped: true).
   */
  enqueue(
    queue: string,
    payload: unknown,
    opts?: {
      delay?: number;
      uniqueKey?: string;
      retries?: number;
      backoff?: "exponential" | "fixed";
      retryDelayMs?: number;
    }
  ): Promise<{ jobId: string; deduped: boolean }>;
  /**
   * Notify a user: one row in their in-app inbox, and one push per enabled
   * provider. Does nothing when notifications aren't set up.
   */
  notify(
    userId: string,
    payload: { title: string; body: string; data?: Record<string, unknown> },
    opts?: {
      /** Push provider names. Default: every enabled one. */
      providers?: string[];
      inbox?: boolean;
      push?: boolean;
    }
  ): Promise<{
    inboxRowId: string | null;
    enqueued: { provider: string; jobId: string; deduped: boolean }[];
  }>;
  /**
   * Record a custom policy decision on the active request log (records API).
   * Does nothing outside an HTTP request (cron jobs, cascades). Several calls
   * accumulate.
   */
  recordRule(opts: {
    /** Logical name of the rule (e.g. "custom-quota"). */
    rule: string;
    /** Defaults to the active hook's collection. */
    collection?: string;
    /** Optional human-readable expression text. */
    expression?: string | null;
    outcome: "allow" | "deny" | "filter";
    reason: string;
  }): void;

  security: {
    /** Hex digest of data. */
    hash(alg: "sha256" | "sha384" | "sha512", data: string | Uint8Array): Promise<string>;
    /** Hex HMAC of data with key. */
    hmac(alg: "sha256" | "sha384" | "sha512", key: string | Uint8Array, data: string | Uint8Array): Promise<string>;
    /** Random hex (default) or base64url string. byteLen is the entropy in bytes. */
    randomString(byteLen: number, alphabet?: "hex" | "base64url"): string;
    randomBytes(len: number): Uint8Array;
    /** Sign a JWT (HS256). expiresIn accepts seconds or "1h", "7d", etc. */
    jwtSign(
      payload: Record<string, unknown>,
      secret: string,
      opts?: { expiresIn?: number | string; issuer?: string; audience?: string }
    ): Promise<string>;
    /** Verify a JWT (HS256). Throws on failure. */
    jwtVerify(
      token: string,
      secret: string,
      opts?: { issuer?: string; audience?: string }
    ): Promise<Record<string, unknown>>;
    /** AES-GCM encrypt with the server's encryption key. */
    aesEncrypt(plaintext: string): Promise<string>;
    aesDecrypt(ciphertext: string): Promise<string>;
    constantTimeEqual(a: string, b: string): boolean;
  };
  path: {
    join(...parts: string[]): string;
    basename(p: string, ext?: string): string;
    dirname(p: string): string;
    /** Extension including the leading dot ("" if none). */
    ext(p: string): string;
    normalize(p: string): string;
  };
  template: {
    /** Render {{var}} and {{#if path}}...{{/if}} against vars. Not HTML-escaped. */
    render(template: string, vars: Record<string, unknown>): string;
    escapeHtml(s: string): string;
  };
  http: {
    request(opts: {
      url: string;
      method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";
      headers?: Record<string, string>;
      body?: string | Uint8Array | Record<string, unknown> | null;
      json?: boolean;
      retries?: number;
      retryDelayMs?: number;
      timeoutMs?: number;
    }): Promise<{
      status: number;
      ok: boolean;
      headers: Record<string, string>;
      text: string;
      json?: unknown;
    }>;
    getJson<T = unknown>(url: string, headers?: Record<string, string>): Promise<T>;
    postJson<T = unknown>(url: string, body: unknown, headers?: Record<string, string>): Promise<T>;
  };
  util: {
    sleep(ms: number): Promise<void>;
    /** Safe JSON.parse: returns null on invalid input. */
    unmarshal<T = unknown>(s: string): T | null;
    readerToString(input: ReadableStream<Uint8Array> | Response): Promise<string>;
  };
  /**
   * SQL on the server's database, SQLite or Postgres. Rows are written
   * directly: no validation, hooks, record history, realtime or webhooks
   * (use helpers.records for those).
   */
  sql: {
    /** Run a SELECT and return its rows. Parameters bind to ? in order. */
    query<T = Record<string, any>>(sql: string, params?: unknown[]): Promise<T[]>;
    /** The first row of a SELECT, or null. */
    queryOne<T = Record<string, any>>(sql: string, params?: unknown[]): Promise<T | null>;
    /** Run INSERT / UPDATE / DELETE; returns the rows changed. */
    exec(sql: string, params?: unknown[]): Promise<{ changes: number }>;
    /**
     * Run fn in a transaction: committed when it resolves, rolled back when
     * it throws. fn takes no argument: every helpers.sql call made while it
     * runs is part of the transaction. Inside a record write or a batch it
     * becomes a savepoint, so a failure undoes only fn.
     */
    transaction<T>(fn: () => Promise<T>): Promise<T>;
  };
  /** @deprecated Synchronous and SQLite-only. Use helpers.sql. */
  db: {
    /** Run a SELECT and return rows. Bind params positionally (?) or named (:name). */
    query<T = Record<string, any>>(sql: string, ...params: any[]): T[];
    queryOne<T = Record<string, any>>(sql: string, ...params: any[]): T | null;
    /** Run INSERT / UPDATE / DELETE. */
    exec(sql: string, ...params: any[]): { changes: number; lastInsertRowid: number | bigint };
    /** Run multiple statements at once (no parameters). For migrations only. */
    execMulti(sql: string): void;
  };
  fs: {
    /** Read file as UTF-8 text. */
    read(path: string): Promise<string>;
    readBytes(path: string): Promise<Uint8Array>;
    /** Write file (overwrites). Creates parent dir if missing. */
    write(path: string, data: string | Uint8Array): Promise<void>;
    append(path: string, data: string | Uint8Array): Promise<void>;
    exists(path: string): Promise<boolean>;
    stat(path: string): Promise<{ size: number; isFile: boolean; isDirectory: boolean; mtime: number }>;
    list(dir: string): Promise<string[]>;
    mkdir(dir: string, opts?: { recursive?: boolean }): Promise<void>;
    remove(path: string, opts?: { recursive?: boolean }): Promise<void>;
    copy(src: string, dst: string): Promise<void>;
    /** Best-effort MIME type guess from extension. */
    mimeOf(path: string): string;
  };
  os: {
    env(name: string): string;
    cwd(): string;
    platform(): string;
    arch(): string;
    hostname(): string;
  };
  mails: {
    send(opts: {
      to: string;
      cc?: string;
      bcc?: string;
      replyTo?: string;
      from?: string;
      subject: string;
      text?: string;
      html?: string;
      attachments?: Array<{
        filename: string;
        content: string | Uint8Array;
        contentType?: string;
      }>;
    }): Promise<{ messageId: string }>;
  };
  cron: {
    /** Add or replace a cron job by name. Schedule is standard 5-field UTC cron. */
    add(opts: {
      name: string;
      schedule: string;
      code: string;
      enabled?: boolean;
    }): Promise<{ id: string }>;
    /** Remove a cron job by name. */
    remove(name: string): Promise<boolean>;
    list(): Promise<{ id: string; name: string; schedule: string; enabled: boolean }[]>;
  };
  /** Feature flags, as set in the admin. */
  flags: {
    isEnabled(key: string, context?: Record<string, unknown>): Promise<boolean>;
    getString(key: string, fallback: string, context?: Record<string, unknown>): Promise<string>;
    getNumber(key: string, fallback: number, context?: Record<string, unknown>): Promise<number>;
    getJson<T = unknown>(key: string, fallback: T, context?: Record<string, unknown>): Promise<T>;
  };
  webhooks: {
    /** Queue an event for every webhook subscribed to it. */
    dispatch(event: string, data?: unknown): Promise<{ enqueued: number }>;
  };
}
`;
