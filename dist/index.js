import { createRequire } from "node:module";
var __require = /* @__PURE__ */ createRequire(import.meta.url);

// src/index.ts
import { readFileSync, existsSync, appendFileSync } from "node:fs";
import { execSync } from "node:child_process";
var VERSION = "0.1.0";
var LINK = /\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)|<(https?:\/\/[^>\s]+)>|(?<![(<"])\b(https?:\/\/[^\s)<>"\]]+)/g;
var claimNumbers = (t) => [...new Set((t.match(/\d+(?:[.,]\d+)*(?:%|x\b|×)?/g) ?? []).map((n) => n.replace(/(x|×)$/, "")).filter((n) => n.replace(/\D/g, "").length >= 2 || n.endsWith("%")))];
function proseLines(md) {
  const out = [];
  let fence = false, comment = false;
  md.split(`
`).forEach((raw, i) => {
    if (/^\s*(```|~~~)/.test(raw)) {
      fence = !fence;
      return;
    }
    if (fence)
      return;
    let t = raw;
    if (comment) {
      if (!t.includes("-->"))
        return;
      t = t.slice(t.indexOf("-->") + 3);
      comment = false;
    }
    t = t.replace(/<!--[\s\S]*?-->/g, "");
    if (t.includes("<!--")) {
      t = t.slice(0, t.indexOf("<!--"));
      comment = true;
    }
    t = t.replace(/\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g, " ").replace(/!\[[^\]]*\]\([^)]*\)/g, " ").replace(/`([^`]*)`/g, "$1");
    if (/^\s*#/.test(t) || /^\s*\|?\s*[-:|\s]+$/.test(t))
      return;
    out.push({ line: i + 1, text: t });
  });
  return out;
}
var sentencesOf = (t) => t.split(/(?<=[.!?])\s+(?=[A-Z"(\[])/).map((s) => s.trim()).filter(Boolean);
var plain = (s) => s.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/<https?:[^>]+>/g, "").replace(/https?:\/\/\S+/g, "").replace(/[*_]{1,3}/g, "").replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "").replace(/\(\s*\)/g, "").replace(/\s+/g, " ").trim();
function extractClaims(file, md) {
  const claims = [];
  for (const { line, text } of proseLines(md))
    for (const s of sentencesOf(text)) {
      const links = [...s.matchAll(LINK)].map((m) => m[2] ?? m[3] ?? m[4]).map((u) => u.replace(/[.,;:]+$/, ""));
      if (!links.length)
        continue;
      const source = links[links.length - 1];
      const p = plain(s);
      const quote = [...p.matchAll(/["“]([^"”]*)["”]/g)].map((m) => m[1].trim()).find((q) => q.length >= 20 && q.split(/\s+/).length >= 4);
      if (quote) {
        claims.push({ file, line, kind: "quote", text: p, source, quote });
        continue;
      }
      const nums = claimNumbers(p.replace(/\b\d{4}-\d{2}-\d{2}\b/g, ""));
      if (nums.length)
        claims.push({ file, line, kind: "number", text: p, source, numbers: nums });
    }
  return claims;
}
var semver = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/;
function versionClaims(files, pkg) {
  if (!pkg?.name || !pkg.version)
    return [];
  const claims = [];
  const esc = pkg.name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const re = new RegExp(`(?<![\\w/-])${esc}@v?(${semver.source})`, "g");
  for (const { file, md } of files) {
    md.split(`
`).forEach((l, i) => {
      for (const m of l.matchAll(re))
        claims.push({ file, line: i + 1, kind: "version", text: m[0], source: "package.json + git tags", version: m[1] });
    });
    if (/changelog/i.test(file)) {
      const heads = md.split(`
`).map((l, i) => ({ i, v: /^#{1,3}\s.*?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(l)?.[1] })).filter((h) => h.v);
      if (heads.length)
        claims.push({
          file,
          line: heads[0].i + 1,
          kind: "version",
          text: `CHANGELOG has an entry for ${pkg.version} (package.json)`,
          source: "package.json",
          version: heads.some((h) => h.v === pkg.version) ? pkg.version : `missing:${pkg.version}`
        });
    }
  }
  return claims;
}
async function checkRemote(c, endpoint, ua) {
  const at = new Date().toISOString();
  const gh = c.source.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/blob\/(.+)$/);
  const params = new URLSearchParams({ claim: c.text.slice(0, 1000), source: gh ? `https://raw.githubusercontent.com/${gh[1]}/${gh[2].replace(/#.*$/, "")}` : c.source });
  if (c.quote) {
    params.set("quote", c.quote);
    params.set("stance", "supports");
  }
  let r;
  try {
    const res = await fetch(`${endpoint}/check?${params}`, { headers: { "user-agent": ua }, signal: AbortSignal.timeout(60000) });
    r = await res.json();
    if (!res.ok)
      return { ...c, verdict: "unmeasurable", detail: `check endpoint: ${r?.error ?? res.status}`, fetched_at: at };
  } catch (e) {
    return { ...c, verdict: "unmeasurable", detail: `check endpoint unreachable: ${e?.message ?? e}`, fetched_at: at };
  }
  const readable = (r.rails ?? []).filter((x) => x.status >= 200 && x.status < 300 && x.chars > 200);
  const fetched_at = r.fetched_at ?? at;
  if (!readable.length)
    return { ...c, verdict: "unmeasurable", detail: `source not readable (${(r.rails ?? []).map((x) => `${x.rail} ${x.status}`).join(", ")})`, fetched_at };
  if (c.kind === "quote") {
    const found = (r.rails ?? []).filter((x) => x.quote_found).map((x) => x.rail);
    if (found.length)
      return { ...c, verdict: "holds", detail: `quote found verbatim on ${found.join(", ")}`, fetched_at };
    const near2 = r.candidates?.[0]?.sentence;
    return { ...c, verdict: "wrong", detail: `quote not in source${near2 ? `; nearest: "${near2.slice(0, 160)}"` : ""}`, fetched_at };
  }
  const absent = (r.claim_numbers_absent_from_source ?? []).filter((n) => c.numbers.includes(n.replace(/%$/, "")) || c.numbers.includes(n));
  if (!absent.length)
    return { ...c, verdict: "holds", detail: `${c.numbers.join(", ")} found in source`, fetched_at };
  const near = r.candidates?.[0]?.sentence;
  return { ...c, verdict: "unsupported", detail: `not in source: ${absent.join(", ")}${near ? `; nearest: "${near.slice(0, 160)}"` : ""}`, fetched_at };
}
function checkVersion(c, pkgVersion, tags) {
  const at = new Date().toISOString();
  if (c.version.startsWith("missing:"))
    return { ...c, verdict: "wrong", detail: `no CHANGELOG heading for ${pkgVersion}`, fetched_at: at };
  if (c.version === pkgVersion)
    return { ...c, verdict: "holds", detail: `matches package.json ${pkgVersion}`, fetched_at: at };
  if (tags === null)
    return { ...c, verdict: "unmeasurable", detail: `package.json says ${pkgVersion}; tags unreadable`, fetched_at: at };
  if (tags.includes(c.version) || tags.includes(`v${c.version}`))
    return { ...c, verdict: "holds", detail: `tag exists (package.json now ${pkgVersion})`, fetched_at: at };
  return { ...c, verdict: "wrong", detail: `no tag ${c.version} and package.json says ${pkgVersion}`, fetched_at: at };
}
function gitTags() {
  try {
    return execSync("git ls-remote --tags origin", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split(`
`).map((l) => l.split("refs/tags/")[1]?.replace(/\^\{\}$/, "")).filter(Boolean);
  } catch {
    try {
      return execSync("git tag", { encoding: "utf8" }).split(`
`).filter(Boolean);
    } catch {
      return null;
    }
  }
}
var input = (n, d) => process.env[`INPUT_${n.toUpperCase().replace(/ /g, "_")}`]?.trim() || d;
var cell = (s) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
async function main() {
  const files = input("files", "README.md CHANGELOG.md").split(/[\s,]+/).filter(Boolean);
  const endpoint = input("endpoint", "https://check-claim.amdal-dev.workers.dev").replace(/\/$/, "");
  const max = +input("max-checks", "25");
  const failOn = input("fail-on", "wrong").split(/[\s,]+/).filter((v) => v !== "never");
  const repo = process.env.GITHUB_REPOSITORY ?? "local";
  const ua = `check-claim-action/${VERSION} (+https://github.com/piiiico/check-claim-action; repo=${repo})`;
  const docs = files.filter((f) => existsSync(f)).map((f) => ({ file: f, md: readFileSync(f, "utf8") }));
  if (!docs.length) {
    console.log(`::warning::none of ${files.join(", ")} exist; nothing to check`);
    return;
  }
  const pkg = existsSync("package.json") ? JSON.parse(readFileSync("package.json", "utf8")) : null;
  const remote = docs.flatMap((d) => extractClaims(d.file, d.md));
  const skipped = Math.max(0, remote.length - max);
  const results = [];
  const queue = remote.slice(0, max);
  await Promise.all(Array.from({ length: 4 }, async () => {
    for (let c;c = queue.shift(); )
      results.push(await checkRemote(c, endpoint, ua));
  }));
  const vc = versionClaims(docs, pkg);
  const tags = vc.length ? gitTags() : null;
  for (const c of vc)
    results.push(checkVersion(c, pkg.version, tags));
  results.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  for (const r of results.filter((r2) => r2.verdict === "wrong" || r2.verdict === "unsupported"))
    console.log(`::${r.verdict === "wrong" ? "error" : "warning"} file=${r.file},line=${r.line},title=check-claim: ${r.kind} claim ${r.verdict}::${r.detail}`);
  const n = (v) => results.filter((r) => r.verdict === v).length;
  const md = [
    `## check-claim: ${n("wrong")} wrong, ${n("unsupported")} unsupported, ${n("holds")} hold, ${n("unmeasurable")} unmeasurable`,
    "",
    results.length ? `| where | claim | source | fetched_at | verdict | detail |
|---|---|---|---|---|---|` : "No checkable claims found (a number or a quoted sentence next to a link, or a version of this package).",
    ...results.map((r) => `| ${r.file}:${r.line} | ${cell(r.text.slice(0, 140))} | ${cell(r.source)} | ${r.fetched_at} | **${r.verdict}** | ${cell(r.detail)} |`),
    skipped ? `
${skipped} more claim(s) not checked (max-checks=${max}).` : "",
    `
<sub>check-claim-action ${VERSION}, built by Pico, an AI agent run by Håkon Åmdal. Number and quote checks call ${endpoint}.</sub>`
  ].join(`
`);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + `
`);
  else
    console.log(md);
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, `wrong=${n("wrong")}
unsupported=${n("unsupported")}
holds=${n("holds")}
unmeasurable=${n("unmeasurable")}
`);
  if (failOn.some((v) => n(v) > 0))
    process.exitCode = 1;
}
if (__require.main == __require.module ?? process.argv[1]?.endsWith("index.js"))
  main().catch((e) => {
    console.log(`::error::${e?.stack ?? e}`);
    process.exitCode = 1;
  });
export {
  versionClaims,
  proseLines,
  extractClaims,
  claimNumbers,
  checkVersion,
  checkRemote
};
