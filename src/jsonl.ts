import { appendFileSync, closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

export function atomicReplaceFile(path: string, data: string | Buffer): void {
  const temp = `${path}.tmp-${process.pid}`;
  let fd: number | undefined;
  try {
    fd = openSync(temp, "w", 0o600);
    writeFileSync(fd, data);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, path);
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    rmSync(temp, { force: true });
    throw error;
  }
}

export function readJsonlTolerant<T = unknown>(path: string): T[] {
  if (!existsSync(path)) return [];
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const records: T[] = [];
  for (const line of text.split(/\r?\n/u)) {
    if (!line) continue;
    try {
      records.push(JSON.parse(line) as T);
    } catch {
      // Malformed/torn JSONL lines are expected after interrupted appends.
    }
  }
  return records;
}

export function appendJsonl(path: string, record: unknown): void {
  appendFileSync(path, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
}
