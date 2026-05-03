/**
 * MCP Prompts — reusable conversation templates the LLM client can offer
 * as slash-commands. Each prompt yields one or more chat messages with
 * substituted arguments; the model takes it from there.
 *
 * Surface (`prompts/list`):
 *
 *   design-collection         — interview the user, emit a schema spec
 *   debug-request             — given a request id or path, walk logs+audit
 *   audit-rules               — security review of one collection's rules
 *   import-from-pocketbase    — emit a step-by-step migration plan
 *   optimize-schema           — index suggestions, normalisation tips
 *
 * Prompts here are *intentionally* lightweight — the heavy lifting (data
 * lookups, mutations) goes through tools / resources. A prompt's job is
 * to nudge the LLM into the right opening turn.
 */

export interface PromptArg {
  name: string;
  description: string;
  required: boolean;
}

export interface PromptDefinition {
  name: string;
  description: string;
  arguments?: PromptArg[];
}

export interface PromptMessage {
  role: "user" | "assistant";
  content: { type: "text"; text: string };
}

export interface GetPromptResult {
  description?: string;
  messages: PromptMessage[];
}

interface InternalPrompt extends PromptDefinition {
  /** Build the messages from filled-in arguments. */
  build: (args: Record<string, unknown>) => PromptMessage[];
}

