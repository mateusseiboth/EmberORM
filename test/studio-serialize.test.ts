import { describe, expect, it } from "vitest";
import { parseSchema } from "@ember/schema";
import type { EmberClientBase } from "@ember/client";
import {
  buildStudioSchema,
  deserializeData,
  deserializeWhere,
  serializeRow,
  startStudioServer,
} from "@ember/studio";

const SCHEMA = `datasource db {
  provider = "firebird"
  url      = env("DATABASE_URL")
}

enum Role {
  USER
  ADMIN
}

model User {
  id        Int      @id @default(autoincrement())
  email     String   @unique
  name      String?
  role      Role     @default(USER)
  balance   BigInt
  createdAt DateTime @default(now())
  posts     Post[]
}

model Post {
  id       Int    @id @default(autoincrement())
  title    String
  author   User   @relation(fields: [authorId], references: [id])
  authorId Int
}
`;

const schema = parseSchema(SCHEMA);

describe("studio serialize", () => {
  it("serializes rich JS values to JSON-safe tokens", () => {
    const date = new Date("2020-01-02T03:04:05.000Z");
    const row = serializeRow({
      id: 1,
      balance: 9007199254740993n,
      createdAt: date,
      avatar: Buffer.from("hi"),
      name: null,
    });
    expect(row.id).toBe(1);
    expect(row.balance).toBe("9007199254740993");
    expect(row.createdAt).toBe(date.toISOString());
    expect(row.avatar).toEqual({ $type: "bytes", base64: Buffer.from("hi").toString("base64") });
    expect(row.name).toBeNull();
  });

  it("deserializes data back into engine types per field", () => {
    const data = deserializeData(
      { balance: "42", createdAt: "2020-01-02T03:04:05.000Z", name: "Ada" },
      "User",
      schema,
    );
    expect(data.balance).toBe(42n);
    expect(data.createdAt).toBeInstanceOf(Date);
    expect(data.name).toBe("Ada");
  });

  it("deserializes where conditions including operator forms", () => {
    const where = deserializeWhere(
      { balance: { gt: "10" }, id: { in: ["1", "2"] }, createdAt: "2020-01-02T03:04:05.000Z" },
      "User",
      schema,
    );
    expect(where).toEqual({
      balance: { gt: 10n },
      id: { in: [1, 2] },
      createdAt: new Date("2020-01-02T03:04:05.000Z"),
    });
  });
});

describe("studio schema metadata", () => {
  it("projects models, primary keys, generated flags, and enums", () => {
    const meta = buildStudioSchema(schema);
    const user = meta.models.find((m) => m.name === "User")!;
    expect(user.primaryKey).toEqual(["id"]);
    const id = user.fields.find((f) => f.name === "id")!;
    expect(id.isGenerated).toBe(true);
    const posts = user.fields.find((f) => f.name === "posts")!;
    expect(posts.kind).toBe("object");
    expect(meta.enums).toEqual([{ name: "Role", values: ["USER", "ADMIN"] }]);
  });
});

describe("studio server API", () => {
  // Minimal fake standing in for EmberClientBase: `.model()` for data routes and
  // `.$on()` for the Console query log.
  function fakeClient(handlers: Record<string, unknown>): EmberClientBase {
    return {
      model: () => handlers,
      $on: () => {},
    } as unknown as EmberClientBase;
  }

  it("serves schema, findMany rows, and routes errors", async () => {
    const captured: { args?: unknown } = {};
    const client = fakeClient({
      findMany: async (args: unknown) => {
        captured.args = args;
        return [{ id: 1, balance: 5n, createdAt: new Date("2020-01-01T00:00:00.000Z") }];
      },
    });
    const server = await startStudioServer({ client, schema, port: 0, webRoot: "/nonexistent" });
    try {
      const meta = (await (await fetch(`${server.url}/api/schema`)).json()) as {
        models: { name: string }[];
      };
      expect(meta.models.map((m) => m.name)).toContain("User");

      const res = await fetch(`${server.url}/api/User/findMany`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ where: { balance: { gt: "3" } }, take: 10 }),
      });
      const body = (await res.json()) as { rows: Record<string, unknown>[] };
      expect(body.rows[0]!.balance).toBe("5");
      expect(body.rows[0]!.createdAt).toBe("2020-01-01T00:00:00.000Z");
      // where was deserialized (BigInt) before reaching the delegate.
      expect((captured.args as { where: { balance: { gt: bigint } } }).where.balance.gt).toBe(3n);

      const missing = await fetch(`${server.url}/api/Nope/findMany`, { method: "POST" });
      expect(missing.status).toBe(404);
    } finally {
      await server.close();
    }
  });
});
