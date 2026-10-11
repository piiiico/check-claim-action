// check-claim-action: checks the claims a repo makes about itself and the world in its own README/CHANGELOG.
// Three claim kinds, each checked against its primary source:
//   number   - a prose sentence with a number (>=2 digits, or a %) next to a link: is every such number in the linked source?
//   quote    - a "quoted sentence" (>=20 chars) next to a link: is it in the linked source verbatim?
//   version  - <this package>@x.y.z in the docs, and the CHANGELOG entry for package.json's version: does that version exist?
// number/quote claims go through the hosted check_claim endpoint (github.com/piiiico/check-claim); versions are checked
// against package.json and the repo's own tags. Links are deliberately NOT liveness-checked: dead-link tools exist, and
// in 2006 checked references only 3 were dead. The gap this fills is links that resolve but don't say what the README says.
import { readFileSync, existsSync, appendFileSync } from "node:fs";
import { execSync } from "node:child_process";

// wrong = the cited thing does not exist (quote not in source, version never shipped). unsupported = the linked source
// does not carry the number; the claim may still be true from elsewhere (a chart, another page), so it warns, not fails.
export type Verdict = "holds" | "wrong" | "unsupported" | "unmeasurable";
export type Claim = { file: string; line: number; kind: "number" | "quote" | "version"; text: string; source: string; quote?: string; numbers?: string[]; version?: string };
export type Checked = Claim & { verdict: Verdict; detail: string; fetched_at: string };

const VERSION = "0.1.0";
const LINK = /\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)|<(https?:\/\/[^>\s]+)>|(?<![(<"])\b(https?:\/\/[^\s)<>"\]]+)/g;
// A number worth checking: two or more digits, or a percentage, or a multiplier like 3x. Single digits match any page.
export const claimNumbers = (t: string) => [...new Set((t.match(/\d+(?:[.,]\d+)*(?:%|x\b|×)?/g) ?? [])
  .map(n => n.replace(/(x|×)$/, ""))
  .filter(n => n.replace(/\D/g, "").length >= 2 || n.endsWith("%")))];

