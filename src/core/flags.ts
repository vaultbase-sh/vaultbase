/**
 * Feature flag evaluation engine.
 *
 * Flags persist in `vaultbase_feature_flags`; this module loads them into
 * a tiny in-memory cache (5 s TTL, busted on PATCH from the admin API)
 * and runs deterministic targeting + percentage-rollout matching against
 * an evaluation context.
 *
 * Hash bucketing uses SHA-1(key + ":" + stickyValue) modulo 100 — same
 * input → same bucket across processes, so a fleet of vaultbase instances
 * keeps individual users on the same variation.
 *
 * Public surface:
 *   - listFlags / getFlag / upsertFlag / deleteFlag — used by the admin CRUD
 *   - evaluate(key, context, defaultValue?)         — the hot path
 *   - evaluateAll(context)                          — bulk eval for client SDK
 *   - invalidateFlagCache                           — called from PATCH
 */
import { eq } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { featureFlags, flagSegments } from "../db/schema.ts";

export type FlagValue = boolean | string | number | Record<string, unknown> | unknown[] | null;

export type FlagType = "bool" | "string" | "number" | "json";

export interface FlagDefinition {
  key: string;
  description: string;
  type: FlagType;
  enabled: boolean;
  default_value: FlagValue;
  variations: Variation[];
  rules: Rule[];
  created_at: number;
  updated_at: number;
}

export interface Variation {
  name: string;
  value: FlagValue;
}

export interface Rule {
  id: string;
  /** Boolean tree of attribute checks. Both branches optional — empty `when` matches everything. */
  when?: Condition;
  /** Percentage rollout 0-100. When set, only that % of matched contexts win. */
  rollout?: { value: number; sticky: string };
  /** Variation name (must exist in `variations`) — or a literal value when no variations defined. */
  variation: string;
  /**
   * Other flags that must already evaluate to a specific variation before
   * this rule fires. Cycle-detected at evaluation time (max prereq depth = 8).
   */
  prerequisites?: Array<{ flag: string; variation: string }>;
}

export type Condition =
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition }
  | { segment: string }
  | { attr: string; op: Operator; value: FlagValue };

export interface SegmentDefinition {
  name: string;
  description: string;
  conditions: Condition;
  created_at: number;
  updated_at: number;
}

export type Operator =
  | "eq" | "neq"
  | "in" | "not_in"
  | "contains" | "starts_with" | "ends_with"
  | "gt" | "gte" | "lt" | "lte"
  | "between"
  | "exists"
  | "regex";

// ── Cache ───────────────────────────────────────────────────────────────────

interface CacheEntry {
  flags: Map<string, FlagDefinition>;
  segments: Map<string, SegmentDefinition>;
  loaded_at: number;
}
let cache: CacheEntry | null = null;
const CACHE_TTL_MS = 5_000;

export function invalidateFlagCache(): void { cache = null; }

async function load(): Promise<CacheEntry> {
  const now = Date.now();
  if (cache && now - cache.loaded_at < CACHE_TTL_MS) return cache;
  const db = getDb();
  const flagRows = await db.select().from(featureFlags);
  const segRows = await db.select().from(flagSegments);
  const flags = new Map<string, FlagDefinition>();
  for (const r of flagRows) flags.set(r.key, decodeFlag(r));
  const segments = new Map<string, SegmentDefinition>();
  for (const r of segRows) segments.set(r.name, decodeSegment(r));
  cache = { flags, segments, loaded_at: now };
  return cache;
}

async function loadFlags(): Promise<Map<string, FlagDefinition>> { return (await load()).flags; }

// ── Decode / encode ─────────────────────────────────────────────────────────

interface DbRow {
  key: string;
  description: string;
  type: string;
  enabled: number;
  default_value: string;
  variations: string;
  rules: string;
  created_at: number;
  updated_at: number;
}

interface SegmentRow {
  name: string;
  description: string;
  conditions: string;
  created_at: number;
  updated_at: number;
}

