// Project Board Law manager.
//
// Zero runtime dependencies: only the Node standard library is used. This module
// is the sole automation entry point for the governed GitHub Project supplied to
// every invocation as a canonical --project URL. It is non-interactive, applies
// writes by default, honours --dry-run, and emits JSON only.
//
// Everything below the pure-helper section is dependency-injectable so the
// mocked integration harness can drive it without touching live GitHub.
import * as https from "node:https";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { LAW_SHA256, PAYLOAD_SHA256, PAYLOADS, RUNTIME_MANAGER_SHA256, RUNTIME_PACKAGE_JSON, } from "./payload.generated.js";
// --------------------------------------------------------------------------
// Constants
// --------------------------------------------------------------------------
/** Pinned REST/GraphQL API version. */
export const API_VERSION = "2026-03-10";
export const REST_BASE = "https://api.github.com";
export const GRAPHQL_URL = "https://api.github.com/graphql";
export const TOKEN_KEY = "PROJECT_CI_TOKEN";
/**
 * The GitHub Actions environment that scopes the PAT. It is a secret-scoping
 * gate, not a deployment: every token-bearing job declares it with
 * `deployment: false`, which suppresses the Deployments-UI record while leaving
 * the environment's branch protection rules fully enforced (verified 2026-08-03).
 * `inspect` audits the environment's posture via `checkEnvironmentPosture`.
 */
export const DEPLOY_ENVIRONMENT = "project-board-law";
export const ENV_FILE = ".agents/project-ci.env";
export const JOURNAL_PATH = ".agents/project-board-law/journal.ndjson";
/**
 * Every secret name the pack provisions and requires to live ONLY on the
 * `project-board-law` environment (the Routine secrets). Any copy of one of these
 * at repository OR organization scope resolves in a token-bearing job regardless
 * of the environment and defeats the default-branch gate, so `inspect` sweeps all
 * applicable scopes for each. `PROJECT_CI_TOKEN` is the PAT; the two
 * `CLAUDE_ROUTINE_FIRE_*` values back the opt-in Routine callback bridge and are
 * likewise environment-scoped (see INSTALL.md).
 */
export const ROUTINE_SECRETS = [
    TOKEN_KEY,
    "CLAUDE_ROUTINE_FIRE_URL",
    "CLAUDE_ROUTINE_FIRE_TOKEN",
];
/**
 * The canonical GitHub Actions secret-name grammar: a leading letter or
 * underscore followed by letters, digits, or underscores. Names are matched
 * case-insensitively by GitHub, so the audit canonicalizes every observed name
 * to uppercase before comparing. A name that does not match this pattern (empty,
 * whitespace-only, whitespace-padded, digit-leading, or otherwise garbage) is not
 * a real secret name and must fail closed rather than pad a total_count.
 */
export const SECRET_NAME_SYNTAX = /^[A-Za-z_][A-Za-z0-9_]*$/;
/**
 * The two exact status-check contexts that must gate the default branch. Both
 * must appear among the effective required status checks (branch protection AND
 * rulesets, unioned). Missing either — or protection that cannot be read — is a
 * distinct fail-closed violation. `identity` is the secretless job; `live-board`
 * is the base-controlled privileged job.
 */
export const REQUIRED_STATUS_CHECK_CONTEXTS = [
    "Project Board Law / identity",
    "project-board-law/live-board",
];
export const BLOCK_BEGIN = "<!-- PROJECT-BOARD-LAW:BEGIN -->";
export const BLOCK_END = "<!-- PROJECT-BOARD-LAW:END -->";
export const APPROVED = "Approved";
export const IN_REVIEW = "In Review";
export const COMMANDS = [
    "inspect",
    "reconcile",
    "install",
    "item",
    "status",
    "hr",
    "true-up",
    "milestone",
];
/**
 * Every option a command consumes, beyond the global --repo/--project/--dry-run.
 * main() rejects any supplied option outside its command's set so that no
 * option — least of all a confirmation — is ever silently ignored.
 */
const GLOBAL_OPTIONS = new Set(["repo", "project", "dry-run"]);
const COMMAND_OPTIONS = {
    inspect: new Set(),
    reconcile: new Set(["iteration-start", "iteration-days"]),
    install: new Set([
        "milestone", "true-up-milestone", "iteration",
        "iteration-start", "iteration-days", "replace-true-up-body",
    ]),
    item: new Set([
        "issue", "title", "confirm", "reset", "status", "priority", "size",
        "estimate", "iteration", "iteration-start", "iteration-days", "parent",
        "blocked-by", "label", "assignee", "milestone", "body",
    ]),
    status: new Set(["issue", "value", "reset"]),
    hr: new Set(["issue", "mode", "request", "reset"]),
    "true-up": new Set(["milestone", "iteration"]),
    milestone: new Set(["name", "due"]),
};
/** Additive schema the manager guarantees. Options/extras are preserved. */
export const REQUIRED_SCHEMA = [
    { name: "Status", dataType: "SINGLE_SELECT", options: [IN_REVIEW, APPROVED] },
    {
        name: "Priority",
        dataType: "SINGLE_SELECT",
        options: ["P0", "P1", "P2", "P3"],
    },
    {
        name: "Size",
        dataType: "SINGLE_SELECT",
        options: ["XS", "S", "M", "L", "XL"],
    },
    { name: "Estimate", dataType: "NUMBER" },
    { name: "Iteration", dataType: "ITERATION" },
];
/** Number of bounded retries for concurrency-sensitive item mutations. */
const ITEM_RETRIES = 3;
// --------------------------------------------------------------------------
// Errors
// --------------------------------------------------------------------------
/** Fail-closed error whose message is safe to print (never carries a token). */
export class ManagerError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = "ManagerError";
        this.code = code;
    }
}
// --------------------------------------------------------------------------
// Argument parsing
// --------------------------------------------------------------------------
const BOOLEAN_FLAGS = new Set(["dry-run"]);
/**
 * Parse `argv` (already stripped of node + script) into a command plus an
 * option map. Supports `--key value`, `--key=value`, repeated flags, and the
 * boolean `--dry-run`.
 */
export function parseArgv(argv) {
    const command = argv[0] ?? "";
    const opts = Object.create(null);
    const push = (key, value) => {
        (opts[key] ??= []).push(value);
    };
    for (let i = 1; i < argv.length; i++) {
        const token = argv[i];
        if (token === undefined)
            continue;
        if (!token.startsWith("--")) {
            throw new ManagerError("bad-argument", `unexpected argument: ${token}`);
        }
        const body = token.slice(2);
        if (body.length === 0) {
            throw new ManagerError("bad-argument", "empty option name");
        }
        const eq = body.indexOf("=");
        if (eq >= 0) {
            push(body.slice(0, eq), body.slice(eq + 1));
            continue;
        }
        if (BOOLEAN_FLAGS.has(body)) {
            push(body, "true");
            continue;
        }
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("--")) {
            push(body, "true");
            continue;
        }
        push(body, next);
        i++;
    }
    return { command, opts };
}
export function firstOpt(opts, key) {
    const list = opts[key];
    return list && list.length > 0 ? list[0] : undefined;
}
export function allOpts(opts, key) {
    return opts[key] ? [...opts[key]] : [];
}
export function hasFlag(opts, key) {
    const list = opts[key];
    return Boolean(list && list.length > 0 && list[0] === "true");
}
export function requireOpt(opts, key) {
    const value = firstOpt(opts, key);
    if (value === undefined || value === "" || value === "true") {
        throw new ManagerError("missing-option", `missing required --${key}`);
    }
    return value;
}
/** A repeatable option value list stripped of the boolean-sentinel "true". */
export function realOpts(opts, key) {
    return allOpts(opts, key).filter((v) => v !== "true");
}
export function nullableOpt(opts, key) {
    const v = firstOpt(opts, key);
    return v && v !== "true" ? v : null;
}
/**
 * A confirmation-class option carries destructive or override intent and may be
 * supplied at most once; conflicting repeated values fail closed rather than
 * silently resolving to either one.
 */
export function singleOpt(opts, key) {
    if (allOpts(opts, key).some((value) => value === "true")) {
        throw new ManagerError("confirmation", `--${key} requires a value`);
    }
    const values = realOpts(opts, key);
    if (values.length > 1) {
        throw new ManagerError("confirmation", `--${key} may be supplied at most once; received ${values.length} conflicting values`);
    }
    return values.length === 1 ? values[0] : null;
}
const REPO_RE = /^https:\/\/github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/;
/** Strict canonical `https://github.com/OWNER/REPO` with no suffix or slash. */
export function parseRepoUrl(value) {
    const match = REPO_RE.exec(value);
    if (!match) {
        throw new ManagerError("bad-repo", "invalid --repo; expected https://github.com/OWNER/REPO");
    }
    const owner = match[1];
    const repo = match[2];
    if (repo.endsWith(".git")) {
        throw new ManagerError("bad-repo", "invalid --repo; drop the .git suffix");
    }
    // `.` and `..` are legal in the character class but are path segments, not
    // names: every REST path interpolates OWNER/REPO, and URL parsing resolves
    // the dots, so `../user` would silently retarget requests at an unrelated
    // endpoint while still carrying the token. No GitHub owner or repository is
    // named `.` or `..`, so rejecting them costs nothing.
    for (const segment of [owner, repo]) {
        if (segment === "." || segment === "..") {
            throw new ManagerError("bad-repo", "invalid --repo; owner and repository cannot be . or ..");
        }
    }
    return { owner, repo, url: `https://github.com/${owner}/${repo}`, nwo: `${owner}/${repo}` };
}
const PROJECT_RE = /^https:\/\/github\.com\/(users|orgs)\/([A-Za-z0-9._-]+)\/projects\/(\d+)$/;
/**
 * Strict canonical Project URL, either user-owned
 * (`https://github.com/users/OWNER/projects/N`) or organization-owned
 * (`https://github.com/orgs/OWNER/projects/N`). The URL segment is the sole
 * source of the owner type, so no extra probe call is needed. There is no
 * default or inferred target: every invocation must name its Project.
 */
export function parseProjectUrl(value) {
    const match = PROJECT_RE.exec(value);
    if (!match) {
        throw new ManagerError("bad-project", "invalid --project; expected https://github.com/users/OWNER/projects/NUMBER or https://github.com/orgs/OWNER/projects/NUMBER");
    }
    const segment = match[1];
    const login = match[2];
    const digits = match[3];
    const number = Number.parseInt(digits, 10);
    if (!Number.isInteger(number) || number <= 0 || String(number) !== digits) {
        throw new ManagerError("bad-project", "invalid --project; project number must be a positive integer");
    }
    return {
        ownerType: segment === "users" ? "user" : "organization",
        login,
        number,
        url: `https://github.com/${segment}/${login}/projects/${number}`,
    };
}
/**
 * Validate an item-specific confirmation like `ARCHIVE:42`. Confirmations can
 * never be supplied globally; they must name the exact issue number.
 */
export function parseConfirmation(value, kind, issueNumber) {
    return value === `${kind}:${issueNumber}`;
}
/** Parse a `KIND:N` confirmation token into its parts, or null when malformed. */
export function splitConfirmation(value) {
    const m = /^(ARCHIVE|DELETE|RESET-APPROVAL):(\d+)$/.exec(value);
    if (!m)
        return null;
    return { kind: m[1], issue: Number.parseInt(m[2], 10) };
}
/**
 * Normalize an issue title into a set of word tokens for deterministic
 * near-duplicate detection: uppercase, every run of non-alphanumeric characters
 * becomes a single space, surrounding whitespace is trimmed, and the remaining
 * words form a set. Locale-independent (Unicode letter/number classes), so it is
 * stable across platforms and depends only on the title bytes.
 */
export function normalizeTitleTokens(title) {
    return new Set(title
        .toUpperCase()
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim()
        .split(/\s+/)
        .filter((token) => token.length > 0));
}
/** True when `inner` is non-empty and every one of its tokens is in `outer`. */
function tokenSetContains(inner, outer) {
    if (inner.size === 0)
        return false;
    for (const token of inner)
        if (!outer.has(token))
            return false;
    return true;
}
/**
 * Deterministic near-duplicate detection: given a proposed issue title and a set
 * of open issues, return those whose normalized token set has Jaccard overlap
 * >= 0.5 with the proposal, OR where one token set fully contains the other.
 * Wording-level differences (case, punctuation, filler words, reordering) thus
 * surface as the same Work. Results are ordered most-similar first, then by issue
 * number, so the caller can present a bounded, stable list.
 */
export function duplicateIssueCandidates(proposedTitle, openIssues) {
    const proposed = normalizeTitleTokens(proposedTitle);
    if (proposed.size === 0)
        return [];
    const scored = [];
    for (const issue of openIssues) {
        const other = normalizeTitleTokens(issue.title);
        if (other.size === 0)
            continue;
        let intersection = 0;
        for (const token of proposed)
            if (other.has(token))
                intersection += 1;
        const union = proposed.size + other.size - intersection;
        const jaccard = union === 0 ? 0 : intersection / union;
        const contained = tokenSetContains(proposed, other) || tokenSetContains(other, proposed);
        if (jaccard >= 0.5 || contained) {
            scored.push({ number: issue.number, title: issue.title, score: contained ? 1 : jaccard });
        }
    }
    scored.sort((a, b) => b.score - a.score || a.number - b.number);
    return scored.map(({ number, title }) => ({ number, title }));
}
// --------------------------------------------------------------------------
// Identity: SHA-256, managed AGENTS block
// --------------------------------------------------------------------------
export function sha256Hex(bytes) {
    return createHash("sha256").update(bytes).digest("hex");
}
/** `BEGIN\n<law bytes>END\n`; the law payload already ends with one newline. */
export function buildManagedBlock(lawText) {
    return `${BLOCK_BEGIN}\n${lawText}${BLOCK_END}\n`;
}
/**
 * Produce the AGENTS.md content whose byte-zero region is the managed block.
 *
 * The law payload itself documents the two marker strings, so a legitimate
 * managed block contains a *balanced, nested* BEGIN/END pair inside its body.
 * Raw substring counts are therefore invalid. Instead the existing content is
 * scanned as a stream of markers walked with a nesting-depth counter: a BEGIN
 * at depth zero opens a top-level block, the END that returns depth to zero
 * closes it, and inner marker examples never register as separate blocks.
 *
 * Exactly one top-level block is accepted (whatever its body — a nested marker
 * example or an outdated payload) and replaced with the current exact block at
 * byte zero, preserving every other byte except the wrapper's single trailing
 * LF/CRLF after END. When no markers exist the block is prepended. An END
 * before BEGIN, unbalanced markers, or more than one top-level block all fail
 * closed. A byte-zero current block is left byte-for-byte unchanged.
 */
export function planAgentsContent(existing, lawText) {
    const block = buildManagedBlock(lawText);
    if (existing === null || existing.length === 0)
        return block;
    let depth = 0;
    let topCount = 0;
    let topBegin = -1;
    let firstBegin = -1;
    let firstEndAfter = -1;
    let cursor = 0;
    while (cursor < existing.length) {
        const beginIdx = existing.indexOf(BLOCK_BEGIN, cursor);
        const endIdx = existing.indexOf(BLOCK_END, cursor);
        if (beginIdx < 0 && endIdx < 0)
            break;
        const isBegin = endIdx < 0 || (beginIdx >= 0 && beginIdx < endIdx);
        if (isBegin) {
            if (depth === 0)
                topBegin = beginIdx;
            depth++;
            cursor = beginIdx + BLOCK_BEGIN.length;
        }
        else {
            if (depth === 0) {
                throw new ManagerError("malformed-agents", "PROJECT-BOARD-LAW:END precedes BEGIN");
            }
            depth--;
            const endAfter = endIdx + BLOCK_END.length;
            if (depth === 0) {
                topCount++;
                if (topCount === 1) {
                    firstBegin = topBegin;
                    firstEndAfter = endAfter;
                }
            }
            cursor = endAfter;
        }
    }
    if (depth !== 0) {
        throw new ManagerError("malformed-agents", "unbalanced PROJECT-BOARD-LAW markers");
    }
    if (topCount > 1) {
        throw new ManagerError("malformed-agents", "duplicate PROJECT-BOARD-LAW block");
    }
    if (topCount === 0) {
        return block + existing;
    }
    // Consume the wrapper's single trailing newline (LF or CRLF) after END so the
    // relocated/replaced block does not leave a stray blank line behind.
    let consumed = firstEndAfter;
    if (existing.startsWith("\r\n", consumed))
        consumed += 2;
    else if (existing[consumed] === "\n")
        consumed += 1;
    const before = existing.slice(0, firstBegin);
    const after = existing.slice(consumed);
    return block + before + after;
}
/** True when the file already opens with the exact expected managed block. */
export function agentsBlockMatches(existing, lawText) {
    if (existing === null)
        return false;
    return existing.startsWith(buildManagedBlock(lawText));
}
/**
 * Decode an existing AGENTS.md as text for managed-block planning, refusing to
 * proceed when the bytes are not round-trippable UTF-8.
 *
 * `planAgentsContent` preserves the file's unmanaged bytes by slicing them as a
 * UTF-8 string and rewriting them via `Buffer.from(text, "utf8")`. Invalid or
 * non-round-tripping bytes decode to U+FFFD and would be silently normalized on
 * write, corrupting user-owned content outside the managed block. Reject them at
 * the trust boundary (fail closed) instead of normalizing them away.
 */
export function decodeAgentsText(buf) {
    const text = buf.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(buf)) {
        throw new ManagerError("malformed-agents", "AGENTS.md is not round-trippable UTF-8; refusing to normalize unmanaged bytes");
    }
    return text;
}
// --------------------------------------------------------------------------
// OAuth scope verification
// --------------------------------------------------------------------------
export function parseScopes(header) {
    if (!header)
        return [];
    return header
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
}
/**
 * Verify reported scopes. Read-only needs `read:project` or `project`. Writes
 * need `project` plus repository issue access: `repo` for private repositories,
 * `repo` or `public_repo` for public-only. Fine-grained tokens report no such
 * classic scopes and therefore fail closed.
 */
export function checkScopes(scopes, opts) {
    const set = new Set(scopes);
    if (opts.write) {
        if (!set.has("project")) {
            return { ok: false, reason: "project scope missing" };
        }
        if (opts.repoPrivate) {
            if (!set.has("repo")) {
                return { ok: false, reason: "repo scope missing for private repository" };
            }
        }
        else if (!set.has("repo") && !set.has("public_repo")) {
            return { ok: false, reason: "repo or public_repo scope missing" };
        }
        return { ok: true };
    }
    if (set.has("project") || set.has("read:project"))
        return { ok: true };
    return { ok: false, reason: "read:project or project scope missing" };
}
// --------------------------------------------------------------------------
// Dates + true-up scheduling (all UTC)
// --------------------------------------------------------------------------
const DAY_MS = 86_400_000;
export function isValidYmd(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value))
        return false;
    const ms = Date.parse(`${value}T00:00:00Z`);
    if (Number.isNaN(ms))
        return false;
    return toYmd(ms) === value;
}
export function toYmd(ms) {
    const d = new Date(ms);
    const y = d.getUTCFullYear().toString().padStart(4, "0");
    const m = (d.getUTCMonth() + 1).toString().padStart(2, "0");
    const day = d.getUTCDate().toString().padStart(2, "0");
    return `${y}-${m}-${day}`;
}
/** Count UTC weekdays (Mon–Fri) strictly after `fromMs` up to and incl `toMs`. */
export function weekdaysBetween(fromMs, toMs) {
    if (toMs <= fromMs)
        return 0;
    const end = Math.floor(toMs / DAY_MS) * DAY_MS;
    let count = 0;
    for (let d = Math.floor(fromMs / DAY_MS) * DAY_MS + DAY_MS; d <= end; d += DAY_MS) {
        const dow = new Date(d).getUTCDay();
        if (dow !== 0 && dow !== 6)
            count++;
    }
    return count;
}
/** Due immediately when no completed true-up exists, else after >5 weekdays. */
export function isTrueUpDue(lastClosedMs, nowMs) {
    if (lastClosedMs === null)
        return true;
    return weekdaysBetween(lastClosedMs, nowMs) > 5;
}
const TRUE_UP_RE = /^Project Board true-up #(\d+)$/;
export function trueUpNumber(title) {
    const m = TRUE_UP_RE.exec(title);
    if (!m)
        return null;
    return Number.parseInt(m[1], 10);
}
/** Highest existing true-up number across titles, 0 when none. */
export function maxTrueUpNumber(titles) {
    let max = 0;
    for (const t of titles) {
        const n = trueUpNumber(t);
        if (n !== null && n > max)
            max = n;
    }
    return max;
}
/**
 * Diff the required additive schema against existing Project fields. Duplicate
 * required names or a required name at the wrong dataType is a hard failure.
 * Existing options/config are preserved; only missing options are planned.
 */
