import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import { makeExtraHelpers } from "../core/hook-helpers-extra.ts";
import { initDb, closeDb } from "../db/client.ts";

const h = makeExtraHelpers();

describe("security", () => {
  it("hash/sha256 matches a known vector", async () => {
    // sha256("abc") = ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
    expect(await h.security.hash("sha256", "abc"))
      .toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("hmac/sha256 matches a known vector (RFC 4231 case 1)", async () => {
    const key = new Uint8Array(20).fill(0x0b);
    const data = new TextEncoder().encode("Hi There");
    expect(await h.security.hmac("sha256", key, data))
      .toBe("b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7");
  });

  it("randomString / randomBytes produce expected lengths", () => {
    expect(h.security.randomString(16)).toHaveLength(32); // hex
    expect(h.security.randomString(15, "base64url")).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(h.security.randomBytes(8).byteLength).toBe(8);
  });

  it("rejects bogus input bounds", () => {
    expect(() => h.security.randomString(0)).toThrow();
    expect(() => h.security.randomString(2000)).toThrow();
    expect(() => h.security.randomBytes(-1)).toThrow();
  });

  it("jwtSign + jwtVerify round-trip", async () => {
    const token = await h.security.jwtSign({ sub: "user1", role: "admin" }, "secret-key", {
      expiresIn: "1h",
      issuer: "vb",
    });
    const payload = await h.security.jwtVerify(token, "secret-key", { issuer: "vb" });
    expect(payload["sub"]).toBe("user1");
    expect(payload["role"]).toBe("admin");
  });

  it("jwtVerify rejects wrong secret", async () => {
    const token = await h.security.jwtSign({ sub: "x" }, "k1");
    await expect(h.security.jwtVerify(token, "k2")).rejects.toThrow();
  });

  it("constantTimeEqual differentiates equal vs unequal", () => {
    expect(h.security.constantTimeEqual("abc", "abc")).toBe(true);
    expect(h.security.constantTimeEqual("abc", "abd")).toBe(false);
    expect(h.security.constantTimeEqual("abc", "abcd")).toBe(false);
  });
});

describe("path", () => {
  it("join collapses redundant separators", () => {
    expect(h.path.join("a", "b", "c")).toBe("a/b/c");
    expect(h.path.join("a/", "/b/", "c")).toBe("a/b/c");
    expect(h.path.join("/root", "x", "..", "y")).toBe("/root/y");
  });

  it("basename / dirname / ext", () => {
    expect(h.path.basename("/foo/bar/baz.txt")).toBe("baz.txt");
    expect(h.path.basename("/foo/bar/baz.txt", ".txt")).toBe("baz");
    expect(h.path.dirname("/foo/bar/baz.txt")).toBe("/foo/bar");
    expect(h.path.dirname("foo")).toBe(".");
    expect(h.path.ext("foo.tar.gz")).toBe(".gz");
    expect(h.path.ext("noext")).toBe("");
    expect(h.path.ext(".dotfile")).toBe("");
  });

  it("normalize resolves ..", () => {
    expect(h.path.normalize("/a/b/../c")).toBe("/a/c");
    expect(h.path.normalize("a/./b//c/")).toBe("a/b/c");
  });
});

describe("template", () => {
  it("renders {{var}} substitutions with dotted paths", () => {
    expect(h.template.render("Hi {{user.name}}!", { user: { name: "Ada" } }))
      .toBe("Hi Ada!");
  });

  it("renders {{#if}} blocks", () => {
    const tpl = "Hi{{#if showAge}} age={{age}}{{/if}}.";
    expect(h.template.render(tpl, { showAge: true, age: 30 })).toBe("Hi age=30.");
    expect(h.template.render(tpl, { showAge: false, age: 30 })).toBe("Hi.");
  });

  it("missing vars render as empty string", () => {
    expect(h.template.render("[{{nope.x.y}}]", {})).toBe("[]");
  });

  it("escapeHtml escapes the canonical 5", () => {
    expect(h.template.escapeHtml(`<a href="x" onclick='y'>&</a>`))
      .toBe("&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;");
  });
});

describe("util", () => {
  it("sleep resolves after the given ms", async () => {
    const t0 = Date.now();
    await h.util.sleep(20);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(15);
  });

  it("unmarshal returns parsed value or null", () => {
    expect(h.util.unmarshal<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
    expect(h.util.unmarshal("not-json")).toBeNull();
  });

  it("readerToString reads a Response", async () => {
    const res = new Response("hello world");
    expect(await h.util.readerToString(res)).toBe("hello world");
  });
});

describe("http", () => {
  it("retries on 5xx and eventually returns", async () => {
    let calls = 0;
    const origFetch = globalThis.fetch;
    (globalThis as { fetch: unknown }).fetch = async (_url: unknown, _init: unknown) => {
      calls++;
      if (calls < 3) return new Response("fail", { status: 503 });
      return new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } });
    };
    try {
      const r = await h.http.request({
        url: "http://example.invalid/",
        retries: 5,
        retryDelayMs: 1,
      });
      expect(calls).toBe(3);
      expect(r.status).toBe(200);
      expect((r.json as { ok: boolean }).ok).toBe(true);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  // shipment 2 — fs / os / db tests live below

  it("encodes JSON body + content-type by default", async () => {
    let captured: { url: string; init: RequestInit | undefined } | null = null;
    const origFetch = globalThis.fetch;
    (globalThis as { fetch: unknown }).fetch = async (url: unknown, init: RequestInit | undefined) => {
      captured = { url: String(url), init };
      return new Response('{"echoed":true}', { status: 200, headers: { "content-type": "application/json" } });
    };
    try {
      await h.http.postJson("http://example.invalid/", { a: 1 });
      expect(captured).not.toBeNull();
      const body = captured!.init?.body;
      expect(body).toBe(JSON.stringify({ a: 1 }));
      const ct = (captured!.init?.headers as Record<string, string>)["Content-Type"];
      expect(ct).toBe("application/json");
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

describe("os", () => {
  it("env / cwd / platform / arch / hostname return strings", () => {
    expect(typeof h.os.env("PATH")).toBe("string");
    expect(typeof h.os.cwd()).toBe("string");
    expect(["linux", "darwin", "win32", "freebsd", "openbsd", "netbsd", "sunos", "aix"]).toContain(h.os.platform());
    expect(typeof h.os.arch()).toBe("string");
    expect(typeof h.os.hostname()).toBe("string");
  });

  it("env returns '' for missing vars", () => {
    expect(h.os.env("___definitely_unset_var_12345___")).toBe("");
  });
});

describe("fs", () => {
  let scratch: string;
  beforeAll(() => { scratch = mkdtempSync(pathJoin(tmpdir(), "vb-fs-")); });
  afterAll(() => { rmSync(scratch, { recursive: true, force: true }); });

  it("write/read round-trips text", async () => {
    const f = pathJoin(scratch, "a.txt");
    await h.fs.write(f, "hello");
    expect(await h.fs.exists(f)).toBe(true);
    expect(await h.fs.read(f)).toBe("hello");
  });

  it("write creates parent directory", async () => {
    const f = pathJoin(scratch, "deep/nested/dir/file.txt");
    await h.fs.write(f, "x");
    expect(await h.fs.exists(f)).toBe(true);
  });

  it("append extends an existing file", async () => {
    const f = pathJoin(scratch, "ap.txt");
    await h.fs.write(f, "one\n");
    await h.fs.append(f, "two\n");
    expect(await h.fs.read(f)).toBe("one\ntwo\n");
  });

  it("readBytes returns Uint8Array", async () => {
    const f = pathJoin(scratch, "bin.dat");
    await h.fs.write(f, new Uint8Array([1, 2, 3]));
    const buf = await h.fs.readBytes(f);
    expect(buf).toBeInstanceOf(Uint8Array);
    expect(Array.from(buf)).toEqual([1, 2, 3]);
  });

  it("stat reports type + size", async () => {
    const f = pathJoin(scratch, "s.txt");
    await h.fs.write(f, "12345");
    const st = await h.fs.stat(f);
    expect(st.isFile).toBe(true);
    expect(st.isDirectory).toBe(false);
    expect(st.size).toBe(5);
    expect(st.mtime).toBeGreaterThan(0);
  });

  it("list returns sorted directory entries", async () => {
    const sub = pathJoin(scratch, "ls");
    await h.fs.mkdir(sub, { recursive: true });
    await h.fs.write(pathJoin(sub, "b"), "");
    await h.fs.write(pathJoin(sub, "a"), "");
    expect(await h.fs.list(sub)).toEqual(["a", "b"]);
  });

  it("remove deletes a file", async () => {
    const f = pathJoin(scratch, "rm.txt");
    await h.fs.write(f, "x");
    await h.fs.remove(f);
    expect(await h.fs.exists(f)).toBe(false);
  });

  it("copy duplicates a file", async () => {
    const src = pathJoin(scratch, "cpsrc");
    const dst = pathJoin(scratch, "cpdir/cpdst");
    await h.fs.write(src, "data");
    await h.fs.copy(src, dst);
    expect(await h.fs.read(dst)).toBe("data");
  });

  it("mimeOf maps extensions to types", () => {
    expect(h.fs.mimeOf("foo.html")).toBe("text/html");
    expect(h.fs.mimeOf("/path/to/x.png")).toBe("image/png");
    expect(h.fs.mimeOf("nope")).toBe("application/octet-stream");
    expect(h.fs.mimeOf("a.UNKNOWN")).toBe("application/octet-stream");
  });
});

describe("db", () => {
  beforeAll(() => { initDb(":memory:"); });
  afterAll(() => { closeDb(); });

  it("execMulti + query + exec round-trip", () => {
    h.db.execMulti(`
      CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT);
      INSERT INTO t (id, name) VALUES (1, 'a'), (2, 'b');
    `);
    const rows = h.db.query<{ id: number; name: string }>("SELECT id, name FROM t ORDER BY id");
    expect(rows).toEqual([{ id: 1, name: "a" }, { id: 2, name: "b" }]);
    const one = h.db.queryOne<{ id: number; name: string }>("SELECT id, name FROM t WHERE id = ?", 2);
    expect(one).toEqual({ id: 2, name: "b" });
    const r = h.db.exec("UPDATE t SET name = ? WHERE id = ?", "B", 2);
    expect(r.changes).toBe(1);
    expect(h.db.queryOne<{ name: string }>("SELECT name FROM t WHERE id = ?", 2)?.name).toBe("B");
  });

  it("queryOne returns null on no rows", () => {
    expect(h.db.queryOne("SELECT id FROM t WHERE id = ?", 99)).toBeNull();
  });
});
