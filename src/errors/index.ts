/** Base class for every error thrown by EmberORM. */
export class EmberError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Raised while lexing/parsing a `.ember` schema file. */
export class SchemaParseError extends EmberError {
  constructor(
    message: string,
    public readonly line: number,
    public readonly column: number,
    public readonly file?: string,
  ) {
    super(
      `${message} (at ${file ? `${file}:` : ""}${line}:${column})`,
    );
  }
}

/** Raised when a parsed schema is structurally invalid. */
export class SchemaValidationError extends EmberError {
  constructor(
    message: string,
    public readonly details: string[] = [],
  ) {
    super(
      details.length > 0 ? `${message}\n - ${details.join("\n - ")}` : message,
    );
  }
}

/** Raised when a query is malformed before it reaches the database. */
export class QueryValidationError extends EmberError {}

/** Wraps a low-level driver/database failure with EmberORM context. */
export class DatabaseError extends EmberError {
  constructor(
    message: string,
    public override readonly cause?: unknown,
    public readonly sql?: string,
  ) {
    super(message);
  }
}

/** Thrown by `*OrThrow` operations when no record matches. */
export class RecordNotFoundError extends EmberError {
  constructor(model: string) {
    super(`No '${model}' record found matching the given criteria.`);
  }
}

/** Thrown on unique constraint violations (mapped from Firebird errors). */
export class UniqueConstraintError extends EmberError {
  constructor(
    public readonly target: string,
    cause?: unknown,
  ) {
    super(`Unique constraint failed on: ${target}`);
    if (cause !== undefined) this.cause = cause;
  }
}