export function planSchema(existing) {
    const byName = new Map();
    for (const f of existing) {
        const bucket = byName.get(f.name);
        if (bucket)
            bucket.push(f);
        else
            byName.set(f.name, [f]);
    }
    const plan = { createFields: [], addOptions: [], createIteration: false };
    for (const req of REQUIRED_SCHEMA) {
        const matches = byName.get(req.name) ?? [];
        if (matches.length > 1) {
            throw new ManagerError("schema-collision", `duplicate field name: ${req.name}`);
        }
        const current = matches[0];
        if (!current) {
            if (req.dataType === "ITERATION")
                plan.createIteration = true;
            else
                plan.createFields.push(req);
            continue;
        }
        if (current.dataType !== req.dataType) {
            throw new ManagerError("schema-collision", `field ${req.name} has data type ${current.dataType}, expected ${req.dataType}`);
        }
        if (req.options) {
            const present = new Set((current.options ?? []).map((o) => o.name));
            for (const option of req.options) {
                if (!present.has(option))
                    plan.addOptions.push({ field: req.name, option });
            }
        }
    }
    return plan;
}
/** True when the required schema is fully satisfied with no additive work. */
export function schemaSatisfied(plan) {
    return (plan.createFields.length === 0 &&
        plan.addOptions.length === 0 &&
        !plan.createIteration);
}
// --------------------------------------------------------------------------
// Token loading + sanitising
// --------------------------------------------------------------------------
export function parseEnvFile(content) {
    const out = Object.create(null);
    for (const raw of content.split(/\r?\n/)) {
        const line = raw.trim();
        if (line.length === 0 || line.startsWith("#"))
            continue;
        const eq = line.indexOf("=");
        if (eq < 0)
            continue;
        const key = line.slice(0, eq).trim();
        let value = line.slice(eq + 1).trim();
        if (value.length >= 2 &&
            ((value.startsWith('"') && value.endsWith('"')) ||
                (value.startsWith("'") && value.endsWith("'")))) {
            value = value.slice(1, -1);
        }
        out[key] = value;
    }
    return out;
}
/** Replace every occurrence of the live token with a fixed redaction marker. */
export function redactToken(text, token) {
    if (!token)
        return text;
    return text.split(token).join("***");
}
/** Default transport over node:https. Never used when a mock is injected. */
export const nodeHttpsTransport = (req) => new Promise((resolve, reject) => {
    let u;
    try {
        u = new URL(req.url);
    }
    catch {
        reject(new ManagerError("bad-url", "invalid request URL"));
        return;
    }
    const options = {
        method: req.method,
        hostname: u.hostname,
        path: `${u.pathname}${u.search}`,
        port: u.port || 443,
        headers: req.headers,
    };
    const request = https.request(options, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
            const headers = Object.create(null);
            for (const [k, v] of Object.entries(res.headers)) {
                if (v === undefined)
                    continue;
                headers[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : String(v);
            }
            resolve({
                status: res.statusCode ?? 0,
                headers,
                body: Buffer.concat(chunks).toString("utf8"),
            });
        });
    });
    request.on("error", (err) => reject(err));
    if (req.body !== undefined)
        request.write(req.body);
    request.end();
});
const MAX_RETRIES = 3;
const MAX_DELAY_MS = 60_000;
function hasRateSignal(headers) {
    return (headers["retry-after"] !== undefined ||
        headers["x-ratelimit-remaining"] === "0");
}
/**
 * Decide whether a status code warrants a retry. 429 is always retryable (it
 * was rejected, not processed). A 403 retries only when it carries a rate
 * signal — never an arbitrary permission 403. 502/503/504 retry only for
 * idempotent requests; a non-idempotent create is not blindly re-sent.
 */
export function shouldRetryStatus(status, headers, idempotent) {
    if (status === 429)
        return true;
    if (status === 403)
        return hasRateSignal(headers);
    if (status === 502 || status === 503 || status === 504)
        return idempotent;
    return false;
}
/**
 * Compute a bounded backoff delay from response headers. Honours `Retry-After`
 * (seconds) and, on a spent primary quota, `X-RateLimit-Reset` (epoch seconds).
 * Falls back to a capped exponential backoff. Never returns a negative value.
 */
export function computeRetryDelayMs(headers, attempt, nowMs) {
    const retryAfter = headers["retry-after"];
    if (retryAfter !== undefined) {
        const secs = Number.parseInt(retryAfter.trim(), 10);
        if (Number.isFinite(secs) && secs >= 0)
            return Math.min(secs * 1000, MAX_DELAY_MS);
    }
    const remaining = headers["x-ratelimit-remaining"];
    const reset = headers["x-ratelimit-reset"];
    if (remaining === "0" && reset !== undefined) {
        const resetMs = Number.parseInt(reset.trim(), 10) * 1000;
        if (Number.isFinite(resetMs)) {
            return Math.max(0, Math.min(resetMs - nowMs, MAX_DELAY_MS));
        }
    }
    return Math.min(1000 * 2 ** attempt, MAX_DELAY_MS);
}
/** Thin GitHub REST + GraphQL client with bounded, rate-aware retries. */
export class GitHubClient {
    token;
    deps;
    constructor(token, deps) {
        this.token = token;
        this.deps = deps;
    }
    baseHeaders(extra) {
        return {
            authorization: `Bearer ${this.token}`,
            accept: "application/vnd.github+json",
            "user-agent": "project-board-law",
            "x-github-api-version": API_VERSION,
            ...extra,
        };
    }
    /**
     * Perform a request with retries for network errors, 429, rate-limited 403,
     * and (idempotent-only) 502–504. A non-idempotent request is never retried on
     * an ambiguous network error; it fails closed so the caller can reconcile.
     */
    async request(req, idempotent) {
        let lastError;
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            let res;
            try {
                res = await this.deps.transport(req);
            }
            catch (err) {
                lastError = err;
                if (idempotent && attempt < MAX_RETRIES) {
                    await this.deps.sleep(Math.min(1000 * 2 ** attempt, MAX_DELAY_MS));
                    continue;
                }
                throw new ManagerError("network", `request failed (fail-closed, no blind retry): ${errText(err)}`);
            }
            if (attempt < MAX_RETRIES && shouldRetryStatus(res.status, res.headers, idempotent)) {
                await this.deps.sleep(computeRetryDelayMs(res.headers, attempt, this.deps.now()));
                continue;
            }
            return res;
        }
        throw new ManagerError("network", `request failed after retries: ${errText(lastError)}`);
    }
    async rest(method, path, body) {
        const url = path.startsWith("http") ? path : `${REST_BASE}${path}`;
        const hasBody = body !== undefined;
        const headers = this.baseHeaders(hasBody ? { "content-type": "application/json" } : undefined);
        const req = hasBody
            ? { method, url, headers, body: JSON.stringify(body) }
            : { method, url, headers };
        // Only POST is treated as non-idempotent; PUT/PATCH/DELETE/GET may retry.
        const res = await this.request(req, method !== "POST");
        let json = null;
        if (res.body.length > 0) {
            try {
                json = JSON.parse(res.body);
            }
            catch {
                json = null;
            }
        }
        if (res.status >= 400) {
            throw new ManagerError("rest-error", `REST ${method} ${path} -> ${res.status}: ${messageOf(json) ?? res.status}`);
        }
        return { status: res.status, headers: res.headers, json, body: res.body };
    }
    /**
     * GET that resolves a 404 to `null` instead of throwing, for existence probes
     * (an environment or a secret that may legitimately be absent). Every other
     * >= 400 status still fails closed exactly like `rest`. GET is idempotent, so
     * the underlying request retries rate/5xx signals like any other read.
     */
    async restOptional(path) {
        const url = path.startsWith("http") ? path : `${REST_BASE}${path}`;
        const res = await this.request({ method: "GET", url, headers: this.baseHeaders() }, true);
        if (res.status === 404)
            return null;
        let json = null;
        if (res.body.length > 0) {
            try {
                json = JSON.parse(res.body);
            }
            catch {
                json = null;
            }
        }
        if (res.status >= 400) {
            throw new ManagerError("rest-error", `REST GET ${path} -> ${res.status}: ${messageOf(json) ?? res.status}`);
        }
        return { status: res.status, headers: res.headers, json, body: res.body };
    }
    /**
     * GET that classifies a scope probe by status instead of throwing. Returns the
     * status for EXACTLY 200 (present/readable), 403 (permission-denied — the scope
     * cannot be verified, so the caller fails closed), and 404 (definitively absent).
     * EVERY other status — including a 2xx that is not 200 (e.g. 204) and any 3xx
     * (an unfollowed redirect) as well as every >= 400 — fails closed exactly like
     * `rest`, because a probe caller treats "not 200/403/404" as clean and an
     * unexpected status must never be silently classified that way. GET is
     * idempotent, so a rate-limited 403 is retried underneath
     * (`request`/`shouldRetryStatus`) and only a terminal permission 403 reaches the
     * caller.
     */
    async restProbe(path) {
        const url = path.startsWith("http") ? path : `${REST_BASE}${path}`;
        const res = await this.request({ method: "GET", url, headers: this.baseHeaders() }, true);
        let json = null;
        if (res.body.length > 0) {
            try {
                json = JSON.parse(res.body);
            }
            catch {
                json = null;
            }
        }
        if (res.status === 200 || res.status === 403 || res.status === 404) {
            return { status: res.status, json };
        }
        throw new ManagerError("rest-error", `REST GET ${path} -> ${res.status}: ${messageOf(json) ?? res.status}`);
    }
    /** GET every page of an array endpoint, following RFC 5988 Link rel=next. */
    async restPaginate(path) {
        let url = path;
        const out = [];
        for (;;) {
            const res = await this.rest("GET", url);
            if (Array.isArray(res.json))
                out.push(...res.json);
            const next = parseLinkNext(res.headers["link"]);
            if (!next)
                break;
            url = next;
        }
        return out;
    }
    /** Fetch classic OAuth scopes reported for the token via `GET /user`. */
    async fetchScopes() {
        const res = await this.rest("GET", "/user");
        return parseScopes(res.headers["x-oauth-scopes"]);
    }
    async graphql(query, variables, idempotent) {
        const headers = this.baseHeaders({ "content-type": "application/json" });
        const req = {
            method: "POST",
            url: GRAPHQL_URL,
            headers,
            body: JSON.stringify({ query, variables }),
        };
        const res = await this.request(req, idempotent);
        let parsed = null;
        try {
            parsed = JSON.parse(res.body);
        }
        catch {
            parsed = null;
        }
        if (res.status >= 400 || !parsed) {
            throw new ManagerError("graphql-error", `GraphQL request failed (${res.status})`);
        }
        if (parsed.errors && parsed.errors.length > 0) {
            throw new ManagerError("graphql-error", `GraphQL error: ${parsed.errors.map((e) => e.message).join("; ")}`);
        }
        if (parsed.data === undefined) {
            throw new ManagerError("graphql-error", "GraphQL response missing data");
        }
        return parsed.data;
    }
}
/** Extract the `rel="next"` URL from a Link header, or null when absent. */
export function parseLinkNext(header) {
    if (!header)
        return null;
    for (const part of header.split(",")) {
        const m = /<([^>]+)>\s*;\s*rel="next"/.exec(part.trim());
        if (m)
            return m[1];
    }
    return null;
}
function errText(err) {
    if (err instanceof Error)
        return err.message;
    return String(err);
}
function messageOf(json) {
    if (json && typeof json === "object" && "message" in json) {
        const m = json.message;
        if (typeof m === "string")
            return m;
    }
    return undefined;
}
/**
 * Build a Project-owner-rooted query. `User` and `Organization` both expose
 * `projectV2(number:)`, but they are distinct GraphQL roots, so the owner type
 * parsed from the Project URL selects the root. Querying both roots at once is
 * not viable: the wrong root resolves to a top-level GraphQL error.
 */
function ownerQuery(project, body, extraVars = "") {
    return `
query($login: String!, $number: Int!, $cursor: String${extraVars}) {
  ${project.ownerType}(login: $login) {
${body}
  }
}`;
}
/** Extract the ProjectV2 payload from whichever owner root was queried. */
function projectOf(data, project) {
    const found = data[project.ownerType]?.projectV2;
    if (!found) {
        throw new ManagerError("no-project", `Project not found or not accessible: ${project.url}`);
    }
    return found;
}
const FIELDS_BODY = `
    projectV2(number: $number) {
      id
      title
      fields(first: 50, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          __typename
          ... on ProjectV2FieldCommon { id name dataType }
          ... on ProjectV2SingleSelectField {
            id name dataType options { id name color description }
          }
          ... on ProjectV2IterationField {
            id name dataType
            configuration {
              iterations { id title startDate duration }
              completedIterations { id title startDate duration }
            }
          }
        }
      }
    }`;
/** Resolve the addressed Project for its owner, paginating all custom fields. */
export async function resolveProject(client, ref) {
    const fields = [];
    let cursor = null;
    let id = "";
    let title = "";
    const query = ownerQuery(ref, FIELDS_BODY);
    for (;;) {
        const data = await client.graphql(query, { login: ref.login, number: ref.number, cursor }, true);
        const project = projectOf(data, ref);
        id = project.id;
        title = project.title;
        for (const node of project.fields.nodes) {
            if (!node || !node.name || !node.dataType)
                continue;
            const field = { name: node.name, dataType: node.dataType };
            if (node.id !== undefined)
                field.id = node.id;
            if (node.options)
                field.options = node.options;
            if (node.configuration) {
                field.iterations = [
                    ...(node.configuration.iterations ?? []),
                    ...(node.configuration.completedIterations ?? []),
                ];
            }
            fields.push(field);
        }
        if (!project.fields.pageInfo.hasNextPage)
            break;
        cursor = project.fields.pageInfo.endCursor;
        if (cursor === null)
            break;
    }
    return { id, title, fields };
}
const REQUIRED_ITEM_VALUE_FIELDS = ["Status", "Priority", "Size", "Estimate", "Iteration"];
/** Return required custom Project values that are absent or unusable. */
export function missingRequiredItemValues(item) {
    const missing = [];
    for (const name of REQUIRED_ITEM_VALUE_FIELDS) {
        const value = item.values.get(name);
        if (!value) {
            missing.push(name);
            continue;
        }
        if ((name === "Status" || name === "Priority" || name === "Size") && !value.optionName) {
            missing.push(name);
        }
        else if (name === "Estimate" && !Number.isFinite(value.number)) {
            missing.push(name);
        }
        else if (name === "Iteration" && !value.iterationTitle) {
            missing.push(name);
        }
    }
    return missing;
}
const ITEMS_VARS = ", $archivedStates: [ProjectV2ItemArchivedState!]";
/**
 * Bulk item read. GitHub multiplies the `first:` argument of every nested
 * connection to score a query and rejects anything above 500,000 possible
 * nodes, so this query deliberately stops at two levels: 100 items x 100 field
 * values = 10,000. A third nested connection here (linked pull requests, at
 * 100) would score 1,000,000 and make every call fail with a node-limit error,
 * so pull request links are fetched separately by `fetchPullRequestLinks`.
 */
const ITEMS_BODY = `
    projectV2(number: $number) {
      items(first: 100, after: $cursor, archivedStates: $archivedStates) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          updatedAt
          content {
            __typename
            ... on Issue { number repository { nameWithOwner } }
          }
          fieldValues(first: 100) {
            pageInfo { hasNextPage endCursor }
            nodes {
              __typename
              ... on ProjectV2ItemFieldSingleSelectValue {
                name optionId field { ... on ProjectV2FieldCommon { name } }
              }
              ... on ProjectV2ItemFieldNumberValue {
                number field { ... on ProjectV2FieldCommon { name } }
              }
              ... on ProjectV2ItemFieldIterationValue {
                title iterationId field { ... on ProjectV2FieldCommon { name } }
              }
            }
          }
        }
      }
    }`;
const MORE_FIELD_VALUES_QUERY = `
query($itemId: ID!, $cursor: String) {
  node(id: $itemId) {
    ... on ProjectV2Item {
      fieldValues(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          __typename
          ... on ProjectV2ItemFieldSingleSelectValue {
            name optionId field { ... on ProjectV2FieldCommon { name } }
          }
          ... on ProjectV2ItemFieldNumberValue {
            number field { ... on ProjectV2FieldCommon { name } }
          }
          ... on ProjectV2ItemFieldIterationValue {
            title iterationId field { ... on ProjectV2FieldCommon { name } }
          }
        }
      }
    }
  }
}`;
async function allFieldValues(client, item) {
    const values = [...item.fieldValues.nodes];
    let page = item.fieldValues.pageInfo;
    while (page.hasNextPage) {
        if (page.endCursor === null) {
            throw new ManagerError("pagination", `field values for item ${item.id} ended without a cursor`);
        }
        const data = await client.graphql(MORE_FIELD_VALUES_QUERY, { itemId: item.id, cursor: page.endCursor }, true);
        if (!data.node)
            throw new ManagerError("no-item", `Project item disappeared: ${item.id}`);
        values.push(...data.node.fieldValues.nodes);
        page = data.node.fieldValues.pageInfo;
    }
    return values;
}
/** Paginate every Project item and every field value, retaining issue-backed items. */
export async function resolveProjectItems(client, ref, archivedStates = ["NOT_ARCHIVED"]) {
    const out = [];
    let cursor = null;
    const query = ownerQuery(ref, ITEMS_BODY, ITEMS_VARS);
    for (;;) {
        const data = await client.graphql(query, { login: ref.login, number: ref.number, cursor, archivedStates }, true);
        const project = projectOf(data, ref);
        for (const node of project.items.nodes) {
            if (!node || !node.content || node.content.__typename !== "Issue")
                continue;
            const number = node.content.number;
            if (number === undefined)
                continue;
            const values = new Map();
            let statusName = null;
            for (const fv of await allFieldValues(client, node)) {
                const fieldName = fv?.field?.name;
                if (!fv || !fieldName)
                    continue;
                const value = { field: fieldName };
                if (fv.name !== undefined) {
                    value.optionName = fv.name;
                    if (fv.optionId !== undefined)
                        value.optionId = fv.optionId;
                    if (fieldName === "Status")
                        statusName = fv.name;
                }
                if (fv.number !== undefined)
                    value.number = fv.number;
                if (fv.title !== undefined) {
                    value.iterationTitle = fv.title;
                    if (fv.iterationId !== undefined)
                        value.iterationId = fv.iterationId;
                }
                values.set(fieldName, value);
            }
            out.push({
                id: node.id,
                updatedAt: node.updatedAt,
                issueNumber: number,
                repoNwo: node.content.repository?.nameWithOwner ?? "",
                statusName,
                values,
            });
        }
        if (!project.items.pageInfo.hasNextPage)
            break;
        cursor = project.items.pageInfo.endCursor;
        if (cursor === null)
            break;
    }
    return out;
}
// --------------------------------------------------------------------------
// Linked pull requests (fetched apart from the bulk item read)
// --------------------------------------------------------------------------
/**
 * Per-item linked-pull-request read. Scores 100 field values x 100 pull
 * requests = 10,000 possible nodes, well inside the 500,000 ceiling that the
 * old three-level bulk query breached.
 *
 * `ProjectV2ItemFieldPullRequestValue` exposes no `id` and does not implement
 * `Node`, so an individual value cannot be addressed for continuation. The
 * inner connection is instead advanced by re-reading the same field-value page
 * with a pull-request cursor. Projects exposes exactly one pull-request field
 * ("Linked pull requests"), so one shared cursor is unambiguous; if a page ever
 * carried two continuable pull-request values the shared cursor could not
 * describe both, and that fails closed rather than truncating silently.
 */
const PR_LINKS_QUERY = `
query($itemId: ID!, $cursor: String, $prCursor: String) {
  node(id: $itemId) {
    ... on ProjectV2Item {
      fieldValues(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          __typename
          ... on ProjectV2ItemFieldPullRequestValue {
            field { ... on ProjectV2FieldCommon { name } }
            pullRequests(first: 100, after: $prCursor) {
              pageInfo { hasNextPage endCursor }
              nodes { url }
            }
          }
        }
      }
    }
  }
}`;
function pullRequestUrls(node) {
    return (node.pullRequests?.nodes ?? [])
        .map((pr) => pr?.url)
        .filter((url) => typeof url === "string");
}
/**
 * Collect every linked pull request URL for one Project item, keyed by field
 * name. Both the field-value list and each pull-request connection are paged to
 * exhaustion, so a value with more than 100 links is reported in full.
 */
export async function fetchPullRequestLinks(client, itemId) {
    const out = new Map();
    let cursor = null;
    for (;;) {
        const page = await client.graphql(PR_LINKS_QUERY, { itemId, cursor, prCursor: null }, true);
        if (!page.node)
            throw new ManagerError("no-item", `Project item disappeared: ${itemId}`);
        const values = page.node.fieldValues.nodes.filter((node) => Boolean(node?.field?.name && node.pullRequests));
        const continuable = values.filter((node) => node.pullRequests?.pageInfo.hasNextPage);
        if (continuable.length > 1) {
            throw new ManagerError("pagination", `item ${itemId} has multiple continuable pull-request values on one page; cannot page them unambiguously`);
        }
        for (const value of values) {
            const name = value.field?.name;
            const collected = [...(out.get(name) ?? []), ...pullRequestUrls(value)];
            out.set(name, collected);
        }
        // Drain the single continuable pull-request connection, if any.
        const first = continuable[0];
        if (first) {
            const name = first.field?.name;
            let prCursor = first.pullRequests?.pageInfo.endCursor ?? null;
            while (prCursor !== null) {
                const more = await client.graphql(PR_LINKS_QUERY, { itemId, cursor, prCursor }, true);
                if (!more.node)
                    throw new ManagerError("no-item", `Project item disappeared: ${itemId}`);
                const match = more.node.fieldValues.nodes.find((node) => node?.field?.name === name && Boolean(node.pullRequests));
                if (!match)
                    break;
                out.set(name, [...(out.get(name) ?? []), ...pullRequestUrls(match)]);
                const info = match.pullRequests?.pageInfo;
                prCursor = info?.hasNextPage ? info.endCursor : null;
            }
        }
        if (!page.node.fieldValues.pageInfo.hasNextPage)
            break;
        cursor = page.node.fieldValues.pageInfo.endCursor;
        if (cursor === null) {
            throw new ManagerError("pagination", `field values for item ${itemId} ended without a cursor`);
        }
    }
    return out;
}
/** Find the Project item backing a repository issue number, or null. */
export async function findProjectItem(client, ref, issueNumber, repoNwo, archivedStates = ["NOT_ARCHIVED"]) {
    const items = await resolveProjectItems(client, ref, archivedStates);
    return (items.find((i) => i.issueNumber === issueNumber && i.repoNwo === repoNwo) ?? null);
}
async function updateItemField(client, projectId, itemId, fieldId, value) {
    await client.graphql(`mutation($input: UpdateProjectV2ItemFieldValueInput!) {
       updateProjectV2ItemFieldValue(input: $input) {
         projectV2Item { id updatedAt }
       }
     }`, { input: { projectId, itemId, fieldId, value } }, false);
}
async function addIssueToProject(client, projectId, contentId) {
    const data = await client.graphql(`mutation($projectId: ID!, $contentId: ID!) {
       addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) {
         item { id }
       }
     }`, { projectId, contentId }, false);
    return data.addProjectV2ItemById.item.id;
}
async function archiveProjectV2Item(client, projectId, itemId) {
    await client.graphql(`mutation($projectId: ID!, $itemId: ID!) {
       archiveProjectV2Item(input: { projectId: $projectId, itemId: $itemId }) {
         item { id }
       }
     }`, { projectId, itemId }, false);
}
async function deleteProjectV2Item(client, projectId, itemId) {
    await client.graphql(`mutation($projectId: ID!, $itemId: ID!) {
       deleteProjectV2Item(input: { projectId: $projectId, itemId: $itemId }) {
         deletedItemId
       }
     }`, { projectId, itemId }, false);
}
async function linkProjectToRepo(client, projectId, repositoryId) {
    await client.graphql(`mutation($projectId: ID!, $repositoryId: ID!) {
       linkProjectV2ToRepository(input: { projectId: $projectId, repositoryId: $repositoryId }) {
         repository { id }
       }
     }`, { projectId, repositoryId }, false);
}
const LINKED_REPOS_BODY = `
    projectV2(number: $number) {
      repositories(first: 100, after: $cursor) {
        nodes { nameWithOwner }
        pageInfo { hasNextPage endCursor }
      }
    }`;
