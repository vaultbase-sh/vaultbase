/**
 * MCP admin REST surface — backs the `/_/mcp` admin SPA page.
 *
 *   GET /admin/mcp/clients   — currently-connected SSE clients (live)
 *   GET /admin/mcp/catalog   — enumerated tools / resources / prompts
 *
 * Both endpoints require the same admin JWT the rest of the SPA uses
 * (audience: "admin"). The catalog endpoint constructs an empty
 * ToolContext purely for description rendering; no tool handler runs,
 * so no scopes are exercised.
 */

import Elysia from "elysia";
import { listMcpEventClients } from "../mcp/events.ts";
import { buildRegistry } from "../mcp/server.ts";
import { listResources, listResourceTemplates } from "../mcp/resources.ts";
import { listPrompts } from "../mcp/prompts.ts";
import { adminGuard } from "./_admin.ts";

export function makeMcpAdminPlugin(jwtSecret: string) {
  return new Elysia({ name: "mcp-admin" })
    .use(adminGuard(jwtSecret))
    .get("/admin/mcp/clients", async () => {
      return { data: listMcpEventClients() };
    }, { requireAdmin: { cookie: true } })
    .get("/admin/mcp/catalog", async () => {
      const reg = await buildRegistry(false);
      const tools = reg.list();
      const resources = listResources();
      const templates = listResourceTemplates();
      const prompts = listPrompts();
      return {
        data: {
          tools,
          resources,
          resourceTemplates: templates,
          prompts,
          counts: {
            tools: tools.length,
            resources: resources.length,
            templates: templates.length,
            prompts: prompts.length,
          },
        },
      };
    }, { requireAdmin: { cookie: true } });
}
