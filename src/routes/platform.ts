import bcrypt from "bcryptjs"

import { Router } from "express"

import { z } from "zod"

import { authenticate, requireAnyCapability } from "../auth.js"

import { pool } from "../db.js"

import { refreshPlatformRequestLimit } from "../platform-settings.js"

import { roleAccess } from "../role-access.js"

import { writeAuditLog } from "../audit-log.js"

import platformUsersRouter from "./platform-users.js"

import type { AuthenticatedRequest } from "../types.js"

const router = Router()

router.use(authenticate, requireAnyCapability("manage_platform"))

router.use("/users", platformUsersRouter)

router.get("/audit-logs", async (request, response) => {
  const parsed = z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    action: z.string().trim().max(100).optional(),
    tenantId: z.uuid().optional(),
  }).safeParse(request.query)
  if (!parsed.success) {
    response.status(400).json({ error: "Filtres d’audit invalides." })
    return
  }
  const { page, limit, action, tenantId } = parsed.data
  const result = await pool.query(
    `SELECT log.id, log.actor_id AS "actorId", actor.full_name AS "actorName",
            log.actor_role AS "actorRole", log.tenant_id AS "tenantId",
            tenant.name AS "tenantName", log.target_type AS "targetType",
            log.target_id AS "targetId", log.action, log.payload_masked AS "payloadMasked",
            target_user.full_name AS "targetName",
            log.ip, log.user_agent AS "userAgent", log.created_at AS "createdAt"
     FROM audit_logs log
     LEFT JOIN users actor ON actor.id = log.actor_id
     LEFT JOIN tenants tenant ON tenant.id = log.tenant_id
     LEFT JOIN users target_user
       ON log.target_type = 'user' AND target_user.id::text = log.target_id
     WHERE ($1::text IS NULL OR log.action = $1)
       AND ($2::uuid IS NULL OR log.tenant_id = $2)
     ORDER BY log.created_at DESC
     LIMIT $3 OFFSET $4`,
    [action ?? null, tenantId ?? null, limit, (page - 1) * limit],
  )
  response.json({ data: result.rows, page, limit })
})

const tenantSchema = z.object({
  name: z.string().trim().min(2).max(160),

  adminFullName: z.string().trim().min(2).max(120),

  adminEmail: z.email().trim().toLowerCase(),

  phone: z.string().trim().max(30).nullable().optional(),

  temporaryPassword: z.string().min(12).max(128),

  planId: z.uuid(),

  registrationRequestId: z.uuid().optional(),
})

const planSchema = z.object({
  name: z.string().trim().min(2).max(80),

  monthlyPriceFcfa: z.number().int().min(0).max(9_000_000_000_000),

  maxUsers: z.number().int().positive().nullable(),

  maxSites: z.number().int().positive().nullable(),

  maxStorageMb: z.number().int().positive().nullable(),

  active: z.boolean().optional(),
})

const planUpdateSchema = planSchema.partial().refine(
  (plan) => Object.keys(plan).length > 0,
  { message: "Au moins un champ du plan doit être fourni." },
)

const subscriptionSchema = z.object({
  planId: z.uuid(),

  status: z.enum(["Essai", "Actif", "Impayé", "Suspendu", "Résilié"]),

  renewsAt: z.iso.date().nullable(),
})

const registrationRequestStatusSchema = z.object({
  status: z.enum(["Nouvelle", "En cours", "Refusée"]),
})

const invoiceSchema = z.object({
  tenantId: z.uuid(),
  description: z.string().trim().min(2).max(180),
  amountFcfa: z.number().int().positive().max(9_000_000_000_000),
  issuedAt: z.iso.date(),
  dueAt: z.iso.date(),
}).refine((invoice) => invoice.dueAt >= invoice.issuedAt, {
  path: ["dueAt"],
  message: "L’échéance doit être égale ou postérieure à la date d’émission.",
})

