import { Router } from "express"
import { z } from "zod"
import { authenticate } from "../auth.js"
import { pool } from "../db.js"
import { issuePasswordReset } from "../password-reset.js"
import { maskEmail, maskPhone, maskSensitiveText } from "../privacy.js"
import { writeAuditLog } from "../audit-log.js"
import type { AuthenticatedRequest } from "../types.js"

const router = Router()

const sensitiveAccessSchema = z.object({
  justification: z.string().trim().min(12).max(500),
  emergencyOverride: z.boolean().default(false),
})
const profileUpdateSchema = z.object({
  fullName: z.string().trim().min(2).max(120).optional(),
  email: z.email().trim().toLowerCase().optional(),
  phone: z.string().trim().min(7).max(30).nullable().optional(),
}).refine((value) => Object.keys(value).length > 0)

router.use(authenticate)

router.get("/", async (request, response) => {
  const query = z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    q: z.string().trim().max(160).optional(),
    status: z.enum(["all", "active", "blocked"]).default("all"),
    role: z.enum([
      "EDITOR",
      "ADMIN_ENTERPRISE",
      "CONDUCTEUR",
      "CHEF_CHANTIER",
      "COMPAGNON",
      "SOUS_TRAITANT",
      "COMPTABLE",
      "MAITRE_OUVRAGE",
    ]).optional(),
    tenantId: z.string().refine((value) => value === "platform" || z.uuid().safeParse(value).success).optional(),
  }).safeParse(request.query)
  if (!query.success) {
    response.status(400).json({ error: "Filtres de recherche invalides." })
    return
  }
  const { page, limit, q, status, role, tenantId } = query.data
  const values = [
    q ? `%${q}%` : null,
    status === "all" ? null : status === "active",
    role ?? null,
    tenantId ?? null,
  ]
  const [rows, count] = await Promise.all([
    pool.query(
      `SELECT u.id, u.full_name AS "fullName", u.email, u.phone,
              u.role, u.active, u.tenant_id AS "tenantId", u.tenant_name AS "tenantName",
              u.assigned_site_id AS "assignedSiteId", s.name AS "assignedSite",
              u.requires_user_consent AS "requiresUserConsent",
              (u.sensitive_data_consented_at IS NOT NULL) AS "sensitiveDataConsented",
              u.created_at AS "createdAt"
       FROM users u
       LEFT JOIN sites s ON s.id = u.assigned_site_id AND s.tenant_id = u.tenant_id
       WHERE ($1::text IS NULL OR u.full_name ILIKE $1 OR u.email ILIKE $1 OR COALESCE(u.phone, '') ILIKE $1 OR u.tenant_name ILIKE $1)
         AND ($2::boolean IS NULL OR u.active = $2)
         AND ($3::text IS NULL OR u.role = $3)
         AND ($4::text IS NULL OR ($4 = 'platform' AND u.tenant_id IS NULL) OR u.tenant_id::text = $4)
       ORDER BY u.created_at DESC, u.full_name
       LIMIT $5 OFFSET $6`,
      [...values, limit, (page - 1) * limit],
    ),
    pool.query(
      `SELECT count(*)::int AS total FROM users u
       WHERE ($1::text IS NULL OR u.full_name ILIKE $1 OR u.email ILIKE $1 OR COALESCE(u.phone, '') ILIKE $1 OR u.tenant_name ILIKE $1)
         AND ($2::boolean IS NULL OR u.active = $2)
         AND ($3::text IS NULL OR u.role = $3)
         AND ($4::text IS NULL OR ($4 = 'platform' AND u.tenant_id IS NULL) OR u.tenant_id::text = $4)`,
      values,
    ),
  ])
  response.json({
    data: rows.rows.map((user) => ({
      ...user,
      email: undefined,
      phone: undefined,
      emailMasked: maskEmail(user.email),
      phoneMasked: maskPhone(user.phone),
    })),
    page,
    limit,
    total: count.rows[0].total,
  })
})

router.get("/:id", (_request, response) => {
  response.status(403).json({ error: "La consultation directe des données personnelles est interdite. Utilisez le mode support justifié." })
})

router.post("/:id/support-access", async (request, response) => {
  const id = z.uuid().safeParse(request.params.id)
  const parsed = sensitiveAccessSchema.safeParse(request.body)
  if (!id.success || !parsed.success) {
    response.status(400).json({ error: "Accès support ou justification invalide." })
    return
  }
  const actor = (request as AuthenticatedRequest).authUser
  const client = await pool.connect()
  let target: {
    id: string; full_name: string; email: string; phone: string | null; role: string;
    active: boolean; tenant_id: string | null; requires_user_consent: boolean;
    sensitive_data_consented_at: Date | null
  }
  let emergencyOverride = false
  try {
    await client.query("BEGIN")
    const result = await client.query<typeof target>(
      `SELECT id, full_name, email, phone, role, active, tenant_id,
              requires_user_consent, sensitive_data_consented_at
       FROM users WHERE id = $1 FOR UPDATE`,
      [id.data],
    )
    const current = result.rows[0]
    if (!current) {
      await client.query("ROLLBACK")
      response.status(404).json({ error: "Compte introuvable." })
      return
    }
    target = current
    emergencyOverride =
      target.requires_user_consent &&
      !target.sensitive_data_consented_at &&
      parsed.data.emergencyOverride
    if (
      target.requires_user_consent &&
      !target.sensitive_data_consented_at &&
      !emergencyOverride
    ) {
      await client.query("ROLLBACK")
      response.status(409).json({
        error: "Le consentement est requis. Un accès d’urgence doit être explicitement justifié.",
      })
      return
    }
    await writeAuditLog(client, request, {
      actorId: actor.id,
      actorRole: actor.role,
      tenantId: target.tenant_id,
      targetType: "user",
      targetId: target.id,
      action: emergencyOverride ? "SUPPORT_ACCESS_EMERGENCY_OVERRIDE" : "SUPPORT_ACCESS_GRANTED",
      payloadMasked: {
        justification: maskSensitiveText(parsed.data.justification),
        email: maskEmail(target.email),
        phone: maskPhone(target.phone),
      },
    })
    await client.query("COMMIT")
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }
  response.setHeader("Cache-Control", "no-store")
  response.json({
    data: {
      id: target.id,
      fullName: target.full_name,
      email: target.email,
      phone: target.phone,
      role: target.role,
      active: target.active,
      consented: Boolean(target.sensitive_data_consented_at),
    },
  })
})

