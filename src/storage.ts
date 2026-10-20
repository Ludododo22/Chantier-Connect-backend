import type { PoolClient } from "pg"

export async function tenantStorageCapacity(
  client: PoolClient,
  tenantId: string,
  incomingBytes: number,
  replacingProfilePhotoUserId?: string,
) {
  await client.query("SELECT id FROM tenants WHERE id = $1 FOR UPDATE", [
    tenantId,
  ])
  const result = await client.query<{
    maxStorageMb: number | null
    usedBytes: string
    replacedProfileBytes: string
  }>(
    `SELECT plan.max_storage_mb AS "maxStorageMb",
            (
              COALESCE((SELECT sum(octet_length(photo.image_data))
                        FROM photos photo WHERE photo.tenant_id = $1), 0)
              + COALESCE((SELECT sum(octet_length(member.profile_photo_data))
                          FROM users member WHERE member.tenant_id = $1), 0)
            )::text AS "usedBytes",
            COALESCE((SELECT octet_length(member.profile_photo_data)
                      FROM users member
                      WHERE member.id = $2 AND member.tenant_id = $1), 0)::text
              AS "replacedProfileBytes"
     FROM tenant_subscriptions subscription
     JOIN subscription_plans plan ON plan.id = subscription.plan_id
     WHERE subscription.tenant_id = $1`,
    [tenantId, replacingProfilePhotoUserId ?? null],
  )
  const quota = result.rows[0]
  if (!quota || quota.maxStorageMb === null) return { allowed: true }

  const used = BigInt(quota.usedBytes) - BigInt(quota.replacedProfileBytes)
  const limit = BigInt(quota.maxStorageMb) * 1024n * 1024n
  return {
    allowed: used + BigInt(incomingBytes) <= limit,
    maxStorageMb: quota.maxStorageMb,
    usedBytes: used.toString(),
  }
}
