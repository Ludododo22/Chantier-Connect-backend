import { createHash, randomBytes } from "node:crypto"
import type { Request } from "express"
import type { UserRole } from "./types.js"
import { pool } from "./db.js"
import { maskEmail } from "./privacy.js"
import { writeAuditLog } from "./audit-log.js"
import { sendPasswordResetEmail } from "./mailer.js"

export function hashPasswordResetToken(token: string) {
  return createHash("sha256").update(token).digest("hex")
}

export async function issuePasswordReset(input: {
  userId: string
  email: string
  fullName: string
  role: UserRole
  tenantId: string | null
  requestedBy: string | null
  actorRole: string
  request: Request
}) {
  const token = randomBytes(32).toString("base64url")
  const tokenHash = hashPasswordResetToken(token)
  const client = await pool.connect()

  try {
    await client.query("BEGIN")
    await client.query(
      `UPDATE password_reset_tokens SET used_at = now()
       WHERE user_id = $1 AND used_at IS NULL`,
      [input.userId],
    )
    await client.query(
      `INSERT INTO password_reset_tokens (user_id, requested_by, token_hash, expires_at)
       VALUES ($1, $2, $3, now() + interval '30 minutes')`,
      [input.userId, input.requestedBy, tokenHash],
    )
    await writeAuditLog(client, input.request, {
      actorId: input.requestedBy,
      actorRole: input.actorRole,
      tenantId: input.tenantId,
      targetType: "user",
      targetId: input.userId,
      action: "PASSWORD_RESET_REQUESTED",
      payloadMasked: { email: maskEmail(input.email), delivery: "en cours" },
    })
    await client.query("COMMIT")
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }

  try {
    await sendPasswordResetEmail({
      email: input.email,
      fullName: input.fullName,
      token,
    })
    return true
  } catch {
    const failureClient = await pool.connect()
    try {
      await failureClient.query("BEGIN")
      await failureClient.query(
        `UPDATE password_reset_tokens SET used_at = now()
         WHERE token_hash = $1 AND used_at IS NULL`,
        [tokenHash],
      )
      await writeAuditLog(failureClient, input.request, {
        actorId: input.requestedBy,
        actorRole: input.actorRole,
        tenantId: input.tenantId,
        targetType: "user",
        targetId: input.userId,
        action: "PASSWORD_RESET_EMAIL_FAILED",
        payloadMasked: { email: maskEmail(input.email) },
      })
      await failureClient.query("COMMIT")
    } catch (error) {
      await failureClient.query("ROLLBACK")
      throw error
    } finally {
      failureClient.release()
    }
    return false
  }
}
