/** Small, dependency-free helpers shared across layers. */

export { loadEnv, parseEnv } from "./env";

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    !(v instanceof Date) &&
    !Buffer.isBuffer(v)
  );
}

export function isEmptyObject(v: unknown): boolean {
  return isPlainObject(v) && Object.keys(v).length === 0;
}

export function uniq<T>(items: T[]): T[] {
  return [...new Set(items)];
}

export function pascalCase(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-zA-Z0-9]+(.)?/g, (_, c: string | undefined) =>
      c ? c.toUpperCase() : "",
    )
    .replace(/^(.)/, (_, c: string) => c.toUpperCase());
}

export function camelCase(input: string): string {
  const pascal = pascalCase(input);
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

export function pluralize(word: string): string {
  if (/[^aeiou]y$/i.test(word)) return word.replace(/y$/i, "ies");
  if (/(s|x|z|ch|sh)$/i.test(word)) return `${word}es`;
  return `${word}s`;
}

/** First char lowercased — used to derive delegate names from model names. */
export function lowerFirst(input: string): string {
  return input.charAt(0).toLowerCase() + input.slice(1);
}

export function indent(text: string, level = 1, unit = "  "): string {
  const pad = unit.repeat(level);
  return text
    .split("\n")
    .map((l) => (l.length > 0 ? pad + l : l))
    .join("\n");
}

export function assertNever(value: never, message = "Unexpected value"): never {
  throw new Error(`${message}: ${JSON.stringify(value)}`);
}
