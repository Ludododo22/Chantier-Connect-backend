import { pool } from "./db.js"

let cachedRequestLimit = 120

let cacheExpiresAt = 0

export async function getPlatformRequestLimit() {
  if (Date.now() < cacheExpiresAt) return cachedRequestLimit

  const result = await pool.query<{ request_limit: number }>(
    "SELECT request_limit FROM platform_settings WHERE singleton = true",
  )

  const settings = result.rows[0]

  if (!settings) {
    throw new Error(
      "Les paramètres de limitation de la plateforme sont introuvables.",
    )
  }

  cachedRequestLimit = settings.request_limit

  cacheExpiresAt = Date.now() + 60_000

  return cachedRequestLimit
}

export function refreshPlatformRequestLimit(requestLimit: number) {
  cachedRequestLimit = requestLimit

  cacheExpiresAt = Date.now() + 60_000
}
