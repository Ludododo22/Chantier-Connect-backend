import pg from "pg"
import fs from "fs"
import path from "path"
import { config } from "./config.js"

// Charge le certificat CA de Supabase depuis la racine du projet
const caCert = fs.readFileSync(
  path.join(process.cwd(), "prod-ca-2021.crt"),
  "utf8"
)

export const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  ssl: config.DATABASE_SSL
    ? {
        ca: caCert,
        rejectUnauthorized: true, // vérification stricte, sécurisée
      }
    : false,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
})

pool.on("error", (error) => {
  console.error("Erreur inattendue du pool PostgreSQL :", error)
})
