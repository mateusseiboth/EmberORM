import { SchemaParseError } from "@ember/errors";
import {
  type AttributeArgValue,
  type DatasourceNode,
  type DefaultValue,
  type EnumNode,
  type FieldNode,
  type GeneratorNode,
  type ModelNode,
  type NativeType,
  type ReferentialAction,
  type RelationInfo,
  type SchemaDocument,
} from "@ember/ast";
import { Lexer, type Token, type TokenType } from "./lexer";

interface RawAttribute {
  name: string; // e.g. "id", "default", "relation", "db.VarChar"
  args: AttributeArgValue[];
  line: number;
  column: number;
}

/**
 * Recursive-descent parser that turns a token stream into a SchemaDocument.
 * Field `kind` (scalar/enum/object) is resolved in a second pass once all
 * model and enum names are known (see `resolveKinds`).
 */
export class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(
    source: string,
    private readonly file?: string,
  ) {
    this.tokens = new Lexer(source, file).tokenize();
  }

  parse(): SchemaDocument {
    const doc: SchemaDocument = { generators: [], models: [], enums: [] };
    let pendingDoc: string[] = [];

    while (!this.isEof()) {
      const tok = this.peek();
      if (tok.type === "doc_comment") {
        pendingDoc.push(tok.value);
        this.advance();
        continue;
      }
      if (tok.type !== "identifier") {
        throw this.error(`Unexpected token '${tok.value}'`, tok);
      }
      const documentation = pendingDoc.length
        ? pendingDoc.join("\n")
        : undefined;
      pendingDoc = [];

      switch (tok.value) {
        case "datasource":
          doc.datasource = this.parseDatasource();
          break;
        case "generator":
          doc.generators.push(this.parseGenerator());
          break;
        case "model":
          doc.models.push(this.parseModel(documentation));
          break;
        case "enum":
          doc.enums.push(this.parseEnum(documentation));
          break;
        default:
          throw this.error(`Unknown top-level keyword '${tok.value}'`, tok);
      }
    }

    resolveKinds(doc);
    return doc;
  }

  // ---- Top-level blocks -------------------------------------------------

  private parseDatasource(): DatasourceNode {
    this.expectKeyword("datasource");
    const name = this.expect("identifier").value;
    this.expect("lbrace");
    const assignments = this.parseAssignments();
    this.expect("rbrace");

    const provider = literalString(assignments["provider"]);
    const urlAssign = assignments["url"];
    let url: DatasourceNode["url"] = { kind: "literal", value: "" };
    if (urlAssign) {
      if (urlAssign.kind === "function" && urlAssign.name === "env") {
        url = { kind: "env", value: literalString(urlAssign.args[0]) };
      } else if (urlAssign.kind === "string") {
        url = { kind: "literal", value: urlAssign.value };
      }
    }
    return { name, provider: provider ?? "firebird", url };
  }

  private parseGenerator(): GeneratorNode {
    this.expectKeyword("generator");
    const name = this.expect("identifier").value;
    this.expect("lbrace");
    const assignments = this.parseAssignments();
    this.expect("rbrace");

    const config: Record<string, string> = {};
    for (const [key, value] of Object.entries(assignments)) {
      if (value.kind === "string") config[key] = value.value;
    }
    return {
      name,
      provider: literalString(assignments["provider"]) ?? "ember-client-js",
      output: assignments["output"]
        ? literalString(assignments["output"])
        : undefined,
      config,
    };
  }

  private parseAssignments(): Record<string, AttributeArgValue> {
    const out: Record<string, AttributeArgValue> = {};
    while (!this.check("rbrace") && !this.isEof()) {
      if (this.check("doc_comment")) {
        this.advance();
        continue;
      }
      const key = this.expect("identifier").value;
      this.expect("equals");
      out[key] = this.parseValue();
    }
    return out;
  }

  private parseModel(documentation?: string): ModelNode {
    this.expectKeyword("model");
    const name = this.expect("identifier").value;
    this.expect("lbrace");

    const model: ModelNode = {
      name,
      fields: [],
      primaryKey: [],
      uniqueIndexes: [],
      indexes: [],
      documentation,
    };

    let pendingDoc: string[] = [];
    while (!this.check("rbrace") && !this.isEof()) {
      const tok = this.peek();
      if (tok.type === "doc_comment") {
        pendingDoc.push(tok.value);
        this.advance();
        continue;
      }
      if (tok.type === "double_at") {
        this.parseBlockAttribute(model);
        pendingDoc = [];
        continue;
      }
      const field = this.parseField(
        pendingDoc.length ? pendingDoc.join("\n") : undefined,
      );
      pendingDoc = [];
      model.fields.push(field);
      // Promote inline @id / @unique to model metadata.
      if (field.isId && !model.primaryKey.includes(field.name)) {
        model.primaryKey.push(field.name);
      }
    }
    this.expect("rbrace");
    return model;
  }

  private parseField(documentation?: string): FieldNode {
    const name = this.expect("identifier").value;
    const typeName = this.expect("identifier").value;

    let isList = false;
    let isRequired = true;
    // Order-independent handling of `[]` and `?`.
    while (this.check("lbracket") || this.check("question")) {
      if (this.check("lbracket")) {
        this.advance();
        this.expect("rbracket");
        isList = true;
      } else {
        this.advance();
        isRequired = false;
      }
    }

    const field: FieldNode = {
      name,
      type: typeName,
      kind: "scalar", // resolved later
      isList,
      isRequired,
      isId: false,
      isUnique: false,
      isUpdatedAt: false,
      documentation,
    };

    while (this.check("at")) {
      const attr = this.parseAttribute();
      this.applyFieldAttribute(field, attr);
    }
    return field;
  }

  private applyFieldAttribute(field: FieldNode, attr: RawAttribute): void {
    if (attr.name.startsWith("db.")) {
      field.nativeType = toNativeType(attr);
      return;
    }
    switch (attr.name) {
      case "id":
        field.isId = true;
        break;
      case "unique":
        field.isUnique = true;
        break;
      case "updatedAt":
        field.isUpdatedAt = true;
        break;
      case "default":
        field.default = toDefaultValue(attr.args[0]);
        break;
      case "map":
        field.dbName = literalString(attr.args[0]);
        break;
      case "relation":
        field.relation = toRelationInfo(attr.args);
        break;
      default:
        throw this.error(`Unknown field attribute '@${attr.name}'`, attr);
    }
  }

  private parseBlockAttribute(model: ModelNode): void {
    const start = this.expect("double_at");
    const name = this.expect("identifier").value;
    const args = this.check("lparen") ? this.parseArgList() : [];

    switch (name) {
      case "id":
        model.primaryKey = fieldNameList(args);
        break;
      case "unique":
        model.uniqueIndexes.push({
          fields: fieldNameList(args),
          name: namedArg(args, "map"),
        });
        break;
      case "index":
        model.indexes.push({
          fields: fieldNameList(args),
          name: namedArg(args, "map"),
          unique: false,
        });
        break;
      case "map":
        model.dbName = literalString(args[0]);
        break;
      default:
        throw this.error(`Unknown block attribute '@@${name}'`, start);
    }
  }

  private parseEnum(documentation?: string): EnumNode {
    this.expectKeyword("enum");
    const name = this.expect("identifier").value;
    this.expect("lbrace");
    const node: EnumNode = { name, values: [], documentation };

    while (!this.check("rbrace") && !this.isEof()) {
      if (this.check("doc_comment")) {
        this.advance();
        continue;
      }
      if (this.check("double_at")) {
        this.advance();
        const attrName = this.expect("identifier").value;
        const args = this.check("lparen") ? this.parseArgList() : [];
        if (attrName === "map") node.dbName = literalString(args[0]);
        continue;
      }
      const valueName = this.expect("identifier").value;
      let dbName: string | undefined;
      while (this.check("at")) {
        const attr = this.parseAttribute();
        if (attr.name === "map") dbName = literalString(attr.args[0]);
      }
      node.values.push({ name: valueName, dbName });
    }
    this.expect("rbrace");
    return node;
  }

  // ---- Attributes & values ---------------------------------------------

  private parseAttribute(): RawAttribute {
    const at = this.expect("at");
    let name = this.expect("identifier").value;
    // Native type attributes look like @db.VarChar(255).
    if (this.check("dot")) {
      this.advance();
      name += "." + this.expect("identifier").value;
    }
    const args = this.check("lparen") ? this.parseArgList() : [];
    return { name, args, line: at.line, column: at.column };
  }

  private parseArgList(): AttributeArgValue[] {
    this.expect("lparen");
    const args: AttributeArgValue[] = [];
    while (!this.check("rparen") && !this.isEof()) {
      args.push(this.parseArg());
      if (this.check("comma")) this.advance();
    }
    this.expect("rparen");
    return args;
  }

  /** Handles both positional values and `name: value` named arguments. */
  private parseArg(): AttributeArgValue {
    if (this.check("identifier") && this.peek(1)?.type === "colon") {
      const key = this.expect("identifier").value;
      this.expect("colon");
      const value = this.parseValue();
      return { kind: "function", name: `__named:${key}`, args: [value] };
    }
    return this.parseValue();
  }

  private parseValue(): AttributeArgValue {
    const tok = this.peek();
    switch (tok.type) {
      case "string":
        this.advance();
        return { kind: "string", value: tok.value };
      case "number":
        this.advance();
        return { kind: "number", value: Number(tok.value) };
      case "lbracket": {
        this.advance();
        const items: AttributeArgValue[] = [];
        while (!this.check("rbracket") && !this.isEof()) {
          items.push(this.parseValue());
          if (this.check("comma")) this.advance();
        }
        this.expect("rbracket");
        return { kind: "array", items };
      }
      case "identifier": {
        this.advance();
        if (tok.value === "true" || tok.value === "false") {
          return { kind: "boolean", value: tok.value === "true" };
        }
        if (this.check("lparen")) {
          const args = this.parseArgList();
          return { kind: "function", name: tok.value, args };
        }
        return { kind: "ref", value: tok.value };
      }
      default:
        throw this.error(`Unexpected value token '${tok.value}'`, tok);
    }
  }

  // ---- Token helpers ----------------------------------------------------

  private peek(offset = 0): Token {
    return this.tokens[this.pos + offset] ?? this.tokens[this.tokens.length - 1]!;
  }

  private advance(): Token {
    const tok = this.tokens[this.pos]!;
    if (this.pos < this.tokens.length - 1) this.pos++;
    return tok;
  }

  private check(type: TokenType): boolean {
    return this.peek().type === type;
  }

  private isEof(): boolean {
    return this.peek().type === "eof";
  }

  private expect(type: TokenType): Token {
    const tok = this.peek();
    if (tok.type !== type) {
      throw this.error(`Expected ${type} but found '${tok.value}' (${tok.type})`, tok);
    }
    return this.advance();
  }

  private expectKeyword(keyword: string): Token {
    const tok = this.peek();
    if (tok.type !== "identifier" || tok.value !== keyword) {
      throw this.error(`Expected keyword '${keyword}'`, tok);
    }
    return this.advance();
  }

  private error(message: string, at: { line: number; column: number }) {
    return new SchemaParseError(message, at.line, at.column, this.file);
  }
}