// Strip fenced code, HTML comments, images/badges; keep line numbers.
export function proseLines(md: string): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = []; let fence = false, comment = false;
  md.split("\n").forEach((raw, i) => {
    if (/^\s*(```|~~~)/.test(raw)) { fence = !fence; return; }
    if (fence) return;
    let t = raw;
    if (comment) { if (!t.includes("-->")) return; t = t.slice(t.indexOf("-->") + 3); comment = false; }
    t = t.replace(/<!--[\s\S]*?-->/g, "");
    if (t.includes("<!--")) { t = t.slice(0, t.indexOf("<!--")); comment = true; }
    t = t.replace(/\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g, " ").replace(/!\[[^\]]*\]\([^)]*\)/g, " ").replace(/`([^`]*)`/g, "$1");
    if (/^\s*#/.test(t) || /^\s*\|?\s*[-:|\s]+$/.test(t)) return; // headings, table rules
    out.push({ line: i + 1, text: t });
  });
  return out;
}

const sentencesOf = (t: string) => t.split(/(?<=[.!?])\s+(?=[A-Z"(\[])/).map(s => s.trim()).filter(Boolean);
const plain = (s: string) => s.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/<https?:[^>]+>/g, "").replace(/https?:\/\/\S+/g, "")
  .replace(/[*_]{1,3}/g, "").replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "").replace(/\(\s*\)/g, "").replace(/\s+/g, " ").trim();

export function extractClaims(file: string, md: string): Claim[] {
  const claims: Claim[] = [];
  for (const { line, text } of proseLines(md)) for (const s of sentencesOf(text)) {
    const links = [...s.matchAll(LINK)].map(m => m[2] ?? m[3] ?? m[4]).map(u => u.replace(/[.,;:]+$/, ""));
    if (!links.length) continue;
    const source = links[links.length - 1]; // the citation usually closes the sentence
    const p = plain(s);
    // pair quote marks in order, so the gap between "quick" and "veet" is never read as a quote
    const quote = [...p.matchAll(/["“]([^"”]*)["”]/g)].map(m => m[1].trim()).find(q => q.length >= 20 && q.split(/\s+/).length >= 4);
    if (quote) { claims.push({ file, line, kind: "quote", text: p, source, quote }); continue; }
    // list-item numbering and dates are not claims about the source; drop the leading "1." and ISO dates
    const nums = claimNumbers(p.replace(/\b\d{4}-\d{2}-\d{2}\b/g, ""));
    if (nums.length) claims.push({ file, line, kind: "number", text: p, source, numbers: nums });
  }
  return claims;
}

const semver = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/;
export function versionClaims(files: { file: string; md: string }[], pkg: { name?: string; version?: string } | null): Claim[] {
  if (!pkg?.name || !pkg.version) return [];
  const claims: Claim[] = []; const esc = pkg.name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const re = new RegExp(`(?<![\\w/-])${esc}@v?(${semver.source})`, "g");
  for (const { file, md } of files) {
    md.split("\n").forEach((l, i) => { for (const m of l.matchAll(re)) claims.push({ file, line: i + 1, kind: "version", text: m[0], source: "package.json + git tags", version: m[1] }); });
    if (/changelog/i.test(file)) {
      const heads = md.split("\n").map((l, i) => ({ i, v: /^#{1,3}\s.*?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(l)?.[1] })).filter(h => h.v);
      if (heads.length) claims.push({ file, line: heads[0].i + 1, kind: "version", text: `CHANGELOG has an entry for ${pkg.version} (package.json)`, source: "package.json",
        version: heads.some(h => h.v === pkg.version) ? pkg.version : `missing:${pkg.version}` });
    }
  }
  return claims;
}

export async function checkRemote(c: Claim, endpoint: string, ua: string): Promise<Checked> {
  const at = new Date().toISOString();
  // github.com/<o>/<r>/blob/<ref>/<path> pages are JS-heavy and often refuse shared egress; their raw file is the same source
  const gh = c.source.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/blob\/(.+)$/);
  const params = new URLSearchParams({ claim: c.text.slice(0, 1000), source: gh ? `https://raw.githubusercontent.com/${gh[1]}/${gh[2].replace(/#.*$/, "")}` : c.source });
  if (c.quote) { params.set("quote", c.quote); params.set("stance", "supports"); }
  let r: any;
  try {
    const res = await fetch(`${endpoint}/check?${params}`, { headers: { "user-agent": ua }, signal: AbortSignal.timeout(60000) });
    r = await res.json();
    if (!res.ok) return { ...c, verdict: "unmeasurable", detail: `check endpoint: ${r?.error ?? res.status}`, fetched_at: at };
  } catch (e: any) { return { ...c, verdict: "unmeasurable", detail: `check endpoint unreachable: ${e?.message ?? e}`, fetched_at: at }; }
  const readable = (r.rails ?? []).filter((x: any) => x.status >= 200 && x.status < 300 && x.chars > 200);
  const fetched_at = r.fetched_at ?? at;
  if (!readable.length) return { ...c, verdict: "unmeasurable", detail: `source not readable (${(r.rails ?? []).map((x: any) => `${x.rail} ${x.status}`).join(", ")})`, fetched_at };
  if (c.kind === "quote") {
    const found = (r.rails ?? []).filter((x: any) => x.quote_found).map((x: any) => x.rail);
    if (found.length) return { ...c, verdict: "holds", detail: `quote found verbatim on ${found.join(", ")}`, fetched_at };
    const near = r.candidates?.[0]?.sentence;
    return { ...c, verdict: "wrong", detail: `quote not in source${near ? `; nearest: "${near.slice(0, 160)}"` : ""}`, fetched_at };
  }
  const absent: string[] = (r.claim_numbers_absent_from_source ?? []).filter((n: string) => c.numbers!.includes(n.replace(/%$/, "")) || c.numbers!.includes(n));
  if (!absent.length) return { ...c, verdict: "holds", detail: `${c.numbers!.join(", ")} found in source`, fetched_at };
  const near = r.candidates?.[0]?.sentence;
  return { ...c, verdict: "unsupported", detail: `not in source: ${absent.join(", ")}${near ? `; nearest: "${near.slice(0, 160)}"` : ""}`, fetched_at };
}

export function checkVersion(c: Claim, pkgVersion: string, tags: string[] | null): Checked {
  const at = new Date().toISOString();
  if (c.version!.startsWith("missing:")) return { ...c, verdict: "wrong", detail: `no CHANGELOG heading for ${pkgVersion}`, fetched_at: at };
  if (c.version === pkgVersion) return { ...c, verdict: "holds", detail: `matches package.json ${pkgVersion}`, fetched_at: at };
  if (tags === null) return { ...c, verdict: "unmeasurable", detail: `package.json says ${pkgVersion}; tags unreadable`, fetched_at: at };
  if (tags.includes(c.version!) || tags.includes(`v${c.version}`)) return { ...c, verdict: "holds", detail: `tag exists (package.json now ${pkgVersion})`, fetched_at: at };
  return { ...c, verdict: "wrong", detail: `no tag ${c.version} and package.json says ${pkgVersion}`, fetched_at: at };
}

function gitTags(): string[] | null {
  try { return execSync("git ls-remote --tags origin", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\n").map(l => l.split("refs/tags/")[1]?.replace(/\^\{\}$/, "")).filter(Boolean) as string[]; }
  catch { try { return execSync("git tag", { encoding: "utf8" }).split("\n").filter(Boolean); } catch { return null; } }
}

const input = (n: string, d: string) => process.env[`INPUT_${n.toUpperCase().replace(/ /g, "_")}`]?.trim() || d;
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

async function main() {
  const files = input("files", "README.md CHANGELOG.md").split(/[\s,]+/).filter(Boolean);
  const endpoint = input("endpoint", "https://check-claim.amdal-dev.workers.dev").replace(/\/$/, "");
  const max = +input("max-checks", "25");
  const failOn = input("fail-on", "wrong").split(/[\s,]+/).filter(v => v !== "never") as Verdict[];
  const repo = process.env.GITHUB_REPOSITORY ?? "local";
  const ua = `check-claim-action/${VERSION} (+https://github.com/piiiico/check-claim-action; repo=${repo})`;
  const docs = files.filter(f => existsSync(f)).map(f => ({ file: f, md: readFileSync(f, "utf8") }));
  if (!docs.length) { console.log(`::warning::none of ${files.join(", ")} exist; nothing to check`); return; }
  const pkg = existsSync("package.json") ? JSON.parse(readFileSync("package.json", "utf8")) : null;
  const remote = docs.flatMap(d => extractClaims(d.file, d.md));
  const skipped = Math.max(0, remote.length - max);
  const results: Checked[] = [];
  const queue = remote.slice(0, max);
  await Promise.all(Array.from({ length: 4 }, async () => { for (let c; (c = queue.shift());) results.push(await checkRemote(c, endpoint, ua)); }));
  const vc = versionClaims(docs, pkg); const tags = vc.length ? gitTags() : null;
  for (const c of vc) results.push(checkVersion(c, pkg.version, tags));
  results.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  for (const r of results.filter(r => r.verdict === "wrong" || r.verdict === "unsupported"))
    console.log(`::${r.verdict === "wrong" ? "error" : "warning"} file=${r.file},line=${r.line},title=check-claim: ${r.kind} claim ${r.verdict}::${r.detail}`);
  const n = (v: Verdict) => results.filter(r => r.verdict === v).length;
  const md = [`## check-claim: ${n("wrong")} wrong, ${n("unsupported")} unsupported, ${n("holds")} hold, ${n("unmeasurable")} unmeasurable`, "",
    results.length ? "| where | claim | source | fetched_at | verdict | detail |\n|---|---|---|---|---|---|" : "No checkable claims found (a number or a quoted sentence next to a link, or a version of this package).",
    ...results.map(r => `| ${r.file}:${r.line} | ${cell(r.text.slice(0, 140))} | ${cell(r.source)} | ${r.fetched_at} | **${r.verdict}** | ${cell(r.detail)} |`),
    skipped ? `\n${skipped} more claim(s) not checked (max-checks=${max}).` : "",
    `\n<sub>check-claim-action ${VERSION}, built by Pico, an AI agent run by Håkon Åmdal. Number and quote checks call ${endpoint}.</sub>`].join("\n");
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + "\n"); else console.log(md);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `wrong=${n("wrong")}\nunsupported=${n("unsupported")}\nholds=${n("holds")}\nunmeasurable=${n("unmeasurable")}\n`);
  if (failOn.some(v => n(v) > 0)) process.exitCode = 1;
}

if (import.meta.main ?? process.argv[1]?.endsWith("index.js")) main().catch(e => { console.log(`::error::${e?.stack ?? e}`); process.exitCode = 1; });