const invoiceSettlementSchema = z.object({
  status: z.enum(["Payée", "Annulée"]),
  paymentMethod: z.enum([
    "Espèces",
    "Virement bancaire",
    "Mobile Money",
    "Autre",
  ]).nullable().optional(),
  paymentReference: z.string().trim().max(180).nullable().optional(),
}).refine((settlement) =>
  settlement.status !== "Payée" || Boolean(settlement.paymentMethod), {
  path: ["paymentMethod"],
  message: "Le mode d’encaissement est obligatoire pour enregistrer un paiement.",
})

const ticketSchema = z.object({
  tenantId: z.uuid(),

  subject: z.string().trim().min(2).max(180),

  description: z.string().trim().max(4000).default(""),

  priority: z.enum(["Basse", "Normale", "Haute", "Urgente"]).default("Normale"),
})

const ticketStatusSchema = z.object({
  status: z.enum(["Nouveau", "En cours", "En attente client", "Résolu"]),
})

const platformSettingsSchema = z.object({
  name: z.string().trim().min(2).max(120),

  supportEmail: z.email(),

  requestLimit: z.number().int().min(10).max(10000),
})

function initialsFromName(name: string) {
  return name

    .split(/\s+/)

    .slice(0, 2)

    .map((part) => part[0]!.toLocaleUpperCase("fr-FR"))

    .join("")
}

router.get("/overview", async (_request, response) => {
  const result = await pool.query(
    `SELECT
       (SELECT count(*)::int FROM tenants) AS "tenantCount",
       (SELECT count(*)::int FROM tenants WHERE status = 'Actif') AS "activeTenantCount",
       (SELECT count(*)::int FROM tenants WHERE status = 'Essai') AS "trialTenantCount",
       (SELECT count(*)::int FROM tenants WHERE status = 'Impayé') AS "pastDueTenantCount",
       (SELECT count(*)::int FROM users WHERE tenant_id IS NOT NULL AND active) AS "activeUserCount",
       (SELECT COALESCE(sum(p.monthly_price_fcfa), 0)::text
          FROM tenant_subscriptions s
          JOIN subscription_plans p ON p.id = s.plan_id
         WHERE s.status = 'Actif' AND p.active) AS "monthlyRevenueFcfa",
       (SELECT count(*)::int FROM support_tickets WHERE status != 'Résolu') AS "openTicketCount"`,
  )

  response.json({ data: result.rows[0] })
})

router.get("/tenants", async (_request, response) => {
  const result = await pool.query(
    `SELECT t.id, t.name, t.status, t.created_at AS "createdAt",
            p.id AS "planId", p.name AS "planName",
            s.status AS "subscriptionStatus", s.renews_at AS "renewsAt",
            count(DISTINCT u.id)::int AS "userCount",
            count(DISTINCT site.id)::int AS "siteCount"
     FROM tenants t
     LEFT JOIN tenant_subscriptions s ON s.tenant_id = t.id
     LEFT JOIN subscription_plans p ON p.id = s.plan_id
     LEFT JOIN users u ON u.tenant_id = t.id AND u.active
     LEFT JOIN sites site ON site.tenant_id = t.id
     GROUP BY t.id, p.id, s.status, s.renews_at
     ORDER BY t.created_at DESC, t.name`,
  )

  response.json({ data: result.rows })
})