async function projectLinkedToRepo(client, ref, repoNwo) {
    let cursor = null;
    const query = ownerQuery(ref, LINKED_REPOS_BODY);
    for (;;) {
        const data = await client.graphql(query, { login: ref.login, number: ref.number, cursor }, true);
        const project = projectOf(data, ref);
        if (project.repositories.nodes.some((repository) => repository?.nameWithOwner === repoNwo)) {
            return true;
        }
        if (!project.repositories.pageInfo.hasNextPage)
            return false;
        cursor = project.repositories.pageInfo.endCursor;
        if (cursor === null)
            throw new ManagerError("pagination", "linked repositories ended without a cursor");
    }
}
/**
 * Set a Project item field with best-feasible optimistic concurrency. The item
 * updatedAt is snapshotted before each mutation and the item is re-read after;
 * if the target value is not observed the mutation is retried up to
 * ITEM_RETRIES times. GitHub exposes no compare-and-swap for Project item
 * fields, so a competing edit landing in the microsecond window between our
 * re-read and a caller's next action remains an irreducible race; that residual
 * TOCTOU is journaled and surfaced rather than masked, and the run fails closed
 * if the value never verifies.
 */
async function setItemFieldConcurrent(ctx, projectId, issueNumber, fieldId, value, matches) {
    let lastSeen = "";
    for (let attempt = 0; attempt < ITEM_RETRIES; attempt++) {
        const before = await findProjectItem(ctx.client, ctx.project, issueNumber, ctx.repo.nwo);
        if (!before) {
            throw new ManagerError("not-in-project", `issue #${issueNumber} is not a Project item`);
        }
        lastSeen = before.updatedAt;
        if (matches(before))
            return; // already at the target; nothing to write
        await updateItemField(ctx.client, projectId, before.id, fieldId, value);
        const after = await findProjectItem(ctx.client, ctx.project, issueNumber, ctx.repo.nwo);
        if (after && matches(after))
            return; // verified
        // Value not observed: a concurrent edit likely intervened — retry fresh.
    }
    throw new ManagerError("concurrency", `unverifiable field write on issue #${issueNumber} after ${ITEM_RETRIES} attempts (last updatedAt ${lastSeen})`);
}
// --------------------------------------------------------------------------
// Schema ensuring (create fields, add options, create iteration)
// --------------------------------------------------------------------------
const DEFAULT_OPTION_COLOR = "GRAY";
function optionInputs(existing, required) {
    const out = [];
    const seen = new Set();
    for (const opt of existing ?? []) {
        const preserved = {
            name: opt.name,
            color: opt.color ?? DEFAULT_OPTION_COLOR,
            description: opt.description ?? "",
        };
        if (opt.id !== undefined)
            preserved.id = opt.id;
        out.push(preserved);
        seen.add(opt.name);
    }
    for (const name of required) {
        if (!seen.has(name)) {
            out.push({ name, color: DEFAULT_OPTION_COLOR, description: "" });
            seen.add(name);
        }
    }
    return out;
}
async function createSingleSelectField(client, projectId, name, options) {
    await client.graphql(`mutation($input: CreateProjectV2FieldInput!) {
       createProjectV2Field(input: $input) { projectV2Field { __typename } }
     }`, {
        input: {
            projectId,
            dataType: "SINGLE_SELECT",
            name,
            singleSelectOptions: optionInputs(undefined, options),
        },
    }, false);
}
async function createNumberField(client, projectId, name) {
    await client.graphql(`mutation($input: CreateProjectV2FieldInput!) {
       createProjectV2Field(input: $input) { projectV2Field { __typename } }
     }`, { input: { projectId, dataType: "NUMBER", name } }, false);
}
async function createIterationField(client, projectId, startDate, durationDays) {
    await client.graphql(`mutation($input: CreateProjectV2FieldInput!) {
       createProjectV2Field(input: $input) { projectV2Field { __typename } }
     }`, {
        input: {
            projectId,
            dataType: "ITERATION",
            name: "Iteration",
            iterationConfiguration: { startDate, duration: durationDays, iterations: [] },
        },
    }, false);
}
async function updateFieldOptions(client, fieldId, existing, required) {
    await client.graphql(`mutation($input: UpdateProjectV2FieldInput!) {
       updateProjectV2Field(input: $input) { projectV2Field { __typename } }
     }`, { input: { fieldId, singleSelectOptions: optionInputs(existing, required) } }, false);
}
/**
 * Additively ensure the required schema, preserving existing options/identity.
 * Missing single-selects/number fields are created; missing options are added
 * via a full option-set update that echoes existing ids-by-name/colors/
 * descriptions; a missing Iteration field is created only when explicit UTC
 * start/duration inputs are supplied. Returns a freshly refetched snapshot.
 */
async function ensureSchema(ctx, snapshot, iteration) {
    planSchema(snapshot.fields); // hard-fail duplicates / wrong dataType
    const byName = new Map(snapshot.fields.map((f) => [f.name, f]));
    let mutated = false;
    for (const req of REQUIRED_SCHEMA) {
        const current = byName.get(req.name);
        if (!current) {
            if (req.dataType === "SINGLE_SELECT") {
                await createSingleSelectField(ctx.client, snapshot.id, req.name, req.options ?? []);
                mutated = true;
            }
            else if (req.dataType === "NUMBER") {
                await createNumberField(ctx.client, snapshot.id, req.name);
                mutated = true;
            }
            else if (req.dataType === "ITERATION") {
                if (iteration.start && iteration.days !== undefined) {
                    await createIterationField(ctx.client, snapshot.id, iteration.start, iteration.days);
                    mutated = true;
                }
                // else: left for a later run with explicit inputs; never invented.
            }
            continue;
        }
        if (req.dataType === "SINGLE_SELECT" && req.options && current.id) {
            const present = new Set((current.options ?? []).map((o) => o.name));
            const missing = req.options.filter((o) => !present.has(o));
            if (missing.length > 0) {
                await updateFieldOptions(ctx.client, current.id, current.options, req.options);
                mutated = true;
            }
        }
    }
    return mutated ? await resolveProject(ctx.client, ctx.project) : snapshot;
}
function fieldByName(snapshot, name) {
    const f = snapshot.fields.find((x) => x.name === name);
    if (!f || !f.id)
        throw new ManagerError("no-field", `Project field missing: ${name}`);
    return f;
}
function optionIdFor(field, optionName) {
    const opt = (field.options ?? []).find((o) => o.name === optionName);
    if (!opt || !opt.id) {
        throw new ManagerError("no-option", `field ${field.name} has no option ${optionName}`);
    }
    return opt.id;
}
function iterationIdFor(field, title) {
    const it = (field.iterations ?? []).find((i) => i.title === title);
    if (!it) {
        throw new ManagerError("no-iteration", `Iteration field has no iteration titled ${title}`);
    }
    return it.id;
}
export const nodeFs = {
    existsSync,
    readFileSync: (p) => readFileSync(p),
    writeFileSync: (p, d) => writeFileSync(p, d),
    appendFileSync: (p, d) => appendFileSync(p, d),
    mkdirSync: (p) => mkdirSync(p, { recursive: true }),
};
/**
 * Append-only NDJSON journal. In dry-run nothing is written; plans are printed
 * by the caller instead. Every entry is sanitised of the token before writing.
 */
export class Journal {
    fs;
    path;
    dryRun;
    now;
    token;
    entries = [];
    constructor(opts) {
        this.fs = opts.fs;
        this.path = opts.path;
        this.dryRun = opts.dryRun;
        this.now = opts.now;
        this.token = opts.token;
    }
    record(state, step, detail) {
        const entry = detail === undefined
            ? { ts: new Date(this.now()).toISOString(), state, step }
            : {
                ts: new Date(this.now()).toISOString(),
                state,
                step,
                detail: redactToken(detail, this.token),
            };
        this.entries.push(entry);
        if (!this.dryRun) {
            const dir = dirname(this.path);
            if (!this.fs.existsSync(dir))
                this.fs.mkdirSync(dir);
            this.fs.appendFileSync(this.path, `${JSON.stringify(entry)}\n`);
        }
        return entry;
    }
}
/**
 * Run ordered steps as a transaction-like sequence. Each applied step is
 * verified (when a verify callback is present) before dependents run. The first
 * failure or failed verification is journaled and every remaining dependent
 * step is journaled `blocked`; execution stops. Returns whether all applied and
 * verified.
 */
export async function runOrderedSteps(steps, journal) {
    const blockRest = (from) => {
        for (let j = from; j < steps.length; j++) {
            const dependent = steps[j];
            if (dependent)
                journal.record("blocked", dependent.name);
        }
    };
    for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        if (!step)
            continue;
        try {
            await step.run();
            journal.record("applied", step.name);
        }
        catch (err) {
            journal.record("failed", step.name, errText(err));
            blockRest(i + 1);
            return { ok: false, failedAt: step.name };
        }
        if (step.verify) {
            let verified = false;
            try {
                verified = await step.verify();
            }
            catch (err) {
                journal.record("failed", step.name, `verify error: ${errText(err)}`);
                blockRest(i + 1);
                return { ok: false, failedAt: step.name };
            }
            if (!verified) {
                journal.record("failed", step.name, "verification did not observe the write");
                blockRest(i + 1);
                return { ok: false, failedAt: step.name };
            }
            journal.record("verified", step.name);
        }
    }
    return { ok: true };
}
export function defaultDeps() {
    return {
        transport: nodeHttpsTransport,
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        now: () => Date.now(),
        env: process.env,
        cwd: process.cwd(),
        selfDir: selfDirname(),
        fs: nodeFs,
        stdout: (line) => process.stdout.write(`${line}\n`),
        stderr: (line) => process.stderr.write(`${line}\n`),
    };
}
function selfDirname() {
    try {
        return dirname(fileURLToPath(import.meta.url));
    }
    catch {
        return process.cwd();
    }
}
/** Resolve the token from process env (wins) then the gitignored env file. */
export function loadToken(deps) {
    const fromEnv = deps.env[TOKEN_KEY];
    if (fromEnv && fromEnv.length > 0)
        return fromEnv;
    const envFile = join(deps.cwd, ENV_FILE);
    if (deps.fs.existsSync(envFile)) {
        const parsed = parseEnvFile(deps.fs.readFileSync(envFile).toString("utf8"));
        const value = parsed[TOKEN_KEY];
        if (value && value.length > 0)
            return value;
    }
    throw new ManagerError("missing-token", `missing ${TOKEN_KEY}; export it or create ${ENV_FILE}`);
}
function buildContext(parsed, deps) {
    const repo = parseRepoUrl(requireOpt(parsed.opts, "repo"));
    const project = parseProjectUrl(requireOpt(parsed.opts, "project"));
    const dryRun = hasFlag(parsed.opts, "dry-run");
    const token = loadToken(deps);
    const client = new GitHubClient(token, {
        transport: deps.transport,
        sleep: deps.sleep,
        now: deps.now,
    });
    const journal = new Journal({
        fs: deps.fs,
        path: join(deps.cwd, JOURNAL_PATH),
        dryRun,
        now: deps.now,
        token,
    });
    return { deps, opts: parsed.opts, repo, project, dryRun, token, client, journal };
}
/**
 * Verify token scope adequacy against actual repository visibility and Project
 * reachability. Every command — including dry-runs — verifies read scopes and
 * reads the repository and Project before any plan is emitted. Write runs
 * additionally require the write scope set.
 */
async function verifyAccess(ctx, write) {
    const scopes = await ctx.client.fetchScopes();
    const repoRes = await ctx.client.rest("GET", `/repos/${ctx.repo.nwo}`);
    const repoJson = repoRes.json;
    if (!repoJson ||
        typeof repoJson.private !== "boolean" ||
        typeof repoJson.node_id !== "string" ||
        repoJson.node_id.length === 0) {
        throw new ManagerError("repo-metadata", "repository response lacked private/node_id metadata");
    }
    const repoPrivate = repoJson.private;
    const check = checkScopes(scopes, { write, repoPrivate });
    if (!check.ok) {
        throw new ManagerError("scope", check.reason ?? "unverifiable scopes");
    }
    const defaultBranch = typeof repoJson.default_branch === "string" ? repoJson.default_branch : "";
    return { repoPrivate, repoNodeId: repoJson.node_id, scopes, defaultBranch };
}
function refuseApproved(status) {
    if (status === APPROVED) {
        throw new ManagerError("approved-human-only", "Approved is human-only; set it in the Project UI");
    }
}
function toIssueRecord(raw) {
    if (!raw || typeof raw !== "object")
        return null;
    const o = raw;
    if (typeof o["number"] !== "number")
        return null;
    return {
        number: o["number"],
        id: typeof o["id"] === "number" ? o["id"] : 0,
        nodeId: typeof o["node_id"] === "string" ? o["node_id"] : "",
        updatedAt: typeof o["updated_at"] === "string" ? o["updated_at"] : "",
        title: typeof o["title"] === "string" ? o["title"] : "",
        state: typeof o["state"] === "string" ? o["state"] : "",
        closed_at: typeof o["closed_at"] === "string" ? o["closed_at"] : null,
        milestone: o["milestone"] && typeof o["milestone"] === "object"
            ? o["milestone"]
            : null,
        body: typeof o["body"] === "string" ? o["body"] : "",
        labels: Array.isArray(o["labels"])
            ? o["labels"]
                .map((label) => {
                if (typeof label === "string")
                    return label;
                if (label && typeof label === "object" && typeof label["name"] === "string") {
                    return label["name"];
                }
                return null;
            })
                .filter((label) => label !== null)
            : [],
        assignees: Array.isArray(o["assignees"])
            ? o["assignees"]
                .map((assignee) => assignee && typeof assignee === "object" && typeof assignee["login"] === "string"
                ? assignee["login"]
                : null)
                .filter((login) => login !== null)
            : [],
        parentNumber: o["parent"] && typeof o["parent"] === "object" && typeof o["parent"]["number"] === "number"
            ? o["parent"]["number"]
            : null,
        isPull: "pull_request" in o && o["pull_request"] != null,
        htmlUrl: typeof o["html_url"] === "string" ? o["html_url"] : "",
    };
}
/**
 * Shared unfiltered REST inventory: every repository Issue AND pull request from
 * `/issues?state=all`. Issue-mutating callers use `listIssues` (pulls removed);
 * PR-mapping compliance needs the pulls, so both derive from this one read.
 */
async function listRepoIssues(ctx) {
    const raw = await ctx.client.restPaginate(`/repos/${ctx.repo.nwo}/issues?state=all&per_page=100`);
    const out = [];
    for (const r of raw) {
        const rec = toIssueRecord(r);
        if (rec)
            out.push(rec);
    }
    return out;
}
/** Repository issues only (pull requests filtered out), for issue-mutating callers. */
async function listIssues(ctx) {
    return (await listRepoIssues(ctx)).filter((rec) => !rec.isPull);
}
/**
 * Reduce any GitHub pull-request URL to a canonical
 * `https://github.com/OWNER/REPO/pull/N`, dropping scheme case, query, fragment,
 * and trailing slashes so a repo PR URL and a Project link URL compare equal.
 */
