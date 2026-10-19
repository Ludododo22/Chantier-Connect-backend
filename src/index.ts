import "dotenv/config"

import app from "./app.js"

import { config } from "./config.js"

import { pool } from "./db.js"

const server = app.listen(config.PORT, "0.0.0.0", () => {
  console.info(
    `API Chantier Connect disponible sur http://127.0.0.1:${config.PORT}`,
  )
})

async function shutdown(signal: string) {
  console.info(`Arrêt de l'API (${signal})...`)

  server.close(async (error) => {
    if (error) {
      console.error("Erreur lors de l'arrêt du serveur HTTP :", error)

      process.exitCode = 1
    }

    await pool.end()

    process.exit()
  })
}

process.once("SIGINT", () => void shutdown("SIGINT"))

process.once("SIGTERM", () => void shutdown("SIGTERM"))
