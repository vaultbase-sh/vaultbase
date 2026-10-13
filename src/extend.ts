/**
 * Everything an extension can register, in one place. Each `register*`
 * returns a function that removes what it added.
 *
 *   on("record.created", ({ collection, record }) => { ... });
 *   registerFieldType({ type: "money", sqlType: "INTEGER", ... });
 *   registerRoute({ name: "stats", method: "GET", path: "/stats/:id", handle: (ctx) => ... });
 *
 * This is the surface the plugin API is built on; until that lands, code
 * that embeds Vaultbase (`createServer`) can call these before starting it.
 */

// Events
export { on, emit, type VaultbaseEvents, type VaultbaseEventName, type RecordEventSource } from "./core/events.ts";

// Data
export { registerFieldType, listFieldTypes, type FieldTypeDef } from "./core/field-types.ts";

// Providers and drivers
export { registerOAuthProvider, listOAuthProviders, type ProviderDef as OAuthProviderDef, type NormalizedProfile } from "./core/oauth2.ts";
export { registerStorageDriver, listStorageDrivers, type StorageDriverDef, type StorageBackend } from "./core/storage.ts";
export { registerEmailTransport, listEmailTransports, type EmailTransportDef, type EmailMessage } from "./core/email.ts";
export { registerPushProvider, listPushProviders, type PushProviderDef, type PushSendContext } from "./core/notifications.ts";

// Code
export { registerHook, type HookRegistration, type HookContext, type HookEvent } from "./core/hooks.ts";
export { registerRoute, type RouteRegistration, type RouteContext } from "./core/routes.ts";
export { registerJob, type JobRegistration } from "./core/jobs.ts";
export { registerWorker, type BuiltinWorkerSpec as WorkerRegistration } from "./core/queues.ts";
export { registerCodeLoader, type CodeLoader } from "./core/code-loader.ts";
