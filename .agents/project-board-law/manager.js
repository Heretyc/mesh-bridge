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
export const ENV_FILE = ".agents/project-ci.env";
export const JOURNAL_PATH = ".agents/project-board-law/journal.ndjson";
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
    return { repoPrivate, repoNodeId: repoJson.node_id, scopes };
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
// Command: inspect (read-only, fail-closed compliance)
// --------------------------------------------------------------------------
async function cmdInspect(ctx) {
    await verifyAccess(ctx, false);
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
        const ok = present && ctx.deps.fs.readFileSync(abs).equals(decodePayload(target));
        if (!ok)
            payloadFilesOk = false;
        fileResults.push({ path: target, ok });
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
        nextTrueUpExists;
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
    if (!issue || issue.body === lawBody)
        return null;
    const expected = `REPLACE-TRUE-UP-BODY:${issue.number}`;
    const confirmations = allOpts(ctx.opts, "replace-true-up-body");
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
    // Materialise the AGENTS content up front so malformed markers fail closed.
    const agentsPath = join(ctx.deps.cwd, "AGENTS.md");
    const existingAgents = ctx.deps.fs.existsSync(agentsPath)
        ? ctx.deps.fs.readFileSync(agentsPath).toString("utf8")
        : null;
    const agentsContent = planAgentsContent(existingAgents, lawText);
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
        localSteps.push(writeAndVerify(target, decodePayload(target)));
    }
    localSteps.push(writeAndVerify(RUNTIME_MANAGER, ctx.deps.fs.readFileSync(selfManager)));
    localSteps.push(writeAndVerify(RUNTIME_PAYLOAD, ctx.deps.fs.readFileSync(selfPayload)));
    localSteps.push(writeAndVerify(RUNTIME_PACKAGE, NESTED_PACKAGE_JSON));
    localSteps.push(writeAndVerify("AGENTS.md", agentsContent));
    const gitignorePath = join(ctx.deps.cwd, ".gitignore");
    const existingIgnore = ctx.deps.fs.existsSync(gitignorePath)
        ? ctx.deps.fs.readFileSync(gitignorePath).toString("utf8")
        : null;
    localSteps.push(writeAndVerify(".gitignore", planGitignore(existingIgnore)));
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
    const confirm = nullableOpt(ctx.opts, "confirm");
    const reset = nullableOpt(ctx.opts, "reset");
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
    const existingIssue = issueNumberOpt !== null
        ? await getIssue(ctx, issueNumberOpt)
        : (await listIssues(ctx)).find((issue) => issue.title === title) ?? null;
    const existingItem = existingIssue
        ? await findProjectItem(ctx.client, ctx.project, existingIssue.number, ctx.repo.nwo)
        : null;
    // Destructive Project-item actions need only an exact target and confirmation;
    // an incomplete item must still be archivable/deletable. Validate these before
    // the normal item's milestone/schema completeness preflight.
    if (confirm !== null) {
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
    const reset = nullableOpt(ctx.opts, "reset");
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
    const reset = nullableOpt(ctx.opts, "reset");
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
