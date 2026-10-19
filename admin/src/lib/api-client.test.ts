import { describe, expect, it } from "bun:test";
import {
  applyUrlEdit, curlSnippet, displayUrl, fetchSnippet, missingPathValues, newRequest, parseUrl,
  pathParamNames, requestFromPreset, requestHeaders, resolvedUrl, sdkSnippet, toHttpFile,
  toInsomnia, toPostman, storableRequest, pushHistory, parseSaved, savedRequestsKey, HISTORY_LIMIT,
} from "./api-client.ts";
import type { Preset } from "./api-presets.ts";

const ORIGIN = "https://api.example.com";

describe("URL and params", () => {
  it("split the URL bar into path and params, decoding values", () => {
    expect(parseUrl("/api/v1/posts?perPage=10&filter=title%20%3D%20%22a%22&flag")).toEqual({
      path: "/api/v1/posts",
      params: [
        { key: "perPage", value: "10", on: true },
        { key: "filter", value: 'title = "a"', on: true },
        { key: "flag", value: "", on: true },
      ],
    });
  });

  it("show params readably and keep disabled rows out of the URL", () => {
    const r = newRequest({ path: "/api/v1/posts", params: [
      { key: "filter", value: 'views > 3 && status = "live"', on: true },
      { key: "sort", value: "-created", on: false },
    ] });
    expect(displayUrl(r)).toBe('/api/v1/posts?filter=views%20>%203%20%26%26%20status%20%3D%20"live"');
    expect(parseUrl(displayUrl(r)).params[0]!.value).toBe('views > 3 && status = "live"');
  });

  it("keep disabled params when the URL bar is edited", () => {
    const r = newRequest({ path: "/api/v1/posts", params: [{ key: "sort", value: "-created", on: false }] });
    const next = applyUrlEdit(r, "/api/v1/posts?perPage=5");
    expect(next.params).toEqual([{ key: "perPage", value: "5", on: true }, { key: "sort", value: "-created", on: false }]);
  });

  it("fill path values, and say which are missing", () => {
    const r = newRequest({ path: "/api/v1/files/{collection}/{recordId}/{field}", pathValues: { collection: "posts", recordId: "a b" } });
    expect(pathParamNames(r.path)).toEqual(["collection", "recordId", "field"]);
    expect(resolvedUrl(r)).toBe("/api/v1/files/posts/a%20b/{field}");
    expect(missingPathValues(r)).toEqual(["field"]);
  });

  it("open a preset with its params and JSON body", () => {
    const r = requestFromPreset({ method: "POST", path: "/api/v1/posts", summary: "", group: "posts", body: '{"title":""}' });
    expect(r).toMatchObject({ method: "POST", path: "/api/v1/posts", bodyMode: "json", body: '{"title":""}' });
    const list = requestFromPreset({ method: "GET", path: "/api/v1/posts?perPage=10", summary: "", group: "posts" });
    expect(list.params).toEqual([{ key: "perPage", value: "10", on: true }]);
  });

  it("send Content-Type only with a JSON body, and enabled headers", () => {
    const r = newRequest({ method: "POST", bodyMode: "json", headers: [{ key: "X-A", value: "1", on: true }, { key: "X-B", value: "2", on: false }] });
    expect(requestHeaders(r)).toEqual({ "Content-Type": "application/json", "X-A": "1" });
    expect(requestHeaders({ ...r, method: "GET" })).toEqual({ "X-A": "1" });
  });
});

describe("snippets", () => {
  const create = newRequest({ method: "POST", path: "/api/v1/posts", bodyMode: "json", body: '{ "title": "it\'s" }' });

  it("curl quotes safely and leaves the token out", () => {
    const s = curlSnippet(create, ORIGIN);
    expect(s).toContain("curl -X POST 'https://api.example.com/api/v1/posts'");
    expect(s).toContain("-H 'Authorization: Bearer <token>'");
    expect(s).toContain(`-d '{ "title": "it'\\''s" }'`);
    expect(curlSnippet({ ...create, auth: { mode: "none" } }, ORIGIN)).not.toContain("Authorization");
  });

  it("fetch() builds the body with JSON.stringify", () => {
    expect(fetchSnippet(create, ORIGIN)).toContain(`body: JSON.stringify({ "title": "it's" }),`);
  });

  it("SDK calls for collections, singletons, auth and custom routes", () => {
    const sdk = (r: Parameters<typeof sdkSnippet>[0], kinds = {}) => sdkSnippet(r, ORIGIN, kinds).split("\n").pop();
    expect(sdk(newRequest({ path: "/api/v1/posts", params: [{ key: "perPage", value: "10", on: true }, { key: "filter", value: "views > 1", on: true }] })))
      .toBe(`const { data, totalItems } = await vb.collection("posts").list({ perPage: 10, filter: "views > 1" });`);
    expect(sdk(create)).toBe(`const record = await vb.collection("posts").create({ "title": "it's" });`);
    expect(sdk(newRequest({ method: "DELETE", path: "/api/v1/posts/{id}", pathValues: { id: "r1" } }))).toBe(`await vb.collection("posts").delete("r1");`);
    expect(sdk(newRequest({ path: "/api/v1/posts/{id}" }))).toBe(`const record = await vb.collection("posts").get("<id>");`);
    expect(sdk(newRequest({ path: "/api/v1/site" }), { site: "singleton" })).toBe(`const record = await vb.singleton("site").get();`);
    expect(sdk(newRequest({ method: "POST", path: "/api/v1/auth/members/login", bodyMode: "json", body: '{"email":"a@b.c","password":"x"}' })))
      .toBe(`const { token, record } = await vb.auth.members.login({"email":"a@b.c","password":"x"});`);
    expect(sdk(newRequest({ method: "POST", path: "/api/v1/auth/members/request-password-reset", bodyMode: "json", body: '{"email":"a@b.c"}' })))
      .toBe(`await vb.auth.members.requestPasswordReset("a@b.c");`);
    expect(sdk(newRequest({ path: "/api/v1/custom/stats" }))).toBe(`const data = await vb.custom.get("/stats");`);
    expect(sdk(newRequest({ path: "/api/v1/admin/logs" }))).toContain("no helper");
  });
});

