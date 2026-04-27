import Elysia, { t } from "elysia";
import * as jose from "jose";
import type { AuthContext } from "../core/rules.ts";
import { evaluateRule } from "../core/rules.ts";
import { getCollection } from "../core/collections.ts";
import {
  createRecord,
  deleteRecord,
  getRecord,
  listRecords,
  ReadOnlyCollectionError,
  RestrictError,
  updateRecord,
} from "../core/records.ts";
import { ValidationError } from "../core/validate.ts";
import { recordRuleEval, type RuleOutcome } from "../core/request-context.ts";

/**
 * Run evaluateRule and record the outcome on the request for the logs plugin
 * to flush. Returns the same boolean evaluateRule returns. Centralized so
 * every call site gets the same human-readable reason in logs.
 */
function checkRule(
  request: Request,
  ruleName: string,
  collectionName: string,
  rule: string | null,
  auth: AuthContext | null,
  record: Record<string, unknown> | null
): boolean {
  let outcome: RuleOutcome;
  let reason: string;
  let allowed: boolean;
  if (rule === null) {
    allowed = true;
    outcome = "allow";
    reason = "public";
  } else if (auth?.type === "admin") {
    allowed = true;
    outcome = "allow";
    reason = "admin bypass";
  } else if (rule === "") {
    allowed = false;
    outcome = "deny";
    reason = "admin only";
  } else {
    allowed = evaluateRule(rule, auth, record);
    outcome = allowed ? "allow" : "deny";
    reason = allowed ? "rule passed" : "rule failed";
  }
  recordRuleEval(request, {
    rule: ruleName,
    collection: collectionName,
    expression: rule,
    outcome,
    reason,
  });
  return allowed;
}

/**
 * List rules are applied as SQL filters when set; record that fact so logs
 * surface the behavior. Admin bypass surfaces separately.
 */
function recordListRule(
  request: Request,
  collectionName: string,
  rule: string | null,
  auth: AuthContext | null
): void {
  let outcome: RuleOutcome;
  let reason: string;
  if (rule === null) {
    outcome = "allow"; reason = "public";
  } else if (auth?.type === "admin") {
    outcome = "allow"; reason = "admin bypass";
  } else if (rule === "") {
    outcome = "deny"; reason = "admin only";
  } else {
    outcome = "filter"; reason = "applied as SQL filter";
  }
  recordRuleEval(request, {
    rule: "list_rule",
    collection: collectionName,
    expression: rule,
    outcome,
    reason,
  });
}

function readOnlyResponse(set: { status?: number | string }, err: ReadOnlyCollectionError) {
  set.status = 405;
  return { error: err.message, code: 405 };
}

function validationResponse(set: { status?: number | string }, err: ValidationError) {
  set.status = 422;
  return { error: "Validation failed", code: 422, details: err.details };
}

async function getAuthContext(
  request: Request,
  jwtSecret: string
): Promise<AuthContext | null> {
  const token = request.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) return null;
  const secret = new TextEncoder().encode(jwtSecret);
  try {
    const { payload } = await jose.jwtVerify(token, secret);
    const aud = Array.isArray(payload.aud) ? payload.aud[0] : payload.aud;
    if (aud !== "user" && aud !== "admin") return null;
    const ctx: AuthContext = {
      id: payload["id"] as string,
      type: aud as "user" | "admin",
    };
    if (typeof payload["email"] === "string") ctx.email = payload["email"];
    return ctx;
  } catch {
    return null;
  }
}