function canonicalPrUrl(url) {
    const m = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i.exec(url.trim());
    if (m)
        return `https://github.com/${m[1]}/${m[2]}/pull/${m[3]}`;
    return url.trim().replace(/[?#].*$/, "").replace(/\/+$/, "");
}
/**
 * Build a PR compliance report: every repo pull request is compliant only when
 * its canonical URL occurs in `linkedPullRequests` on at least one repository
 * Issue-backed Project item (the map keys). A PullRequest-backed Project item
 * never appears here — `resolveProjectItems` retains only Issue-backed items —
 * so a PR-backed item alone does not satisfy mapping.
 */
function buildPullRequestReports(nwo, pulls, linkedByUrl) {
    return pulls.map((pr) => {
        const url = pr.htmlUrl
            ? canonicalPrUrl(pr.htmlUrl)
            : `https://github.com/${nwo}/pull/${pr.number}`;
        const mappedSet = linkedByUrl.get(url);
        const mappedIssues = mappedSet ? [...mappedSet].sort((a, b) => a - b) : [];
        const mapped = mappedIssues.length > 0;
        return {
            number: pr.number,
            title: pr.title,
            url,
            mappedIssues: mapped ? mappedIssues : "N/A",
            mapped,
            compliant: mapped,
        };
    });
}
/**
 * Enumerate every repo PR and check each maps into some Issue-backed Project
 * item's linked pull requests. Callers with items/inventory/links already loaded
 * pass them to avoid re-reads; otherwise this fetches them.
 */
async function pullRequestComplianceReport(ctx, opts = {}) {
    const repoItems = opts.repoItems ??
        (await resolveProjectItems(ctx.client, ctx.project)).filter((i) => i.repoNwo === ctx.repo.nwo);
    const inventory = opts.inventory ?? (await listRepoIssues(ctx));
    const linkedByUrl = new Map();
    for (const item of repoItems) {
        const links = opts.linkedByItem?.get(item.id) ??
            [...(await fetchPullRequestLinks(ctx.client, item.id)).values()].flat();
        for (const raw of links) {
            const canon = canonicalPrUrl(raw);
            let set = linkedByUrl.get(canon);
            if (!set) {
                set = new Set();
                linkedByUrl.set(canon, set);
            }
            set.add(item.issueNumber);
        }
    }
    const pullRequests = buildPullRequestReports(ctx.repo.nwo, inventory.filter((r) => r.isPull), linkedByUrl);
    return { pullRequests, pullRequestsOk: pullRequests.every((r) => r.compliant) };
}
async function getIssue(ctx, number) {
    const res = await ctx.client.rest("GET", `/repos/${ctx.repo.nwo}/issues/${number}`);
    const rec = toIssueRecord(res.json);
    if (!rec)
        throw new ManagerError("no-issue", `issue #${number} not found`);
    return rec;
}
function relationNumbers(raw) {
    return raw
        .map((value) => value && typeof value === "object" && typeof value["number"] === "number"
        ? value["number"]
        : null)
        .filter((value) => value !== null);
}
async function nativeRelations(ctx, issue) {
    const [subIssues, blockedBy, blocking] = await Promise.all([
        ctx.client.restPaginate(`/repos/${ctx.repo.nwo}/issues/${issue.number}/sub_issues?per_page=100`),
        ctx.client.restPaginate(`/repos/${ctx.repo.nwo}/issues/${issue.number}/dependencies/blocked_by?per_page=100`),
        ctx.client.restPaginate(`/repos/${ctx.repo.nwo}/issues/${issue.number}/dependencies/blocking?per_page=100`),
    ]);
    const subs = relationNumbers(subIssues);
    const blocked = relationNumbers(blockedBy);
    const blocks = relationNumbers(blocking);
    return {
        parent: issue.parentNumber ?? "N/A",
        subIssues: subs.length > 0 ? subs : "N/A",
        blockedBy: blocked.length > 0 ? blocked : "N/A",
        blocking: blocks.length > 0 ? blocks : "N/A",
    };
}
async function listMilestones(ctx) {
    const raw = await ctx.client.restPaginate(`/repos/${ctx.repo.nwo}/milestones?state=all&per_page=100`);
    const out = [];
    for (const r of raw) {
        if (!r || typeof r !== "object")
            continue;
        const o = r;
        if (typeof o["title"] !== "string" || typeof o["number"] !== "number")
            continue;
        out.push({
            number: o["number"],
            title: o["title"],
            due_on: typeof o["due_on"] === "string" ? o["due_on"] : null,
        });
    }
    return out;
}
/** Parse repeated `--milestone NAME` / `NAME=YYYY-MM-DD` inputs additively. */
export function parseMilestoneInputs(values) {
    const out = [];
    for (const raw of values) {
        if (raw === "true" || raw.length === 0)
            continue;
        const eq = raw.indexOf("=");
        if (eq < 0) {
            out.push({ name: raw });
            continue;
        }
        const name = raw.slice(0, eq);
        const due = raw.slice(eq + 1);
        if (!isValidYmd(due)) {
            throw new ManagerError("bad-date", `milestone date must be YYYY-MM-DD: ${raw}`);
        }
        out.push({ name, due });
    }
    return out;
}
/** Create a missing milestone; only an explicit date updates an existing one. */
async function ensureMilestone(ctx, input) {
    const existing = await listMilestones(ctx);
    const match = existing.find((m) => m.title === input.name);
    if (!match) {
        const body = { title: input.name };
        if (input.due !== undefined)
            body["due_on"] = `${input.due}T00:00:00Z`;
        await ctx.client.rest("POST", `/repos/${ctx.repo.nwo}/milestones`, body);
        return;
    }
    if (input.due !== undefined) {
        await ctx.client.rest("PATCH", `/repos/${ctx.repo.nwo}/milestones/${match.number}`, { due_on: `${input.due}T00:00:00Z` });
    }
}
async function milestoneNumberFor(ctx, name) {
    const existing = await listMilestones(ctx);
    return existing.find((m) => m.title === name)?.number ?? null;
}
async function milestoneMatches(ctx, input) {
    const match = (await listMilestones(ctx)).find((milestone) => milestone.title === input.name);
    if (!match)
        return false;
    return input.due === undefined || match.due_on?.slice(0, 10) === input.due;
}
const RUNTIME_MANAGER = ".agents/project-board-law/manager.js";
const RUNTIME_PAYLOAD = ".agents/project-board-law/payload.generated.js";
const RUNTIME_PACKAGE = ".agents/project-board-law/package.json";
/** Compute the ordered local file plan for install. */
export function planInstallFiles() {
    const files = [];
    for (const target of Object.keys(PAYLOADS)) {
        files.push({ path: target, reason: "vendored payload" });
    }
    files.push({ path: RUNTIME_MANAGER, reason: "compiled manager" });
    files.push({ path: RUNTIME_PAYLOAD, reason: "sibling generated payload" });
    files.push({ path: RUNTIME_PACKAGE, reason: "nested type=module package" });
    files.push({ path: "AGENTS.md", reason: "byte-identical top law block" });
    files.push({ path: ".gitignore", reason: "gitignore entries" });
    return files.sort((a, b) => a.path.localeCompare(b.path));
}
const GITIGNORE_ENTRIES = [
    "node_modules/",
    ".agents/project-ci.env",
    ".agents/project-board-law/journal.ndjson",
];
/** Merge required gitignore entries, preserving existing lines and order. */
export function planGitignore(existing) {
    const lines = existing ? existing.split(/\r?\n/) : [];
    const have = new Set(lines.map((l) => l.trim()));
    const out = [...lines];
    if (out.length > 0 && out[out.length - 1] === "")
        out.pop();
    for (const entry of GITIGNORE_ENTRIES) {
        if (!have.has(entry))
            out.push(entry);
    }
    return `${out.join("\n")}\n`;
}
const NESTED_PACKAGE_JSON = RUNTIME_PACKAGE_JSON;
function decodePayload(target) {
    const encoded = PAYLOADS[target];
    if (encoded === undefined) {
        throw new ManagerError("payload", `missing vendored payload: ${target}`);
    }
    return Buffer.from(encoded, "base64");
}
// --------------------------------------------------------------------------
// Customizable installation guide: deterministic, fail-closed three-way merge
//
// `.agents/project-board-law/INSTALL.md` is the SOLE installed artifact a
// governed repository may customize; every other vendored artifact stays
// byte-identical to its embedded payload. On upgrade the manager reconciles
// three inputs with a deterministic line merge that fails closed before any
// write:
//   base   — the prior upstream default, read as DATA from the already-installed
//            generated payload artifact (never imported or executed) and trusted
//            only after that artifact's own manifest digest verifies it;
//   ours   — the on-disk target customization;
//   theirs — the incoming vendored default.
// Identical or disjoint line edits merge; an overlapping incompatible edit, an
// absent/unverifiable prior default, or ambiguous newline/encoding fails closed
// so neither the customization nor an incoming security/functionality change is
// ever silently dropped. The prior-default bytes only influence a documentation
// merge and are never executed, so a forged artifact cannot escalate privilege.
// --------------------------------------------------------------------------
/** The one installed artifact a governed repository may customize. */
export const CUSTOMIZABLE_INSTALL = ".agents/project-board-law/INSTALL.md";
/** Decode installation-guide bytes, rejecting a BOM, non-UTF-8, and mixed EOLs. */
export function analyzeInstallText(buf) {
    if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
        return { ok: false, error: "a UTF-8 BOM" };
    }
    const text = buf.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(buf)) {
        return { ok: false, error: "invalid UTF-8" };
    }
    if (text.includes("\r")) {
        const crlf = (text.match(/\r\n/g) ?? []).length;
        const cr = (text.match(/\r/g) ?? []).length;
        const lf = (text.match(/\n/g) ?? []).length;
        if (cr !== crlf || lf !== crlf)
            return { ok: false, error: "mixed newlines" };
        return { ok: true, text, newline: "\r\n", finalNewline: text.endsWith("\r\n") };
    }
    return { ok: true, text, newline: "\n", finalNewline: text.endsWith("\n") };
}
/** Split into lines for the shared newline; a final newline is tracked apart. */
function splitInstallLines(text, nl) {
    if (text.length === 0)
        return [];
    const parts = text.split(nl);
    if (parts.length > 0 && parts[parts.length - 1] === "")
        parts.pop();
    return parts;
}
/** Deterministic LCS-aligned matching index pairs between two line arrays. */
function lcsPairs(a, b) {
    const n = a.length;
    const m = b.length;
    const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) {
        const row = dp[i];
        const next = dp[i + 1];
        for (let j = m - 1; j >= 0; j--) {
            row[j] = a[i] === b[j] ? next[j + 1] + 1 : Math.max(next[j], row[j + 1]);
        }
    }
    const pairs = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
        if (a[i] === b[j]) {
            pairs.push([i, j]);
            i++;
            j++;
        }
        else if (dp[i + 1][j] >= dp[i][j + 1]) {
            i++;
        }
        else {
            j++;
        }
    }
    return pairs;
}
/** Differing regions between base (o) and one side (s), from an LCS alignment. */
function diffRegions(o, s) {
    const pairs = lcsPairs(o, s);
    pairs.push([o.length, s.length]); // sentinel closes the trailing region
    const regions = [];
    let oi = 0;
    let si = 0;
    for (const [om, sm] of pairs) {
        if (om - oi > 0 || sm - si > 0) {
            regions.push({ oStart: oi, oLen: om - oi, sStart: si, sLen: sm - si });
        }
        oi = om + 1;
        si = sm + 1;
    }
    return regions;
}
/** Reconstruct one side's lines for a base region bounded by unchanged lines. */
function reconstructSide(sideArr, group, side, rs, re) {
    const mine = group.filter((h) => h.side === side).sort((x, y) => x.oStart - y.oStart);
    if (mine.length === 0)
        return [];
    const first = mine[0];
    const last = mine[mine.length - 1];
    const start = first.sStart - (first.oStart - rs);
    const end = last.sStart + last.sLen + (re - last.oEnd);
    return sideArr.slice(start, end);
}
/**
 * Line-based three-way merge. Regions changed on a single side are taken as-is;
 * strictly overlapping edits from both sides resolve only when identical and
 * otherwise fail closed. Disjoint and adjacent edits both merge cleanly.
 */
function diff3Merge(base, ours, theirs) {
    const hunks = [];
    for (const r of diffRegions(base, ours)) {
        hunks.push({ side: 0, oStart: r.oStart, oEnd: r.oStart + r.oLen, sStart: r.sStart, sLen: r.sLen });
    }
    for (const r of diffRegions(base, theirs)) {
        hunks.push({ side: 1, oStart: r.oStart, oEnd: r.oStart + r.oLen, sStart: r.sStart, sLen: r.sLen });
    }
    hunks.sort((x, y) => x.oStart - y.oStart || x.oEnd - y.oEnd || x.side - y.side);
    const out = [];
    let oPos = 0;
    const emitBase = (until) => {
        for (let k = oPos; k < until; k++)
            out.push(base[k]);
        if (until > oPos)
            oPos = until;
    };
    let i = 0;
    while (i < hunks.length) {
        const head = hunks[i];
        let rs = head.oStart;
        let re = head.oEnd;
        const group = [head];
        i++;
        // Group STRICTLY overlapping hunks; adjacent (touching) edits stay
        // independent so disjoint changes merge instead of colliding. One exception:
        // pure insertions (zero-length base region) at the SAME base anchor never
        // strictly overlap, yet they compete for the same gap. Group them so an
        // identical insertion from both sides is emitted once and a divergent one
        // fails closed, instead of concatenating both silently.
        while (i < hunks.length) {
            const next = hunks[i];
            const overlaps = next.oStart < re;
            const sameAnchorInsert = re === rs && next.oStart === rs && next.oEnd === next.oStart;
            if (!overlaps && !sameAnchorInsert)
                break;
            re = Math.max(re, next.oEnd);
            group.push(next);
            i++;
        }
        emitBase(rs);
        const sides = new Set(group.map((h) => h.side));
        if (sides.size === 1) {
            const side = group[0].side;
            out.push(...reconstructSide(side === 0 ? ours : theirs, group, side, rs, re));
        }
        else {
            const ourSlice = reconstructSide(ours, group, 0, rs, re);
            const theirSlice = reconstructSide(theirs, group, 1, rs, re);
            if (ourSlice.length === theirSlice.length && ourSlice.every((l, k) => l === theirSlice[k])) {
                out.push(...ourSlice);
            }
            else {
                return {
                    ok: false,
                    reason: `overlapping incompatible edit near line ${rs + 1} of the prior installation guide`,
                };
            }
        }
        oPos = Math.max(oPos, re);
    }
    emitBase(base.length);
    return { ok: true, lines: out };
}
/**
 * Three-way merge of the installation guide. Every input must be BOM-free
 * UTF-8 sharing one newline style and trailing-newline state; any ambiguity
 * fails closed.
 */
export function threeWayMergeInstall(base, ours, theirs) {
    const b = analyzeInstallText(base);
    const o = analyzeInstallText(ours);
    const t = analyzeInstallText(theirs);
    if (!b.ok)
        return { ok: false, reason: `prior default is ${b.error}` };
    if (!o.ok)
        return { ok: false, reason: `target customization is ${o.error}` };
    if (!t.ok)
        return { ok: false, reason: `incoming default is ${t.error}` };
    if (b.newline !== o.newline || b.newline !== t.newline) {
        return { ok: false, reason: "ambiguous newline style across prior, customized, and incoming installation guide" };
    }
    if (b.finalNewline !== o.finalNewline || b.finalNewline !== t.finalNewline) {
        return { ok: false, reason: "ambiguous trailing newline across prior, customized, and incoming installation guide" };
    }
    const nl = b.newline;
    const merged = diff3Merge(splitInstallLines(b.text, nl), splitInstallLines(o.text, nl), splitInstallLines(t.text, nl));
    if (!merged.ok)
        return { ok: false, reason: merged.reason };
    let text = merged.lines.join(nl);
    if (b.finalNewline && merged.lines.length > 0)
        text += nl;
    return { ok: true, content: Buffer.from(text, "utf8") };
}
/**
 * Whole-file canonical form the generator emits: the fixed header comment, the
 * five `export const` declarations in exact order, and the `PAYLOADS` object.
 * The artifact is consumed as DATA (never imported, never executed), yet only
 * this exact wrapper is accepted. Anchoring start-to-end means no prefix,
 * suffix, second statement, or executable trailer can ride alongside a
 * legitimate-looking payload set; the sole optional trailing byte is one final
 * newline. `PAYLOAD_SHA256` and the entries block are the only variable capture
 * groups.
 */
const GENERATED_WRAPPER = /^\/\/ Generated by scripts\/generate-payload\.mjs; do not edit\.\nexport const LAW_SHA256 = "[0-9a-f]{64}";\nexport const PAYLOAD_SHA256 = "([0-9a-f]{64})";\nexport const RUNTIME_MANAGER_SHA256 = "[0-9a-f]{64}";\nexport const RUNTIME_PACKAGE_JSON = "(?:[^"\\]|\\.)*";\nexport const PAYLOADS = \{\n([\s\S]*)\n\};\n?$/;
/** One `  "target": ["aaa", ...].join("")` line, optional trailing comma. */
const GENERATED_ENTRY = /^ {4}("(?:[^"\\]|\\.)*"): (\["(?:[^"\\]|\\.)*"(?:, ?"(?:[^"\\]|\\.)*")*\])\.join\(""\)(,?)$/;
/**
 * Parse a generated payload artifact as DATA (never executed). It must be the
 * ENTIRE canonical generated wrapper — nothing before the header, nothing after
 * the closing `};` but one optional newline. Every entry reproduces the
 * generator's `"target": ["aaa", ...].join("")` shape; each decoded payload must
 * be canonical, round-tripping base64. Any prefix, suffix, extra statement,
 * executable trailer, stray carriage return, ambiguous or malformed escaping, or
 * non-round-tripping encoding fails closed. Used only to recover the prior
 * installation-guide default and to bind the vendored source identity.
 */
export function parseGeneratedPayloadArtifact(src) {
    // A carriage return would make newline handling ambiguous; the generated form
    // is strictly LF, so any CR marks a non-canonical artifact.
    if (src.includes("\r"))
        return { ok: false, error: "a non-LF (carriage-return) byte" };
    const wrapper = GENERATED_WRAPPER.exec(src);
    if (!wrapper)
        return { ok: false, error: "a non-canonical generated wrapper" };
    const payloadSha256 = wrapper[1];
    const body = wrapper[2];
    const lines = body.split("\n");
    const payloads = new Map();
    for (let i = 0; i < lines.length; i++) {
        const entry = GENERATED_ENTRY.exec(lines[i]);
        if (!entry)
            return { ok: false, error: "a malformed PAYLOADS entry" };
        // Every entry but the last carries a trailing comma; a missing interior
        // comma would mean a truncated or spliced object body.
        if (entry[3] !== "," && i !== lines.length - 1) {
            return { ok: false, error: "a PAYLOADS entry missing its separator" };
        }
        let key;
        let pieces;
        try {
            key = JSON.parse(entry[1]);
            pieces = JSON.parse(entry[2]);
        }
        catch {
            return { ok: false, error: "a malformed PAYLOADS entry" };
        }
        if (typeof key !== "string" || JSON.stringify(key) !== entry[1]) {
            return { ok: false, error: "a non-canonical PAYLOADS key" };
        }
        if (payloads.has(key))
            return { ok: false, error: "a duplicate PAYLOADS key" };
        if (!Array.isArray(pieces) || pieces.length === 0 || !pieces.every((p) => typeof p === "string")) {
            return { ok: false, error: "malformed PAYLOADS base64 pieces" };
        }
        const encoded = pieces.join("");
        if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
            return { ok: false, error: "a non-base64 PAYLOADS payload" };
        }
        const bytes = Buffer.from(encoded, "base64");
        if (bytes.toString("base64") !== encoded) {
            return { ok: false, error: "a non-round-tripping PAYLOADS payload" };
        }
        payloads.set(key, bytes);
    }
    if (payloads.size === 0)
        return { ok: false, error: "no PAYLOADS entries" };
    return { ok: true, artifact: { payloadSha256, payloads } };
}
/** Recompute the payload manifest digest exactly as the generator emits it. */
function payloadManifestHash(payloads) {
    const manifest = Buffer.from([...payloads.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([target, bytes]) => `${target}\0${sha256Hex(bytes)}\0`)
        .join(""));
    return sha256Hex(manifest);
}
/**
 * Bind the runtime payload source (the sibling `payload.generated.js` about to be
 * vendored) to the EXACT payload identity imported at module load. `PAYLOADS`,
 * `PAYLOAD_SHA256`, and every artifact derived from them — including the resolved
 * INSTALL guide and the other vendored payload files — are frozen when this module
 * is imported, but the source file itself is read from disk only during apply.
 * If that later read differs in its payload set from the imported identity (e.g.
 * the file was swapped between module import and this read), accepting its bytes
 * as the planned source snapshot would copy a source inconsistent with the
 * payloads written beside it while the prewrite guard — which only pins that same
 * later read — passes. Verify against the module-load `PAYLOAD_SHA256` and fail
 * closed so no such divergent source can ever be accepted as the planned snapshot.
 */
function verifyRuntimePayloadSourceIdentity(bytes) {
    const parsed = parseGeneratedPayloadArtifact(bytes.toString("utf8"));
    if (!parsed.ok)
        return { ok: false, reason: `runtime payload source has ${parsed.error}` };
    if (parsed.artifact.payloadSha256 !== PAYLOAD_SHA256) {
        return {
            ok: false,
            reason: "runtime payload source declares a payload identity that differs from the imported PAYLOAD_SHA256",
        };
    }
    if (payloadManifestHash(parsed.artifact.payloads) !== PAYLOAD_SHA256) {
        return {
            ok: false,
            reason: "runtime payload source payloads differ from the imported payload identity",
        };
    }
    return { ok: true };
}
/**
 * Recover the prior installation-guide default from the already-installed
 * generated payload, trusting it only after its own manifest digest verifies.
 * Never imports or executes the artifact.
 */
function readPriorInstallDefault(fs, cwd) {
    const path = join(cwd, RUNTIME_PAYLOAD);
    if (!fs.existsSync(path)) {
        return { ok: false, reason: "installed generated payload is absent" };
    }
    let sourceBytes;
    try {
        sourceBytes = fs.readFileSync(path);
    }
    catch (err) {
        return { ok: false, reason: `installed generated payload is unreadable: ${errText(err)}` };
    }
    const parsed = parseGeneratedPayloadArtifact(sourceBytes.toString("utf8"));
    if (!parsed.ok)
        return { ok: false, reason: `installed generated payload has ${parsed.error}` };
    if (payloadManifestHash(parsed.artifact.payloads) !== parsed.artifact.payloadSha256) {
        return { ok: false, reason: "installed generated payload failed its own manifest digest" };
    }
    const base = parsed.artifact.payloads.get(CUSTOMIZABLE_INSTALL);
    if (!base)
        return { ok: false, reason: "installed generated payload lacks the installation-guide entry" };
    // Return the exact raw artifact bytes consumed to derive `base` so the install
    // pre-write guard can pin them without a second, race-prone read.
    return { ok: true, base, sourceBytes };
}
/**
 * Resolve the installation-guide bytes to write. Initial install writes the
 * incoming default; an uncustomized target adopts it; a customized target is
 * three-way merged against the identity-verified prior default. Any unsafe or
 * ambiguous state fails closed.
 */
export function resolveInstallCustomization(fs, cwd, incomingDefault) {
    const target = join(cwd, CUSTOMIZABLE_INSTALL);
    const ours = fs.existsSync(target) ? fs.readFileSync(target) : null;
    const targetSha256 = ours === null ? null : sha256Hex(ours);
    if (ours === null) {
        return { ok: true, content: incomingDefault, mode: "initial", targetSha256, priorSourceSha256: null };
    }
    if (ours.equals(incomingDefault)) {
        return { ok: true, content: incomingDefault, mode: "current", targetSha256, priorSourceSha256: null };
    }
    const prior = readPriorInstallDefault(fs, cwd);
    if (!prior.ok) {
        return { ok: false, reason: `cannot obtain the prior installation-guide default: ${prior.reason}` };
    }
    // Fingerprint the EXACT artifact bytes the merge base was derived from, so the
    // pre-write guard pins that same read — never a second one that could race.
    const priorSourceSha256 = sha256Hex(prior.sourceBytes);
    if (ours.equals(prior.base)) {
        return { ok: true, content: incomingDefault, mode: "adopt-default", targetSha256, priorSourceSha256 };
    }
    const merged = threeWayMergeInstall(prior.base, ours, incomingDefault);
    if (!merged.ok)
        return { ok: false, reason: merged.reason };
    return { ok: true, content: merged.content, mode: "merged", targetSha256, priorSourceSha256 };
}
/** Plan-visible summary of an installation-guide resolution (secret-free). */
function publicInstallResolution(res) {
    return res.ok
        ? { path: CUSTOMIZABLE_INSTALL, action: res.mode }
        : { path: CUSTOMIZABLE_INSTALL, blocked: res.reason };
}
/**
 * A deployment-branch-policy name that would let a pull-request ref reach the
 * environment. Any of these patterns defeats the "default branch only" gate,
 * because a pull request's controlled head/merge ref could then deploy and
 * receive the PAT. Matches `refs/pull/` prefixes (including the `/merge` ref),
 * a bare `pull/<n>` segment, and any name ending in `/merge`.
 */
export function isPullRefPattern(name) {
    const n = name.trim();
    return /(^|\/)pull\//.test(n) || /refs\/pull/.test(n) || /\/merge$/.test(n);
}
/**
 * Audit the secret-scoping environment posture from the token-bearing inspect
 * path (identity is deliberately secretless and never runs this). Every check is
 * evaluated and every failure is reported — the caller sees ALL violations, not
 * just the first. Absence is proven with 404-tolerant probes so a missing
 * environment or secret is a clear finding rather than a thrown error.
 */