describe("export", () => {
  const presets: Preset[] = [
    { method: "GET", path: "/api/v1/posts?perPage=10", summary: "List posts", group: "posts" },
    { method: "PATCH", path: "/api/v1/posts/{id}", summary: "Update a posts record", group: "posts", body: '{"title":""}' },
    { method: "POST", path: "/api/v1/auth/members/login", summary: "Log in", group: "members auth", body: '{"email":""}' },
  ];

  it("Postman: v2.1 collection, folders per group, :id path variables", () => {
    const pm = JSON.parse(toPostman(presets, ORIGIN));
    expect(pm.info.schema).toContain("v2.1.0");
    expect(pm.variable).toEqual([{ key: "baseUrl", value: ORIGIN }, { key: "token", value: "" }]);
    expect(pm.item.map((f: { name: string }) => f.name)).toEqual(["posts", "members auth"]);
    const upd = pm.item[0].item[1].request;
    expect(upd.url.raw).toBe("{{baseUrl}}/api/v1/posts/:id");
    expect(upd.url.variable).toEqual([{ key: "id", value: "" }]);
    expect(upd.body.raw).toBe('{"title":""}');
    expect(pm.item[0].item[0].request.url.query).toEqual([{ key: "perPage", value: "10" }]);
  });

  it("Insomnia: export format 4 with a base environment", () => {
    const ins = JSON.parse(toInsomnia(presets, ORIGIN));
    expect(ins.__export_format).toBe(4);
    const env = ins.resources.find((r: { _type: string }) => r._type === "environment");
    expect(env.data.baseUrl).toBe(ORIGIN);
    const reqs = ins.resources.filter((r: { _type: string }) => r._type === "request");
    expect(reqs).toHaveLength(3);
    expect(reqs[1].url).toBe("{{ _.baseUrl }}/api/v1/posts/{id}");
    const folders = ins.resources.filter((r: { _type: string }) => r._type === "request_group");
    expect(reqs[2].parentId).toBe(folders[1]._id);
  });

  it(".http: variables up top, one ### block per request", () => {
    const http = toHttpFile(presets, ORIGIN);
    expect(http.startsWith(`@baseUrl = ${ORIGIN}\n@token = \n`)).toBe(true);
    expect(http.match(/^### /gm)).toHaveLength(3);
    expect(http).toContain('PATCH {{baseUrl}}/api/v1/posts/{id}\nAuthorization: Bearer {{token}}\nContent-Type: application/json\n\n{"title":""}');
  });
});

describe("history and saved requests", () => {
  it("store requests without tokens or files", () => {
    const file = new File(["x"], "a.txt");
    const r = newRequest({ auth: { mode: "bearer", token: "secret" }, form: [{ key: "f", value: "", on: true, file }] });
    const s = storableRequest(r);
    expect(s.auth).toEqual({ mode: "bearer" });
    expect(JSON.stringify(s)).not.toContain("secret");
    expect(s.form[0]).toEqual({ key: "f", value: "", on: true });
  });

  it("keep history newest first, capped, without back-to-back repeats", () => {
    let h: ReturnType<typeof pushHistory> = [];
    const a = newRequest({ path: "/api/v1/a" });
    h = pushHistory(h, { at: 1, status: 200, req: a });
    h = pushHistory(h, { at: 2, status: 404, req: { ...a } });
    expect(h.map((e) => e.at)).toEqual([2]);
    for (let i = 0; i < 60; i++) h = pushHistory(h, { at: 10 + i, status: 200, req: newRequest({ path: `/p${i}` }) });
    expect(h).toHaveLength(HISTORY_LIMIT);
    expect(h[0]!.req.path).toBe("/p59");
  });

  it("read saved requests leniently", () => {
    expect(parseSaved(undefined)).toEqual([]);
    expect(parseSaved("not json")).toEqual([]);
    const saved = parseSaved(JSON.stringify([{ name: "Posts", req: { method: "GET", path: "/api/v1/posts" } }, { bogus: true }]));
    expect(saved).toHaveLength(1);
    expect(saved[0]!.req).toMatchObject({ method: "GET", path: "/api/v1/posts", params: [], auth: { mode: "admin" } });
    expect(savedRequestsKey("a1")).toBe("admin.api_saved.a1");
  });
});