export function makeRecordsPlugin(jwtSecret: string) {
  return new Elysia({ name: "records" })
    .get(
      "/api/:collection",
      async ({ params, query, request, set }) => {
        const col = await getCollection(params.collection);
        if (!col) { set.status = 404; return { error: "Collection not found", code: 404 }; }
        const auth = await getAuthContext(request, jwtSecret);

        // null = public; "" = admin only; expression rule → applied as filter
        recordListRule(request, col.name, col.list_rule, auth);
        if (col.list_rule === "") {
          if (auth?.type !== "admin") { set.status = 403; return { error: "Forbidden", code: 403 }; }
        }

        const opts: import("../core/records.ts").ListOptions = {
          page: query.page ? parseInt(query.page) : 1,
          perPage: query.perPage ? parseInt(query.perPage) : 30,
          auth,
        };
        if (query.filter) opts.filter = query.filter;
        if (query.sort) opts.sort = query.sort;
        if (query.expand) opts.expand = query.expand;
        if (query.fields) opts.fields = query.fields;
        if (query.skipTotal === "1" || query.skipTotal === "true") opts.skipTotal = true;
        // Apply expression rule as access filter (admins bypass)
        if (col.list_rule && col.list_rule !== "" && auth?.type !== "admin") {
          opts.accessRule = col.list_rule;
        }
        return listRecords(params.collection, opts);
      },
      {
        query: t.Object({
          page: t.Optional(t.String()),
          perPage: t.Optional(t.String()),
          filter: t.Optional(t.String()),
          sort: t.Optional(t.String()),
          expand: t.Optional(t.String()),
          fields: t.Optional(t.String()),
          skipTotal: t.Optional(t.String()),
        }),
      }
    )
    .get("/api/:collection/:id", async ({ params, request, set }) => {
      const col = await getCollection(params.collection);
      if (!col) { set.status = 404; return { error: "Collection not found", code: 404 }; }
      const auth = await getAuthContext(request, jwtSecret);
      const record = await getRecord(params.collection, params.id);
      if (!record) { set.status = 404; return { error: "Record not found", code: 404 }; }
      if (!checkRule(request, "view_rule", col.name, col.view_rule, auth, record as unknown as Record<string, unknown>)) {
        set.status = 403;
        return { error: "Forbidden", code: 403 };
      }
      return { data: record };
    })
    .post(
      "/api/:collection",
      async ({ params, body, request, set }) => {
        const col = await getCollection(params.collection);
        if (!col) { set.status = 404; return { error: "Collection not found", code: 404 }; }
        const auth = await getAuthContext(request, jwtSecret);
        // For create, rule evaluates against the incoming body
        if (!checkRule(request, "create_rule", col.name, col.create_rule, auth, (body ?? {}) as Record<string, unknown>)) {
          set.status = 403;
          return { error: "Forbidden", code: 403 };
        }
        try {
          const record = await createRecord(params.collection, body as Record<string, unknown>, auth);
          return { data: record };
        } catch (e) {
          if (e instanceof ValidationError) return validationResponse(set, e);
          if (e instanceof ReadOnlyCollectionError) return readOnlyResponse(set, e);
          throw e;
        }
      },
      { body: t.Any() }
    )
    .patch(
      "/api/:collection/:id",
      async ({ params, body, request, set }) => {
        const col = await getCollection(params.collection);
        if (!col) { set.status = 404; return { error: "Collection not found", code: 404 }; }
        const auth = await getAuthContext(request, jwtSecret);
        const existing = await getRecord(params.collection, params.id);
        if (!existing) { set.status = 404; return { error: "Record not found", code: 404 }; }
        if (!checkRule(request, "update_rule", col.name, col.update_rule, auth, existing as unknown as Record<string, unknown>)) {
          set.status = 403;
          return { error: "Forbidden", code: 403 };
        }
        try {
          const record = await updateRecord(params.collection, params.id, body as Record<string, unknown>, auth);
          return { data: record };
        } catch (e) {
          if (e instanceof ValidationError) return validationResponse(set, e);
          if (e instanceof ReadOnlyCollectionError) return readOnlyResponse(set, e);
          throw e;
        }
      },
      { body: t.Any() }
    )
    .delete("/api/:collection/:id", async ({ params, request, set }) => {
      const col = await getCollection(params.collection);
      if (!col) { set.status = 404; return { error: "Collection not found", code: 404 }; }
      const auth = await getAuthContext(request, jwtSecret);
      const existing = await getRecord(params.collection, params.id);
      if (!existing) { set.status = 404; return { error: "Record not found", code: 404 }; }
      if (!checkRule(request, "delete_rule", col.name, col.delete_rule, auth, existing as unknown as Record<string, unknown>)) {
        set.status = 403;
        return { error: "Forbidden", code: 403 };
      }
      try {
        await deleteRecord(params.collection, params.id, auth);
      } catch (e) {
        if (e instanceof ValidationError) return validationResponse(set, e);
        if (e instanceof ReadOnlyCollectionError) return readOnlyResponse(set, e);
        if (e instanceof RestrictError) {
          set.status = 409;
          return { error: e.message, code: 409, details: e.details };
        }
        throw e;
      }
      return { data: null };
    });
}