router.patch("/:id", async (request, response) => {
  const id = z.uuid().safeParse(request.params.id)
  const parsed = profileUpdateSchema.safeParse(request.body)
  if (!id.success || !parsed.success) {
    response.status(400).json({ error: "Modification de compte invalide." })
    return
  }
  const editor = (request as AuthenticatedRequest).authUser
  const initials = parsed.data.fullName?.split(/\s+/).slice(0, 2).map((part) => part[0]!.toLocaleUpperCase("fr-FR")).join("")
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    const result = await client.query(
      `UPDATE users SET full_name = COALESCE($2, full_name), initials = COALESCE($3, initials),
              email = COALESCE($4, email), phone = CASE WHEN $5::boolean THEN $6 ELSE phone END
       WHERE id = $1 RETURNING id, tenant_id, full_name AS "fullName", email, phone`,
      [id.data, parsed.data.fullName ?? null, initials ?? null, parsed.data.email ?? null, parsed.data.phone !== undefined, parsed.data.phone ?? null],
    )
    if (!result.rowCount) {
      await client.query("ROLLBACK")
      response.status(404).json({ error: "Compte introuvable." })
      return
    }
    await writeAuditLog(client, request, {
      actorId: editor.id, actorRole: editor.role, tenantId: result.rows[0].tenant_id,
      targetType: "user", targetId: id.data,
      action: "USER_PROFILE_UPDATED",
      payloadMasked: {
        fullName: parsed.data.fullName,
        email: parsed.data.email ? maskEmail(parsed.data.email) : undefined,
        phone: parsed.data.phone ? maskPhone(parsed.data.phone) : undefined,
      },
      })
    await client.query("COMMIT")
    response.json({ data: { id: result.rows[0].id, fullName: result.rows[0].fullName, emailMasked: maskEmail(result.rows[0].email), phoneMasked: maskPhone(result.rows[0].phone) } })
  } catch (error) {
    await client.query("ROLLBACK")
    if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") {
      response.status(409).json({ error: "Cet email ou ce téléphone est déjà utilisé." })
      return
    }
    throw error
  } finally {
    client.release()
  }
})

router.patch("/:id/status", async (request, response) => {
  const id = z.uuid().safeParse(request.params.id)
  const parsed = z.object({ active: z.boolean() }).safeParse(request.body)
  if (!id.success || !parsed.success) {
    response.status(400).json({ error: "Statut de compte invalide." })
    return
  }
  const actor = (request as AuthenticatedRequest).authUser
  if (id.data === actor.id) {
    response.status(400).json({ error: "Vous ne pouvez pas bloquer votre propre compte." })
    return
  }
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    const result = await client.query<{ id: string; tenant_id: string | null; role: string; active: boolean }>(
      `UPDATE users SET active = $2, session_version = session_version + CASE WHEN $2 THEN 0 ELSE 1 END
       WHERE id = $1 AND role <> 'EDITOR' RETURNING id, tenant_id, role, active`,
      [id.data, parsed.data.active],
    )
    if (!result.rowCount) {
      await client.query("ROLLBACK")
      response.status(404).json({ error: "Compte introuvable ou protégé." })
      return
    }
    await writeAuditLog(client, request, {
      actorId: actor.id, actorRole: actor.role, tenantId: result.rows[0].tenant_id,
      targetType: "user", targetId: id.data,
      action: parsed.data.active ? "USER_UNBLOCKED" : "USER_BLOCKED",
      payloadMasked: { active: parsed.data.active },
    })
    await client.query("COMMIT")
    response.json({ data: result.rows[0] })
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }
})

router.post("/:id/password-reset", async (request, response) => {
  const id = z.uuid().safeParse(request.params.id)
  if (!id.success) {
    response.status(400).json({ error: "Identifiant de compte invalide." })
    return
  }
  const target = await pool.query<{
    id: string; email: string; full_name: string; role: AuthenticatedRequest["authUser"]["role"];
    tenant_id: string | null
  }>("SELECT id, email, full_name, role, tenant_id FROM users WHERE id = $1 AND active = true", [id.data])
  if (!target.rowCount) {
    response.status(404).json({ error: "Compte actif introuvable." })
    return
  }
  const actor = (request as AuthenticatedRequest).authUser
  const sent = await issuePasswordReset({
    userId: target.rows[0].id,
    email: target.rows[0].email,
    fullName: target.rows[0].full_name,
    role: target.rows[0].role,
    tenantId: target.rows[0].tenant_id,
    requestedBy: actor.id,
    actorRole: actor.role,
    request,
  })
  if (!sent) {
    response.status(503).json({ error: "L’email de réinitialisation n’a pas pu être envoyé." })
    return
  }
  response.status(202).json({ message: "Lien de réinitialisation envoyé." })
})

export default router
