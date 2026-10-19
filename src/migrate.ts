import { readdir, readFile } from "node:fs/promises"

import path from "node:path"

import { fileURLToPath } from "node:url"

import "dotenv/config"

import { pool } from "./db.js"

async function migrate() {
  const client = await pool.connect()

  try {
    await client.query(
      "SELECT pg_advisory_lock(hashtext('chantier-connect-migrations'))",
    )

    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         version text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    )

    const migrationsDirectory = fileURLToPath(
      new URL("../migrations/", import.meta.url),
    )

    const files = (await readdir(migrationsDirectory))

      .filter((file) => file.endsWith(".sql"))

      .sort()

    for (const file of files) {
      const alreadyApplied = await client.query(
        "SELECT 1 FROM schema_migrations WHERE version = $1",

        [file],
      )

      if (alreadyApplied.rowCount) {
        console.info(`Migration déjà appliquée : ${file}`)

        continue
      }

      const sql = await readFile(path.join(migrationsDirectory, file), "utf8")

      await client.query("BEGIN")

      try {
        await client.query(sql)

        await client.query(
          "INSERT INTO schema_migrations (version) VALUES ($1)",
          [file],
        )

        await client.query("COMMIT")

        console.info(`Migration appliquée : ${file}`)
      } catch (error) {
        await client.query("ROLLBACK")

        throw error
      }
    }
  } finally {
    client.release()

    await pool.end()
  }
}

migrate().catch((error: unknown) => {
  console.error("Échec des migrations PostgreSQL :", error)

  process.exitCode = 1
})
