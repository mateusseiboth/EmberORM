import type { SqlValue } from "@ember/driver";

/**
 * An accumulating SQL fragment that keeps text and bound parameters together,
 * so values are always parameterized (`?`) and never string-interpolated.
 * This is the core defense against SQL injection in the query layer.
 */
export class Sql {
  private parts: string[] = [];
  public readonly params: SqlValue[] = [];

  static raw(text: string): Sql {
    return new Sql().push(text);
  }

  static value(value: SqlValue): Sql {
    return new Sql().bind(value);
  }

  static join(fragments: Sql[], separator: string): Sql {
    const out = new Sql();
    fragments.forEach((frag, i) => {
      if (i > 0) out.push(separator);
      out.append(frag);
    });
    return out;
  }

  /** Append raw, trusted SQL text (keywords, already-escaped identifiers). */
  push(text: string): this {
    this.parts.push(text);
    return this;
  }

  /** Append a `?` placeholder bound to `value`. */
  bind(value: SqlValue): this {
    this.parts.push("?");
    this.params.push(value);
    return this;
  }

  /** Append a comma-separated list of placeholders bound to `values`. */
  bindList(values: readonly SqlValue[]): this {
    this.parts.push(values.map(() => "?").join(", "));
    this.params.push(...values);
    return this;
  }

  /** Merge another fragment (text + params) into this one. */
  append(other: Sql): this {
    this.parts.push(other.text);
    this.params.push(...other.params);
    return this;
  }

  get text(): string {
    return this.parts.join("");
  }

  isEmpty(): boolean {
    return this.text.trim().length === 0;
  }

  toQuery(): { sql: string; params: SqlValue[] } {
    return { sql: this.text, params: this.params };
  }
}