export async function checkEnvironmentPosture(ctx, defaultBranch) {
    const env = DEPLOY_ENVIRONMENT;
    const nwo = ctx.repo.nwo;
    const violations = [];
    // (a) The environment must exist. If created on first use it carries no
    // protection rules, which defeats the gate, so absence is fail-closed.
    const envRes = await ctx.client.restOptional(`/repos/${nwo}/environments/${env}`);
    if (envRes === null) {
        violations.push({
            check: "environment-missing",
            message: `environment "${env}" does not exist; create it and scope ${TOKEN_KEY} to it before any token-bearing run`,
        });
    }
    else {
        const envJson = (envRes.json ?? {});
        const dbp = envJson.deployment_branch_policy ?? null;
        // (b.1) The policy must be CUSTOM (custom_branch_policies), never the
        // protected-branches preset, so exactly one named branch can be pinned.
        if (!dbp || dbp.custom_branch_policies !== true || dbp.protected_branches === true) {
            violations.push({
                check: "branch-policy-not-custom",
                message: `environment "${env}" must use a custom deployment branch policy (custom_branch_policies=true, protected_branches=false)`,
            });
        }
        // (b.2)+(c) Enumerate the custom branch policies once and audit them.
        const policyRes = await ctx.client.restOptional(`/repos/${nwo}/environments/${env}/deployment-branch-policies`);
        const policyJson = (policyRes?.json ?? {});
        const policies = Array.isArray(policyJson.branch_policies) ? policyJson.branch_policies : [];
        const names = policies.map((p) => (typeof p.name === "string" ? p.name : ""));
        // (c) No policy may match a pull-request ref pattern.
        const pullRefNames = names.filter((name) => name.length > 0 && isPullRefPattern(name));
        if (pullRefNames.length > 0) {
            violations.push({
                check: "branch-policy-pull-ref",
                message: `environment "${env}" has deployment branch policies matching pull-request refs (${pullRefNames.join(", ")}); a pull request could then deploy and receive ${TOKEN_KEY}`,
            });
        }
        // (b.2) Exactly one branch-type policy, equal to the repository default branch.
        const branchPolicies = policies.filter((p) => p.type === "branch");
        const defaultOnly = policies.length === 1 &&
            branchPolicies.length === 1 &&
            defaultBranch.length > 0 &&
            branchPolicies[0]?.name === defaultBranch;
        if (!defaultOnly) {
            const seen = names.length > 0 ? names.join(", ") : "none";
            violations.push({
                check: "branch-policy-default-only",
                message: `environment "${env}" must permit exactly one branch policy equal to the default branch "${defaultBranch || "(unknown)"}"; found: ${seen}`,
            });
        }
        // (e) No custom GitHub App deployment protection rules: they are INCOMPATIBLE
        // with `deployment: false` and would make every token-bearing job fail
        // immediately (per GitHub docs). Only native branch policies are permitted.
        const ruleRes = await ctx.client.restOptional(`/repos/${nwo}/environments/${env}/deployment-protection-rules`);
        const ruleJson = (ruleRes?.json ?? {});
        const customRules = Array.isArray(ruleJson.custom_deployment_protection_rules)
            ? ruleJson.custom_deployment_protection_rules
            : [];
        if (customRules.length > 0) {
            violations.push({
                check: "deployment-protection-rules-incompatible",
                message: `environment "${env}" has ${customRules.length} custom GitHub App deployment protection rule(s); these are incompatible with "deployment: false" and would make every token-bearing job fail immediately — remove them and rely on the native branch policy`,
            });
        }
    }
    // (d) No copy of ANY provisioned secret outside the environment. Every Routine
    // secret must live ONLY on the "${env}" environment; a repository-scope OR an
    // organization-scope copy resolves in the token-bearing job regardless of the
    // environment and silently defeats the gate. Sweep every applicable scope for
    // every name, and FAIL CLOSED (distinct "scope-unverifiable" finding) on any
    // scope that cannot be read. Checked whether or not the environment exists.
    violations.push(...(await auditSecretScopes(ctx, env)));
    return { environment: env, ok: violations.length === 0, violations };
}
/**
 * Audit every scope from which a token-bearing job could resolve a provisioned
 * secret: per-name REPOSITORY secrets, and the ORGANIZATION secrets visible to
 * the repository (when it belongs to an org). Any present copy of a Routine
 * secret is a distinct violation; any scope that returns 403 is a distinct
 * fail-closed "scope-unverifiable" finding — a scope is never silently treated as
 * clean. The organization listing is paginated to completion and its shape is
 * validated: a prohibited secret on a later page must not be missed, and a
 * malformed or incomplete 200 body is fail-closed, not empty=clean. A 404 on the
 * org-secrets endpoint means org scope is not applicable ONLY when the repository
 * is user-owned; for an organization-owned repository (or an owner whose type
 * cannot be read) a 404 is itself fail-closed.
 */
export async function auditSecretScopes(ctx, env) {
    const nwo = ctx.repo.nwo;
    const violations = [];
    // Repository scope, one probe per provisioned name.
    for (const name of ROUTINE_SECRETS) {
        const probe = await ctx.client.restProbe(`/repos/${nwo}/actions/secrets/${name}`);
        if (probe.status === 200) {
            violations.push({
                check: "repo-scope-secret",
                message: `a repository-scope secret named ${name} exists; it resolves regardless of the environment and defeats the gate — delete it and store ${name} in the "${env}" environment only`,
            });
        }
        else if (probe.status === 403) {
            violations.push({
                check: "secret-scope-unverifiable",
                message: `repository-scope secret "${name}" for ${nwo} could not be verified (HTTP 403); grant the token repository "Secrets" read (a fine-grained PAT with the Secrets:read permission, or a classic token with repo scope) so inspect can prove no unscoped copy exists — failing closed`,
            });
        }
        // 404 => absent at repository scope => compliant for this name.
    }
    // Organization scope: the org secrets shared with (visible to) this repository.
    // Paginate to completion and validate the response shape. A Routine secret on
    // ANY page defeats the gate even if repository scope is clean, so a single
    // unpaginated read could silently miss a copy on page 2+; a malformed or partial
    // 200 body must fail closed rather than read as empty=clean.
    const PER_PAGE = 100;
    const orgNames = new Set();
    let orgStatus = 0;
    let totalCount = 0;
    let accumulated = 0;
    let shapeInvalid = false;
    // A non-200 is a legitimate "org scope does not apply" signal ONLY on the very
    // first request, before any page has been read. Once a 200 page has been
    // collected, pagination is underway; a later non-200 truncates the listing and
    // we can no longer prove completeness, so it is unverifiable, NOT the
    // user-owned-repo n/a case. Track whether a 200 page has been seen.
    let sawOkPage = false;
    for (let page = 1;; page += 1) {
        const orgProbe = await ctx.client.restProbe(`/repos/${nwo}/actions/organization-secrets?per_page=${PER_PAGE}&page=${page}`);
        orgStatus = orgProbe.status;
        if (orgProbe.status !== 200)
            break;
        sawOkPage = true;
        const body = (orgProbe.json ?? null);
        const pageSecrets = body && Array.isArray(body.secrets) ? body.secrets : null;
        const pageTotal = body &&
            typeof body.total_count === "number" &&
            Number.isInteger(body.total_count) &&
            body.total_count >= 0
            ? body.total_count
            : null;
        if (pageSecrets === null || pageTotal === null) {
            // Non-array secrets, or a total_count that is not a nonnegative integer =>
            // unverifiable.
            shapeInvalid = true;
            break;
        }
        if (page === 1) {
            totalCount = pageTotal;
        }
        else if (pageTotal !== totalCount) {
            // total_count must be stable across pages; drift means it cannot be trusted.
            shapeInvalid = true;
            break;
        }
        // (c) A page must never exceed the requested per_page; a longer page is a
        // malformed body, not extra coverage.
        if (pageSecrets.length > PER_PAGE) {
            shapeInvalid = true;
            break;
        }
        // (a) Every entry must carry a string name that is a SYNTACTICALLY VALID
        // GitHub Actions secret name — /^[A-Za-z_][A-Za-z0-9_]*$/ (letters, digits,
        // underscores; not digit-leading; no spaces or other characters; never
        // trimmed, so a name with surrounding whitespace is invalid, not
        // whitespace-stripped-then-valid). (b) Names must be UNIQUE across the whole
        // walk on their CANONICAL (uppercase) form, because GitHub secret names are
        // case-insensitive — `Foo` and `FOO` are the same secret, so seeing both is a
        // duplicate. A malformed entry ({}, empty/garbage/whitespace-filler name) or a
        // canonical duplicate (e.g. the same 100-name page served twice) would
        // otherwise pad the RAW count toward total_count while concealing an unseen —
        // possibly prohibited — org secret. Any such entry fails closed, never
        // empty=clean. The canonical form is also what Routine-secret matching runs on
        // below, so a lowercase org copy (e.g. `project_ci_token`) is still detected.
        let pageInvalid = false;
        for (const s of pageSecrets) {
            const raw = s && typeof s.name === "string" ? s.name : "";
            if (!SECRET_NAME_SYNTAX.test(raw)) {
                pageInvalid = true;
                break;
            }
            const canonical = raw.toUpperCase();
            if (orgNames.has(canonical)) {
                pageInvalid = true;
                break;
            }
            orgNames.add(canonical);
        }
        if (pageInvalid) {
            shapeInvalid = true;
            break;
        }
        // Every entry is now validated and unique, so accumulated counts only distinct
        // real names (accumulated === orgNames.size). Matching runs on this set.
        accumulated += pageSecrets.length;
        // Stop only once the whole set is accounted for. A short page that still
        // leaves accumulated < total_count is an inconsistent body, caught by the
        // accumulated !== totalCount check after the loop.
        if (accumulated >= totalCount)
            break;
        if (pageSecrets.length < PER_PAGE)
            break;
        if (page >= 1000) {
            // Runaway guard: never spin forever on a pathological endpoint.
            shapeInvalid = true;
            break;
        }
    }
    if (sawOkPage && orgStatus !== 200) {
        // A 200 page was read, then a later request returned a non-200. Pagination
        // began and was truncated mid-walk, so the listing is unprovable — this is
        // unverifiable and fails closed regardless of owner type; the user-owned-repo
        // n/a path is legal only on the FIRST request, before any 200 page.
        violations.push({
            check: "secret-scope-unverifiable",
            message: `organization-scope secrets visible to ${nwo} could not be verified: a later page of the organization-secrets listing returned HTTP ${orgStatus} after an earlier page was read, so pagination was truncated and inspect cannot prove no org-level copy of ${ROUTINE_SECRETS.join(", ")} exists — failing closed; re-run inspect once the API returns a complete response, or confirm org-level secret absence with an organization admin`,
        });
    }
    else if (orgStatus === 403) {
        violations.push({
            check: "secret-scope-unverifiable",
            message: `organization-scope secrets visible to ${nwo} could not be verified (HTTP 403); do NOT widen the runtime CI token — instead verify org-level secret absence with a separate least-privileged credential (a fine-grained organization token granting organization "Secrets" read) or have an organization admin confirm no org-level copy of ${ROUTINE_SECRETS.join(", ")} is visible to the repository, then re-run inspect — failing closed`,
        });
    }
    else if (orgStatus === 404) {
        // A 404 means "no organization-secrets endpoint for this repository". That is
        // legitimate ONLY for a user-owned repository. For an org-owned repo — or one
        // whose owner type cannot be read — the endpoint should exist, so a 404 is
        // itself unverifiable and fails closed.
        const ownerType = await fetchOwnerType(ctx, nwo);
        if (ownerType !== "User") {
            const owner = ownerType === "Organization"
                ? "is organization-owned"
                : "has an owner type that could not be determined";
            violations.push({
                check: "secret-scope-unverifiable",
                message: `organization-scope secrets for ${nwo} could not be verified: the repository ${owner} yet the organization-secrets endpoint returned 404, so inspect cannot prove no org-level copy of ${ROUTINE_SECRETS.join(", ")} exists — failing closed; verify org-level secret absence with a separate least-privileged credential (a fine-grained organization token granting organization "Secrets" read) or have an organization admin confirm, then re-run inspect`,
            });
        }
        // ownerType === "User" => not owned by an org => org scope does not apply.
    }
    else if (orgStatus === 200) {
        if (shapeInvalid || accumulated !== totalCount) {
            const detail = shapeInvalid
                ? "the organization-secrets response was malformed (a missing/non-integer/negative total_count, a non-array secrets field, a page longer than the per-page limit, or an entry whose name is missing, syntactically invalid, or a case-insensitive duplicate)"
                : `the organization-secrets listing was incomplete (total_count ${totalCount} but ${accumulated} read)`;
            violations.push({
                check: "secret-scope-unverifiable",
                message: `organization-scope secrets visible to ${nwo} could not be verified: ${detail}, so inspect cannot prove no org-level copy of ${ROUTINE_SECRETS.join(", ")} exists — failing closed; re-run inspect once the API returns a complete response, or confirm org-level secret absence with an organization admin`,
            });
        }
        else {
            for (const name of ROUTINE_SECRETS) {
                if (orgNames.has(name.toUpperCase())) {
                    violations.push({
                        check: "org-scope-secret",
                        message: `an organization-scope secret named ${name} is visible to ${nwo}; it resolves in the token-bearing job regardless of the environment and defeats the gate — remove the org-level copy (or revoke this repository's access to it) and store ${name} in the "${env}" environment only`,
                    });
                }
            }
        }
    }
    return violations;
}
/**
 * Resolve a repository's owner type ("User" | "Organization" | "") via one GET
 * /repos/{nwo}. Returns "" when the type cannot be read; callers treat an unknown
 * owner type as fail-closed for organization-scope purposes.
 */
async function fetchOwnerType(ctx, nwo) {
    const meta = await ctx.client.restProbe(`/repos/${nwo}`);
    if (meta.status !== 200)
        return "";
    const json = (meta.json ?? {});
    return json.owner && typeof json.owner.type === "string" ? json.owner.type : "";
}
/**
 * Verify the default branch requires BOTH exact status-check contexts
 * (`REQUIRED_STATUS_CHECK_CONTEXTS`) among its effective required status checks,
 * reading effective branch protection AND branch rulesets and unioning their
 * required contexts. Missing either context is a distinct violation; protection
 * or rulesets that cannot be read (403, or an unknown default branch) is a
 * distinct fail-closed "…-unreadable" violation. Only the token-bearing inspect
 * path runs this; identity (secretless) never does.
 */
export async function checkBranchProtection(ctx, defaultBranch) {
    const nwo = ctx.repo.nwo;
    const violations = [];
    const contexts = new Set();
    if (defaultBranch.length === 0) {
        violations.push({
            check: "branch-protection-unreadable",
            message: `the repository default branch could not be determined, so its required status checks cannot be verified — failing closed; ensure the token can read the repository`,
        });
        return { branch: defaultBranch, ok: false, requiredChecks: [], violations };
    }
    const branchPath = encodeURIComponent(defaultBranch);
    // (1) Effective branch protection. Requires "Administration" read; a 403 means
    // the scope is unverifiable and fails closed. A 404 is a definitive "no branch
    // protection object" — readable, but contributing no contexts.
    const protection = await ctx.client.restProbe(`/repos/${nwo}/branches/${branchPath}/protection`);
    if (protection.status === 403) {
        violations.push({
            check: "branch-protection-unreadable",
            message: `branch protection for "${defaultBranch}" could not be read (HTTP 403); grant the token repository "Administration" read so inspect can prove both required status checks (${REQUIRED_STATUS_CHECK_CONTEXTS.join(", ")}) are enforced — failing closed`,
        });
    }
    else if (protection.status === 200) {
        const pJson = (protection.json ?? {});
        const rsc = pJson.required_status_checks ?? null;
        if (rsc) {
            for (const c of Array.isArray(rsc.contexts) ? rsc.contexts : []) {
                if (typeof c === "string")
                    contexts.add(c);
            }
            for (const c of Array.isArray(rsc.checks) ? rsc.checks : []) {
                if (c && typeof c.context === "string")
                    contexts.add(c.context);
            }
        }
    }
    // protection.status === 404 => branch not protected by a classic rule; a
    // ruleset may still supply the contexts, so this is not itself unreadable.
    // (2) Branch rulesets that apply to the default branch. Readable with plain
    // repository read; a 403 still fails closed as a distinct unverifiable finding.
    const rules = await ctx.client.restProbe(`/repos/${nwo}/rules/branches/${branchPath}`);
    if (rules.status === 403) {
        violations.push({
            check: "branch-rulesets-unreadable",
            message: `branch rulesets for "${defaultBranch}" could not be read (HTTP 403); grant the token repository read so inspect can prove both required status checks (${REQUIRED_STATUS_CHECK_CONTEXTS.join(", ")}) are enforced — failing closed`,
        });
    }
    else if (rules.status === 200 && Array.isArray(rules.json)) {
        for (const rule of rules.json) {
            const r = (rule ?? {});
            if (r.type !== "required_status_checks")
                continue;
            const checks = r.parameters?.required_status_checks;
            for (const c of Array.isArray(checks) ? checks : []) {
                if (c && typeof c.context === "string")
                    contexts.add(c.context);
            }
        }
    }
    // rules.status === 404 => no rulesets apply => contributes no contexts.
    // Require BOTH exact contexts among the unioned effective required checks.
    for (const required of REQUIRED_STATUS_CHECK_CONTEXTS) {
        if (!contexts.has(required)) {
            violations.push({
                check: "required-status-check-missing",
                message: `the default branch "${defaultBranch}" does not require the status check "${required}"; add it to a branch protection rule or ruleset for "${defaultBranch}" so a pull request cannot merge without it — failing closed`,
            });
        }
    }
    return {
        branch: defaultBranch,
        ok: violations.length === 0,
        requiredChecks: [...contexts].sort(),
        violations,
    };
}
// --------------------------------------------------------------------------
// Command: inspect (read-only, fail-closed compliance)
// --------------------------------------------------------------------------
async function cmdInspect(ctx) {
    const access = await verifyAccess(ctx, false);
    const snapshot = await resolveProject(ctx.client, ctx.project);
    // Schema state.
    let schemaError = null;
    let schemaOk = false;
    try {
        schemaOk = schemaSatisfied(planSchema(snapshot.fields));
    }
    catch (err) {
        schemaError = errText(err);
    }
    // On-disk canonical law vs embedded law digest.
    const embeddedLaw = decodePayload("PROJECT-BOARD-LAW.md");
    const embeddedLawText = embeddedLaw.toString("utf8");
    const lawPath = join(ctx.deps.cwd, "PROJECT-BOARD-LAW.md");
    const diskLaw = ctx.deps.fs.existsSync(lawPath)
        ? ctx.deps.fs.readFileSync(lawPath)
        : null;
    const lawByteIdentity = diskLaw !== null &&
        sha256Hex(diskLaw) === LAW_SHA256 &&
        sha256Hex(embeddedLaw) === LAW_SHA256;
    // AGENTS.md managed block byte identity.
    const agentsPath = join(ctx.deps.cwd, "AGENTS.md");
    const agents = ctx.deps.fs.existsSync(agentsPath)
        ? ctx.deps.fs.readFileSync(agentsPath).toString("utf8")
        : null;
    let agentsByteIdentity = false;
    let agentsError = null;
    try {
        agentsByteIdentity = agents !== null && planAgentsContent(agents, embeddedLawText) === agents;
    }
    catch (err) {
        agentsError = errText(err);
    }
    // Every managed payload file present with byte-identical content.
    const fileResults = [];
    let payloadFilesOk = true;
    for (const target of Object.keys(PAYLOADS)) {
        const abs = join(ctx.deps.cwd, target);
        const present = ctx.deps.fs.existsSync(abs);
        // The installation guide is the sole customizable installed artifact: it is
        // verified present, never byte-identical. Every other payload stays exact.
        const ok = target === CUSTOMIZABLE_INSTALL
            ? present
            : present && ctx.deps.fs.readFileSync(abs).equals(decodePayload(target));
        if (!ok)
            payloadFilesOk = false;
        fileResults.push(target === CUSTOMIZABLE_INSTALL ? { path: target, ok, customizable: true } : { path: target, ok });
    }
    // Generated expectations bind the installed manager and static package. The
    // generated payload is the internal consistency root and must match the one
    // currently executing.
    const installedManager = join(ctx.deps.cwd, RUNTIME_MANAGER);
    const installedPayload = join(ctx.deps.cwd, RUNTIME_PAYLOAD);
    const installedPackage = join(ctx.deps.cwd, RUNTIME_PACKAGE);
    const sourceManager = join(ctx.deps.selfDir, "manager.js");
    const sourcePayload = join(ctx.deps.selfDir, "payload.generated.js");
    const runtimeByteIdentity = ctx.deps.fs.existsSync(installedManager) &&
        ctx.deps.fs.existsSync(installedPayload) &&
        ctx.deps.fs.existsSync(installedPackage) &&
        ctx.deps.fs.existsSync(sourceManager) &&
        ctx.deps.fs.existsSync(sourcePayload) &&
        sha256Hex(ctx.deps.fs.readFileSync(installedManager)) === RUNTIME_MANAGER_SHA256 &&
        ctx.deps.fs.readFileSync(installedPayload).equals(ctx.deps.fs.readFileSync(sourcePayload)) &&
        ctx.deps.fs.readFileSync(installedPackage).equals(Buffer.from(RUNTIME_PACKAGE_JSON));
    // Remote governance: every repository issue maps to a complete Project item.
    const items = await resolveProjectItems(ctx.client, ctx.project);
    const repoItems = items.filter((i) => i.repoNwo === ctx.repo.nwo);
    const inventory = await listRepoIssues(ctx);
    const issues = inventory.filter((rec) => !rec.isPull);
    // One linked-pull-request read per repo Project item, shared by the per-issue
    // report and the PR-mapping compliance report below.
    const linkedByItem = new Map();
    for (const item of repoItems) {
        linkedByItem.set(item.id, [...(await fetchPullRequestLinks(ctx.client, item.id)).values()].flat());
    }
    const itemReports = await Promise.all(issues.map(async (issue) => {
        const item = repoItems.find((candidate) => candidate.issueNumber === issue.number) ?? null;
        const missingCustomValues = item
            ? missingRequiredItemValues(item)
            : [...REQUIRED_ITEM_VALUE_FIELDS];
        const linkedPullRequests = item ? linkedByItem.get(item.id) ?? [] : [];
        const relations = await nativeRelations(ctx, issue);
        return {
            issue: issue.number,
            inProject: item !== null,
            status: item?.statusName ?? "N/A",
            milestone: issue?.milestone?.title ?? "N/A",
            missingCustomValues,
            labels: issue.labels.length > 0 ? issue.labels : "N/A",
            assignees: issue.assignees.length > 0 ? issue.assignees : "N/A",
            linkedPullRequests: linkedPullRequests.length > 0 ? linkedPullRequests : "N/A",
            relations,
            compliant: item !== null &&
                Boolean(issue.milestone?.title) &&
                missingCustomValues.length === 0,
        };
    }));
    const orphanProjectItems = repoItems
        .filter((item) => !issues.some((issue) => issue.number === item.issueNumber))
        .map((item) => item.issueNumber);
    const itemsOk = itemReports.every((report) => report.compliant) && orphanProjectItems.length === 0;
    const { pullRequests, pullRequestsOk } = await pullRequestComplianceReport(ctx, {
        repoItems,
        inventory,
        linkedByItem,
    });
    const repositoryLinked = await projectLinkedToRepo(ctx.client, ctx.project, ctx.repo.nwo);
    // Secret-scoping environment posture. Only the token-bearing inspect path runs
    // this; identity (secretless) never does. All violations are reported.
    const environmentPosture = await checkEnvironmentPosture(ctx, access.defaultBranch);
    // Default-branch required-status-check posture: both exact contexts must gate
    // the default branch via branch protection and/or rulesets. Fails closed on any
    // missing context or unreadable protection. Token-bearing inspect path only.
    const branchProtection = await checkBranchProtection(ctx, access.defaultBranch);
    const openTrueUps = issues.filter((i) => trueUpNumber(i.title) !== null && i.state === "open");
    const nextTrueUp = openTrueUps[0] ?? null;
    const nextTrueUpItem = nextTrueUp
        ? repoItems.find((item) => item.issueNumber === nextTrueUp.number) ?? null
        : null;
    const nextTrueUpExists = openTrueUps.length === 1 &&
        nextTrueUp !== null &&
        nextTrueUpItem !== null &&
        nextTrueUp.body === embeddedLawText &&
        Boolean(nextTrueUp.milestone?.title) &&
        missingRequiredItemValues(nextTrueUpItem).length === 0;
    const compliant = schemaError === null &&
        schemaOk &&
        lawByteIdentity &&
        agentsByteIdentity &&
        payloadFilesOk &&
        runtimeByteIdentity &&
        repositoryLinked &&
        itemsOk &&
        pullRequestsOk &&
        nextTrueUpExists &&
        environmentPosture.ok &&
        branchProtection.ok;
    return {
        command: "inspect",
        repo: ctx.repo.url,
        project: ctx.project.url,
        projectId: snapshot.id,
        lawSha256: LAW_SHA256,
        payloadSha256: PAYLOAD_SHA256,
        identity: {
            lawByteIdentity,
            agentsByteIdentity,
            agentsError,
            payloadFilesOk,
            runtimeByteIdentity,
            files: fileResults,
        },
        schema: schemaError ? { ok: false, error: schemaError } : { ok: schemaOk },
        items: itemReports,
        orphanProjectItems,
        pullRequests,
        pullRequestsOk,
        repositoryLinked,
        itemsOk,
        nextTrueUpExists,
        environmentPosture,
        branchProtection,
        compliant,
    };
}
// --------------------------------------------------------------------------
// Command: reconcile
// --------------------------------------------------------------------------
async function cmdReconcile(ctx) {
    await verifyAccess(ctx, true);
    const snapshot = await resolveProject(ctx.client, ctx.project);
    const plan = planSchema(snapshot.fields);
    const iteration = readIterationInputs(ctx.opts);
    if (plan.createIteration && (!iteration.start || iteration.days === undefined)) {
        throw new ManagerError("iteration-inputs-required", "creating Iteration requires --iteration-start and --iteration-days");
    }
    if (ctx.dryRun) {
        const prCompliance = await pullRequestComplianceReport(ctx);
        return {
            command: "reconcile",
            dryRun: true,
            project: snapshot.id,
            plan,
            items: await itemComplianceReport(ctx),
            pullRequests: prCompliance.pullRequests,
            pullRequestsOk: prCompliance.pullRequestsOk,
        };
    }
    ctx.journal.record("planned", "reconcile-schema", JSON.stringify(plan));
    const steps = [
        {
            name: "ensure-schema",
            run: async () => {
                await ensureSchema(ctx, snapshot, iteration);
            },
            verify: async () => schemaSatisfied(planSchema((await resolveProject(ctx.client, ctx.project)).fields)),
        },
    ];
    const result = await runOrderedSteps(steps, ctx.journal);
    const prCompliance = await pullRequestComplianceReport(ctx);
    return {
        command: "reconcile",
        dryRun: false,
        project: snapshot.id,
        applied: result.ok,
        items: await itemComplianceReport(ctx),
        pullRequests: prCompliance.pullRequests,
        pullRequestsOk: prCompliance.pullRequestsOk,
    };
}
function readIterationInputs(opts) {
    const start = nullableOpt(opts, "iteration-start");
    const daysStr = nullableOpt(opts, "iteration-days");
    const out = {};
    if (start) {
        if (!isValidYmd(start)) {
            throw new ManagerError("bad-date", "--iteration-start must be YYYY-MM-DD (UTC)");
        }
        out.start = start;
    }
    if (daysStr) {
        const days = Number.parseInt(daysStr, 10);
        if (!Number.isInteger(days) || days <= 0) {
            throw new ManagerError("bad-iteration", "--iteration-days must be a positive integer");
        }
        out.days = days;
    }
    return out;
}
async function itemComplianceReport(ctx) {
    const items = await resolveProjectItems(ctx.client, ctx.project);
    const issues = await listIssues(ctx);
    const repoItems = items.filter((item) => item.repoNwo === ctx.repo.nwo);
    return issues.map((issue) => {
        const item = repoItems.find((candidate) => candidate.issueNumber === issue.number) ?? null;
        const milestone = issue?.milestone?.title ?? "N/A";
        const missingCustomValues = item
            ? missingRequiredItemValues(item)
            : [...REQUIRED_ITEM_VALUE_FIELDS];
        return {
            issue: issue.number,
            inProject: item !== null,
            status: item?.statusName ?? "N/A",
            milestone,
            missingCustomValues,
            compliant: item !== null && milestone !== "N/A" && missingCustomValues.length === 0,
        };
    });
}
function publicTrueUpBodyReplacement(plan) {
    return {
        issue: plan.issue,
        expectedUpdatedAt: plan.expectedUpdatedAt,
        patch: plan.patch,
    };
}
async function planTrueUpBodyReplacement(ctx, lawBody) {
    const open = (await listIssues(ctx)).filter((issue) => trueUpNumber(issue.title) !== null && issue.state === "open");
    if (open.length > 1) {
        throw new ManagerError("true-up-collision", "multiple open true-up issues exist");
    }
    const issue = open[0];
    const confirmations = allOpts(ctx.opts, "replace-true-up-body");
    if (!issue || issue.body === lawBody) {
        // A replacement confirmation supplied when no stale true-up body exists
        // authorizes nothing and would be silently ignored — fail closed instead.
        if (confirmations.length > 0) {
            throw new ManagerError("replace-true-up-body-mismatch", issue
                ? `--replace-true-up-body was supplied but true-up #${issue.number} already carries the current law body; nothing to replace`
                : "--replace-true-up-body was supplied but no open true-up issue exists; nothing to replace");
        }
        return null;
    }
    const expected = `REPLACE-TRUE-UP-BODY:${issue.number}`;
    if (confirmations.length !== 1 || confirmations[0] !== expected) {
        throw new ManagerError("replace-true-up-body-required", `stale true-up body requires --replace-true-up-body ${expected}`);
    }
    if (!issue.nodeId || !issue.updatedAt) {
        throw new ManagerError("true-up-snapshot", `issue #${issue.number} lacks a verifiable identity snapshot`);
    }
    return {
        issue: issue.number,
        nodeId: issue.nodeId,
        title: issue.title,
        state: issue.state,
        milestone: issue.milestone?.title ?? null,
        expectedUpdatedAt: issue.updatedAt,
        expectedBody: issue.body,
        patch: { body: lawBody },
    };
}
async function replaceTrueUpBody(ctx, plan) {
    const fresh = await getIssue(ctx, plan.issue);
    if (fresh.number !== plan.issue ||
        fresh.nodeId !== plan.nodeId ||
        fresh.title !== plan.title ||
        fresh.state !== plan.state ||
        fresh.updatedAt !== plan.expectedUpdatedAt ||
        fresh.body !== plan.expectedBody) {
        throw new ManagerError("true-up-concurrent-change", `issue #${plan.issue} changed after install preflight`);
    }
    await ctx.client.rest("PATCH", `/repos/${ctx.repo.nwo}/issues/${plan.issue}`, plan.patch);
}
async function trueUpBodyReplacementMatches(ctx, plan) {
    const issue = await getIssue(ctx, plan.issue);
    return (issue.number === plan.issue &&
        issue.nodeId === plan.nodeId &&
        issue.title === plan.title &&
        issue.state === plan.state &&
        (issue.milestone?.title ?? null) === plan.milestone &&
        issue.body === plan.patch.body);
}
/**
 * Freeze the fingerprint of a planning input. `bytes` are the exact bytes the
 * plan consumed (null when the path was absent), so the recorded hash is the
 * one the written content was derived from — not a re-read that could itself
 * race.
 */
