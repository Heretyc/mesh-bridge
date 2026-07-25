export type Redactor = (text: string) => string;

export function makeRedactor(secrets: string[]): Redactor {
  const tokens = [...new Set(secrets.map((secret) => secret.trim()).filter((secret) => secret.length >= 8))]
    .sort((left, right) => right.length - left.length);
  if (tokens.length === 0) return (text) => text;
  return (text) => tokens.reduce((current, token) => current.split(token).join("[REDACTED]"), text);
}

export function redactRecord<T>(record: T, redact: Redactor): T {
  if (typeof record === "string") return redact(record) as T;
  if (Array.isArray(record)) return record.map((item) => redactRecord(item, redact)) as T;
  if (record && typeof record === "object") {
    return Object.fromEntries(
      Object.entries(record).map(([key, value]) => [key, redactRecord(value, redact)]),
    ) as T;
  }
  return record;
}
