import { test, expect } from "bun:test";
import { extractClaims, versionClaims, checkVersion, claimNumbers, proseLines } from "./index";

test("number claim next to a link is extracted, code and badges are not", () => {
  const md = "# T\n[![ci](https://x.io/b.svg)](https://x.io)\n\nIt handles 12,000 requests per second ([bench](https://ex.com/b)).\n```\nfoo 9999 https://ex.com/c\n```\nSee 1 thing at https://ex.com/d.";
  const c = extractClaims("README.md", md);
  expect(c).toHaveLength(1);
  expect(c[0]).toMatchObject({ kind: "number", line: 4, source: "https://ex.com/b", numbers: ["12,000"] });
});
test("quoted sentence becomes a quote claim", () => {
  const c = extractClaims("README.md", 'The paper says "dispensing with recurrence and convolutions entirely" [1](https://arxiv.org/abs/1706.03762).');
  expect(c[0]).toMatchObject({ kind: "quote", quote: "dispensing with recurrence and convolutions entirely", source: "https://arxiv.org/abs/1706.03762" });
});
test("single digits are not claims, percents are", () => {
  expect(claimNumbers("3x faster, 5% less, 2 things, 42 runs")).toEqual(["5%", "42"]);
});
test("html comments are dropped across lines", () => {
  expect(proseLines("a\n<!--\n42 https://x.io\n-->\nb").map(l => l.text).filter(Boolean)).toEqual(["a", "b"]);
});
test("version claims: own package only, changelog entry for package.json version", () => {
  const pkg = { name: "@s/x", version: "1.2.0" };
  const c = versionClaims([{ file: "README.md", md: "npm i @s/x@1.1.9 and other@3.0.0" }, { file: "CHANGELOG.md", md: "## 1.1.9\n- a" }], pkg);
  expect(c.map(x => x.version)).toEqual(["1.1.9", "missing:1.2.0"]);
  expect(checkVersion(c[0], "1.2.0", ["v1.1.9"]).verdict).toBe("holds");
  expect(checkVersion(c[0], "1.2.0", ["v1.0.0"]).verdict).toBe("wrong");
  expect(checkVersion(c[1], "1.2.0", []).verdict).toBe("wrong");
  expect(checkVersion({ ...c[0], version: "1.2.0" }, "1.2.0", null).verdict).toBe("holds");
});
test("quote marks pair in order; a gap between two short quotes is not a quote", () => {
  const c = extractClaims("README.md", 'Vite (French word for "quick", pronounced like "veet") is fast and 10x leaner [x](https://a.io/b).');
  expect(c.find(x => x.kind === "quote")).toBeUndefined();
});