router.get("/tenants/:id", async (request, response) => {
  const id = z.uuid().safeParse(request.params.id)
  if (!id.success) {
    response.status(400).json({ error: "Identifiant d’entreprise invalide." })
    return
  }
  const result = await pool.query(
    `SELECT t.id, t.name, t.status, t.created_at AS "createdAt",
            p.id AS "planId", p.name AS "planName",
            s.status AS "subscriptionStatus", s.renews_at AS "renewsAt",
            (SELECT count(*)::int FROM users u WHERE u.tenant_id = t.id AND u.active) AS "userCount",
            (SELECT count(*)::int FROM sites x WHERE x.tenant_id = t.id) AS "siteCount",
            (SELECT count(*)::int FROM sites x WHERE x.tenant_id = t.id AND x.status <> 'Archivé') AS "activeSiteCount"
     FROM tenants t
     LEFT JOIN tenant_subscriptions s ON s.tenant_id = t.id
     LEFT JOIN subscription_plans p ON p.id = s.plan_id
     WHERE t.id = $1`,
    [id.data],
  )
  if (!result.rowCount) {
    response.status(404).json({ error: "Entreprise introuvable." })
    return
  }
  response.json({ data: result.rows[0] })
})

const tenantUpdateSchema = z.object({
  name: z.string().trim().min(2).max(160).optional(),
  status: z.enum(["Actif", "Essai", "Impayé", "Suspendu", "Archivé"]).optional(),
}).refine((value) => value.name !== undefined || value.status !== undefined)

