import { describe, expect, it } from "vitest";
import { parseSchema } from "@ember/schema";
import { findModel, idFields, scalarFields } from "@ember/ast";
import { FirebirdDialect } from "@ember/sql";
import {
  compileFindMany,
  compileCount,
  compileInsert,
  compileUpdate,
  compileDelete,
  compileAggregate,
  newContext,
  compileWhere,
  resolveRelation,
} from "@ember/query";

const SCHEMA = `model User {
  id     Int     @id @default(autoincrement())
  email  String  @unique @db.VarChar(255)
  name   String?
  age    Int     @default(0)
  active Boolean @default(true)
  posts  Post[]
  @@map("USERS")
}

model Post {
  id       Int    @id @default(autoincrement())
  title    String
  authorId Int    @map("AUTHOR_ID")
  author   User   @relation(fields: [authorId], references: [id])
}`;

const doc = parseSchema(SCHEMA);
const dialect = new FirebirdDialect();
const User = findModel(doc, "User")!;
const Post = findModel(doc, "Post")!;
const ctx = () => newContext(doc, dialect);

describe("where compiler", () => {
  it("builds equality with bound parameters", () => {
    const sql = compileWhere(User, "t0", { email: "a@b.com" }, ctx());
    expect(sql.text).toBe(`"t0"."EMAIL" = ?`);
    expect(sql.params).toEqual(["a@b.com"]);
  });

  it("supports operators and AND/OR/NOT", () => {
    const sql = compileWhere(
      User,
      "t0",
      {
        OR: [{ age: { gte: 18 } }, { active: true }],
        name: { contains: "a", mode: "insensitive" },
      },
      ctx(),
    );
    expect(sql.text).toContain("OR");
    expect(sql.text).toContain('UPPER("t0"."NAME") LIKE');
    expect(sql.params).toContain(18);
    // contains escapes and wraps in %..%
    expect(sql.params.some((p) => String(p).includes("%A%"))).toBe(true);
  });

  it("compiles relation filters as EXISTS subqueries", () => {
    const sql = compileWhere(
      User,
      "t0",
      { posts: { some: { title: "x" } } },
      ctx(),
    );
    expect(sql.text).toContain("EXISTS (SELECT 1 FROM");
    expect(sql.text).toContain('"AUTHOR_ID"');
    expect(sql.params).toEqual(["x"]);
  });

  it("turns IN ([]) into a false predicate", () => {
    const sql = compileWhere(User, "t0", { id: { in: [] } }, ctx());
    expect(sql.text).toBe("1 = 0");
  });
});

describe("statement compiler", () => {
  it("compiles findMany with projection, FIRST/SKIP and ORDER BY", () => {
    const stmt = compileFindMany(
      User,
      { where: { active: true }, orderBy: { age: "desc" }, take: 10, skip: 5 },
      scalarFields(User),
      ctx(),
    );
    expect(stmt.sql.text).toContain("SELECT FIRST 10 SKIP 5");
    expect(stmt.sql.text).toContain('FROM "USERS" "t0"');
    expect(stmt.sql.text).toContain('ORDER BY "t0"."AGE" DESC');
    expect(stmt.sql.params).toEqual([true]);
  });

  it("compiles COUNT", () => {
    const sql = compileCount(User, { active: true }, ctx());
    expect(sql.text).toContain("COUNT(*)");
    expect(sql.params).toEqual([true]);
  });

  it("compiles INSERT ... RETURNING", () => {
    const row = new Map<string, any>([
      ["EMAIL", "a@b.com"],
      ["AGE", 21],
    ]);
    const stmt = compileInsert(User, row, ctx(), idFields(User));
    expect(stmt.sql.text).toBe(
      'INSERT INTO "USERS" ("EMAIL", "AGE") VALUES (?, ?) RETURNING "ID" AS "id"',
    );
    expect(stmt.sql.params).toEqual(["a@b.com", 21]);
  });

  it("compiles UPDATE with alias and WHERE", () => {
    const set = new Map<string, any>([["NAME", { kind: "set", value: "Bob" }]]);
    const stmt = compileUpdate(User, { id: 1 }, set, ctx());
    expect(stmt.sql.text).toBe(
      'UPDATE "USERS" "t0" SET "NAME" = ? WHERE "t0"."ID" = ?',
    );
    expect(stmt.sql.params).toEqual(["Bob", 1]);
  });

  it("compiles atomic arithmetic UPDATE assignments", () => {
    const set = new Map<string, any>([
      ["AGE", { kind: "arith", op: "+", value: 5 }],
      ["NAME", { kind: "set", value: "Z" }],
    ]);
    const stmt = compileUpdate(User, { id: 1 }, set, ctx());
    expect(stmt.sql.text).toBe(
      'UPDATE "USERS" "t0" SET "AGE" = "AGE" + ?, "NAME" = ? WHERE "t0"."ID" = ?',
    );
    expect(stmt.sql.params).toEqual([5, "Z", 1]);
  });

  it("compiles DELETE", () => {
    const stmt = compileDelete(User, { id: 1 }, ctx());
    expect(stmt.sql.text).toBe('DELETE FROM "USERS" "t0" WHERE "t0"."ID" = ?');
    expect(stmt.sql.params).toEqual([1]);
  });

  it("compiles aggregate functions", () => {
    const sql = compileAggregate(
      User,
      { _count: true, _avg: { age: true }, _max: { age: true } },
      ctx(),
    );
    expect(sql.text).toContain("COUNT(*)");
    expect(sql.text).toContain('AVG("t0"."AGE")');
    expect(sql.text).toContain('MAX("t0"."AGE")');
  });
});

describe("relation resolution", () => {
  it("resolves owning side (Post.author)", () => {
    const rel = resolveRelation(doc, Post, Post.fields.find((f) => f.name === "author")!);
    expect(rel.owns).toBe(true);
    expect(rel.fromColumns).toEqual(["AUTHOR_ID"]);
    expect(rel.toColumns).toEqual(["ID"]);
    expect(rel.relatedModel.name).toBe("User");
  });

  it("resolves back side (User.posts)", () => {
    const rel = resolveRelation(doc, User, User.fields.find((f) => f.name === "posts")!);
    expect(rel.owns).toBe(false);
    expect(rel.isList).toBe(true);
    expect(rel.fromColumns).toEqual(["ID"]);
    expect(rel.toColumns).toEqual(["AUTHOR_ID"]);
  });
});
