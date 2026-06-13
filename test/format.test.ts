import { describe, expect, it } from "vitest";
import { parseSchema, completeRelations, formatSchema } from "@ember/schema";
import { findModel, relationFields } from "@ember/ast";

describe("relation auto-completion (Prisma-like format)", () => {
  it("adds the back-relation list on the parent when only the owning side exists", () => {
    const doc = completeRelations(
      parseSchema(`model User {
        id Int @id
      }
      model Post {
        id       Int  @id
        authorId Int
        author   User @relation(fields: [authorId], references: [id])
      }`),
    );
    const user = findModel(doc, "User")!;
    const back = relationFields(user);
    expect(back).toHaveLength(1);
    expect(back[0]!.type).toBe("Post");
    expect(back[0]!.isList).toBe(true);
    expect(back[0]!.name).toBe("posts");
  });

  it("adds the owning side + scalar FK when only the list exists", () => {
    const doc = completeRelations(
      parseSchema(`model User {
        id    Int    @id
        posts Post[]
      }
      model Post {
        id Int @id
      }`),
    );
    const post = findModel(doc, "Post")!;
    const author = post.fields.find((f) => f.kind === "object" && f.type === "User")!;
    expect(author).toBeTruthy();
    expect(author.relation?.fields).toEqual(["userId"]);
    expect(author.relation?.references).toEqual(["id"]);
    const fk = post.fields.find((f) => f.name === "userId")!;
    expect(fk.kind).toBe("scalar");
    expect(fk.type).toBe("Int");
  });

  it("adds a to-one back-relation for a 1:1 (unique FK)", () => {
    const doc = completeRelations(
      parseSchema(`model User {
        id Int @id
      }
      model Profile {
        id     Int  @id
        userId Int  @unique
        user   User @relation(fields: [userId], references: [id])
      }`),
    );
    const user = findModel(doc, "User")!;
    const back = relationFields(user)[0]!;
    expect(back.type).toBe("Profile");
    expect(back.isList).toBe(false); // 1:1 -> nullable to-one, not a list
    expect(back.name).toBe("profile");
  });

  it("preserves the relation name on both sides", () => {
    const doc = completeRelations(
      parseSchema(`model User {
        id Int @id
      }
      model Post {
        id       Int  @id
        authorId Int
        author   User @relation("Authored", fields: [authorId], references: [id])
      }`),
    );
    const back = relationFields(findModel(doc, "User")!)[0]!;
    expect(back.relation?.name).toBe("Authored");
  });

  it("is idempotent (formatting twice yields the same output)", () => {
    const src = `model User {
  id    Int    @id
  posts Post[]
}

model Post {
  id Int @id
}`;
    const once = formatSchema(src);
    const twice = formatSchema(once);
    expect(twice).toBe(once);
    // the completed owning relation (named after the parent model) is present
    // and indentation is canonical (2 spaces)
    expect(once).toContain("user");
    expect(once).toContain("userId");
    expect(once).toMatch(/\n  \w/);
  });
});