// ---- Value coercion helpers --------------------------------------------

function literalString(v: AttributeArgValue | undefined): string {
  if (!v) return "";
  if (v.kind === "string") return v.value;
  if (v.kind === "ref") return v.value;
  return String("value" in v ? v.value : "");
}

function toNativeType(attr: RawAttribute): NativeType {
  const name = attr.name.slice("db.".length);
  const args = attr.args
    .filter((a) => a.kind === "number")
    .map((a) => (a as { value: number }).value);
  return { name, args };
}

function toDefaultValue(v: AttributeArgValue | undefined): DefaultValue {
  if (!v) return {};
  switch (v.kind) {
    case "function":
      return { function: { name: v.name, args: v.args } };
    case "string":
      return { literal: v.value };
    case "number":
      return { literal: v.value };
    case "boolean":
      return { literal: v.value };
    case "ref":
      // enum value default such as @default(USER)
      return { literal: v.value };
    default:
      return {};
  }
}

function toRelationInfo(args: AttributeArgValue[]): RelationInfo {
  const info: RelationInfo = {};
  for (const arg of args) {
    if (arg.kind === "string") {
      info.name = arg.value;
      continue;
    }
    const named = asNamed(arg);
    if (!named) continue;
    const [key, value] = named;
    if (key === "name" && value.kind === "string") info.name = value.value;
    if (key === "fields") info.fields = refArray(value);
    if (key === "references") info.references = refArray(value);
    if (key === "onDelete") info.onDelete = refName(value) as ReferentialAction;
    if (key === "onUpdate") info.onUpdate = refName(value) as ReferentialAction;
  }
  return info;
}