function freezePrewrite(into, label, abs, bytes) {
    into.push({ label, abs, hash: bytes === null ? null : sha256Hex(bytes) });
}
/**
 * Re-read every frozen source/target immediately before the first local write
 * and return the first input whose existence or bytes drifted since planning
 * (changed, disappeared, or appeared), or null when the whole transaction's
 * inputs are unchanged. This closes the plan->apply TOCTOU window: a customized
 * target edited after planning can no longer be silently overwritten by a stale
 * merge, and a vendored source swapped after planning cannot be copied blindly.
 */
function firstDriftedPrewrite(fs, snapshots) {
    for (const snap of snapshots) {
        const current = fs.existsSync(snap.abs) ? sha256Hex(fs.readFileSync(snap.abs)) : null;
        if (current !== snap.hash)
            return snap.label;
    }
    return null;
}
async function cmdInstall(ctx) {
    const iteration = readIterationInputs(ctx.opts);
    const milestones = parseMilestoneInputs(allOpts(ctx.opts, "milestone"));
    const trueUpMilestone = nullableOpt(ctx.opts, "true-up-milestone");
    const trueUpIteration = nullableOpt(ctx.opts, "iteration");
    if (!trueUpMilestone) {
        throw new ManagerError("true-up-milestone-required", "install requires --true-up-milestone so the next true-up cannot be created without a milestone");
    }
    // Validate the full remote plan (scopes + repo + project) before any local
    // write, per fail-closed install semantics.
    const access = await verifyAccess(ctx, true);
    const lawText = decodePayload("PROJECT-BOARD-LAW.md").toString("utf8");
    const trueUpBodyReplacement = await planTrueUpBodyReplacement(ctx, lawText);
    const snapshot = await resolveProject(ctx.client, ctx.project);
    const existingMilestones = await listMilestones(ctx);
    if (!existingMilestones.some((milestone) => milestone.title === trueUpMilestone) &&
        !milestones.some((milestone) => milestone.name === trueUpMilestone)) {
        throw new ManagerError("missing-milestone", `true-up milestone does not exist and is not an install input: ${trueUpMilestone}`);
    }
    const schemaPlan = planSchema(snapshot.fields);
    if (schemaPlan.createIteration && (!iteration.start || iteration.days === undefined)) {
        throw new ManagerError("iteration-inputs-required", "creating Iteration requires --iteration-start and --iteration-days");
    }
    // Every planning input that determines a local write is fingerprinted from the
    // exact bytes read here; the pre-write drift guard re-verifies them just before
    // the first mutation so a plan->apply change fails closed with zero writes.
    const prewrite = [];
    // Materialise the AGENTS content up front so malformed markers fail closed.
    const agentsPath = join(ctx.deps.cwd, "AGENTS.md");
    const agentsBytes = ctx.deps.fs.existsSync(agentsPath)
        ? ctx.deps.fs.readFileSync(agentsPath)
        : null;
    freezePrewrite(prewrite, "AGENTS.md", agentsPath, agentsBytes);
    const existingAgents = agentsBytes === null ? null : decodeAgentsText(agentsBytes);
    const agentsContent = planAgentsContent(existingAgents, lawText);
    // Resolve the customizable installation guide up front (read-only) so its
    // exact plan appears in dry-run and an unsafe merge fails closed before any
    // local or remote write.
    const installGuide = resolveInstallCustomization(ctx.deps.fs, ctx.deps.cwd, decodePayload(CUSTOMIZABLE_INSTALL));
    // Bind the resolved guide bytes to the exact target/base snapshots they were
    // derived from: the merge result cannot outlive the inputs it merged. The
    // target is always tracked (a null hash detects a guide that appears after an
    // initial-install plan); the prior base is tracked only when it was consumed.
    if (installGuide.ok) {
        prewrite.push({
            label: CUSTOMIZABLE_INSTALL,
            abs: join(ctx.deps.cwd, CUSTOMIZABLE_INSTALL),
            hash: installGuide.targetSha256,
        });
        if (installGuide.priorSourceSha256 !== null) {
            // The merge base was recovered (digest-verified) from the installed payload
            // artifact. Pin the EXACT bytes that derivation consumed — do NOT re-read
            // the file here. A second read could differ from the bytes the base came
            // from, letting a change slip past the guard while INSTALL content stays
            // derived from the earlier read. Any later change to those bytes then fails
            // closed at the guard.
            prewrite.push({
                label: RUNTIME_PAYLOAD,
                abs: join(ctx.deps.cwd, RUNTIME_PAYLOAD),
                hash: installGuide.priorSourceSha256,
            });
        }
    }
    // Runtime siblings must exist to copy; absence is a hard failure.
    const selfManager = join(ctx.deps.selfDir, "manager.js");
    const selfPayload = join(ctx.deps.selfDir, "payload.generated.js");
    const filePlan = planInstallFiles();
    if (ctx.dryRun) {
        return {
            command: "install",
            dryRun: true,
            repo: ctx.repo.url,
            repoPrivate: access.repoPrivate,
            files: filePlan,
            runtimeSiblingsPresent: ctx.deps.fs.existsSync(selfManager) && ctx.deps.fs.existsSync(selfPayload),
            installGuide: publicInstallResolution(installGuide),
            milestones,
            remotePlan: {
                link: true,
                schema: schemaPlan,
                milestones: milestones.map((m) => m.name),
                trueUpMilestone,
                trueUpIteration,
                replaceTrueUpBody: trueUpBodyReplacement
                    ? publicTrueUpBodyReplacement(trueUpBodyReplacement)
                    : null,
            },
        };
    }
    if (!ctx.deps.fs.existsSync(selfManager) || !ctx.deps.fs.existsSync(selfPayload)) {
        throw new ManagerError("runtime-missing", "runtime siblings manager.js/payload.generated.js are absent; cannot vendor");
    }
    // An unsafe installation-guide merge fails closed before any local or remote
    // write; the blocked reason is journaled and the run applies nothing.
    if (!installGuide.ok) {
        ctx.journal.record("blocked", `merge:${CUSTOMIZABLE_INSTALL}`, installGuide.reason);
        return {
            command: "install",
            dryRun: false,
            applied: false,
            phase: "install-guide",
            reason: installGuide.reason,
        };
    }
    // A confirmed stale true-up body is repaired before install can write local
    // files or any unrelated remote resource.
    if (trueUpBodyReplacement) {
        const publicPlan = publicTrueUpBodyReplacement(trueUpBodyReplacement);
        ctx.journal.record("planned", `replace-true-up-body:${trueUpBodyReplacement.issue}`, JSON.stringify(publicPlan));
        const replacementResult = await runOrderedSteps([{
                name: `replace-true-up-body:${trueUpBodyReplacement.issue}`,
                run: () => replaceTrueUpBody(ctx, trueUpBodyReplacement),
                verify: () => trueUpBodyReplacementMatches(ctx, trueUpBodyReplacement),
            }], ctx.journal);
        if (!replacementResult.ok) {
            return { command: "install", dryRun: false, applied: false, phase: "true-up-body" };
        }
    }
    // --- Local writes (exact bytes) with per-file read-back verification. ---
    const localSteps = [];
    const writeAndVerify = (rel, data) => ({
        name: `write:${rel}`,
        run: async () => {
            const abs = join(ctx.deps.cwd, rel);
            const dir = dirname(abs);
            if (!ctx.deps.fs.existsSync(dir))
                ctx.deps.fs.mkdirSync(dir);
            ctx.deps.fs.writeFileSync(abs, data);
        },
        verify: async () => {
            const abs = join(ctx.deps.cwd, rel);
            if (!ctx.deps.fs.existsSync(abs))
                return false;
            const got = ctx.deps.fs.readFileSync(abs);
            const want = typeof data === "string" ? Buffer.from(data, "utf8") : data;
            return got.equals(want);
        },
    });
    for (const target of Object.keys(PAYLOADS)) {
        // The customizable installation guide is written from the resolved merge;
        // every other payload is written byte-identically.
        const data = target === CUSTOMIZABLE_INSTALL ? installGuide.content : decodePayload(target);
        localSteps.push(writeAndVerify(target, data));
    }
    const managerBytes = ctx.deps.fs.readFileSync(selfManager);
    // Bind the vendored runtime manager to the authoritative RUNTIME_MANAGER_SHA256
    // identity (frozen at module load, the same generated/runtime identity chain the
    // payload source is bound to) BEFORE it becomes the planned snapshot or is
    // copied. A tampered or swapped manager.js — bytes that do not hash to the
    // distribution's expectation — must never be vendored; the prewrite guard alone
    // cannot catch it because it pins these very bytes. Fail closed before any local
    // write, then pin the exact verified bytes into the pre-write snapshot.
    if (sha256Hex(managerBytes) !== RUNTIME_MANAGER_SHA256) {
        const reason = "runtime manager source bytes differ from the authoritative RUNTIME_MANAGER_SHA256 identity";
        ctx.journal.record("blocked", `source-identity:${RUNTIME_MANAGER}`, reason);
        return {
            command: "install",
            dryRun: false,
            applied: false,
            phase: "source-identity",
            reason,
        };
    }
    freezePrewrite(prewrite, "source:manager.js", selfManager, managerBytes);
    localSteps.push(writeAndVerify(RUNTIME_MANAGER, managerBytes));
    const payloadBytes = ctx.deps.fs.readFileSync(selfPayload);
    // Bind this single read of the vendored payload source to the payload identity
    // imported at module load BEFORE it becomes the planned snapshot. A source
    // whose payload set diverges from the imported PAYLOADS (e.g. swapped between
    // module import/merge planning and this read) must never be accepted and
    // copied while INSTALL and the other payload files stay derived from the
    // imported bytes; the prewrite guard alone cannot catch a change that precedes
    // this read because it pins these very bytes. Fail closed before any local write.
    const sourceIdentity = verifyRuntimePayloadSourceIdentity(payloadBytes);
    if (!sourceIdentity.ok) {
        ctx.journal.record("blocked", `source-identity:${RUNTIME_PAYLOAD}`, sourceIdentity.reason);
        return {
            command: "install",
            dryRun: false,
            applied: false,
            phase: "source-identity",
            reason: sourceIdentity.reason,
        };
    }
    freezePrewrite(prewrite, "source:payload.generated.js", selfPayload, payloadBytes);
    localSteps.push(writeAndVerify(RUNTIME_PAYLOAD, payloadBytes));
    localSteps.push(writeAndVerify(RUNTIME_PACKAGE, NESTED_PACKAGE_JSON));
    localSteps.push(writeAndVerify("AGENTS.md", agentsContent));
    const gitignorePath = join(ctx.deps.cwd, ".gitignore");
    const gitignoreBytes = ctx.deps.fs.existsSync(gitignorePath)
        ? ctx.deps.fs.readFileSync(gitignorePath)
        : null;
    freezePrewrite(prewrite, ".gitignore", gitignorePath, gitignoreBytes);
    const existingIgnore = gitignoreBytes === null ? null : gitignoreBytes.toString("utf8");
    localSteps.push(writeAndVerify(".gitignore", planGitignore(existingIgnore)));
    // Root-cause TOCTOU guard: immediately before the first local mutation,
    // re-read every planned source/target and fail closed if any changed,
    // disappeared, or appeared since planning. Drift is journaled and blocks the
    // entire local apply — no partial or stale-merge write can occur.
    const drifted = firstDriftedPrewrite(ctx.deps.fs, prewrite);
    if (drifted) {
        ctx.journal.record("blocked", `local-drift:${drifted}`, "planned input changed between plan and apply");
        return {
            command: "install",
            dryRun: false,
            applied: false,
            phase: "local-drift",
            drift: drifted,
        };
    }
    ctx.journal.record("planned", "install", JSON.stringify(filePlan.map((f) => f.path)));
    const localResult = await runOrderedSteps(localSteps, ctx.journal);
    if (!localResult.ok) {
        return { command: "install", dryRun: false, applied: false, phase: "local" };
    }
    // --- Remote writes: link, schema, milestones, required next true-up. ---
    const remoteSteps = [];
    remoteSteps.push({
        name: "link-project",
        run: async () => {
            if (!(await projectLinkedToRepo(ctx.client, ctx.project, ctx.repo.nwo))) {
                await linkProjectToRepo(ctx.client, snapshot.id, access.repoNodeId);
            }
        },
        verify: () => projectLinkedToRepo(ctx.client, ctx.project, ctx.repo.nwo),
    });
    remoteSteps.push({
        name: "ensure-schema",
        run: async () => {
            await ensureSchema(ctx, snapshot, iteration);
        },
        verify: async () => {
            const fresh = planSchema((await resolveProject(ctx.client, ctx.project)).fields);
            return schemaSatisfied(fresh);
        },
    });
    for (const m of milestones) {
        remoteSteps.push({
            name: `ensure-milestone:${m.name}`,
            run: () => ensureMilestone(ctx, m),
            verify: () => milestoneMatches(ctx, m),
        });
    }
    remoteSteps.push({
        name: "ensure-next-true-up",
        run: () => ensureNextTrueUp(ctx, trueUpMilestone, trueUpIteration),
        verify: () => verifyExactlyOneOpenTrueUp(ctx),
    });
    const remoteResult = await runOrderedSteps(remoteSteps, ctx.journal);
    return {
        command: "install",
        dryRun: false,
        repo: ctx.repo.url,
        files: filePlan.map((f) => f.path),
        applied: localResult.ok && remoteResult.ok,
    };
}
function selectTrueUpIteration(snapshot, preferred, nowMs) {
    const field = fieldByName(snapshot, "Iteration");
    if (preferred) {
        iterationIdFor(field, preferred);
        return preferred;
    }
    const day = Date.parse(`${toYmd(nowMs)}T00:00:00Z`);
    const current = (field.iterations ?? []).find((iteration) => {
        if (!iteration.startDate || !iteration.duration)
            return false;
        const start = Date.parse(`${iteration.startDate}T00:00:00Z`);
        return start <= day && day < start + iteration.duration * DAY_MS;
    });
    if (!current) {
        throw new ManagerError("iteration-required", "no current UTC iteration exists; supply --iteration with an existing title");
    }
    return current.title;
}
async function verifyExactlyOneOpenTrueUp(ctx) {
    const issues = await listIssues(ctx);
    const open = issues.filter((issue) => trueUpNumber(issue.title) !== null && issue.state === "open");
    if (open.length !== 1)
        return false;
    const issue = open[0];
    const item = await findProjectItem(ctx.client, ctx.project, issue.number, ctx.repo.nwo);
    return Boolean(item &&
        issue.body === decodePayload("PROJECT-BOARD-LAW.md").toString("utf8") &&
        issue.milestone?.title &&
        missingRequiredItemValues(item).length === 0);
}
/** Create the first/next complete open numbered true-up when none is open. */
async function ensureNextTrueUp(ctx, milestone, preferredIteration = null) {
    const issues = await listIssues(ctx);
    const open = issues.filter((i) => trueUpNumber(i.title) !== null && i.state === "open");
    if (open.length > 1)
        throw new ManagerError("true-up-collision", "multiple open true-up issues exist");
    if (open.length === 1) {
        if (!(await verifyExactlyOneOpenTrueUp(ctx))) {
            throw new ManagerError("true-up-incomplete", "the open true-up is not a complete Project item");
        }
        return;
    }
    const next = maxTrueUpNumber(issues.map((i) => i.title)) + 1;
    const snapshot = await resolveProject(ctx.client, ctx.project);
    const iteration = selectTrueUpIteration(snapshot, preferredIteration, ctx.deps.now());
    await createTrueUpIssue(ctx, next, milestone, snapshot, iteration);
}
async function createTrueUpIssue(ctx, number, milestone, snapshot, iterationTitle) {
    const title = `Project Board true-up #${number}`;
    const issues = await listIssues(ctx);
    let issue = issues.find((candidate) => candidate.title === title) ?? null;
    const milestoneNumber = await milestoneNumberFor(ctx, milestone);
    if (milestoneNumber === null)
        throw new ManagerError("missing-milestone", `milestone does not exist: ${milestone}`);
    const lawBody = decodePayload("PROJECT-BOARD-LAW.md").toString("utf8");
    const body = {
        title,
        body: lawBody,
        milestone: milestoneNumber,
    };
    if (!issue) {
        const created = await ctx.client.rest("POST", `/repos/${ctx.repo.nwo}/issues`, body);
        issue = toIssueRecord(created.json);
        if (!issue)
            throw new ManagerError("issue", "created true-up lacked an issue record");
    }
    else {
        if (issue.state !== "open")
            throw new ManagerError("true-up-collision", `${title} already exists but is closed`);
        if (issue.body !== lawBody || issue.milestone?.title !== milestone) {
            await ctx.client.rest("PATCH", `/repos/${ctx.repo.nwo}/issues/${issue.number}`, body);
            issue = await getIssue(ctx, issue.number);
        }
    }
    let item = await findProjectItem(ctx.client, ctx.project, issue.number, ctx.repo.nwo);
    if (!item) {
        await addIssueToProject(ctx.client, snapshot.id, issue.nodeId);
        item = await findProjectItem(ctx.client, ctx.project, issue.number, ctx.repo.nwo);
    }
    if (!item)
        throw new ManagerError("not-in-project", `${title} could not be added to ${ctx.project.url}`);
    const values = [
        ["Status", { singleSelectOptionId: optionIdFor(fieldByName(snapshot, "Status"), IN_REVIEW) }, (candidate) => candidate.statusName === IN_REVIEW],
        ["Priority", { singleSelectOptionId: optionIdFor(fieldByName(snapshot, "Priority"), "P2") }, (candidate) => candidate.values.get("Priority")?.optionName === "P2"],
        ["Size", { singleSelectOptionId: optionIdFor(fieldByName(snapshot, "Size"), "S") }, (candidate) => candidate.values.get("Size")?.optionName === "S"],
        ["Estimate", { number: 1 }, (candidate) => candidate.values.get("Estimate")?.number === 1],
        ["Iteration", { iterationId: iterationIdFor(fieldByName(snapshot, "Iteration"), iterationTitle) }, (candidate) => candidate.values.get("Iteration")?.iterationTitle === iterationTitle],
    ];
    for (const [name, value, matches] of values) {
        await setItemFieldConcurrent(ctx, snapshot.id, issue.number, fieldByName(snapshot, name).id, value, matches);
    }
    const finalIssue = await getIssue(ctx, issue.number);
    const finalItem = await findProjectItem(ctx.client, ctx.project, issue.number, ctx.repo.nwo);
    if (!finalItem ||
        finalIssue.body !== lawBody ||
        finalIssue.milestone?.title !== milestone ||
        missingRequiredItemValues(finalItem).length > 0) {
        throw new ManagerError("true-up-incomplete", `${title} did not verify as a complete Project item`);
    }
}
// --------------------------------------------------------------------------
// Command: milestone
// --------------------------------------------------------------------------
async function cmdMilestone(ctx) {
    const name = requireOpt(ctx.opts, "name");
    const dueRaw = nullableOpt(ctx.opts, "due");
    if (dueRaw !== null && !isValidYmd(dueRaw)) {
        throw new ManagerError("bad-date", "--due must be YYYY-MM-DD (UTC)");
    }
    const input = dueRaw !== null ? { name, due: dueRaw } : { name };
    await verifyAccess(ctx, true);
    await resolveProject(ctx.client, ctx.project);
    const existing = (await listMilestones(ctx)).find((milestone) => milestone.title === name) ?? null;
    if (ctx.dryRun) {
        const action = existing === null
            ? "create"
            : input.due !== undefined && existing.due_on?.slice(0, 10) !== input.due
                ? "update-date"
                : "preserve";
        return { command: "milestone", dryRun: true, milestone: input, action };
    }
    ctx.journal.record("planned", `milestone:${name}`, JSON.stringify(input));
    const steps = [
        {
            name: `ensure-milestone:${name}`,
            run: () => ensureMilestone(ctx, input),
            verify: () => milestoneMatches(ctx, input),
        },
    ];
    const result = await runOrderedSteps(steps, ctx.journal);
    return { command: "milestone", dryRun: false, milestone: input, applied: result.ok };
}
// --------------------------------------------------------------------------
// Command: item
// --------------------------------------------------------------------------
async function cmdItem(ctx) {
    const issueOpt = nullableOpt(ctx.opts, "issue");
    const title = nullableOpt(ctx.opts, "title");
    const confirm = singleOpt(ctx.opts, "confirm");
    const reset = singleOpt(ctx.opts, "reset");
    // --confirm and --reset each authorize a different single mutation; paired in
    // one invocation one of them would be silently discarded, so the combination
    // is contradictory and fails closed.
    if (confirm !== null && reset !== null) {
        throw new ManagerError("confirmation", "--confirm and --reset are mutually exclusive in one invocation");
    }
    const status = nullableOpt(ctx.opts, "status");
    refuseApproved(status);
    if (!issueOpt && !title) {
        throw new ManagerError("bad-item", "item requires either --issue N or --title");
    }
    const fields = {
        status,
        priority: nullableOpt(ctx.opts, "priority"),
        size: nullableOpt(ctx.opts, "size"),
        estimate: nullableOpt(ctx.opts, "estimate"),
        iteration: nullableOpt(ctx.opts, "iteration"),
    };
    const parent = nullableOpt(ctx.opts, "parent");
    const parentNumber = parent ? parsePositiveInt(parent, "parent") : null;
    const blockedBy = realOpts(ctx.opts, "blocked-by").map((value) => parsePositiveInt(value, "blocked-by"));
    const labels = realOpts(ctx.opts, "label");
    const assignees = realOpts(ctx.opts, "assignee");
    const milestone = nullableOpt(ctx.opts, "milestone");
    const iterationInputs = readIterationInputs(ctx.opts);
    await verifyAccess(ctx, true);
    const snapshot = await resolveProject(ctx.client, ctx.project);
    const schemaPlan = planSchema(snapshot.fields);
    const issueNumberOpt = issueOpt ? parsePositiveInt(issueOpt, "issue") : null;
    // On the title path, read the issue inventory once: the exact-title reconcile
    // below and the duplicate-issue guard both consume it.
    const issueInventory = issueNumberOpt === null ? await listIssues(ctx) : null;
    const existingIssue = issueNumberOpt !== null
        ? await getIssue(ctx, issueNumberOpt)
        : issueInventory.find((issue) => issue.title === title) ?? null;
    const existingItem = existingIssue
        ? await findProjectItem(ctx.client, ctx.project, existingIssue.number, ctx.repo.nwo)
        : null;
    // Duplicate-issue guard — CREATE path only (--title, no --issue, and no exact
    // open-or-closed-title reconcile matched above). Before minting a net-new issue
    // for requested Work, require verified absence of a plausible existing OPEN
    // issue via a deterministic normalized near-match; a plausible candidate must
    // be extended, not duplicated. Fail closed listing the candidates unless this
    // invocation carries the exact item-specific `--confirm NEW-ISSUE:<title>`
    // (mirrors the ARCHIVE:N / REPLACE-TRUE-UP-BODY:N idioms). The law-mandated
    // true-up sequence never reaches here — createTrueUpIssue owns its own
    // creation — so numbered `Project Board true-up #N` titles are unaffected.
    if (issueNumberOpt === null && existingIssue === null && title !== null) {
        const openTitles = (issueInventory ?? [])
            .filter((issue) => issue.state === "open")
            .map((issue) => ({ number: issue.number, title: issue.title }));
        const candidates = duplicateIssueCandidates(title, openTitles);
        if (candidates.length > 0 && confirm !== `NEW-ISSUE:${title}`) {
            const shown = candidates
                .slice(0, 10)
                .map((candidate) => `#${candidate.number} ${candidate.title}`)
                .join("; ");
            const more = candidates.length > 10 ? ` (+${candidates.length - 10} more)` : "";
            throw new ManagerError("duplicate-candidates", `refusing to create a net-new issue "${title}": ${candidates.length} open issue(s) may already cover this Work — ${shown}${more}. Extend the matching issue (scope note, comment, or native relation), or if this Work is genuinely distinct re-run with --confirm NEW-ISSUE:${title}`);
        }
        // A NEW-ISSUE confirmation with no duplicate candidates overrides nothing
        // and would be silently ignored — fail closed instead.
        if (candidates.length === 0 && confirm !== null && confirm.startsWith("NEW-ISSUE:")) {
            throw new ManagerError("confirmation", "NEW-ISSUE confirmation was supplied but no duplicate candidates exist; nothing to confirm — re-run without --confirm");
        }
    }
    // A NEW-ISSUE confirmation outside the net-new create path — an --issue
    // update, an exact-title reconcile hit, or a confirm string that differs from
    // the proposed --title — is a mismatched confirmation and fails closed before
    // any mutation; a confirmation is never silently ignored.
    if (confirm !== null && confirm.startsWith("NEW-ISSUE:")) {
        if (issueNumberOpt !== null) {
            throw new ManagerError("confirmation", "NEW-ISSUE confirmation applies only to --title creation without --issue");
        }
        if (existingIssue !== null) {
            throw new ManagerError("confirmation", `NEW-ISSUE confirmation is mismatched: "${title}" already exists as issue #${existingIssue.number}; extend it or retitle the Work`);
        }
        if (confirm !== `NEW-ISSUE:${title}`) {
            throw new ManagerError("confirmation", "NEW-ISSUE confirmation must repeat the exact proposed --title byte-for-byte");
        }
    }
    // A reset confirmation that authorizes nothing here (no Approved status being
    // cleared) would be silently ignored — fail closed instead.
    if (reset !== null &&
        !(existingItem?.statusName === APPROVED && fields.status !== null && fields.status !== APPROVED)) {
        throw new ManagerError("confirmation", "--reset was supplied but this invocation clears no Approved status; nothing to reset");
    }
    // Destructive Project-item actions need only an exact target and confirmation;
    // an incomplete item must still be archivable/deletable. Validate these before
    // the normal item's milestone/schema completeness preflight.
    if (confirm !== null && !confirm.startsWith("NEW-ISSUE:")) {
        const parsed = splitConfirmation(confirm);
        if (!parsed || (parsed.kind !== "ARCHIVE" && parsed.kind !== "DELETE")) {
            throw new ManagerError("confirmation", "expected --confirm ARCHIVE:N or DELETE:N");
        }
        if (issueNumberOpt === null ||
            confirm !== `${parsed.kind}:${issueNumberOpt}` ||
            parsed.issue !== issueNumberOpt ||
            existingItem === null) {
            throw new ManagerError("confirmation", "confirmation must name an existing Project issue exactly");
        }
        // The destructive path performs exactly one action; any accompanying
        // mutation option would be silently ignored — fail closed instead.
        const extraneous = [
            title !== null && "--title",
            fields.status !== null && "--status",
            fields.priority !== null && "--priority",
            fields.size !== null && "--size",
            fields.estimate !== null && "--estimate",
            fields.iteration !== null && "--iteration",
            parentNumber !== null && "--parent",
            blockedBy.length > 0 && "--blocked-by",
            labels.length > 0 && "--label",
            assignees.length > 0 && "--assignee",
            milestone !== null && "--milestone",
            nullableOpt(ctx.opts, "body") !== null && "--body",
        ].filter((flag) => typeof flag === "string");
        if (extraneous.length > 0) {
            throw new ManagerError("confirmation", `${parsed.kind}:${issueNumberOpt} is a single destructive action; these options would be silently ignored: ${extraneous.join(", ")}`);
        }
        if (ctx.dryRun) {
            return {
                command: "item",
                dryRun: true,
                plan: { action: parsed.kind.toLowerCase(), issue: issueNumberOpt },
            };
        }
        return await runItemConfirmation(ctx, snapshot, issueOpt, confirm);
    }
    if (schemaPlan.createIteration && (!iterationInputs.start || iterationInputs.days === undefined)) {
        throw new ManagerError("iteration-inputs-required", "creating Iteration requires --iteration-start and --iteration-days");
    }
    const finalMilestone = milestone ?? existingIssue?.milestone?.title ?? null;
    if (!finalMilestone) {
        throw new ManagerError("missing-milestone", "item requires a milestone, supplied or already present");
    }
    if ((await milestoneNumberFor(ctx, finalMilestone)) === null) {
        throw new ManagerError("missing-milestone", `milestone does not exist: ${finalMilestone}`);
    }
    const finalValues = {
        Status: fields.status ?? existingItem?.values.get("Status")?.optionName ?? null,
        Priority: fields.priority ?? existingItem?.values.get("Priority")?.optionName ?? null,
        Size: fields.size ?? existingItem?.values.get("Size")?.optionName ?? null,
        Estimate: fields.estimate ??
            (existingItem?.values.get("Estimate")?.number !== undefined
                ? String(existingItem.values.get("Estimate")?.number)
                : null),
        Iteration: fields.iteration ?? existingItem?.values.get("Iteration")?.iterationTitle ?? null,
    };
    const missingFinalValues = Object.entries(finalValues)
        .filter(([, value]) => value === null)
        .map(([name]) => name);
    if (missingFinalValues.length > 0) {
        throw new ManagerError("missing-item-values", `item would remain incomplete; supply: ${missingFinalValues.join(", ")}`);
    }
    if (existingItem?.statusName === APPROVED &&
        fields.status !== null &&
        fields.status !== APPROVED &&
        !(reset && parseConfirmation(reset, "RESET-APPROVAL", existingIssue?.number ?? 0))) {
        throw new ManagerError("reset-approval-required", `clearing Approved requires --reset RESET-APPROVAL:${existingIssue?.number}`);
    }
    for (const [fieldName, value] of [["Status", finalValues.Status], ["Priority", finalValues.Priority], ["Size", finalValues.Size]]) {
        const existingField = snapshot.fields.find((field) => field.name === fieldName);
        const required = REQUIRED_SCHEMA.find((field) => field.name === fieldName)?.options ?? [];
        const available = new Set([...(existingField?.options ?? []).map((option) => option.name), ...required]);
        if (value !== null && !available.has(value)) {
            throw new ManagerError("no-option", `field ${fieldName} has no option ${value}`);
        }
    }
    if (!Number.isFinite(Number(finalValues.Estimate))) {
        throw new ManagerError("bad-estimate", "--estimate must be a number");
    }
    const iterationField = snapshot.fields.find((field) => field.name === "Iteration");
    if (iterationField && finalValues.Iteration && !(iterationField.iterations ?? []).some((iteration) => iteration.title === finalValues.Iteration)) {
        throw new ManagerError("no-iteration", `Iteration field has no iteration titled ${finalValues.Iteration}`);
    }
    const plan = {
        issue: issueOpt ? Number.parseInt(issueOpt, 10) : null,
        title,
        milestone: finalMilestone,
        fields,
        parent: parentNumber,
        blockedBy,
        labels,
        assignees,
        confirm: confirm ?? null,
        reset: reset ?? null,
        schema: schemaPlan,
    };
    if (ctx.dryRun) {
        return { command: "item", dryRun: true, plan };
    }
    ctx.journal.record("planned", `item:${title ?? issueOpt}`, JSON.stringify(plan));
    let issueNumber = 0;
    let issueNodeId = "";
    let ready = snapshot;
    const steps = [];
    steps.push({
        name: "ensure-schema",
        run: async () => {
            ready = await ensureSchema(ctx, snapshot, iterationInputs);
        },
        verify: async () => schemaSatisfied(planSchema((await resolveProject(ctx.client, ctx.project)).fields)),
    });
    steps.push({
        name: "create-or-reconcile-issue",
        run: async () => {
            const issue = await ensureIssue(ctx, {
                issueNumber: issueNumberOpt,
                title,
                body: nullableOpt(ctx.opts, "body"),
                milestone: finalMilestone,
                labels,
                assignees,
            });
            issueNumber = issue.number;
            issueNodeId = issue.nodeId;
        },
        verify: async () => {
            if (issueNumber === 0)
                return false;
            const issue = await getIssue(ctx, issueNumber);
            const labelsOk = labels.every((label) => issue.labels.includes(label));
            const assigneesOk = assignees.every((assignee) => issue.assignees.includes(assignee));
            const body = nullableOpt(ctx.opts, "body");
            const bodyOk = body === null || issue.body === body;
            return issue.milestone?.title === finalMilestone && labelsOk && assigneesOk && bodyOk;
        },
    });
    steps.push({
        name: "add-to-project",
        run: async () => {
            if (!(await findProjectItem(ctx.client, ctx.project, issueNumber, ctx.repo.nwo))) {
                await addIssueToProject(ctx.client, ready.id, issueNodeId);
            }
        },
        verify: async () => (await findProjectItem(ctx.client, ctx.project, issueNumber, ctx.repo.nwo)) !== null,
    });
    // Single-select + number + iteration field values.
    const singleSelects = [
        ["Status", fields.status],
        ["Priority", fields.priority],
        ["Size", fields.size],
    ];
    for (const [fieldName, value] of singleSelects) {
        if (!value)
            continue;
        steps.push({
            name: `set-${fieldName}:${value}`,
            run: async () => {
                const field = fieldByName(ready, fieldName);
                const optId = optionIdFor(field, value);
                await setItemFieldConcurrent(ctx, ready.id, issueNumber, field.id, { singleSelectOptionId: optId }, (it) => it.values.get(fieldName)?.optionName === value);
            },
            verify: async () => {
                const it = await findProjectItem(ctx.client, ctx.project, issueNumber, ctx.repo.nwo);
                return it?.values.get(fieldName)?.optionName === value;
            },
        });
    }
    if (fields.estimate) {
        const estimate = Number(fields.estimate);
        if (!Number.isFinite(estimate)) {
            throw new ManagerError("bad-estimate", "--estimate must be a number");
        }
        steps.push({
            name: `set-Estimate:${estimate}`,
            run: async () => {
                const field = fieldByName(ready, "Estimate");
                await setItemFieldConcurrent(ctx, ready.id, issueNumber, field.id, { number: estimate }, (it) => it.values.get("Estimate")?.number === estimate);
            },
            verify: async () => {
                const it = await findProjectItem(ctx.client, ctx.project, issueNumber, ctx.repo.nwo);
                return it?.values.get("Estimate")?.number === estimate;
            },
        });
    }
    if (fields.iteration) {
        const iterationName = fields.iteration;
        steps.push({
            name: `set-Iteration:${iterationName}`,
            run: async () => {
                const field = fieldByName(ready, "Iteration");
                const iterId = iterationIdFor(field, iterationName);
                await setItemFieldConcurrent(ctx, ready.id, issueNumber, field.id, { iterationId: iterId }, (it) => it.values.get("Iteration")?.iterationTitle === iterationName);
            },
            verify: async () => {
                const it = await findProjectItem(ctx.client, ctx.project, issueNumber, ctx.repo.nwo);
                return it?.values.get("Iteration")?.iterationTitle === iterationName;
            },
        });
    }
    // Native parent (sub-issue) relation.
    if (parentNumber !== null) {
        steps.push({
            name: `set-parent:${parentNumber}`,
            run: async () => {
                const child = await getIssue(ctx, issueNumber);
                await ctx.client.rest("POST", `/repos/${ctx.repo.nwo}/issues/${parentNumber}/sub_issues`, { sub_issue_id: child.id });
            },
            verify: async () => {
                const subs = await ctx.client.restPaginate(`/repos/${ctx.repo.nwo}/issues/${parentNumber}/sub_issues?per_page=100`);
                return subs.some((s) => toIssueRecord(s)?.number === issueNumber);
            },
        });
    }
    // Native blocked-by dependencies (repeatable).
    for (const blockerNumber of blockedBy) {
        steps.push({
            name: `blocked-by:${blockerNumber}`,
            run: async () => {
                const blocker = await getIssue(ctx, blockerNumber);
                await ctx.client.rest("POST", `/repos/${ctx.repo.nwo}/issues/${issueNumber}/dependencies/blocked_by`, { issue_id: blocker.id });
            },
            verify: async () => {
                const deps = await ctx.client.restPaginate(`/repos/${ctx.repo.nwo}/issues/${issueNumber}/dependencies/blocked_by?per_page=100`);
                return deps.some((d) => toIssueRecord(d)?.number === blockerNumber);
            },
        });
    }
    const result = await runOrderedSteps(steps, ctx.journal);
    let applied = result.ok;
    if (applied) {
        const [finalIssue, finalItem] = await Promise.all([
            getIssue(ctx, issueNumber),
            findProjectItem(ctx.client, ctx.project, issueNumber, ctx.repo.nwo),
        ]);
        const complete = finalIssue.milestone?.title === finalMilestone &&
            finalItem !== null &&
            missingRequiredItemValues(finalItem).length === 0;
        if (!complete) {
            ctx.journal.record("failed", `item-compliance:${issueNumber}`, "final item is incomplete");
            applied = false;
        }
        else {
            ctx.journal.record("verified", `item-compliance:${issueNumber}`);
        }
    }
    return { command: "item", dryRun: false, applied, issue: issueNumber, plan };
}
async function runItemConfirmation(ctx, snapshot, issueOpt, confirm) {
    const parsed = splitConfirmation(confirm);
    if (!parsed || (parsed.kind !== "ARCHIVE" && parsed.kind !== "DELETE")) {
        throw new ManagerError("confirmation", "expected --confirm ARCHIVE:N or DELETE:N");
    }
    if (!issueOpt) {
        throw new ManagerError("confirmation", "archive/delete require --issue N");
    }
    const issueNumber = Number.parseInt(issueOpt, 10);
    if (parsed.issue !== issueNumber || confirm !== `${parsed.kind}:${issueNumber}`) {
        throw new ManagerError("confirmation", `confirmation must name issue #${issueNumber} exactly`);
    }
    const item = await findProjectItem(ctx.client, ctx.project, issueNumber, ctx.repo.nwo);
    if (!item) {
        throw new ManagerError("not-in-project", `issue #${issueNumber} is not a Project item`);
    }
    ctx.journal.record("planned", `${parsed.kind.toLowerCase()}:${issueNumber}`, item.id);
    const steps = [
        {
            name: `${parsed.kind.toLowerCase()}-item:${issueNumber}`,
            run: async () => {
                if (parsed.kind === "ARCHIVE") {
                    await archiveProjectV2Item(ctx.client, snapshot.id, item.id);
                }
                else {
                    // Deletes the Project item only; the repository issue is never deleted.
                    await deleteProjectV2Item(ctx.client, snapshot.id, item.id);
                }
            },
            verify: async () => {
                const [active, archived] = await Promise.all([
                    findProjectItem(ctx.client, ctx.project, issueNumber, ctx.repo.nwo, ["NOT_ARCHIVED"]),
                    findProjectItem(ctx.client, ctx.project, issueNumber, ctx.repo.nwo, ["ARCHIVED"]),
                ]);
                return parsed.kind === "DELETE"
                    ? active === null && archived === null
                    : active === null && archived !== null;
            },
        },
    ];
    const result = await runOrderedSteps(steps, ctx.journal);
    return {
        command: "item",
        dryRun: false,
        action: parsed.kind.toLowerCase(),
        issue: issueNumber,
        applied: result.ok,
    };
}
/** Create or reconcile the repository issue, avoiding duplicate titles. */
async function ensureIssue(ctx, spec) {
    const milestoneNumber = spec.milestone
        ? await milestoneNumberFor(ctx, spec.milestone)
        : null;
    const payload = {};
    if (spec.title)
        payload["title"] = spec.title;
    if (spec.body !== null)
        payload["body"] = spec.body;
    if (milestoneNumber !== null)
        payload["milestone"] = milestoneNumber;
    if (spec.labels.length > 0)
        payload["labels"] = spec.labels;
    if (spec.assignees.length > 0)
        payload["assignees"] = spec.assignees;
    if (spec.issueNumber !== null) {
        await ctx.client.rest("PATCH", `/repos/${ctx.repo.nwo}/issues/${spec.issueNumber}`, payload);
        const issue = await getIssue(ctx, spec.issueNumber);
        return { number: issue.number, nodeId: issue.nodeId };
    }
    // Reconcile by title across all pages before creating, to avoid duplicates.
    const issues = await listIssues(ctx);
    const match = issues.find((i) => i.title === spec.title);
    if (match) {
        await ctx.client.rest("PATCH", `/repos/${ctx.repo.nwo}/issues/${match.number}`, payload);
        const issue = await getIssue(ctx, match.number);
        return { number: issue.number, nodeId: issue.nodeId };
    }
    if (!("body" in payload))
        payload["body"] = "";
    const created = await ctx.client.rest("POST", `/repos/${ctx.repo.nwo}/issues`, payload);
    const rec = toIssueRecord(created.json);
    if (!rec)
        throw new ManagerError("issue", "created issue lacked a number");
    return { number: rec.number, nodeId: rec.nodeId };
}
// --------------------------------------------------------------------------
// Command: status
// --------------------------------------------------------------------------
async function cmdStatus(ctx) {
    const issue = parsePositiveInt(requireOpt(ctx.opts, "issue"), "issue");
    const value = requireOpt(ctx.opts, "value");
    refuseApproved(value);
    const reset = singleOpt(ctx.opts, "reset");
    await verifyAccess(ctx, true);
    const snapshot = await resolveProject(ctx.client, ctx.project);
    const current = await findProjectItem(ctx.client, ctx.project, issue, ctx.repo.nwo);
    if (!current)
        throw new ManagerError("not-in-project", `issue #${issue} is not a Project item`);
    const currentlyApproved = current?.statusName === APPROVED;
    const statusSchema = snapshot.fields.find((field) => field.name === "Status");
    if (statusSchema && statusSchema.dataType !== "SINGLE_SELECT") {
        throw new ManagerError("schema-collision", "field Status must be SINGLE_SELECT");
    }
    const availableStatus = new Set([
        ...(statusSchema?.options ?? []).map((option) => option.name),
        IN_REVIEW,
        APPROVED,
    ]);
    if (!availableStatus.has(value))
        throw new ManagerError("no-option", `Status has no option ${value}`);
    const plan = { issue, value, currentStatus: current?.statusName ?? "N/A" };
    // Clearing an observed Approved requires the exact reset confirmation.
    if (currentlyApproved && !(reset && parseConfirmation(reset, "RESET-APPROVAL", issue))) {
        throw new ManagerError("reset-approval-required", `clearing Approved requires --reset RESET-APPROVAL:${issue}`);
    }
    // A reset confirmation supplied when the item is not Approved authorizes
    // nothing and would be silently ignored — fail closed instead.
    if (reset !== null && !currentlyApproved) {
        throw new ManagerError("confirmation", `--reset was supplied but issue #${issue} is not Approved; nothing to reset`);
    }
    if (ctx.dryRun) {
        return { command: "status", dryRun: true, plan };
    }
    ctx.journal.record("planned", `status:${issue}`, JSON.stringify(plan));
    let ready = snapshot;
    const steps = [
        {
            name: "ensure-status-schema",
            run: async () => {
                ready = await ensureSchema(ctx, snapshot, {});
            },
            verify: async () => {
                const field = (await resolveProject(ctx.client, ctx.project)).fields.find((candidate) => candidate.name === "Status");
                const options = new Set((field?.options ?? []).map((option) => option.name));
                return field?.dataType === "SINGLE_SELECT" && options.has(IN_REVIEW) && options.has(APPROVED);
            },
        },
        {
            name: `set-status:${issue}`,
            run: async () => {
                const statusField = fieldByName(ready, "Status");
                const optId = optionIdFor(statusField, value);
                await setItemFieldConcurrent(ctx, ready.id, issue, statusField.id, { singleSelectOptionId: optId }, (it) => it.statusName === value);
            },
            verify: async () => {
                const it = await findProjectItem(ctx.client, ctx.project, issue, ctx.repo.nwo);
                return it?.statusName === value;
            },
        },
    ];
    const result = await runOrderedSteps(steps, ctx.journal);
    return { command: "status", dryRun: false, applied: result.ok, plan };
}
// --------------------------------------------------------------------------
// Command: hr
// --------------------------------------------------------------------------
async function cmdHr(ctx) {
    const issue = parsePositiveInt(requireOpt(ctx.opts, "issue"), "issue");
    const mode = requireOpt(ctx.opts, "mode");
    if (mode !== "decision" && mode !== "action") {
        throw new ManagerError("bad-mode", "--mode must be decision or action");
    }
    const request = requireOpt(ctx.opts, "request");
    const reset = singleOpt(ctx.opts, "reset");
    await verifyAccess(ctx, true);
    const snapshot = await resolveProject(ctx.client, ctx.project);
    const current = await findProjectItem(ctx.client, ctx.project, issue, ctx.repo.nwo);
    if (!current)
        throw new ManagerError("not-in-project", `issue #${issue} is not a Project item`);
    const approved = current?.statusName === APPROVED;
    const statusSchema = snapshot.fields.find((field) => field.name === "Status");
    if (statusSchema && statusSchema.dataType !== "SINGLE_SELECT") {
        throw new ManagerError("schema-collision", "field Status must be SINGLE_SELECT");
    }
    const plan = { issue, mode, request, currentStatus: current?.statusName ?? "N/A" };
    // Moving to In Review would reset an observed Approved: require confirmation.
    if (approved && !(reset && parseConfirmation(reset, "RESET-APPROVAL", issue))) {
        throw new ManagerError("reset-approval-required", `moving an Approved item to In Review requires --reset RESET-APPROVAL:${issue}`);
    }
    // A reset confirmation supplied when the item is not Approved authorizes
    // nothing and would be silently ignored — fail closed instead.
    if (reset !== null && !approved) {
        throw new ManagerError("confirmation", `--reset was supplied but issue #${issue} is not Approved; nothing to reset`);
    }
    if (ctx.dryRun) {
        return { command: "hr", dryRun: true, plan };
    }
    ctx.journal.record("planned", `hr:${issue}`, JSON.stringify(plan));
    let ready = snapshot;
    let commentId = 0;
    const commentBody = hrCommentBody(mode, request);
    const steps = [
        {
            name: "ensure-status-schema",
            run: async () => {
                ready = await ensureSchema(ctx, snapshot, {});
            },
            verify: async () => {
                const field = (await resolveProject(ctx.client, ctx.project)).fields.find((candidate) => candidate.name === "Status");
                const options = new Set((field?.options ?? []).map((option) => option.name));
                return field?.dataType === "SINGLE_SELECT" && options.has(IN_REVIEW) && options.has(APPROVED);
            },
        },
        {
            name: `comment:${issue}`,
            run: async () => {
                commentId = await postComment(ctx, issue, commentBody);
            },
            verify: () => commentMatches(ctx, commentId, commentBody),
        },
        {
            name: `set-status:${issue}`,
            run: async () => {
                const statusField = fieldByName(ready, "Status");
                const inReviewOpt = optionIdFor(statusField, IN_REVIEW);
                await setItemFieldConcurrent(ctx, ready.id, issue, statusField.id, { singleSelectOptionId: inReviewOpt }, (it) => it.statusName === IN_REVIEW);
            },
            verify: async () => {
                const it = await findProjectItem(ctx.client, ctx.project, issue, ctx.repo.nwo);
                return it?.statusName === IN_REVIEW;
            },
        },
    ];
    const result = await runOrderedSteps(steps, ctx.journal);
    return { command: "hr", dryRun: false, applied: result.ok, plan };
}
function hrCommentBody(mode, request) {
    const header = mode === "decision" ? "Human Review (decision)" : "Human Review (action)";
    return `## ${header}\n\n${request}\n`;
}
async function postComment(ctx, issue, body) {
    const response = await ctx.client.rest("POST", `/repos/${ctx.repo.nwo}/issues/${issue}/comments`, { body });
    const id = response.json && typeof response.json === "object"
        ? response.json["id"]
        : undefined;
    if (typeof id !== "number")
        throw new ManagerError("comment", "created comment lacked an id");
    return id;
}
async function commentMatches(ctx, id, body) {
    if (id <= 0)
        return false;
    const response = await ctx.client.rest("GET", `/repos/${ctx.repo.nwo}/issues/comments/${id}`);
    return Boolean(response.json &&
        typeof response.json === "object" &&
        response.json["body"] === body);
}
// --------------------------------------------------------------------------
// Command: true-up
// --------------------------------------------------------------------------
async function cmdTrueUp(ctx) {
    const milestone = requireOpt(ctx.opts, "milestone");
    const preferredIteration = nullableOpt(ctx.opts, "iteration");
    await verifyAccess(ctx, true);
    const snapshot = await resolveProject(ctx.client, ctx.project);
    if (!schemaSatisfied(planSchema(snapshot.fields))) {
        throw new ManagerError("schema-incomplete", "run reconcile/install before true-up");
    }
    if ((await milestoneNumberFor(ctx, milestone)) === null) {
        throw new ManagerError("missing-milestone", `milestone does not exist: ${milestone}`);
    }
    const iterationTitle = selectTrueUpIteration(snapshot, preferredIteration, ctx.deps.now());
    const inventory = await listRepoIssues(ctx);
    const issues = inventory.filter((rec) => !rec.isPull);
    const items = await resolveProjectItems(ctx.client, ctx.project);
    const repoItems = items.filter((i) => i.repoNwo === ctx.repo.nwo);
    const closedTrueUps = issues.filter((i) => trueUpNumber(i.title) !== null && i.state === "closed");
    const lastClosedMs = closedTrueUps.reduce((acc, i) => {
        if (!i.closed_at)
            return acc;
        const ms = Date.parse(i.closed_at);
        if (Number.isNaN(ms))
            return acc;
        return acc === null || ms > acc ? ms : acc;
    }, null);
    const due = isTrueUpDue(lastClosedMs, ctx.deps.now());
    const openTrueUps = issues.filter((i) => trueUpNumber(i.title) !== null && i.state === "open");
    if (openTrueUps.length > 1) {
        throw new ManagerError("true-up-collision", "multiple open true-up issues exist");
    }
    const next = maxTrueUpNumber(issues.map((i) => i.title)) + 1;
    const compliance = await itemComplianceReport(ctx);
    const violations = compliance.filter((report) => !report.compliant);
    const { pullRequests, pullRequestsOk } = await pullRequestComplianceReport(ctx, {
        repoItems,
        inventory,
    });
    const unmappedPullRequests = pullRequests.filter((report) => !report.compliant);
    // Is an open true-up already Approved by a human?
    const openTrueUp = openTrueUps[0] ?? null;
    const openTrueUpItem = openTrueUp
        ? repoItems.find((item) => item.issueNumber === openTrueUp.number) ?? null
        : null;
    const approvedOpen = openTrueUp && openTrueUpItem?.statusName === APPROVED
        ? openTrueUp
        : null;
    const plan = {
        due,
        openTrueUps: openTrueUps.map((i) => i.number),
        nextNumber: next,
        violations,
        pullRequests,
        pullRequestsOk,
        unmappedPullRequests: unmappedPullRequests.map((report) => report.number),
        approvedOpen: approvedOpen?.number ?? null,
        milestone,
        iteration: iterationTitle,
    };
    if (ctx.dryRun) {
        return { command: "true-up", dryRun: true, plan };
    }
    ctx.journal.record("planned", "true-up", JSON.stringify(plan));
    const steps = [];
    // Record each violation by comment + HR, never resetting Approved silently.
    for (const v of violations) {
        const issueNumber = v.issue;
        const item = repoItems.find((candidate) => candidate.issueNumber === issueNumber) ?? null;
        const isApproved = item?.statusName === APPROVED;
        const detail = [
            !v.inProject ? "missing Project item" : null,
            v.milestone === "N/A" ? "missing milestone" : null,
            ...v.missingCustomValues.map((name) => `missing ${name}`),
        ].filter((value) => value !== null).join(", ");
        const body = hrCommentBody("action", `True-up audit: ${detail}. Correct the item; Human Review is requested. Status is not changed automatically${isApproved ? " because it is Approved" : ""}.`);
        let commentId = 0;
        steps.push({
            name: `violation-comment:${issueNumber}`,
            run: async () => {
                commentId = await postComment(ctx, issueNumber, body);
            },
            verify: () => commentMatches(ctx, commentId, body),
        });
        if (item && !isApproved) {
            // Move to In Review only when not Approved (no silent Approved reset).
            steps.push({
                name: `violation-in-review:${issueNumber}`,
                run: async () => {
                    const statusField = fieldByName(snapshot, "Status");
                    const inReviewOpt = optionIdFor(statusField, IN_REVIEW);
                    await setItemFieldConcurrent(ctx, snapshot.id, issueNumber, statusField.id, { singleSelectOptionId: inReviewOpt }, (it) => it.statusName === IN_REVIEW);
                },
                verify: async () => {
                    const it = await findProjectItem(ctx.client, ctx.project, issueNumber, ctx.repo.nwo);
                    return it?.statusName === IN_REVIEW;
                },
            });
        }
    }
    // Unmapped repo pull requests are surfaced by an Action-HR comment on the PR
    // itself (a PR accepts issue comments), never by touching an unrelated issue
    // and never by manufacturing In Review on a nonexistent Project issue.
    for (const pr of unmappedPullRequests) {
        const body = hrCommentBody("action", `True-up audit: pull request #${pr.number} (${pr.title}) is not linked from any Issue-backed Project item's "Linked pull requests". Link it to a governed Project item; Human Review is requested. No Project status is changed.`);
        let commentId = 0;
        steps.push({
            name: `pull-request-comment:${pr.number}`,
            run: async () => {
                commentId = await postComment(ctx, pr.number, body);
            },
            verify: () => commentMatches(ctx, commentId, body),
        });
    }
    if (approvedOpen && violations.length === 0 && pullRequestsOk) {
        // Human approved the current true-up and this audit is clean: close and advance.
        const approvedNumber = approvedOpen.number;
        steps.push({
            name: `close-true-up:${approvedNumber}`,
            run: async () => {
                const currentItem = await findProjectItem(ctx.client, ctx.project, approvedNumber, ctx.repo.nwo);
                const currentIssue = await getIssue(ctx, approvedNumber);
                if (!currentItem ||
                    currentIssue.body !== decodePayload("PROJECT-BOARD-LAW.md").toString("utf8") ||
                    !currentIssue.milestone?.title ||
                    missingRequiredItemValues(currentItem).length > 0) {
                    throw new ManagerError("true-up-incomplete", "approved true-up did not pass final audit verification");
                }
                await ctx.client.rest("PATCH", `/repos/${ctx.repo.nwo}/issues/${approvedNumber}`, { state: "closed" });
            },
            verify: async () => (await getIssue(ctx, approvedNumber)).state === "closed",
        });
        steps.push({
            name: `create-true-up:#${next}`,
            run: () => createTrueUpIssue(ctx, next, milestone, snapshot, iterationTitle),
            verify: () => verifyExactlyOneOpenTrueUp(ctx),
        });
    }
    else if (openTrueUps.length === 0) {
        // Missing next true-up is repaired on the first authorized run, even before due.
        steps.push({
            name: `create-true-up:#${next}`,
            run: () => createTrueUpIssue(ctx, next, milestone, snapshot, iterationTitle),
            verify: () => verifyExactlyOneOpenTrueUp(ctx),
        });
    }
    const result = await runOrderedSteps(steps, ctx.journal);
    return { command: "true-up", dryRun: false, applied: result.ok, plan, pullRequestsOk };
}
// --------------------------------------------------------------------------
// Dispatch + main
// --------------------------------------------------------------------------
function parsePositiveInt(value, label) {
    const n = Number.parseInt(value, 10);
    if (!Number.isInteger(n) || n <= 0 || String(n) !== value) {
        throw new ManagerError(`bad-${label}`, `--${label} must be a positive integer`);
    }
    return n;
}
const HANDLERS = {
    inspect: cmdInspect,
    reconcile: cmdReconcile,
    install: cmdInstall,
    item: cmdItem,
    status: cmdStatus,
    hr: cmdHr,
    "true-up": cmdTrueUp,
    milestone: cmdMilestone,
};
function isCommand(value) {
    return COMMANDS.includes(value);
}
/**
 * Program entry. Returns a process exit code and never throws: all failures are
 * fail-closed, sanitised of the token, and emitted as JSON. `main` runs only
 * when the module is executed directly so tests can import these helpers.
 */
