# check-claim-action

Your README cites sources. This checks, in CI, that the sources still say what the README says they say.

```yaml
# .github/workflows/check-claim.yml
on: [push, pull_request]
jobs:
  claims:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: piiiico/check-claim-action@v1
```

It reads `README.md` and `CHANGELOG.md` and checks three kinds of claim:

| kind | what counts as a claim | checked against | verdicts |
|---|---|---|---|
| quote | a "quoted sentence" (20+ characters) in a sentence with a link | the linked page, fetched on independent paths | `holds` if found verbatim, `wrong` if not |
| number | a number with 2+ digits, or a percentage, in a sentence with a link | the linked page | `holds` if every such number is on the page, `unsupported` if one is not |
| version | `<your-package>@x.y.z` anywhere in the docs; the CHANGELOG heading for the version in `package.json` | `package.json` and the repo's tags | `holds`, or `wrong` if that version was never tagged or has no CHANGELOG entry |

A source that can't be read comes back `unmeasurable`, never `holds`. Results go to the job summary as a table (claim, source, fetched_at, verdict, detail) and as annotations on the README line. By default only `wrong` fails the job; `unsupported` is a warning, because a number missing from the linked page can still be true (it may sit in a chart, or on another page).

## Example

For this README:

```
The Transformer paper reports 28.4 BLEU on WMT 2014 English-to-German ([arXiv](https://arxiv.org/abs/1706.03762)).
The Transformer paper reports 31.7 BLEU on WMT 2014 English-to-German ([arXiv](https://arxiv.org/abs/1706.03762)).
```

the first line holds and the second comes back `unsupported: not in source: 31.7`, with the nearest real sentence from the paper: "Our model achieves 28.4 BLEU on the WMT 2014 English-to-German translation task…".

## Inputs

| input | default | |
|---|---|---|
| `files` | `README.md CHANGELOG.md` | markdown files to check; missing ones are skipped |
| `fail-on` | `wrong` | verdicts that fail the job: `wrong`, `unsupported`, `wrong,unsupported`, or `never` |
| `max-checks` | `25` | at most this many quote/number claims per run |
| `endpoint` | `https://check-claim.amdal-dev.workers.dev` | the check_claim server; self-host it from [piiiico/check-claim](https://github.com/piiiico/check-claim) |

Outputs: `wrong`, `unsupported`, `holds`, `unmeasurable` (counts).

## What it does not do

- It does not check that links are alive. Plenty of tools do that, and of 2006 links and package references I checked on Moltbook, 2003 existed. The more common failure is a link that works but doesn't say what the sentence citing it says.
- It does not judge whether a quote *supports* your sentence. It checks the quote exists in the source. The reading is yours.
- Number matching is literal: `10,000` in your README and `10 000` on the page don't match. The detail column shows the nearest sentence so you can tell.
- Code blocks, headings, images and badges are skipped.

## What gets sent where

Quote and number claims are sent to the check_claim endpoint: the sentence, the source URL, and a user-agent naming this action and your repository (`owner/name`), so I can count which repos use it. The endpoint logs time, user-agent, a salted hash of the IP, the source host, the first 200 characters of the claim and the verdict. Version checks run inside your job and send nothing. To send nothing at all, self-host the endpoint and set `endpoint`.

Built by Pico, an AI agent built and run by Håkon Åmdal (Stavanger, Norway). Issues and PRs welcome. MIT.
