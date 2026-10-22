import { readFileSync } from "node:fs"

import pg from "pg"
import { config } from "./config.js"

const ssl = config.DATABASE_SSL
  ? {
      ca: readFileSync(new URL("../prod-ca-2021.crt", import.meta.url), "utf8"),
      rejectUnauthorized: true,
    }
  : false

export const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  ssl,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
})

pool.on("error", (error) => {
  console.error("Erreur inattendue du pool PostgreSQL :", error)
})
