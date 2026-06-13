import { describe, expect, it } from "vitest";
import { parseSchema, parseAndValidate, printSchema } from "@ember/schema";
import { findModel, scalarFields, relationFields } from "@ember/ast";

const SCHEMA = `datasource db {
  provider = "firebird"
  url      = env("DATABASE_URL")
}

enum Role {
  USER
  ADMIN
}

model User {
  id    Int    @id @default(autoincrement())
  email String @unique @db.VarChar(255)
  name  String?
  role  Role   @default(USER)
  posts Post[]

  @@map("USERS")
}

model Post {
  id       Int    @id @default(autoincrement())
  title    String
  authorId Int    @map("AUTHOR_ID")
  author   User   @relation(fields: [authorId], references: [id], onDelete: Cascade)
}`;

describe("schema parser", () => {
  it("parses datasource, enum, models and fields", () => {
    const doc = parseAndValidate(SCHEMA);
    expect(doc.datasource?.provider).toBe("firebird");
    expect(doc.datasource?.url).toEqual({ kind: "env", value: "DATABASE_URL" });
    expect(doc.enums).toHaveLength(1);
    expect(doc.enums[0]!.values.map((v) => v.name)).toEqual(["USER", "ADMIN"]);
    expect(doc.models.map((m) => m.name)).toEqual(["User", "Post"]);
  });

  it("resolves field kinds, attributes and maps", () => {
    const doc = parseSchema(SCHEMA);
    const user = findModel(doc, "User")!;
    expect(user.dbName).toBe("USERS");
    expect(user.primaryKey).toEqual(["id"]);

    const id = user.fields.find((f) => f.name === "id")!;
    expect(id.isId).toBe(true);
    expect(id.default?.function?.name).toBe("autoincrement");

    const email = user.fields.find((f) => f.name === "email")!;
    expect(email.isUnique).toBe(true);
    expect(email.nativeType).toEqual({ name: "VarChar", args: [255] });

    const name = user.fields.find((f) => f.name === "name")!;
    expect(name.isRequired).toBe(false);

    const role = user.fields.find((f) => f.name === "role")!;
    expect(role.kind).toBe("enum");
    expect(role.default?.literal).toBe("USER");

    const posts = user.fields.find((f) => f.name === "posts")!;
    expect(posts.kind).toBe("object");
    expect(posts.isList).toBe(true);
  });

  it("parses relation attribute with fields/references/onDelete", () => {
    const doc = parseSchema(SCHEMA);
    const post = findModel(doc, "Post")!;
    const author = post.fields.find((f) => f.name === "author")!;
    expect(author.relation).toMatchObject({
      fields: ["authorId"],
      references: ["id"],
      onDelete: "Cascade",
    });
    expect(scalarFields(post).map((f) => f.name)).toContain("authorId");
    expect(relationFields(post).map((f) => f.name)).toEqual(["author"]);
  });

  it("round-trips through the printer", () => {
    const doc = parseAndValidate(SCHEMA);
    const printed = printSchema(doc);
    const reparsed = parseAndValidate(printed);
    expect(reparsed.models.map((m) => m.name)).toEqual(["User", "Post"]);
    const user = findModel(reparsed, "User")!;
    expect(user.dbName).toBe("USERS");
    expect(user.fields.find((f) => f.name === "email")!.nativeType).toEqual({
      name: "VarChar",
      args: [255],
    });
  });

  it("rejects a model without a primary key", () => {
    expect(() =>
      parseAndValidate(`model Broken {\n  name String\n}`),
    ).toThrowError(/no @id/i);
  });

  it("rejects unknown field types", () => {
    expect(() =>
      parseAndValidate(`model Broken {\n  id Int @id\n  x  Nope\n}`),
    ).toThrowError(/unknown type/i);
  });
});