router.patch("/tenants/:id", async (request, response) => {
  const id = z.uuid().safeParse(request.params.id)
  const parsed = tenantUpdateSchema.safeParse(request.body)
  if (!id.success || !parsed.success) {
    response.status(400).json({ error: "Mise à jour d’entreprise invalide." })
    return
  }
  const editor = (request as AuthenticatedRequest).authUser
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    const result = await client.query(
      `UPDATE tenants SET name = COALESCE($2, name), status = COALESCE($3, status)
       WHERE id = $1 RETURNING id, name, status`,
      [id.data, parsed.data.name ?? null, parsed.data.status ?? null],
    )
    if (!result.rowCount) {
      await client.query("ROLLBACK")
      response.status(404).json({ error: "Entreprise introuvable." })
      return
    }
    await writeAuditLog(client, request, {
      actorId: editor.id, actorRole: editor.role, tenantId: id.data,
      targetType: "tenant", targetId: id.data, action: "TENANT_UPDATED",
      payloadMasked: parsed.data,
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

router.get("/registration-requests", async (_request, response) => {
  const result = await pool.query(
    `SELECT id, company_name AS "companyName",
            admin_full_name AS "adminFullName", admin_email AS "adminEmail",
            phone, message, status, created_at AS "createdAt",
            updated_at AS "updatedAt"
     FROM registration_requests
     ORDER BY CASE status
                WHEN 'Nouvelle' THEN 0
                WHEN 'En cours' THEN 1
                ELSE 2
              END,
              created_at DESC`,
  )

  response.json({ data: result.rows })
})

router.patch("/registration-requests/:id", async (request, response) => {
  const id = z.uuid().safeParse(request.params.id)
  const parsed = registrationRequestStatusSchema.safeParse(request.body)

  if (!id.success || !parsed.success) {
    response.status(400).json({ error: "Demande ou statut invalide." })
    return
  }

  const editor = (request as AuthenticatedRequest).authUser
  const result = await pool.query(
    `UPDATE registration_requests
     SET status = $2, reviewed_by = $3, updated_at = now()
     WHERE id = $1 AND status != 'Entreprise créée'
     RETURNING id, status, updated_at AS "updatedAt"`,
    [id.data, parsed.data.status, editor.id],
  )

  if (!result.rowCount) {
    const existing = await pool.query(
      "SELECT status FROM registration_requests WHERE id = $1",
      [id.data],
    )
    if (!existing.rowCount) {
      response.status(404).json({ error: "Demande introuvable." })
      return
    }
    response.status(409).json({
      error: "Une demande convertie en entreprise ne peut plus être modifiée.",
    })
    return
  }

  response.json({ data: result.rows[0] })
})

router.get("/invoices", async (_request, response) => {
  const result = await pool.query(
    `SELECT i.id, i.invoice_number AS "invoiceNumber",
            i.tenant_id AS "tenantId", t.name AS "tenantName",
            i.description, i.amount_fcfa AS "amountFcfa",
            i.issued_at AS "issuedAt", i.due_at AS "dueAt", i.status,
            i.payment_method AS "paymentMethod",
            i.payment_reference AS "paymentReference", i.paid_at AS "paidAt",
                 u.full_name AS "closedBy",
            i.created_at AS "createdAt"
     FROM platform_invoices i
     JOIN tenants t ON t.id = i.tenant_id
               LEFT JOIN users u ON u.id = i.closed_by
     ORDER BY CASE i.status WHEN 'À payer' THEN 0 ELSE 1 END,
              i.due_at ASC, i.created_at DESC`,
  )

  response.json({ data: result.rows })
})

router.post("/invoices", async (request, response) => {
  const parsed = invoiceSchema.safeParse(request.body)
  if (!parsed.success) {
    response.status(400).json({
      error: "Données de facture invalides.",
      details: parsed.error.flatten().fieldErrors,
    })
    return
  }

  const invoiceNumber = await pool.query<{ invoiceNumber: string }>(
    `SELECT 'CC-' || to_char(CURRENT_DATE, 'YYYY') || '-' ||
            lpad(nextval('platform_invoice_number_seq')::text, 6, '0') AS "invoiceNumber"`,
  )
  const editor = (request as AuthenticatedRequest).authUser
  const input = parsed.data
  const result = await pool.query(
    `WITH created AS (
       INSERT INTO platform_invoices (
         invoice_number, tenant_id, description, amount_fcfa,
         issued_at, due_at, created_by
       )
       SELECT $1, t.id, $3, $4, $5, $6, $7
       FROM tenants t
       WHERE t.id = $2
       RETURNING *
     )
     SELECT i.id, i.invoice_number AS "invoiceNumber",
            i.tenant_id AS "tenantId", t.name AS "tenantName",
            i.description, i.amount_fcfa AS "amountFcfa",
            i.issued_at AS "issuedAt", i.due_at AS "dueAt", i.status,
            i.payment_method AS "paymentMethod",
            i.payment_reference AS "paymentReference", i.paid_at AS "paidAt",
            i.created_at AS "createdAt"
     FROM created i
     JOIN tenants t ON t.id = i.tenant_id`,
    [
      invoiceNumber.rows[0]!.invoiceNumber,
      input.tenantId,
      input.description,
      input.amountFcfa,
      input.issuedAt,
      input.dueAt,
      editor.id,
    ],
  )

  if (!result.rowCount) {
    response.status(404).json({ error: "Entreprise introuvable." })
    return
  }

  response.status(201).json({ data: result.rows[0] })
})

router.patch("/invoices/:id/status", async (request, response) => {
  const id = z.uuid().safeParse(request.params.id)
  const parsed = invoiceSettlementSchema.safeParse(request.body)
  if (!id.success || !parsed.success) {
    response.status(400).json({ error: "Facture ou règlement invalide." })
    return
  }

  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    const current = await client.query<{ status: string }>(
      "SELECT status FROM platform_invoices WHERE id = $1 FOR UPDATE",
      [id.data],
    )
    if (!current.rowCount) {
      await client.query("ROLLBACK")
      response.status(404).json({ error: "Facture introuvable." })
      return
    }
    if (current.rows[0]!.status !== "À payer") {
      await client.query("ROLLBACK")
      response.status(409).json({ error: "Cette facture a déjà été clôturée." })
      return
    }

    const settlement = parsed.data
    const editor = (request as AuthenticatedRequest).authUser
    const result = await client.query(
      `UPDATE platform_invoices
       SET status = $2, payment_method = $3, payment_reference = $4,
           paid_at = CASE WHEN $2 = 'Payée' THEN now() ELSE NULL END,
           closed_by = $5, updated_at = now()
       WHERE id = $1
       RETURNING id, status, payment_method AS "paymentMethod",
                 payment_reference AS "paymentReference", paid_at AS "paidAt"`,
      [
        id.data,
        settlement.status,
        settlement.status === "Payée" ? settlement.paymentMethod : null,
        settlement.status === "Payée" ? settlement.paymentReference ?? null : null,
        editor.id,
      ],
    )
    await client.query("COMMIT")
    response.json({ data: result.rows[0] })
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }
})

router.post("/tenants", async (request, response) => {
  const parsed = tenantSchema.safeParse(request.body)

  if (!parsed.success) {
    response.status(400).json({
      error: "Données de l’entreprise invalides.",
      details: parsed.error.flatten().fieldErrors,
    })

    return
  }

  const input = parsed.data

  const editor = (request as AuthenticatedRequest).authUser

  const passwordHash = await bcrypt.hash(input.temporaryPassword, 12)

  const client = await pool.connect()

  try {
    await client.query("BEGIN")

    if (input.registrationRequestId) {
      const registrationRequest = await client.query(
        `SELECT id FROM registration_requests
         WHERE id = $1 AND tenant_id IS NULL AND status IN ('Nouvelle', 'En cours')
         FOR UPDATE`,
        [input.registrationRequestId],
      )

      if (!registrationRequest.rowCount) {
        await client.query("ROLLBACK")
        response.status(409).json({
          error: "Cette demande a déjà été traitée ou n’est plus disponible.",
        })
        return
      }
    }

    const planResult = await client.query(
      "SELECT id, name FROM subscription_plans WHERE id = $1 AND active",
      [input.planId],
    )

    const plan = planResult.rows[0]

    if (!plan) {
      await client.query("ROLLBACK")
      response.status(400).json({
        error: "Le plan choisi est introuvable ou inactif.",
      })
      return
    }

    const tenantResult = await client.query(
      `INSERT INTO tenants (name, plan, status)
       VALUES ($1, $2, 'Essai')
       RETURNING id, name, plan, status, created_at AS "createdAt"`,

      [input.name, plan.name],
    )

    const tenant = tenantResult.rows[0]

    await client.query(
      `INSERT INTO tenant_settings (tenant_id, legal_name)
       VALUES ($1, $2)`,
      [tenant.id, tenant.name],
    )

    await client.query(
      `INSERT INTO users (
         tenant_id, email, phone, password_hash, must_change_password,
         full_name, initials, role,
         role_label, tenant_name, tenant_plan, sections, capabilities
       )
       VALUES ($1, $2, $3, $4, true, $5, $6, 'ADMIN_ENTERPRISE', $7, $8, $9, $10, $11)`,

      [
        tenant.id,

        input.adminEmail,

        input.phone || null,

        passwordHash,

        input.adminFullName,

        initialsFromName(input.adminFullName),

        roleAccess.ADMIN_ENTERPRISE.label,

        tenant.name,

        tenant.plan,

        JSON.stringify(roleAccess.ADMIN_ENTERPRISE.sections),

        JSON.stringify(roleAccess.ADMIN_ENTERPRISE.capabilities),
      ],
    )

    await client.query(
      `INSERT INTO tenant_subscriptions (tenant_id, plan_id, status, renews_at)
       VALUES ($1, $2, 'Essai', CURRENT_DATE + 14)`,

      [tenant.id, plan.id],
    )

    if (input.registrationRequestId) {
      const linked = await client.query(
        `UPDATE registration_requests
         SET status = 'Entreprise créée', reviewed_by = $2, tenant_id = $3, updated_at = now()
         WHERE id = $1 AND tenant_id IS NULL AND status IN ('Nouvelle', 'En cours')`,
        [input.registrationRequestId, editor.id, tenant.id],
      )
      if (!linked.rowCount) {
        await client.query("ROLLBACK")
        response.status(409).json({ error: "Cette demande a déjà été convertie." })
        return
      }
    }

    await writeAuditLog(client, request, {
      actorId: editor.id,
      actorRole: editor.role,
      tenantId: tenant.id,
      targetType: "tenant",
      targetId: tenant.id,
      action: "TENANT_CREATED",
      payloadMasked: {
        name: tenant.name,
        registrationRequestId: input.registrationRequestId ?? null,
      },
    })

    await client.query("COMMIT")

    response.status(201).json({ data: tenant, adminEmail: input.adminEmail })
  } catch (error) {
    await client.query("ROLLBACK")

    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "23505"
    ) {
      response.status(409).json({
        error: "Une entreprise ou un compte utilise déjà ces informations.",
      })

      return
    }

    throw error
  } finally {
    client.release()
  }
})

router.patch("/tenants/:id/subscription", async (request, response) => {
  const id = z.uuid().safeParse(request.params.id)

  const parsed = subscriptionSchema.safeParse(request.body)

  if (!id.success || !parsed.success) {
    response.status(400).json({ error: "Entreprise ou abonnement invalide." })

    return
  }

  const { planId, status, renewsAt } = parsed.data
  const requiresActivePlan = status === "Actif" || status === "Essai"

  const editor = (request as AuthenticatedRequest).authUser

  const client = await pool.connect()

  try {
    await client.query("BEGIN")

    const plan = await client.query(
      `SELECT name FROM subscription_plans
       WHERE id = $1 AND ($2::boolean = false OR active)`,
      [planId, requiresActivePlan],
    )

    if (!plan.rowCount) {
      await client.query("ROLLBACK")

      response
        .status(400)
        .json({ error: "Le plan choisi est introuvable ou inactif." })

      return
    }

    if (requiresActivePlan) {
      const validity = await client.query<{ valid: boolean }>(
        "SELECT $1::date >= CURRENT_DATE AS valid",
        [renewsAt],
      )
      if (!validity.rows[0]?.valid) {
        await client.query("ROLLBACK")
        response.status(400).json({
          error: "Une date de fin de validité égale ou postérieure à aujourd’hui est obligatoire pour activer l’abonnement.",
        })
        return
      }
    }

    const tenant = await client.query(
      `UPDATE tenants SET plan = $2, status = CASE WHEN status = 'Archivé' THEN status ELSE $3 END
       WHERE id = $1 RETURNING id`,

      [id.data, plan.rows[0].name, status === "Résilié" ? "Suspendu" : status],
    )

    if (!tenant.rowCount) {
      await client.query("ROLLBACK")

      response.status(404).json({ error: "Entreprise introuvable." })

      return
    }

    const subscription = await client.query(
      `INSERT INTO tenant_subscriptions (tenant_id, plan_id, status, renews_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id) DO UPDATE SET
         plan_id = EXCLUDED.plan_id, status = EXCLUDED.status,
         renews_at = EXCLUDED.renews_at,
         updated_at = now()
       RETURNING tenant_id AS "tenantId", plan_id AS "planId",
                 status, renews_at AS "renewsAt"`,

      [id.data, planId, status, renewsAt],
    )

    await writeAuditLog(client, request, {
      actorId: editor.id,
      actorRole: editor.role,
      tenantId: id.data,
      targetType: "tenant_subscription",
      targetId: id.data,
      action: "TENANT_SUBSCRIPTION_UPDATED",
      payloadMasked: { planId, status, renewsAt },
    })

    await client.query("COMMIT")

    response.json({ data: subscription.rows[0] })
  } catch (error) {
    await client.query("ROLLBACK")

    throw error
  } finally {
    client.release()
  }
})

router.get("/plans", async (_request, response) => {
  const result = await pool.query(
    `SELECT p.id, p.name, p.monthly_price_fcfa AS "monthlyPriceFcfa",
            p.max_users AS "maxUsers", p.max_sites AS "maxSites",
            p.max_storage_mb AS "maxStorageMb",
            p.active, count(s.tenant_id)::int AS "subscriberCount"
     FROM subscription_plans p
     LEFT JOIN tenant_subscriptions s ON s.plan_id = p.id AND s.status != 'Résilié'
     GROUP BY p.id
     ORDER BY p.monthly_price_fcfa, p.name`,
  )

  response.json({ data: result.rows })
})

router.post("/plans", async (request, response) => {
  const parsed = planSchema.safeParse(request.body)

  if (!parsed.success) {
    response.status(400).json({
      error: "Données du plan invalides.",
      details: parsed.error.flatten().fieldErrors,
    })

    return
  }

  try {
    const plan = parsed.data

    const result = await pool.query(
      `INSERT INTO subscription_plans (name, monthly_price_fcfa, max_users, max_sites, max_storage_mb, active)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, name, monthly_price_fcfa AS "monthlyPriceFcfa",
                 max_users AS "maxUsers", max_sites AS "maxSites",
                 max_storage_mb AS "maxStorageMb", active`,

      [
        plan.name,
        plan.monthlyPriceFcfa,
        plan.maxUsers,
        plan.maxSites,
        plan.maxStorageMb,
        plan.active ?? true,
      ],
    )

    response.status(201).json({ data: result.rows[0] })
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "23505"
    ) {
      response.status(409).json({ error: "Un plan porte déjà ce nom." })

      return
    }

    throw error
  }
})

router.patch("/plans/:id", async (request, response) => {
  const id = z.uuid().safeParse(request.params.id)

  const parsed = planUpdateSchema.safeParse(request.body)

  if (!id.success || !parsed.success) {
    response.status(400).json({ error: "Données du plan invalides." })

    return
  }

  try {
    const plan = parsed.data

    const editor = (request as AuthenticatedRequest).authUser
    const client = await pool.connect()
    let result
    try {
      await client.query("BEGIN")
      result = await client.query(
      `UPDATE subscription_plans
       SET name = CASE WHEN $2::boolean THEN $3 ELSE name END,
           monthly_price_fcfa = CASE WHEN $4::boolean THEN $5 ELSE monthly_price_fcfa END,
           max_users = CASE WHEN $6::boolean THEN $7::integer ELSE max_users END,
           max_sites = CASE WHEN $8::boolean THEN $9::integer ELSE max_sites END,
           active = CASE WHEN $10::boolean THEN $11 ELSE active END,
           max_storage_mb = CASE WHEN $12::boolean THEN $13::integer ELSE max_storage_mb END
       WHERE id = $1
       RETURNING id, name, monthly_price_fcfa AS "monthlyPriceFcfa",
                 max_users AS "maxUsers", max_sites AS "maxSites",
                 max_storage_mb AS "maxStorageMb", active`,

      [
        id.data,
        plan.name !== undefined,
        plan.name ?? null,
        plan.monthlyPriceFcfa !== undefined,
        plan.monthlyPriceFcfa ?? null,
        plan.maxUsers !== undefined,
        plan.maxUsers ?? null,
        plan.maxSites !== undefined,
        plan.maxSites ?? null,
        plan.active !== undefined,
        plan.active ?? null,
        plan.maxStorageMb !== undefined,
        plan.maxStorageMb ?? null,
      ],
    )

      if (!result.rowCount) {
        await client.query("ROLLBACK")
        response.status(404).json({ error: "Plan introuvable." })
        return
      }

      await writeAuditLog(client, request, {
        actorId: editor.id,
        actorRole: editor.role,
        targetType: "subscription_plan",
        targetId: id.data,
        action: "SUBSCRIPTION_PLAN_UPDATED",
        payloadMasked: plan,
      })
      await client.query("COMMIT")

      response.json({ data: result.rows[0] })
    } catch (error) {
      await client.query("ROLLBACK")
      throw error
    } finally {
      client.release()
    }
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "23505"
    ) {
      response.status(409).json({ error: "Un plan porte déjà ce nom." })

      return
    }

    throw error
  }
})

