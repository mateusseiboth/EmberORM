import { SchemaParseError } from "@ember/errors";

export type TokenType =
  | "identifier"
  | "string"
  | "number"
  | "lbrace"
  | "rbrace"
  | "lparen"
  | "rparen"
  | "lbracket"
  | "rbracket"
  | "equals"
  | "comma"
  | "colon"
  | "at"
  | "double_at"
  | "question"
  | "dot"
  | "doc_comment"
  | "eof";

export interface Token {
  type: TokenType;
  value: string;
  line: number;
  column: number;
}

const SINGLE_CHAR_TOKENS: Record<string, TokenType> = {
  "{": "lbrace",
  "}": "rbrace",
  "(": "lparen",
  ")": "rparen",
  "[": "lbracket",
  "]": "rbracket",
  "=": "equals",
  ",": "comma",
  ":": "colon",
  "?": "question",
  ".": "dot",
};

const IDENT_START = /[A-Za-z_]/;
const IDENT_PART = /[A-Za-z0-9_]/;

/**
 * Converts schema source text into a flat token stream.
 * Regular `//` comments are discarded; `///` doc comments are preserved as
 * `doc_comment` tokens so the parser can attach documentation to nodes.
 */
export class Lexer {
  private pos = 0;
  private line = 1;
  private column = 1;

  constructor(
    private readonly source: string,
    private readonly file?: string,
  ) {}

  tokenize(): Token[] {
    const tokens: Token[] = [];
    let token = this.next();
    while (token.type !== "eof") {
      tokens.push(token);
      token = this.next();
    }
    tokens.push(token); // eof
    return tokens;
  }

  private next(): Token {
    this.skipWhitespaceAndComments();
    if (this.pos >= this.source.length) {
      return this.make("eof", "");
    }

    const startLine = this.line;
    const startColumn = this.column;
    const ch = this.source[this.pos]!;

    // Doc comment (/// ...) — re-check here because skip kept them.
    if (ch === "/" && this.peek(1) === "/" && this.peek(2) === "/") {
      return this.readDocComment(startLine, startColumn);
    }

    if (ch === '"') {
      return this.readString(startLine, startColumn);
    }

    if (ch === "@") {
      this.advance();
      if (this.source[this.pos] === "@") {
        this.advance();
        return { type: "double_at", value: "@@", line: startLine, column: startColumn };
      }
      return { type: "at", value: "@", line: startLine, column: startColumn };
    }

    const single = SINGLE_CHAR_TOKENS[ch];
    if (single) {
      this.advance();
      return { type: single, value: ch, line: startLine, column: startColumn };
    }

    if (ch === "-" || /[0-9]/.test(ch)) {
      return this.readNumber(startLine, startColumn);
    }

    if (IDENT_START.test(ch)) {
      return this.readIdentifier(startLine, startColumn);
    }

    throw new SchemaParseError(
      `Unexpected character '${ch}'`,
      startLine,
      startColumn,
      this.file,
    );
  }

  private readDocComment(line: number, column: number): Token {
    this.advance(); // /
    this.advance(); // /
    this.advance(); // /
    let value = "";
    while (this.pos < this.source.length && this.source[this.pos] !== "\n") {
      value += this.source[this.pos];
      this.advance();
    }
    return { type: "doc_comment", value: value.trim(), line, column };
  }

  private readString(line: number, column: number): Token {
    this.advance(); // opening quote
    let value = "";
    while (this.pos < this.source.length && this.source[this.pos] !== '"') {
      const c = this.source[this.pos]!;
      if (c === "\\") {
        this.advance();
        const escaped = this.source[this.pos];
        if (escaped === undefined) break;
        value += escapeChar(escaped);
        this.advance();
        continue;
      }
      if (c === "\n") {
        throw new SchemaParseError(
          "Unterminated string literal",
          line,
          column,
          this.file,
        );
      }
      value += c;
      this.advance();
    }
    if (this.source[this.pos] !== '"') {
      throw new SchemaParseError(
        "Unterminated string literal",
        line,
        column,
        this.file,
      );
    }
    this.advance(); // closing quote
    return { type: "string", value, line, column };
  }

  private readNumber(line: number, column: number): Token {
    let value = "";
    if (this.source[this.pos] === "-") {
      value += "-";
      this.advance();
    }
    while (
      this.pos < this.source.length &&
      /[0-9.]/.test(this.source[this.pos]!)
    ) {
      value += this.source[this.pos];
      this.advance();
    }
    return { type: "number", value, line, column };
  }

  private readIdentifier(line: number, column: number): Token {
    let value = "";
    while (
      this.pos < this.source.length &&
      IDENT_PART.test(this.source[this.pos]!)
    ) {
      value += this.source[this.pos];
      this.advance();
    }
    return { type: "identifier", value, line, column };
  }

  private skipWhitespaceAndComments(): void {
    while (this.pos < this.source.length) {
      const ch = this.source[this.pos]!;
      if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
        this.advance();
        continue;
      }
      // Keep doc comments (///) — only skip plain // comments.
      if (ch === "/" && this.peek(1) === "/" && this.peek(2) !== "/") {
        while (this.pos < this.source.length && this.source[this.pos] !== "\n") {
          this.advance();
        }
        continue;
      }
      if (ch === "/" && this.peek(1) === "*") {
        this.advance();
        this.advance();
        while (
          this.pos < this.source.length &&
          !(this.source[this.pos] === "*" && this.peek(1) === "/")
        ) {
          this.advance();
        }
        this.advance();
        this.advance();
        continue;
      }
      break;
    }
  }

  private peek(offset: number): string | undefined {
    return this.source[this.pos + offset];
  }

  private advance(): void {
    if (this.source[this.pos] === "\n") {
      this.line++;
      this.column = 1;
    } else {
      this.column++;
    }
    this.pos++;
  }

  private make(type: TokenType, value: string): Token {
    return { type, value, line: this.line, column: this.column };
  }
}

function escapeChar(c: string): string {
  switch (c) {
    case "n":
      return "\n";
    case "t":
      return "\t";
    case "r":
      return "\r";
    case '"':
      return '"';
    case "\\":
      return "\\";
    default:
      return c;
  }
}
