import type { PoolClient } from "pg"

import type { Request } from "express"

export interface AuditEvent {
  actorId: string | null
  actorRole: string
  tenantId?: string | null
  targetType: string
  targetId: string
  action: string
  payloadMasked?: Record<string, unknown>
}

export async function writeAuditLog(
  client: PoolClient,
  request: Request,
  event: AuditEvent,
) {
  await client.query(
    `INSERT INTO audit_logs (
       actor_id, actor_role, tenant_id, target_type, target_id, action,
       payload_masked, ip, user_agent
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      event.actorId,
      event.actorRole,
      event.tenantId ?? null,
      event.targetType,
      event.targetId,
      event.action,
      JSON.stringify(event.payloadMasked ?? {}),
      request.ip ?? null,
      request.get("user-agent") ?? null,
    ],
  )
}
