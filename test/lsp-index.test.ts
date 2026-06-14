import { describe, expect, it } from "vitest";
import {
  buildIndex,
  wordAt,
  findBlock,
  blockAt,
} from "../editors/vscode/src/server/schema-index";

const SCHEMA = `model User {
  id    Int    @id
  posts Post[]
}

enum Role {
  USER
  ADMIN
}

model Post {
  id       Int  @id
  authorId Int
  author   User @relation(fields: [authorId], references: [id])
}`;

describe("LSP schema position index", () => {
  const index = buildIndex(SCHEMA);

  it("indexes models, enums and fields with spans", () => {
    expect(index.models.map((m) => m.name)).toEqual(["User", "Post"]);
    expect(index.enums.map((e) => e.name)).toEqual(["Role"]);

    const user = findBlock(index, "User")!;
    expect(user.fields.map((f) => `${f.name}:${f.type}`)).toEqual([
      "id:Int",
      "posts:Post",
    ]);
    // declaration name span points at the model name on line 0
    expect(user.nameSpan.start).toEqual({ line: 0, character: 6 });
  });

  it("resolves the word under a relation type reference (go-to-definition)", () => {
    // `author   User @relation(...)` — "User" type reference on line 13
    const w = wordAt(SCHEMA, { line: 13, character: 11 });
    expect(w?.word).toBe("User");
    // the definition target is the User model declaration
    const target = findBlock(index, w!.word)!;
    expect(target.nameSpan.start.line).toBe(0);
  });

  it("knows which block a line belongs to (rename/scoping)", () => {
    expect(blockAt(index, 12)?.name).toBe("Post"); // authorId line
    expect(blockAt(index, 1)?.name).toBe("User");
    expect(blockAt(index, 7)?.name).toBe("Role");
  });

  it("ignores comments when scanning", () => {
    const idx = buildIndex(`model A {\n  id Int @id // a comment with model B {\n}`);
    expect(idx.models.map((m) => m.name)).toEqual(["A"]);
  });
});
