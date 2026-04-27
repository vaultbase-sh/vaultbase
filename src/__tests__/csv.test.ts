import { describe, expect, it } from "bun:test";
import { encodeCsv, encodeField, parseCsv, parseCsvToObjects } from "../core/csv.ts";

describe("encodeField", () => {
  it("returns empty string for null/undefined", () => {
    expect(encodeField(null)).toBe("");
    expect(encodeField(undefined)).toBe("");
  });

  it("doesn't quote when not needed", () => {
    expect(encodeField("hello")).toBe("hello");
    expect(encodeField(123)).toBe("123");
    expect(encodeField(true)).toBe("true");
  });

  it("quotes values containing commas", () => {
    expect(encodeField("a,b")).toBe('"a,b"');
  });

  it("quotes values containing newlines", () => {
    expect(encodeField("line1\nline2")).toBe('"line1\nline2"');
    expect(encodeField("with\rcr")).toBe('"with\rcr"');
  });

  it("doubles embedded quotes inside a quoted field", () => {
    expect(encodeField('she said "hi"')).toBe('"she said ""hi"""');
  });

  it("JSON-encodes objects/arrays", () => {
    expect(encodeField({ a: 1 })).toBe('"{""a"":1}"');
    expect(encodeField([1, 2])).toBe('"[1,2]"');
  });
});

describe("encodeCsv", () => {
  it("emits header + rows joined with CRLF", () => {
    const out = encodeCsv(["a", "b"], [[1, 2], [3, 4]]);
    expect(out).toBe("a,b\r\n1,2\r\n3,4");
  });
});

describe("parseCsv — happy path", () => {
  it("parses a simple table", () => {
    expect(parseCsv("a,b,c\n1,2,3\n4,5,6")).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
      ["4", "5", "6"],
    ]);
  });

  it("handles CRLF line endings", () => {
    expect(parseCsv("a,b\r\n1,2\r\n3,4")).toEqual([
      ["a", "b"],
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  it("ignores trailing newline", () => {
    expect(parseCsv("a,b\n1,2\n").length).toBe(2);
  });

  it("preserves empty trailing fields", () => {
    expect(parseCsv("a,b,c\n1,,3")).toEqual([
      ["a", "b", "c"],
      ["1", "", "3"],
    ]);
  });
});

describe("parseCsv — quoted fields", () => {
  it("accepts simple quoted field", () => {
    expect(parseCsv('a,b\n"hello",world')).toEqual([
      ["a", "b"],
      ["hello", "world"],
    ]);
  });

  it("preserves commas inside quotes", () => {
    expect(parseCsv('a,b\n"a,b","c"')).toEqual([
      ["a", "b"],
      ["a,b", "c"],
    ]);
  });

  it("preserves newlines inside quotes", () => {
    expect(parseCsv('a,b\n"line1\nline2","x"')).toEqual([
      ["a", "b"],
      ["line1\nline2", "x"],
    ]);
  });

  it("doubled quotes become a single quote inside a quoted field", () => {
    expect(parseCsv('a,b\n"she said ""hi""","x"')).toEqual([
      ["a", "b"],
      ['she said "hi"', "x"],
    ]);
  });

  it("throws on unterminated quote", () => {
    expect(() => parseCsv('a,b\n"unterminated,row')).toThrow(/Unterminated/);
  });
});

describe("round-trip", () => {
  it("encodeCsv → parseCsv recovers the same data", () => {
    const headers = ["title", "body", "tags"];
    const rows = [
      ["hello", 'with "quotes" and, commas', "[1,2,3]"],
      ["multi\nline", "", "{}"],
    ];
    const text = encodeCsv(headers, rows);
    expect(parseCsv(text)).toEqual([headers, ...rows]);
  });
});

describe("parseCsvToObjects", () => {
  it("pivots rows under header keys", () => {
    expect(parseCsvToObjects("name,age\nalice,30\nbob,25")).toEqual([
      { name: "alice", age: "30" },
      { name: "bob",   age: "25" },
    ]);
  });

  it("returns [] for empty input", () => {
    expect(parseCsvToObjects("")).toEqual([]);
  });
});
