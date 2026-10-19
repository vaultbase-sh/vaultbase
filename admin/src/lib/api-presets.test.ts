import { describe, expect, it } from "bun:test";
import { groupPresets, matchesPreset, presetsFromSpec, sampleFor, type OpenApiSpec } from "./api-presets.ts";

// The shapes the server's spec builder (src/core/openapi.ts) produces.
const spec: OpenApiSpec = {
  paths: {
    "/api/v1/posts": {
      get: { summary: "List posts", tags: ["posts"], parameters: [{ name: "perPage", in: "query" }] },
      post: { summary: "Create a posts record", tags: ["posts"], requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/PostsInput" } } } } },
    },
    "/api/v1/posts/{id}": {
      get: { summary: "Get a posts record", tags: ["posts"] },
      delete: { summary: "Delete a posts record", tags: ["posts"] },
    },
    "/api/v1/site": {
      get: { summary: "Get the site singleton", tags: ["site"] },
      patch: { summary: "Update the site singleton", tags: ["site"], requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/SiteInput" } } } } },
    },
    "/api/v1/auth/members/login": {
      post: { summary: "Log in", tags: ["members auth"], requestBody: { content: { "application/json": { schema: { type: "object", properties: { email: { type: "string", format: "email" }, password: { type: "string" } } } } } } },
    },
    "/api/v1/files/{filename}": { get: { summary: "Download a file", tags: ["files"] } },
  },
  components: {
    schemas: {
      PostsInput: { type: "object", properties: { title: { type: "string" }, views: { type: "integer" }, status: { type: "string", enum: ["draft", "live"] }, tags: { type: "array" }, id: { type: "string", readOnly: true } } },
      SiteInput: { type: "object", properties: { maintenance: { type: ["boolean", "null"] } } },
    },
  },
};

describe("API preview presets", () => {
  const presets = presetsFromSpec(spec);
  const find = (m: string, p: string) => presets.find((x) => x.method === m && x.path.split("?")[0] === p);

  it("list every operation in the spec", () => {
    expect(presets.map((p) => `${p.method} ${p.path}`)).toEqual([
      "GET /api/v1/posts?perPage=10", "POST /api/v1/posts", "GET /api/v1/posts/{id}", "DELETE /api/v1/posts/{id}",
      "GET /api/v1/site", "PATCH /api/v1/site", "POST /api/v1/auth/members/login", "GET /api/v1/files/{filename}",
    ]);
  });

  it("page only operations that take perPage, so a singleton GET stays bare", () => {
    expect(find("GET", "/api/v1/site")!.path).toBe("/api/v1/site");
  });

  it("build sample bodies from the schemas", () => {
    expect(JSON.parse(find("POST", "/api/v1/posts")!.body!)).toEqual({ title: "", views: 0, status: "draft", tags: [] });
    expect(JSON.parse(find("PATCH", "/api/v1/site")!.body!)).toEqual({ maintenance: false });
    expect(JSON.parse(find("POST", "/api/v1/auth/members/login")!.body!)).toEqual({ email: "user@example.com", password: "" });
    expect(find("GET", "/api/v1/posts/{id}")!.body).toBeUndefined();
  });

  it("know which collection a path is about, not for auth or files routes", () => {
    expect(find("GET", "/api/v1/posts/{id}")!.collection).toBe("posts");
    expect(find("POST", "/api/v1/auth/members/login")!.collection).toBeUndefined();
    expect(find("GET", "/api/v1/files/{filename}")!.collection).toBeUndefined();
  });

  it("group by tag in spec order, and filter on method, path or summary", () => {
    expect(groupPresets(presets).map((g) => g.group)).toEqual(["posts", "site", "members auth", "files"]);
    expect(presets.filter((p) => matchesPreset(p, "singleton")).length).toBe(2);
    expect(presets.filter((p) => matchesPreset(p, "delete")).length).toBe(1);
  });

  it("stop on deep or unknown schemas", () => {
    expect(sampleFor(spec, { $ref: "#/components/schemas/Missing" })).toBeNull();
  });
});