function asNamed(
  arg: AttributeArgValue,
): [string, AttributeArgValue] | undefined {
  if (arg.kind === "function" && arg.name.startsWith("__named:")) {
    return [arg.name.slice("__named:".length), arg.args[0]!];
  }
  return undefined;
}

function namedArg(args: AttributeArgValue[], key: string): string | undefined {
  for (const arg of args) {
    const named = asNamed(arg);
    if (named && named[0] === key && named[1].kind === "string") {
      return named[1].value;
    }
  }
  return undefined;
}

function refArray(v: AttributeArgValue): string[] {
  if (v.kind === "array") {
    return v.items.map((i) => refName(i)).filter((s): s is string => !!s);
  }
  const single = refName(v);
  return single ? [single] : [];
}

function refName(v: AttributeArgValue): string | undefined {
  if (v.kind === "ref") return v.value;
  if (v.kind === "string") return v.value;
  return undefined;
}

/** A list of bare field references, used by @@id/@@unique/@@index. */
function fieldNameList(args: AttributeArgValue[]): string[] {
  for (const arg of args) {
    if (arg.kind === "array") return refArray(arg);
    const named = asNamed(arg);
    if (named && named[0] === "fields") return refArray(named[1]);
  }
  // single bare ref form: @@id(field)
  return args.map((a) => refName(a)).filter((s): s is string => !!s);
}

/**
 * Second pass: now that all model and enum names are known, classify each
 * field as scalar, enum, or object (relation).
 */
function resolveKinds(doc: SchemaDocument): void {
  const modelNames = new Set(doc.models.map((m) => m.name));
  const enumNames = new Set(doc.enums.map((e) => e.name));
  for (const model of doc.models) {
    for (const field of model.fields) {
      if (modelNames.has(field.type)) field.kind = "object";
      else if (enumNames.has(field.type)) field.kind = "enum";
      else field.kind = "scalar";
    }
  }
}