const PROMPTS: InternalPrompt[] = [
  {
    name: "design-collection",
    description:
      "Interview the user to design a new Vaultbase collection — fields, types, rules. Ends by calling vaultbase.create_collection.",
    arguments: [
      { name: "topic", description: "What the collection is for (e.g. 'blog posts', 'orders').", required: true },
    ],
    build: (args) => {
      const topic = String(args.topic ?? "<unspecified>");
      return [
        userMsg(
          `You're helping design a new Vaultbase collection for: ${topic}.\n\n` +
          "Walk through these steps in order:\n" +
          "1. Confirm what entities live in this collection and what each one represents.\n" +
          "2. Propose ~5–10 fields (name, type, options) — call out unique constraints, foreign-key relations, encrypted-at-rest candidates.\n" +
          "3. Propose API rules (list / view / create / update / delete) — who can do what.\n" +
          "4. Decide whether to enable record history.\n" +
          "5. Once the user approves, call `vaultbase.create_collection` with the agreed shape.\n\n" +
          "Use `vaultbase.list_collections` first to avoid duplicating an existing one.",
        ),
      ];
    },
  },
  {
    name: "debug-request",
    description:
      "Given a request id (`X-Request-Id`) or a path, walk the logs + audit trail and report likely root cause.",
    arguments: [
      { name: "needle", description: "Request id, path, or any log substring.", required: true },
      { name: "date", description: "Optional YYYY-MM-DD log day. Defaults to today.", required: false },
    ],
    build: (args) => {
      const needle = String(args.needle ?? "");
      const date = typeof args.date === "string" ? args.date : "today";
      return [
        userMsg(
          `Investigate the failure related to: \`${needle}\` (logs from ${date}).\n\n` +
          "Steps:\n" +
          `1. Read \`vaultbase://logs/${date}\` (or call \`vaultbase.read_logs\`) and find entries matching the needle.\n` +
          "2. For any 4xx/5xx, note status, ip, user-agent, request id.\n" +
          "3. Check `vaultbase.read_audit_log` for adjacent state changes.\n" +
          "4. Synthesise: what request, who, when, what failed, likely cause.\n" +
          "Be terse — a one-paragraph summary then a bulleted timeline.",
        ),
      ];
    },
  },
  {
    name: "audit-rules",
    description:
      "Security review of one collection's API rules — surfaces over-permissive patterns, common pitfalls.",
    arguments: [
      { name: "collection", description: "Collection name to review.", required: true },
    ],
    build: (args) => {
      const collection = String(args.collection ?? "<unspecified>");
      return [
        userMsg(
          `Review the API rules for the \`${collection}\` collection.\n\n` +
          `Read \`vaultbase://collection/${collection}\` first. Then evaluate each of the five rules ` +
          "(list / view / create / update / delete) against this checklist:\n\n" +
          "- Is `''` (empty string = full public access) used by accident?\n" +
          "- Does `update` / `delete` confine ownership via `@request.auth.id = field`?\n" +
          "- Are auth-collection rules tight — can a user read another user's row?\n" +
          "- Are encrypted-at-rest fields protected from list? (rules apply to filtering too).\n" +
          "- Any rule that depends on a field the create rule doesn't enforce?\n\n" +
          "Output: a markdown table with rule | verdict | suggested change. Be specific — quote the exact rule text in each row.",
        ),
      ];
    },
  },
  {
    name: "import-from-pocketbase",
    description:
      "Step-by-step plan to migrate a PocketBase deployment into this Vaultbase. Emits commands; does not run them.",
    arguments: [
      { name: "pbDataPath", description: "Path to PocketBase pb_data directory.", required: false },
    ],
    build: (args) => {
      const pb = typeof args.pbDataPath === "string" ? args.pbDataPath : "/path/to/pb_data";
      return [
        userMsg(
          `Plan a migration from PocketBase (data at \`${pb}\`) to this Vaultbase deployment.\n\n` +
          "Cover:\n" +
          "1. Schema export from PB (`pocketbase admin export ...`) → vaultbase create_collection per resource.\n" +
          "2. Data copy strategy — direct SQL? CSV via `vaultbase csv import`?\n" +
          "3. Auth-user migration: hash format compatibility, force password reset.\n" +
          "4. File migration: pb_data/storage → vaultbase uploads dir / S3.\n" +
          "5. Custom hooks: rewrite as Vaultbase JS hooks.\n" +
          "6. Cutover: dual-write window vs. hard cutover.\n\n" +
          "Output as numbered steps with the exact commands to run. Do NOT execute mutating tools — review first.",
        ),
      ];
    },
  },
  {
    name: "optimize-schema",
    description:
      "Inspect current collections and suggest indexes, denormalisations, or splits that would speed up reads.",
    arguments: [],
    build: () => [
      userMsg(
        "Inspect every collection in this Vaultbase and suggest optimisations.\n\n" +
        "Method:\n" +
        "1. Read `vaultbase://collections`.\n" +
        "2. For each, read `vaultbase://collection/{name}` and look at field types + rules.\n" +
        "3. Check `vaultbase.list_indexes` (if available) for current indexes.\n" +
        "4. Suggest:\n" +
        "   - Missing indexes for fields used in rules / common filters.\n" +
        "   - Wide TEXT columns that should split into a child collection.\n" +
        "   - JSON-blob columns whose hot fields should hoist into typed columns.\n" +
        "   - Any collection without `created_at` / `updated_at` indexes (pagination cost).\n\n" +
        "Group output by collection. For each suggestion, note expected impact (small / medium / large).",
      ),
    ],
  },
];

function userMsg(text: string): PromptMessage {
  return { role: "user", content: { type: "text", text } };
}

export function listPrompts(): PromptDefinition[] {
  return PROMPTS.map((p) => {
    const out: PromptDefinition = { name: p.name, description: p.description };
    if (p.arguments && p.arguments.length > 0) out.arguments = p.arguments;
    return out;
  });
}

export function getPrompt(name: string, args: Record<string, unknown>): GetPromptResult {
  const p = PROMPTS.find((x) => x.name === name);
  if (!p) throw new Error(`Unknown prompt: '${name}'`);
  // Validate required args.
  for (const a of p.arguments ?? []) {
    if (a.required && (args[a.name] === undefined || args[a.name] === null || args[a.name] === "")) {
      throw new Error(`Prompt '${name}': missing required argument '${a.name}'`);
    }
  }
  return {
    description: p.description,
    messages: p.build(args),
  };
}
