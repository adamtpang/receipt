# receipt

Paste a GitHub repo and a claim about it. Get a verdict, not a vibe.

## Why

A cold email says "155 commits." A resume says "shipped in two weeks." Most
of the time nobody checks. This checks.

Give it `owner/repo` (or a full github.com URL) and, optionally, the text of
the claim you want tested. It reads the real commit count straight from the
GitHub API and tells you: MATCH, CLOSE, MISMATCH, or UNVERIFIABLE (a private
repo cannot be checked by a stranger, and that fact is itself the finding).

## How the commit count works

GitHub's API has no "total commits" field. The trick: request one commit per
page, then read the page number in the response's `Link: rel="last"` header.
That page number is the true total, no pagination loop required.

## Run it

No dependencies, no build step, no database.

```
node server.js
```

Then open `http://localhost:3000`.

## Stack

Plain Node.js (`node:http`, `node:fs`, `node:url`), a static HTML page, and
the public GitHub REST API. Deliberately has no framework and no dependency
tree: the whole app is two files.
