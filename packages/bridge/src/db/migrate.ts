/**
 * Minimal forward-only migration runner: applies `schema.sql` plus any
 * numbered files in `migrations/` that have not run yet, recorded in
 * `schema_migrations`. Idempotent; safe to run on every boot.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import postgres from "postgres";

export async function migrate(databaseUrl: string, options: { readOnly?: boolean } = {}): Promise<string[]> {
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  const applied: string[] = [];
  try {
    if (!options.readOnly) await sql.unsafe(
      "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );

    const dir = new URL(".", import.meta.url).pathname;
    const files: string[] = ["schema.sql"];
    try {
      const extra = (await readdir(join(dir, "migrations"))).filter((f) => f.endsWith(".sql")).sort();
      files.push(...extra.map((f) => join("migrations", f)));
    } catch {
      // no migrations dir yet
    }

    for (const file of files) {
      const [row] = await sql`SELECT 1 FROM schema_migrations WHERE name = ${file}`;
      if (row) continue;
      if (options.readOnly) throw new Error("Database migrations must complete before portal startup");
      const body = await readFile(join(dir, file), "utf8");
      await sql.begin(async (tx) => {
        await tx.unsafe(body);
        await tx`INSERT INTO schema_migrations (name) VALUES (${file})`;
      });
      applied.push(file);
    }
  } finally {
    await sql.end();
  }
  return applied;
}

if (import.meta.main) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set");
  const applied = await migrate(url);
  console.log(applied.length ? `applied: ${applied.join(", ")}` : "schema up to date");
}