router.get("/tickets", async (_request, response) => {
  const result = await pool.query(
    `SELECT t.id, t.tenant_id AS "tenantId", n.name AS "tenantName",
            t.subject, t.description, t.priority, t.status,
            t.created_at AS "createdAt", t.updated_at AS "updatedAt",
            t.resolved_at AS "resolvedAt"
     FROM support_tickets t
     JOIN tenants n ON n.id = t.tenant_id
     ORDER BY CASE t.status WHEN 'Nouveau' THEN 0 WHEN 'En cours' THEN 1
                            WHEN 'En attente client' THEN 2 ELSE 3 END,
              t.created_at DESC`,
  )

  response.json({ data: result.rows })
})

router.post("/tickets", async (request, response) => {
  const parsed = ticketSchema.safeParse(request.body)

  if (!parsed.success) {
    response.status(400).json({
      error: "Données du ticket invalides.",
      details: parsed.error.flatten().fieldErrors,
    })

    return
  }

  const ticket = parsed.data

  const editor = (request as AuthenticatedRequest).authUser

  const result = await pool.query(
    `INSERT INTO support_tickets (tenant_id, created_by, subject, description, priority)
     SELECT id, $2, $3, $4, $5 FROM tenants WHERE id = $1
     RETURNING id, tenant_id AS "tenantId", subject, description, priority, status,
               created_at AS "createdAt", updated_at AS "updatedAt"`,

    [
      ticket.tenantId,
      editor.id,
      ticket.subject,
      ticket.description,
      ticket.priority,
    ],
  )

  if (!result.rowCount) {
    response.status(404).json({ error: "Entreprise introuvable." })

    return
  }

  response.status(201).json({ data: result.rows[0] })
})

