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
// Keep this in sync with the AGENTS.md "Load Triggers" section. The count includes
// the vendored PROJECT-BOARD-LAW.md canonical law at the repository root.
const EXPECTED_NON_AGENTS_MARKDOWN = 25;

const root = process.cwd();
const failures = [];
let markdownCount = 0;
let nonAgentsMarkdownCount = 0;

function rel(file) {
  return path.relative(root, file).split(path.sep).join('/');
}

function stripManagedBlock(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex(
    (line) => /subagent-mcp/i.test(line) && /(managed block|invariant)/i.test(line),
  );

  if (start === -1) return text;

  const end = lines.findIndex(
    (line, index) => index >= start && /end/i.test(line) && /managed block/i.test(line),
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
    if (basename !== 'AGENTS.md') nonAgentsMarkdownCount += 1;
    // AGENTS.md carries the byte-zero PROJECT-BOARD-LAW managed block, so it
    // shares the single 24000-byte cap applied to every governed .md doc.
    const limit = 24000;
    if (buffer.length > limit) {
      failures.push(`FAIL ${rel(file)}: ${buffer.length} bytes exceeds ${limit} byte limit`);
    }
  }

  if (POINTER_FILES.has(basename)) {
    const expected = POINTER_TEMPLATE.replace('{BASENAME}', basename).trim();
    const actual = stripManagedBlock(buffer.toString('utf8').replace(/\r\n/g, '\n')).trim();
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

if (nonAgentsMarkdownCount !== EXPECTED_NON_AGENTS_MARKDOWN) {
  failures.push(
    `FAIL load-trigger coverage: found ${nonAgentsMarkdownCount} non-AGENTS markdown docs, ` +
      `expected ${EXPECTED_NON_AGENTS_MARKDOWN} (one Load Trigger each in AGENTS.md)`,
  );
}

if (failures.length) {
  console.log(failures.join('\n'));
  process.exit(1);
}

console.log(
  `md-policy: OK (${markdownCount} markdown files checked; ` +
    `${nonAgentsMarkdownCount}/${EXPECTED_NON_AGENTS_MARKDOWN} non-AGENTS docs)`,
);