export async function main(argv, overrides) {
    const deps = { ...defaultDeps(), ...overrides };
    let token;
    try {
        const parsed = parseArgv(argv);
        if (!parsed.command) {
            throw new ManagerError("no-command", `expected one of: ${COMMANDS.join(", ")}`);
        }
        if (!isCommand(parsed.command)) {
            throw new ManagerError("bad-command", `unknown command: ${parsed.command}`);
        }
        for (const key of Object.keys(parsed.opts)) {
            if (!GLOBAL_OPTIONS.has(key) && !COMMAND_OPTIONS[parsed.command].has(key)) {
                throw new ManagerError("unknown-option", `--${key} is not an option of ${parsed.command}; a supplied option is never silently ignored`);
            }
        }
        const ctx = buildContext(parsed, deps);
        token = ctx.token;
        const result = await HANDLERS[parsed.command](ctx);
        if (parsed.command === "inspect" &&
            result &&
            typeof result === "object" &&
            "compliant" in result &&
            result.compliant === false) {
            deps.stdout(JSON.stringify(result));
            return 2;
        }
        if (result &&
            typeof result === "object" &&
            "applied" in result &&
            result.applied === false) {
            throw new ManagerError("write-failed", JSON.stringify(result));
        }
        deps.stdout(JSON.stringify(result));
        return 0;
    }
    catch (err) {
        const code = err instanceof ManagerError ? err.code : "error";
        const raw = err instanceof Error ? err.message : String(err);
        deps.stderr(JSON.stringify({ error: code, message: redactToken(raw, token) }));
        return 1;
    }
}
function isDirectRun() {
    const entry = process.argv[1];
    if (!entry)
        return false;
    try {
        return import.meta.url === pathToFileURL(entry).href;
    }
    catch {
        return false;
    }
}
if (isDirectRun()) {
    main(process.argv.slice(2)).then((code) => {
        process.exitCode = code;
    }, (err) => {
        process.stderr.write(`${JSON.stringify({ error: "fatal", message: errText(err) })}\n`);
        process.exitCode = 1;
    });
}
