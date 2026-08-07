// receipt: paste a GitHub repo and a claim about it, get a verdict, not a vibe.
//
// Built to be exactly the thing I've been doing by hand all week: someone
// says "155 commits," and instead of trusting the number, you check it. This
// is that check, as a tool, using only the GitHub public API. No database, no
// auth, no dependencies. It works on any public repo, right now.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
const UA = "receipt-verifier";

/**
 * GitHub's API has no "total commits" field. The trick: ask for 1 commit per
 * page, then read the page number of the "last" link in the Link header.
 * That page number is the true total. No pagination loop required.
 */
async function commitCount(owner, repo, branch) {
  const url = `https://api.github.com/repos/${owner}/${repo}/commits?per_page=1${branch ? `&sha=${encodeURIComponent(branch)}` : ""}`;
  const res = await fetch(url, { headers: { "user-agent": UA, accept: "application/vnd.github+json" } });
  if (!res.ok) return { ok: false, status: res.status };
  const link = res.headers.get("link");
  const match = link && link.match(/[?&]page=(\d+)>;\s*rel="last"/);
  if (match) return { ok: true, count: Number(match[1]) };
  // No "last" link means everything fit on one page.
  const body = await res.json();
  return { ok: true, count: Array.isArray(body) ? body.length : 0 };
}

async function repoInfo(owner, repo) {
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
    headers: { "user-agent": UA, accept: "application/vnd.github+json" },
  });
  if (!res.ok) return { ok: false, status: res.status };
  const body = await res.json();
  return {
    ok: true,
    private: body.private,
    defaultBranch: body.default_branch,
    stars: body.stargazers_count,
    description: body.description,
    htmlUrl: body.html_url,
  };
}

/** Pull the first number near the word "commit" out of a free-text claim. */
function parseClaim(claim) {
  const m = claim.match(/(\d[\d,]*)\s*\+?\s*commits?/i) || claim.match(/commits?[^\d]{0,10}(\d[\d,]*)/i);
  if (!m) return null;
  return Number(m[1].replace(/,/g, ""));
}

function parseRepoInput(input) {
  const trimmed = input.trim();
  const urlMatch = trimmed.match(/github\.com\/([^/\s]+)\/([^/\s#?]+)/i);
  if (urlMatch) return { owner: urlMatch[1], repo: urlMatch[2].replace(/\.git$/, "") };
  const slashMatch = trimmed.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (slashMatch) return { owner: slashMatch[1], repo: slashMatch[2] };
  return null;
}

async function verify(input, claimText) {
  const parsedRepo = parseRepoInput(input);
  if (!parsedRepo) {
    return { verdict: "UNREADABLE", note: "Could not read that as owner/repo or a github.com URL." };
  }
  const { owner, repo } = parsedRepo;

  const info = await repoInfo(owner, repo);
  if (!info.ok) {
    return {
      verdict: "UNVERIFIABLE",
      note:
        info.status === 404
          ? `${owner}/${repo} is not public, or does not exist. A claim about a private repo cannot be checked by a stranger, which is itself the finding.`
          : `GitHub returned HTTP ${info.status}.`,
      owner,
      repo,
    };
  }

  const claimed = claimText ? parseClaim(claimText) : null;
  const commits = await commitCount(owner, repo, info.defaultBranch);

  const result = {
    owner,
    repo,
    htmlUrl: info.htmlUrl,
    private: info.private,
    stars: info.stars,
    description: info.description,
    actualCommits: commits.ok ? commits.count : null,
    claimedCommits: claimed,
  };

  if (claimed == null) {
    result.verdict = "INFO";
    result.note = commits.ok
      ? `No commit-count claim found in the text. Real count on ${info.defaultBranch}: ${commits.count}.`
      : "No claim found, and the commit count itself could not be read.";
    return result;
  }
  if (!commits.ok) {
    result.verdict = "UNVERIFIABLE";
    result.note = "Repo is public but the commit count could not be read.";
    return result;
  }
  if (claimed === commits.count) {
    result.verdict = "MATCH";
    result.note = `Claimed ${claimed}, real count is ${commits.count}. Exact match.`;
  } else if (Math.abs(claimed - commits.count) <= Math.max(2, commits.count * 0.02)) {
    result.verdict = "CLOSE";
    result.note = `Claimed ${claimed}, real count is ${commits.count}. Close enough to be the same claim made at a slightly different time.`;
  } else {
    result.verdict = "MISMATCH";
    result.note = `Claimed ${claimed}, real count is ${commits.count}. That is a real discrepancy, not rounding.`;
  }
  return result;
}

const MIME = { ".html": "text/html", ".css": "text/css", ".js": "application/javascript" };

const server = createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/api/verify") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const { repo, claim } = JSON.parse(body || "{}");
        if (!repo || typeof repo !== "string") {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ verdict: "ERROR", note: "Missing repo." }));
          return;
        }
        const result = await verify(repo, claim ?? "");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ verdict: "ERROR", note: err.message }));
      }
    });
    return;
  }

  // Static file serving, deliberately minimal: this is a two-file app.
  const reqPath = req.url === "/" ? "/index.html" : req.url;
  const filePath = path.join(PUBLIC_DIR, reqPath);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  try {
    const data = await readFile(filePath);
    const ext = path.extname(filePath);
    res.writeHead(200, { "content-type": MIME[ext] || "text/plain" });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
});

server.listen(PORT, () => {
  console.log(`receipt running on port ${PORT}`);
});