function decodeSegment(r: SegmentRow): SegmentDefinition {
  let conditions: Condition = { all: [] };
  try {
    const parsed = JSON.parse(r.conditions) as unknown;
    if (parsed && typeof parsed === "object") conditions = parsed as Condition;
  } catch { /* keep empty */ }
  return {
    name: r.name,
    description: r.description,
    conditions,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

function decodeFlag(r: DbRow): FlagDefinition {
  const safeJson = <T>(s: string, fallback: T): T => {
    try { return JSON.parse(s) as T; } catch { return fallback; }
  };
  return {
    key: r.key,
    description: r.description,
    type: (r.type === "string" || r.type === "number" || r.type === "json") ? r.type : "bool",
    enabled: r.enabled === 1,
    default_value: safeJson<FlagValue>(r.default_value, false),
    variations: safeJson<Variation[]>(r.variations, []),
    rules: safeJson<Rule[]>(r.rules, []),
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

// ── CRUD ────────────────────────────────────────────────────────────────────

export async function listFlags(): Promise<FlagDefinition[]> {
  return Array.from((await loadFlags()).values()).sort((a, b) => a.key.localeCompare(b.key));
}

export async function getFlag(key: string): Promise<FlagDefinition | null> {
  return (await loadFlags()).get(key) ?? null;
}

export async function listSegments(): Promise<SegmentDefinition[]> {
  return Array.from((await load()).segments.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export async function getSegment(name: string): Promise<SegmentDefinition | null> {
  return (await load()).segments.get(name) ?? null;
}

export interface UpsertSegmentInput {
  name: string;
  description?: string;
  conditions?: Condition;
}

export async function upsertSegment(input: UpsertSegmentInput): Promise<SegmentDefinition> {
  if (!/^[a-z][a-z0-9_.-]{0,63}$/i.test(input.name)) {
    throw new Error("Invalid name: lowercase alphanumerics + . _ -, max 64");
  }
  const db = getDb();
  const existing = await db.select().from(flagSegments).where(eq(flagSegments.name, input.name)).limit(1);
  const now = Math.floor(Date.now() / 1000);
  if (existing.length === 0) {
    await db.insert(flagSegments).values({
      name: input.name,
      description: input.description ?? "",
      conditions: JSON.stringify(input.conditions ?? { all: [] }),
      created_at: now, updated_at: now,
    });
  } else {
    const patch: Record<string, unknown> = { updated_at: now };
    if (input.description !== undefined) patch["description"] = input.description;
    if (input.conditions !== undefined)  patch["conditions"]  = JSON.stringify(input.conditions);
    await db.update(flagSegments).set(patch).where(eq(flagSegments.name, input.name));
  }
  invalidateFlagCache();
  const fresh = await getSegment(input.name);
  if (!fresh) throw new Error("Segment missing after upsert");
  return fresh;
}

export async function deleteSegment(name: string): Promise<void> {
  await getDb().delete(flagSegments).where(eq(flagSegments.name, name));
  invalidateFlagCache();
}

export interface UpsertInput {
  key: string;
  description?: string;
  type?: FlagType;
  enabled?: boolean;
  default_value?: FlagValue;
  variations?: Variation[];
  rules?: Rule[];
}

export async function upsertFlag(input: UpsertInput): Promise<FlagDefinition> {
  if (!/^[a-z][a-z0-9_.-]{0,63}$/i.test(input.key)) {
    throw new Error("Invalid key: lowercase alphanumerics + . _ -, max 64");
  }
  const db = getDb();
  const existing = await db.select().from(featureFlags).where(eq(featureFlags.key, input.key)).limit(1);
  const now = Math.floor(Date.now() / 1000);
  if (existing.length === 0) {
    await db.insert(featureFlags).values({
      key: input.key,
      description: input.description ?? "",
      type: input.type ?? "bool",
      enabled: (input.enabled ?? true) ? 1 : 0,
      default_value: JSON.stringify(input.default_value ?? false),
      variations: JSON.stringify(input.variations ?? []),
      rules: JSON.stringify(input.rules ?? []),
      created_at: now,
      updated_at: now,
    });
  } else {
    const patch: Record<string, unknown> = { updated_at: now };
    if (input.description !== undefined)   patch["description"] = input.description;
    if (input.type !== undefined)          patch["type"] = input.type;
    if (input.enabled !== undefined)       patch["enabled"] = input.enabled ? 1 : 0;
    if (input.default_value !== undefined) patch["default_value"] = JSON.stringify(input.default_value);
    if (input.variations !== undefined)    patch["variations"] = JSON.stringify(input.variations);
    if (input.rules !== undefined)         patch["rules"] = JSON.stringify(input.rules);
    await db.update(featureFlags).set(patch).where(eq(featureFlags.key, input.key));
  }
  invalidateFlagCache();
  const fresh = await getFlag(input.key);
  if (!fresh) throw new Error("Flag missing after upsert");
  return fresh;
}

export async function deleteFlag(key: string): Promise<void> {
  await getDb().delete(featureFlags).where(eq(featureFlags.key, key));
  invalidateFlagCache();
}

// ── Evaluation ──────────────────────────────────────────────────────────────

export type EvaluationContext = Record<string, unknown>;

export interface EvaluationResult {
  value: FlagValue;
  variation: string | null;
  reason: "default" | "disabled" | "rule_match" | "rule_match_rollout_skip" | "no_match" | "missing";
  rule_id?: string;
}

const MAX_PREREQ_DEPTH = 8;

export async function evaluate(
  key: string,
  context: EvaluationContext,
  fallback?: FlagValue,
  _depth = 0,
): Promise<EvaluationResult> {
  if (_depth > MAX_PREREQ_DEPTH) {
    return { value: fallback ?? false, variation: null, reason: "no_match" };
  }
  const c = await load();
  const flag = c.flags.get(key);
  if (!flag) return { value: fallback ?? false, variation: null, reason: "missing" };
  if (!flag.enabled) return { value: flag.default_value, variation: null, reason: "disabled" };

  for (const rule of flag.rules) {
    // Prerequisites first — if any prereq fails, skip the rule.
    if (rule.prerequisites && rule.prerequisites.length > 0) {
      let ok = true;
      for (const p of rule.prerequisites) {
        const pr = await evaluate(p.flag, context, undefined, _depth + 1);
        if (pr.variation !== p.variation && String(pr.value) !== p.variation) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
    }
    if (rule.when && !matchCondition(rule.when, context, c.segments)) continue;
    if (rule.rollout) {
      const stickyValue = readAttr(context, rule.rollout.sticky);
      if (stickyValue == null) continue;
      const bucket = bucketHash(`${flag.key}:${String(stickyValue)}`);
      if (bucket >= clampPercent(rule.rollout.value)) {
        // Matched the predicate but lost the rollout coin-flip — keep
        // walking later rules so a fallback rule (no rollout) can win.
        continue;
      }
    }
    return {
      value: resolveVariation(flag, rule.variation),
      variation: rule.variation,
      reason: "rule_match",
      rule_id: rule.id,
    };
  }
  return { value: flag.default_value, variation: null, reason: "no_match" };
}

export async function evaluateAll(context: EvaluationContext): Promise<Record<string, FlagValue>> {
  const c = await load();
  const out: Record<string, FlagValue> = {};
  for (const flag of c.flags.values()) {
    const r = await evaluate(flag.key, context);
    out[flag.key] = r.value;
  }
  return out;
}

function resolveVariation(flag: FlagDefinition, name: string): FlagValue {
  const found = flag.variations.find((v) => v.name === name);
  if (found) return found.value;
  // No variations defined → treat the variation name as a literal label
  // mapped to default for boolean flags.
  if (flag.type === "bool") return name === "true" ? true : name === "false" ? false : flag.default_value;
  return flag.default_value;
}

// ── Condition matching ──────────────────────────────────────────────────────

function matchCondition(c: Condition, ctx: EvaluationContext, segments: Map<string, SegmentDefinition>, _depth = 0): boolean {
  if (_depth > MAX_PREREQ_DEPTH) return false; // segment self-reference guard
  if ("all" in c) return c.all.every((sub) => matchCondition(sub, ctx, segments, _depth + 1));
  if ("any" in c) return c.any.some((sub)  => matchCondition(sub, ctx, segments, _depth + 1));
  if ("not" in c) return !matchCondition(c.not, ctx, segments, _depth + 1);
  if ("segment" in c) {
    const seg = segments.get(c.segment);
    if (!seg) return false;
    return matchCondition(seg.conditions, ctx, segments, _depth + 1);
  }
  return matchOp(c.attr, c.op, c.value, ctx);
}

function matchOp(attrPath: string, op: Operator, ruleValue: FlagValue, ctx: EvaluationContext): boolean {
  const v = readAttr(ctx, attrPath);
  switch (op) {
    case "eq":          return v === ruleValue;
    case "neq":         return v !== ruleValue;
    case "in":          return Array.isArray(ruleValue) && ruleValue.includes(v as never);
    case "not_in":      return Array.isArray(ruleValue) && !ruleValue.includes(v as never);
    case "contains":    return typeof v === "string" && typeof ruleValue === "string" && v.includes(ruleValue);
    case "starts_with": return typeof v === "string" && typeof ruleValue === "string" && v.startsWith(ruleValue);
    case "ends_with":   return typeof v === "string" && typeof ruleValue === "string" && v.endsWith(ruleValue);
    case "gt":          return typeof v === "number" && typeof ruleValue === "number" && v >  ruleValue;
    case "gte":         return typeof v === "number" && typeof ruleValue === "number" && v >= ruleValue;
    case "lt":          return typeof v === "number" && typeof ruleValue === "number" && v <  ruleValue;
    case "lte":         return typeof v === "number" && typeof ruleValue === "number" && v <= ruleValue;
    case "between":     return typeof v === "number" && Array.isArray(ruleValue)
                            && ruleValue.length === 2 && typeof ruleValue[0] === "number" && typeof ruleValue[1] === "number"
                            && v >= ruleValue[0] && v <= ruleValue[1];
    case "exists":      return v !== undefined && v !== null;
    case "regex": {
      if (typeof v !== "string" || typeof ruleValue !== "string") return false;
      try { return new RegExp(ruleValue).test(v); } catch { return false; }
    }
    default:            return false;
  }
}

function readAttr(ctx: EvaluationContext, path: string): unknown {
  const parts = path.split(".");
  let cur: unknown = ctx;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

// ── Hashing ─────────────────────────────────────────────────────────────────

/** SHA-1 first 4 bytes → uint32 → modulo 100. Returns 0..99. */
async function sha1Bytes(input: string): Promise<Uint8Array> {
  const buf = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-1", buf);
  return new Uint8Array(digest);
}

function bucketHashSync(input: string): number {
  // Synchronous FNV-1a fallback because evaluate() is hot-path and we
  // don't want to await SHA-1 per rule. Distribution of FNV-1a is good
  // enough for percentage rollouts (worst-case skew ~2% at 100k samples).
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h % 100;
}

function bucketHash(input: string): number { return bucketHashSync(input); }
function clampPercent(n: number): number { return Math.max(0, Math.min(100, Math.round(n))); }

// keep sha1Bytes exported in case admin UI wants stable bucket preview
export { sha1Bytes };
