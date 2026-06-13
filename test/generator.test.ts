import { describe, expect, it } from "vitest";
import { parseSchema } from "@ember/schema";
import { generateClientSource } from "@ember/generator";

const SCHEMA = `enum Role {
  USER
  ADMIN
}

model User {
  id      Int     @id @default(autoincrement())
  email   String  @unique
  role    Role    @default(USER)
  posts   Post[]
  profile Profile?
  @@map("USERS")
}

model Profile {
  id     Int  @id @default(autoincrement())
  userId Int  @unique
  user   User @relation(fields: [userId], references: [id])
}

model Post {
  id       Int    @id @default(autoincrement())
  title    String
  views    Int    @default(0)
  authorId Int
  author   User   @relation(fields: [authorId], references: [id])
}`;

const src = generateClientSource(parseSchema(SCHEMA));

describe("client generator", () => {
  it("emits the recursive payload resolver and registry", () => {
    expect(src).toContain("export type $Payload<M extends $ModelName, A>");
    expect(src).toContain('export type $ModelName = "User" | "Profile" | "Post";');
    expect(src).toContain("export interface $RelationMap {");
    expect(src).toContain('export type UserGetPayload<A> = $Payload<"User", A>;');
  });

  it("encodes relation list-ness and nullability in the registry", () => {
    expect(src).toContain('posts: { model: "Post"; isList: true }');
    expect(src).toContain('profile: { model: "Profile"; isList: false; isNullable: true }');
    expect(src).toContain('author: { model: "User"; isList: false }');
  });

  it("generates an enum const + type", () => {
    expect(src).toContain('export const Role = {');
    expect(src).toContain("export type Role = (typeof Role)[keyof typeof Role];");
  });

  it("exposes atomic numeric update operators on numeric fields only", () => {
    // numeric field gets increment/decrement/multiply/divide
    expect(src).toMatch(/views\?:[^\n]*increment\?: number; decrement\?: number; multiply\?: number; divide\?: number/);
    // string field only gets set
    expect(src).toMatch(/title\?: string \| \{ set\?: string \};/);
  });

  it("makes foreign-key scalars optional in CreateInput", () => {
    // authorId is a FK and may be provided via the relation
    expect(src).toMatch(/PostCreateInput = \{[\s\S]*authorId\?: number;/);
  });

  it("builds a typed delegate and client class", () => {
    expect(src).toContain("export interface UserDelegate {");
    expect(src).toContain("export class EmberClient extends EmberClientBase");
    expect(src).toContain("declare readonly user: Prisma.UserDelegate;");
  });
});