router.patch("/tickets/:id/status", async (request, response) => {
  const id = z.uuid().safeParse(request.params.id)

  const parsed = ticketStatusSchema.safeParse(request.body)

  if (!id.success || !parsed.success) {
    response
      .status(400)
      .json({ error: "Statut ou identifiant de ticket invalide." })

    return
  }

  const result = await pool.query(
    `UPDATE support_tickets
     SET status = $2, updated_at = now(),
         resolved_at = CASE WHEN $2 = 'Résolu' THEN now() ELSE NULL END
     WHERE id = $1
     RETURNING id, status, updated_at AS "updatedAt", resolved_at AS "resolvedAt"`,

    [id.data, parsed.data.status],
  )

  if (!result.rowCount) {
    response.status(404).json({ error: "Ticket introuvable." })

    return
  }

  response.json({ data: result.rows[0] })
})

router.get("/settings", async (_request, response) => {
  const result = await pool.query(
    `SELECT name, support_email AS "supportEmail",
            request_limit AS "requestLimit", updated_at AS "updatedAt"
     FROM platform_settings WHERE singleton = true`,
  )

  const settings = result.rows[0]

  if (!settings) {
    response
      .status(404)
      .json({ error: "Paramètres de la plateforme introuvables." })

    return
  }

  response.json({ data: settings })
})

router.put("/settings", async (request, response) => {
  const parsed = platformSettingsSchema.safeParse(request.body)

  if (!parsed.success) {
    response.status(400).json({
      error: "Paramètres de la plateforme invalides.",
      details: parsed.error.flatten().fieldErrors,
    })

    return
  }

  const settings = parsed.data

  const result = await pool.query(
    `UPDATE platform_settings
     SET name = $1, support_email = $2, request_limit = $3, updated_at = now()
     WHERE singleton = true
     RETURNING name, support_email AS "supportEmail",
               request_limit AS "requestLimit", updated_at AS "updatedAt"`,

    [settings.name, settings.supportEmail, settings.requestLimit],
  )

  if (!result.rowCount) {
    response
      .status(404)
      .json({ error: "Paramètres de la plateforme introuvables." })

    return
  }

  refreshPlatformRequestLimit(settings.requestLimit)

  response.json({ data: result.rows[0] })
})

export default router
