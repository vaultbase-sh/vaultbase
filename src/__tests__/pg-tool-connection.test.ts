/**
 * pg_dump used to get the connection URL, password and all, on its command
 * line, where any user on the host can read it (`ps`). The password now goes
 * in PGPASSWORD and the URL loses it.
 */
import { describe, expect, it } from "bun:test";
import { pgDumpSchemaPattern, pgToolConnection } from "../core/backups.ts";

describe("pgToolConnection", () => {
  it("takes the password out of the authority", () => {
    expect(pgToolConnection("postgres://vb:s3cret@db.internal:5432/vaultbase")).toEqual({
      dbname: "postgres://vb@db.internal:5432/vaultbase",
      env: { PGPASSWORD: "s3cret" },
    });
  });

  it("decodes a percent-encoded password, and keeps an unencoded @ in it", () => {
    expect(pgToolConnection("postgresql://vb:p%40ss%2Fw%3Ard@h/db").env).toEqual({ PGPASSWORD: "p@ss/w:rd" });
    const raw = pgToolConnection("postgres://vb:p@ss@h:5432/db");
    expect(raw).toEqual({ dbname: "postgres://vb@h:5432/db", env: { PGPASSWORD: "p@ss" } });
  });

  it("leaves the rest of the URL as it was, encoding included", () => {
    const url = "postgres://vb:pw@h/db?sslmode=require&options=-c%20search_path%3Dvb_x";
    expect(pgToolConnection(url).dbname).toBe("postgres://vb@h/db?sslmode=require&options=-c%20search_path%3Dvb_x");
  });

  it("takes password= out of the query string, wherever it is, and it wins over the authority", () => {
    expect(pgToolConnection("postgres://vb@h/db?password=a%2Bb+c").env).toEqual({ PGPASSWORD: "a+b+c" });
    expect(pgToolConnection("postgres://vb@h/db?password=x").dbname).toBe("postgres://vb@h/db");
    expect(pgToolConnection("postgres://vb@h/db?password=x&sslmode=require").dbname).toBe("postgres://vb@h/db?sslmode=require");
    expect(pgToolConnection("postgres://vb@h/db?sslmode=require&password=x").dbname).toBe("postgres://vb@h/db?sslmode=require");
    expect(pgToolConnection("postgres://vb:one@h/db?password=two")).toEqual({ dbname: "postgres://vb@h/db", env: { PGPASSWORD: "two" } });
    expect(pgToolConnection("postgres://vb@h/db?passwordless=1").dbname).toBe("postgres://vb@h/db?passwordless=1");
  });

  it("a URL without a password, or a socket URL, passes through", () => {
    expect(pgToolConnection("postgres://vb@h/db")).toEqual({ dbname: "postgres://vb@h/db", env: {} });
    expect(pgToolConnection("postgres:///vaultbase?host=/var/run/postgresql")).toEqual({ dbname: "postgres:///vaultbase?host=/var/run/postgresql", env: {} });
    expect(pgToolConnection("postgres://vb:pw@/vaultbase?host=/tmp")).toEqual({ dbname: "postgres://vb@/vaultbase?host=/tmp", env: { PGPASSWORD: "pw" } });
  });

  it("an empty password sets nothing", () => {
    expect(pgToolConnection("postgres://vb:@h/db")).toEqual({ dbname: "postgres://vb@h/db", env: {} });
  });
});

describe("pgDumpSchemaPattern", () => {
  it("quotes the schema so case and wildcards are literal", () => {
    expect(pgDumpSchemaPattern("public")).toBe(`"public"`);
    expect(pgDumpSchemaPattern("MySchema")).toBe(`"MySchema"`);
    expect(pgDumpSchemaPattern("a*b")).toBe(`"a*b"`);
    expect(pgDumpSchemaPattern(`we"ird`)).toBe(`"we""ird"`);
  });
});
