// Pre-flight markdown policy check. Limits are bytes per wc -c.
// Run from repo root: node scripts/check-md-policy.mjs
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const POINTER_FILES = new Set([
  'CLAUDE.md',
  'GEMINI.md',
  'codex.md',
  'copilot-instructions.md',
  '.cursorrules',
  '.windsurfrules',
]);

const POINTER_TEMPLATE = `# {BASENAME} — read-only pointer

This file is read-only. Do not add, edit, or remove directives here.
\`AGENTS.md\` is the single canonical instruction file for this repository;
read it first. Anything that would otherwise reside in this file must be
placed in \`AGENTS.md\` or in an in-repo doc wired back to \`AGENTS.md\` via a
Load Trigger. The only permitted exception is a tool-managed subagent-mcp
managed block, which must be preserved verbatim when present.`;

// One Load Trigger is registered in AGENTS.md for every non-AGENTS Markdown doc.
// Keep this in sync with the AGENTS.md "Load Triggers" section.
const EXPECTED_NON_AGENTS_MARKDOWN = new Set([
  '.github/PULL_REQUEST_TEMPLATE.md',
  '.github/copilot-instructions.md',
  'agents/GIT_COLLABORATION.md',
  'CLAUDE.md',
  'docs/CONTRIBUTING.md',
  'docs/spec/dev-loop/_INDEX.md',
  'docs/spec/dev-loop/claude-routine-prompt.md',
  'docs/spec/dev-loop/claude-routines-cicd.md',
  'docs/spec/dev-loop/git-collaboration.md',
  'docs/spec/memory-policy.md',
  'docs/spec/prompt-review/eight-perspective-review.md',
  'docs/spec/safety-scope/00-scope-and-cascade.md',
  'docs/spec/safety-scope/01-question-flow.md',
  'docs/spec/safety-scope/02-debug-and-credentials.md',
  'docs/spec/safety-scope/03-subagents-platforms.md',
  'docs/spec/safety-scope.md',
  'GEMINI.md',
  'README.md',
]);

const root = process.cwd();
const failures = [];
let markdownCount = 0;
const nonAgentsMarkdown = new Set();

function rel(file) {
  return path.relative(root, file).split(path.sep).join('/');
}

function stripManagedBlock(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) =>
    line.includes('<!-- subagent-mcp:managed:begin'),
  );

  if (start === -1) return text;

  const end = lines.findIndex((line, index) =>
    index >= start && line.includes('<!-- subagent-mcp:managed:end'),
  );

  lines.splice(start, end === -1 ? lines.length - start : end - start + 1);
  return lines.join('\n');
}

function checkFile(file) {
  const basename = path.basename(file);
  const buffer = fs.readFileSync(file);
  const isMarkdown = basename === 'AGENTS.md' || path.extname(file) === '.md';

  if (isMarkdown) {
    markdownCount += 1;
    if (basename !== 'AGENTS.md') nonAgentsMarkdown.add(rel(file));
    const limit = 24000;
    if (buffer.length > limit) {
      failures.push(`FAIL ${rel(file)}: ${buffer.length} bytes exceeds ${limit} byte limit`);
    }
  }

  if (POINTER_FILES.has(basename)) {
    const expected = POINTER_TEMPLATE.replace('{BASENAME}', basename).trim();
    const actual = stripManagedBlock(buffer.toString('utf8')).trim();
    if (actual !== expected) {
      failures.push(`FAIL ${rel(file)}: pointer file content is not canonical`);
    }
  }
}

function scan(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      // Scan `.github` (holds the Copilot pointer and PR-template Markdown);
      // still skip `.git` and any other hidden metadata directories.
      if (entry.name.startsWith('.') && entry.name !== '.github') continue;
      scan(fullPath);
      continue;
    }

    if (entry.isFile()) checkFile(fullPath);
  }
}

scan(root);

for (const file of EXPECTED_NON_AGENTS_MARKDOWN) {
  if (!nonAgentsMarkdown.has(file)) failures.push(`FAIL missing markdown doc: ${file}`);
}
for (const file of nonAgentsMarkdown) {
  if (!EXPECTED_NON_AGENTS_MARKDOWN.has(file)) {
    failures.push(`FAIL markdown doc lacks registered Load Trigger: ${file}`);
  }
}

const agentsText = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
const loadTriggers = agentsText.split(/^## Load Triggers\r?$/m)[1]?.split(/^## /m)[0] ?? '';
for (const file of EXPECTED_NON_AGENTS_MARKDOWN) {
  if (!loadTriggers.includes(`- \`${file}\`:`)) {
    failures.push(`FAIL AGENTS.md Load Triggers missing exact entry: ${file}`);
  }
}

if (failures.length) {
  console.log(failures.join('\n'));
  process.exit(1);
}

console.log(
  `md-policy: OK (${markdownCount} markdown files checked; ` +
    `${nonAgentsMarkdown.size}/${EXPECTED_NON_AGENTS_MARKDOWN.size} non-AGENTS docs)`,
);
