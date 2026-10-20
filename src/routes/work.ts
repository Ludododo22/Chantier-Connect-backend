import bcrypt from "bcryptjs"

import { createHash } from "node:crypto"

import { Router } from "express"

import { z } from "zod"

import type { QueryResult } from "pg"

import { authenticate, requireAnyCapability, requireTenant } from "../auth.js"

import { pool } from "../db.js"

import { writeAuditLog } from "../audit-log.js"
import { tenantStorageCapacity } from "../storage.js"

import { roleAccess, siteScopedRoles } from "../role-access.js"

import type { AuthenticatedRequest, UserRole } from "../types.js"

const router = Router()

router.use(authenticate)

router.get(
  "/activity/recent",
  requireAnyCapability("read_company", "read_assigned", "read_team"),
  async (request, response) => {
    const userRequest = request as AuthenticatedRequest
    const tenantId = requireTenant(userRequest, response)
    if (!tenantId) return

    const result = await pool.query(
      `SELECT activity.kind, activity.title, activity.detail,
    activity.site_name AS "siteName",
    activity.occurred_at AS "occurredAt"
  FROM (
    SELECT 'Tâche' AS kind, t.title, t.status AS detail,
      s.name AS site_name, t.created_at AS occurred_at
    FROM tasks t
    JOIN sites s ON s.id = t.site_id AND s.tenant_id = t.tenant_id
    WHERE t.tenant_id = $1 AND ($3::boolean OR t.created_by = $2)
    UNION ALL
    SELECT 'Rapport', 'Rapport journalier', r.status,
      s.name, r.created_at
    FROM reports r
    JOIN sites s ON s.id = r.site_id AND s.tenant_id = r.tenant_id
    WHERE r.tenant_id = $1 AND ($3::boolean OR r.author_id = $2)
    UNION ALL
    SELECT 'Photo', p.caption, 'Photo ajoutée',
      s.name, p.created_at
    FROM photos p
    JOIN sites s ON s.id = p.site_id AND s.tenant_id = p.tenant_id
    WHERE p.tenant_id = $1 AND ($3::boolean OR p.author_id = $2)
    UNION ALL
    SELECT 'Pointage', 'Pointage chantier',
      CASE WHEN a.clock_out_at IS NULL THEN 'Entrée enregistrée' ELSE 'Journée clôturée' END,
      s.name, a.clock_in_at
    FROM attendance_records a
    JOIN sites s ON s.id = a.site_id AND s.tenant_id = a.tenant_id
    WHERE a.tenant_id = $1 AND ($3::boolean OR a.user_id = $2)
    UNION ALL
    SELECT 'Finance', f.description,
      CASE f.entry_type WHEN 'encaissement' THEN 'Encaissement' WHEN 'depense' THEN 'Dépense' ELSE 'Engagement' END,
      s.name, f.created_at
    FROM finance_entries f
    JOIN sites s ON s.id = f.site_id AND s.tenant_id = f.tenant_id
    WHERE f.tenant_id = $1 AND ($3::boolean OR f.created_by = $2)
    UNION ALL
    SELECT 'Dossier de paiement', d.subject, d.status,
      s.name, d.created_at
    FROM payment_dossiers d
    JOIN sites s ON s.id = d.site_id AND s.tenant_id = d.tenant_id
    WHERE d.tenant_id = $1 AND ($3::boolean OR d.created_by = $2)
  ) activity
  ORDER BY activity.occurred_at DESC
  LIMIT 8`,
      [
        tenantId,
        userRequest.authUser.id,
        userRequest.authUser.role === "ADMIN_ENTERPRISE",
      ],
    )

    response.json({ data: result.rows })
  },
)

router.get(
  "/company/settings",

  requireAnyCapability("manage_company"),

  async (request, response) => {
    const userRequest = request as AuthenticatedRequest

    const tenantId = requireTenant(userRequest, response)

    if (!tenantId) return

    const result = await pool.query(
      `SELECT legal_name AS "legalName", tax_id AS "taxId", email, phone,
              address, city, country, language, currency, preferences,
              updated_at AS "updatedAt"
       FROM tenant_settings WHERE tenant_id = $1`,

      [tenantId],
    )

    const settings = result.rows[0]

    if (!settings) {
      response
        .status(404)
        .json({ error: "Paramètres de l’entreprise introuvables." })

      return
    }

    response.json({ data: settings })
  },
)

router.put(
  "/company/settings",

  requireAnyCapability("manage_company"),

  async (request, response) => {
    const userRequest = request as AuthenticatedRequest

    const tenantId = requireTenant(userRequest, response)

    if (!tenantId) return

    const parsed = tenantSettingsSchema.safeParse(request.body)

    if (!parsed.success) {
      response.status(400).json({
        error: "Paramètres de l’entreprise invalides.",
        details: parsed.error.flatten().fieldErrors,
      })

      return
    }

    const settings = parsed.data

    const result = await pool.query(
      `INSERT INTO tenant_settings (
         tenant_id, legal_name, tax_id, email, phone, address, city, country,
         language, currency, preferences, updated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())
       ON CONFLICT (tenant_id) DO UPDATE SET
         legal_name = EXCLUDED.legal_name, tax_id = EXCLUDED.tax_id,
         email = EXCLUDED.email, phone = EXCLUDED.phone,
         address = EXCLUDED.address, city = EXCLUDED.city,
         country = EXCLUDED.country, language = EXCLUDED.language,
         currency = EXCLUDED.currency, preferences = EXCLUDED.preferences,
         updated_at = now()
       RETURNING legal_name AS "legalName", tax_id AS "taxId", email, phone,
                 address, city, country, language, currency, preferences,
                 updated_at AS "updatedAt"`,

      [
        tenantId,
        settings.legalName,
        settings.taxId,
        settings.email,

        settings.phone,
        settings.address,
        settings.city,
        settings.country,

        settings.language,
        settings.currency,
        JSON.stringify(settings.preferences),
      ],
    )

    response.json({ data: result.rows[0] })
  },
)

const siteSchema = z.object({
  name: z.string().trim().min(2).max(120),

  location: z.string().trim().min(2).max(160),

  status: z.enum(["En cours", "En pause", "Terminé", "Archivé"]).default("En cours"),

  progress: z.number().int().min(0).max(100).default(0),

  budgetFcfa: z.number().int().min(0).max(9_000_000_000_000).default(0),

  startDate: z.iso.date().nullable().optional(),

  endDate: z.iso.date().nullable().optional(),
})

const taskSchema = z.object({
  siteId: z.uuid(),

  title: z.string().trim().min(2).max(180),

  description: z.string().trim().max(4000).default(""),

  category: z.string().trim().min(1).max(80).default("Général"),

  priority: z.enum(["Basse", "Normale", "Haute", "Urgente"]).default("Normale"),

  status: z
    .enum(["À faire", "En cours", "Terminée", "Bloquée"])
    .default("À faire"),

  dueDate: z.iso.date().nullable().optional(),

  assignedTo: z.uuid().nullable().optional(),
})

const taskStatusSchema = z.object({
  status: z.enum(["À faire", "En cours", "Terminée", "Bloquée"]),
})

const reportSchema = z.object({
  siteId: z.uuid(),

  workDone: z.string().trim().min(2).max(8000),

  crewCount: z.number().int().min(0).max(500),

  reportDate: z.iso.date().optional(),
})

const photoSchema = z.object({
  siteId: z.uuid(),

  caption: z.string().trim().min(2).max(240),

  contentType: z.enum(["image/jpeg", "image/png", "image/webp"]),

  imageBase64: z.string().min(1).max(2_800_000),

  latitude: z.number().min(-90).max(90).nullable().optional(),

  longitude: z.number().min(-180).max(180).nullable().optional(),

  capturedAt: z.iso.datetime().optional(),
})

const attendanceSchema = z.object({
  latitude: z.number().min(-90).max(90).nullable().optional(),

  longitude: z.number().min(-180).max(180).nullable().optional(),
})

const financeSchema = z.object({
  entryType: z.enum(["engagement", "encaissement", "depense"]),

  siteId: z.uuid(),

  category: z.string().trim().min(2).max(100),

  description: z.string().trim().min(2).max(240),

  amountFcfa: z.number().int().positive().max(9_000_000_000_000),

  dueDate: z.iso.date().nullable().optional(),
})

const financeStatusSchema = z.object({
  status: z.literal("réalisé"),
})

const tenantSettingsSchema = z.object({
  legalName: z.string().trim().min(2).max(160),

  taxId: z.string().trim().max(60),

  email: z.email().or(z.literal("")),

  phone: z.string().trim().max(30),

  address: z.string().trim().max(240),

  city: z.string().trim().max(100),

  country: z.string().trim().min(2).max(80),

  language: z.literal("fr"),

  currency: z.literal("XAF"),

  preferences: z.record(z.string(), z.boolean()).default({}),
})

const managedRoleSchema = z.enum([
  "CONDUCTEUR",

  "CHEF_CHANTIER",

  "COMPAGNON",

  "SOUS_TRAITANT",

  "COMPTABLE",

  "MAITRE_OUVRAGE",
])

const createMemberSchema = z.object({
  fullName: z.string().trim().min(2).max(120),

  email: z.email().trim().toLowerCase(),

  phone: z
    .string()
    .trim()
    .min(7)
    .max(30)
    .nullable()
    .optional()
    .or(z.literal("")),

  role: managedRoleSchema,

  assignedSiteId: z.uuid().nullable().optional(),

  assignedSite: z.string().trim().min(2).max(120).nullable().optional(),

  temporaryPassword: z.string().min(12).max(128),
})

const updateMemberSchema = z.object({
  role: managedRoleSchema,

  assignedSiteId: z.uuid().nullable().optional(),

  assignedSite: z.string().trim().min(2).max(120).nullable().optional(),

  active: z.boolean(),
})

const teamProfileSchema = z.object({
  fullName: z.string().trim().min(2).max(120),
  email: z.email().trim().toLowerCase(),
  phone: z.string().trim().min(7).max(30).nullable(),
})

function initialsFromName(name: string) {
  return name

    .split(/\s+/)

    .slice(0, 2)

    .map((part) => part[0]!.toLocaleUpperCase("fr-FR"))

    .join("")
}

async function findAssignedSite(
  tenantId: string,
  siteId: string | null | undefined,
  legacyName: string | null | undefined,
) {
  if (siteId) {
    const result = await pool.query<{ id: string; name: string }>(
      `SELECT id, name FROM sites WHERE id = $1 AND tenant_id = $2 AND status <> 'Archivé'`,
      [siteId, tenantId],
    )
    return result.rows[0] ?? null
  }
  if (!legacyName) return null
  const result = await pool.query<{ id: string; name: string }>(
    `SELECT id, name FROM sites WHERE tenant_id = $1 AND name = $2 AND status <> 'Archivé' ORDER BY created_at LIMIT 2`,
    [tenantId, legacyName.trim()],
  )
  return result.rowCount === 1 ? result.rows[0]! : null
}

router.get(
  "/team",

  requireAnyCapability("manage_team", "read_team"),

  async (request, response) => {
    const userRequest = request as AuthenticatedRequest

    const tenantId = requireTenant(userRequest, response)

    if (!tenantId) return

    const canReadAll =
      userRequest.authUser.capabilities.includes("read_company")

    const result = await pool.query(
      `SELECT u.id, u.email, u.phone, u.full_name AS "fullName",
              u.initials, u.role, u.role_label AS "roleLabel",
              COALESCE(assigned.name, u.assigned_site) AS "assignedSite",
              u.assigned_site_id AS "assignedSiteId", u.active,
              u.created_at AS "createdAt"
       FROM users u
       LEFT JOIN sites assigned
         ON assigned.id = u.assigned_site_id AND assigned.tenant_id = u.tenant_id
       WHERE u.tenant_id = $1
         AND ($5::boolean OR u.active = true)
         AND (
              $2::boolean
              OR u.id = $3
              OR ($4::uuid IS NOT NULL AND u.assigned_site_id = $4)
         )
       ORDER BY u.active DESC, u.full_name`,

      [
        tenantId,

        canReadAll,

        userRequest.authUser.id,

        userRequest.authUser.assignedSiteId,

        userRequest.authUser.capabilities.includes("manage_team"),
      ],
    )

    response.json({ data: result.rows })
  },
)

router.post(
  "/team",

  requireAnyCapability("manage_team"),

  async (request, response) => {
    const userRequest = request as AuthenticatedRequest

    const tenantId = requireTenant(userRequest, response)

    if (!tenantId) return

    const parsed = createMemberSchema.safeParse(request.body)

    if (!parsed.success) {
      response.status(400).json({
        error: "Données du membre invalides.",

        details: parsed.error.flatten().fieldErrors,
      })

      return
    }

    const member = parsed.data

    const access = roleAccess[member.role]

    const assignedSite = await findAssignedSite(
      tenantId,
      member.assignedSiteId,
      member.assignedSite ?? null,
    )

    const siteRequired = siteScopedRoles.includes(member.role)

    if ((siteRequired || member.assignedSiteId || member.assignedSite) && !assignedSite) {
      response
        .status(400)
        .json({ error: "Le chantier doit appartenir à cette entreprise et être sélectionné sans ambiguïté." })

      return
    }

    const passwordHash = await bcrypt.hash(member.temporaryPassword, 12)

    const client = await pool.connect()
    try {
      await client.query("BEGIN")
      await client.query("SELECT id FROM tenants WHERE id = $1 FOR UPDATE", [tenantId])
      const plan = await client.query<{ max_users: number | null }>(
        `SELECT p.max_users FROM tenant_subscriptions ts
         JOIN subscription_plans p ON p.id = ts.plan_id WHERE ts.tenant_id = $1`,
        [tenantId],
      )
      const userCount = await client.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM users WHERE tenant_id = $1 AND active",
        [tenantId],
      )
      if (plan.rows[0]?.max_users !== null && plan.rows[0]?.max_users !== undefined && userCount.rows[0]!.count >= plan.rows[0].max_users) {
        await client.query("ROLLBACK")
        response.status(409).json({ error: "La limite d’utilisateurs de votre offre est atteinte." })
        return
      }
      const result = await client.query(
        `INSERT INTO users (
           tenant_id, email, phone, password_hash, must_change_password,
           full_name, initials,
           role, role_label, tenant_name, tenant_plan, assigned_site, assigned_site_id,
           sections, capabilities
         )
         VALUES ($1, $2, $3, $4, true, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         RETURNING id, email, phone, full_name AS "fullName", initials,
                   role, role_label AS "roleLabel", assigned_site AS "assignedSite",
                   assigned_site_id AS "assignedSiteId",
                   active, created_at AS "createdAt"`,

        [
          tenantId,

          member.email,

          member.phone || null,

          passwordHash,

          member.fullName,

          initialsFromName(member.fullName),

          member.role,

          access.label,

          userRequest.authUser.tenantName,

          userRequest.authUser.tenantPlan,

          assignedSite?.name ?? null,

          assignedSite?.id ?? null,

          JSON.stringify(access.sections),

          JSON.stringify(access.capabilities),
        ],
      )

      await writeAuditLog(client, request, {
        actorId: userRequest.authUser.id,
        actorRole: userRequest.authUser.role,
        tenantId,
        targetType: "user",
        targetId: result.rows[0].id,
        action: "TEAM_MEMBER_CREATED",
        payloadMasked: { role: member.role, assignedSiteId: assignedSite?.id ?? null },
      })
      await client.query("COMMIT")
      response.status(201).json({ data: result.rows[0] })
    } catch (error) {
      await client.query("ROLLBACK")
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "23505"
      ) {
        response
          .status(409)
          .json({ error: "Un compte utilise déjà cet email ou ce numéro." })

        return
      }

      throw error
    } finally {
      client.release()
    }
  },
)

router.patch(
  "/team/:id",

  requireAnyCapability("manage_team"),

  async (request, response) => {
    const userRequest = request as AuthenticatedRequest

    const tenantId = requireTenant(userRequest, response)

    if (!tenantId) return

    const id = z.uuid().safeParse(request.params.id)

    const parsed = updateMemberSchema.safeParse(request.body)

    if (!id.success || !parsed.success) {
      response.status(400).json({ error: "Mise à jour du membre invalide." })

      return
    }

    if (id.data === userRequest.authUser.id) {
      response
        .status(400)
        .json({ error: "Vous ne pouvez pas modifier votre propre accès." })

      return
    }

    const member = parsed.data

    const access = roleAccess[member.role]

    const assignedSite = await findAssignedSite(
      tenantId,
      member.assignedSiteId,
      member.assignedSite ?? null,
    )

    if ((siteScopedRoles.includes(member.role) || member.assignedSiteId || member.assignedSite) && !assignedSite) {
      response
        .status(400)
        .json({ error: "Le chantier doit appartenir à cette entreprise et être sélectionné sans ambiguïté." })

      return
    }

    const client = await pool.connect()
    let result: QueryResult<{
      id: string; email: string; phone: string | null; fullName: string; initials: string;
      role: UserRole; roleLabel: string; assignedSite: string | null;
      assignedSiteId: string | null; active: boolean; createdAt: Date
    }>
    try {
      await client.query("BEGIN")
      result = await client.query(
      `UPDATE users
       SET role = $1, role_label = $2, assigned_site = $3, assigned_site_id = $4, active = $5,
           session_version = session_version + CASE WHEN $5 THEN 0 ELSE 1 END,
           sections = $6, capabilities = $7
       WHERE id = $8 AND tenant_id = $9 AND role <> 'ADMIN_ENTERPRISE'
       RETURNING id, email, phone, full_name AS "fullName", initials,
                 role, role_label AS "roleLabel", assigned_site AS "assignedSite",
                 assigned_site_id AS "assignedSiteId",
                 active, created_at AS "createdAt"`,

      [
        member.role,

        access.label,

        assignedSite?.name ?? null,

        assignedSite?.id ?? null,

        member.active,

        JSON.stringify(access.sections),

        JSON.stringify(access.capabilities),

        id.data,

        tenantId,
      ],
      )

    if (!result.rowCount) {
      await client.query("ROLLBACK")
      response
        .status(404)
        .json({ error: "Membre introuvable ou accès protégé." })

      return
    }

      await writeAuditLog(client, request, {
        actorId: userRequest.authUser.id,
        actorRole: userRequest.authUser.role,
        tenantId,
        targetType: "user",
        targetId: id.data,
        action: "TEAM_MEMBER_UPDATED",
        payloadMasked: { role: member.role, active: member.active, assignedSiteId: assignedSite?.id ?? null },
      })
      await client.query("COMMIT")
    } catch (error) {
      await client.query("ROLLBACK")
      throw error
    } finally {
      client.release()
    }

    response.json({ data: result.rows[0] })
  },
)

router.patch(
  "/team/:id/profile",
  requireAnyCapability("manage_team"),
  async (request, response) => {
    const userRequest = request as AuthenticatedRequest
    const tenantId = requireTenant(userRequest, response)
    if (!tenantId) return
    const id = z.uuid().safeParse(request.params.id)
    const parsed = teamProfileSchema.safeParse(request.body)
    if (!id.success || !parsed.success) {
      response.status(400).json({ error: "Profil de membre invalide." })
      return
    }
    if (id.data === userRequest.authUser.id) {
      response.status(400).json({ error: "Modifiez vos propres coordonnées dans Profil." })
      return
    }
    const member = parsed.data
    const client = await pool.connect()
    try {
      await client.query("BEGIN")
      const result = await client.query(
        `UPDATE users SET full_name = $1, initials = $2, email = $3, phone = $4
         WHERE id = $5 AND tenant_id = $6 AND role <> 'ADMIN_ENTERPRISE'
         RETURNING id, full_name AS "fullName", role, active`,
        [member.fullName, initialsFromName(member.fullName), member.email, member.phone || null, id.data, tenantId],
      )
      if (!result.rowCount) {
        await client.query("ROLLBACK")
        response.status(404).json({ error: "Membre introuvable ou protégé." })
        return
      }
      await writeAuditLog(client, request, {
        actorId: userRequest.authUser.id,
        actorRole: userRequest.authUser.role,
        tenantId,
        targetType: "user",
        targetId: id.data,
        action: "TEAM_MEMBER_PROFILE_UPDATED",
        payloadMasked: { fullName: member.fullName, email: "masqué", phone: member.phone ? "masqué" : null },
      })
      await client.query("COMMIT")
      response.json({ data: result.rows[0] })
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
  },
)

router.delete(
  "/team/:id",

  requireAnyCapability("manage_team"),

  async (request, response) => {
    const userRequest = request as AuthenticatedRequest

    const tenantId = requireTenant(userRequest, response)

    if (!tenantId) return

    const id = z.uuid().safeParse(request.params.id)

    if (!id.success) {
      response.status(400).json({ error: "Identifiant de membre invalide." })

      return
    }

    if (id.data === userRequest.authUser.id) {
      response
        .status(400)
        .json({ error: "Vous ne pouvez pas supprimer votre propre compte." })

      return
    }

    const client = await pool.connect()
    let result: QueryResult<{
      id: string; email: string; phone: string | null; fullName: string; initials: string;
      role: UserRole; roleLabel: string; assignedSite: string | null; active: boolean; createdAt: Date
    }>
    try {
      await client.query("BEGIN")
      result = await client.query(
        `UPDATE users SET active = false, session_version = session_version + 1
         WHERE id = $1 AND tenant_id = $2 AND role <> 'ADMIN_ENTERPRISE'
         RETURNING id, email, phone, full_name AS "fullName", initials,
                   role, role_label AS "roleLabel", assigned_site AS "assignedSite",
                   active, created_at AS "createdAt"`,
        [id.data, tenantId],
      )
      if (!result.rowCount) {
        await client.query("ROLLBACK")
        response.status(404).json({ error: "Membre introuvable ou compte protégé." })
        return
      }
      await writeAuditLog(client, request, {
        actorId: userRequest.authUser.id,
        actorRole: userRequest.authUser.role,
        tenantId,
        targetType: "user",
        targetId: id.data,
        action: "TEAM_MEMBER_DEACTIVATED",
        payloadMasked: { active: false },
      })
      await client.query("COMMIT")
    } catch (error) {
      await client.query("ROLLBACK")
      throw error
    } finally {
      client.release()
    }

    response.json({ data: result.rows[0] })
  },
)

router.get(
  "/sites",

  requireAnyCapability("manage_sites", "manage_finance", "read_finance", "read_assigned"),

  async (request, response) => {
    const userRequest = request as AuthenticatedRequest

    const tenantId = requireTenant(userRequest, response)

    if (!tenantId) return

    const canReadAll =
      userRequest.authUser.capabilities.includes("manage_sites") ||
      userRequest.authUser.capabilities.includes("manage_finance") ||
      userRequest.authUser.capabilities.includes("read_finance")

    const canReadBudget =
      userRequest.authUser.capabilities.includes("manage_finance") ||
      userRequest.authUser.capabilities.includes("read_finance")

    const canReadSiteDetails =
      userRequest.authUser.capabilities.includes("manage_sites") ||
      userRequest.authUser.capabilities.includes("read_assigned")

    const result = await pool.query(
      `SELECT s.id, s.name,
               CASE WHEN $5::boolean THEN s.location ELSE NULL END AS location,
               CASE WHEN $5::boolean THEN s.status ELSE NULL END AS status,
               CASE WHEN $5::boolean THEN s.progress ELSE NULL END AS progress,
               CASE WHEN $4::boolean THEN s.budget_fcfa::text ELSE NULL END AS "budgetFcfa",
               CASE WHEN $5::boolean THEN s.start_date ELSE NULL END AS "startDate",
               CASE WHEN $5::boolean THEN s.end_date ELSE NULL END AS "endDate",
               s.created_at AS "createdAt",
               CASE WHEN $5::boolean THEN (
                 SELECT count(*)::integer FROM users assigned_user
                 WHERE assigned_user.assigned_site_id = s.id
                   AND assigned_user.tenant_id = s.tenant_id AND assigned_user.active
               ) ELSE NULL END AS "teamCount"
       FROM sites s
       WHERE s.tenant_id = $1
          AND ($2::boolean OR s.id = $3::uuid)
       GROUP BY s.id
       ORDER BY s.created_at DESC`,

      [
        tenantId,
        canReadAll,
        userRequest.authUser.assignedSiteId,
        canReadBudget,
        canReadSiteDetails,
      ],
    )

    response.json({ data: result.rows })
  },
)

router.get(
  "/sites/:id",
  requireAnyCapability("manage_sites"),
  async (request, response) => {
    const userRequest = request as AuthenticatedRequest
    const tenantId = requireTenant(userRequest, response)
    if (!tenantId) return
    const id = z.uuid().safeParse(request.params.id)
    if (!id.success) {
      response.status(400).json({ error: "Identifiant de chantier invalide." })
      return
    }
    const result = await pool.query(
      `SELECT s.id, s.name, s.location, s.status, s.progress,
              s.budget_fcfa AS "budgetFcfa", s.start_date AS "startDate",
              s.end_date AS "endDate", s.created_at AS "createdAt",
              COALESCE(jsonb_agg(jsonb_build_object(
                'id', u.id, 'fullName', u.full_name, 'role', u.role, 'active', u.active
              )) FILTER (WHERE u.id IS NOT NULL), '[]'::jsonb) AS "assignedTeam",
              count(u.id) FILTER (WHERE u.active)::int AS "teamCount"
       FROM sites s
       LEFT JOIN users u ON u.assigned_site_id = s.id AND u.tenant_id = s.tenant_id
       WHERE s.id = $1 AND s.tenant_id = $2
       GROUP BY s.id`,
      [id.data, tenantId],
    )
    if (!result.rowCount) {
      response.status(404).json({ error: "Chantier introuvable." })
      return
    }
    response.json({ data: result.rows[0] })
  },
)

router.post(
  "/sites",

  requireAnyCapability("manage_sites"),

  async (request, response) => {
    const userRequest = request as AuthenticatedRequest

    const tenantId = requireTenant(userRequest, response)

    if (!tenantId) return

    const parsed = siteSchema.safeParse(request.body)

    if (!parsed.success) {
      response.status(400).json({
        error: "Données de chantier invalides.",
        details: parsed.error.flatten().fieldErrors,
      })

      return
    }

    const site = parsed.data

    const client = await pool.connect()
    let result
    try {
      await client.query("BEGIN")
      await client.query("SELECT id FROM tenants WHERE id = $1 FOR UPDATE", [tenantId])
      const plan = await client.query<{ max_sites: number | null }>(
        `SELECT p.max_sites FROM tenant_subscriptions ts
         JOIN subscription_plans p ON p.id = ts.plan_id WHERE ts.tenant_id = $1`,
        [tenantId],
      )
      const siteCount = await client.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM sites WHERE tenant_id = $1 AND status <> 'Archivé'",
        [tenantId],
      )
      if (plan.rows[0]?.max_sites !== null && plan.rows[0]?.max_sites !== undefined && siteCount.rows[0]!.count >= plan.rows[0].max_sites) {
        await client.query("ROLLBACK")
        response.status(409).json({ error: "La limite de chantiers de votre offre est atteinte." })
        return
      }
      result = await client.query(
      `INSERT INTO sites (tenant_id, name, location, status, progress, budget_fcfa, start_date, end_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, name, location, status, progress, budget_fcfa AS "budgetFcfa",
                 start_date AS "startDate", end_date AS "endDate", created_at AS "createdAt",
                 0::integer AS "teamCount"`,

      [
        tenantId,
        site.name,
        site.location,
        site.status,
        site.progress,
        site.budgetFcfa,
        site.startDate ?? null,
        site.endDate ?? null,
      ],
      )

      await writeAuditLog(client, request, {
        actorId: userRequest.authUser.id,
        actorRole: userRequest.authUser.role,
        tenantId,
        targetType: "site",
        targetId: result.rows[0].id,
        action: "SITE_CREATED",
        payloadMasked: { name: site.name, status: site.status },
      })
      await client.query("COMMIT")
    } catch (error) {
      await client.query("ROLLBACK")
      throw error
    } finally {
      client.release()
    }

    response.status(201).json({ data: result.rows[0] })
  },
)

router.patch(
  "/sites/:id",
  requireAnyCapability("manage_sites"),
  async (request, response) => {
    const userRequest = request as AuthenticatedRequest
    const tenantId = requireTenant(userRequest, response)
    if (!tenantId) return
    const id = z.uuid().safeParse(request.params.id)
    const parsed = siteSchema.safeParse(request.body)
    if (!id.success || !parsed.success) {
      response.status(400).json({ error: "Mise à jour du chantier invalide." })
      return
    }
    const site = parsed.data
    const client = await pool.connect()
    try {
      await client.query("BEGIN")
      const result = await client.query(
        `UPDATE sites SET name = $1, location = $2, status = $3, progress = $4,
                budget_fcfa = $5, start_date = $6, end_date = $7
         WHERE id = $8 AND tenant_id = $9
         RETURNING id, name, location, status, progress, budget_fcfa AS "budgetFcfa",
                   start_date AS "startDate", end_date AS "endDate", created_at AS "createdAt"`,
        [site.name, site.location, site.status, site.progress, site.budgetFcfa, site.startDate ?? null, site.endDate ?? null, id.data, tenantId],
      )
      if (!result.rowCount) {
        await client.query("ROLLBACK")
        response.status(404).json({ error: "Chantier introuvable." })
        return
      }
      await writeAuditLog(client, request, {
        actorId: userRequest.authUser.id,
        actorRole: userRequest.authUser.role,
        tenantId,
        targetType: "site",
        targetId: id.data,
        action: site.status === "Archivé" ? "SITE_ARCHIVED" : "SITE_UPDATED",
        payloadMasked: { name: site.name, status: site.status },
      })
      await client.query("COMMIT")
      response.json({ data: result.rows[0] })
    } catch (error) {
      await client.query("ROLLBACK")
      throw error
    } finally {
      client.release()
    }
  },
)

router.get(
  "/tasks",

  requireAnyCapability("manage_tasks", "update_assigned_tasks"),

  async (request, response) => {
    const userRequest = request as AuthenticatedRequest

    const tenantId = requireTenant(userRequest, response)

    if (!tenantId) return

    const canReadAll =
      userRequest.authUser.capabilities.includes("read_company")

    const canManageAssignedSite =
      userRequest.authUser.capabilities.includes("manage_tasks") &&
      userRequest.authUser.assignedSiteId !== null

    const result = await pool.query(
      `SELECT t.id, t.site_id AS "siteId", s.name AS "siteName", t.title,
              t.description, t.category, t.priority, t.status,
              t.due_date AS "dueDate", t.assigned_to AS "assignedTo",
              u.initials AS "assigneeInitials", u.full_name AS "assigneeName",
              t.created_at AS "createdAt", t.updated_at AS "updatedAt"
       FROM tasks t
       JOIN sites s ON s.id = t.site_id AND s.tenant_id = t.tenant_id
       LEFT JOIN users u ON u.id = t.assigned_to AND u.tenant_id = t.tenant_id
       WHERE t.tenant_id = $1
         AND (
           $2::boolean
           OR (
             s.id = $5::uuid
             AND ($4::boolean OR t.assigned_to = $3)
           )
         )
       ORDER BY t.due_date NULLS LAST, t.created_at DESC`,

      [
        tenantId,
        canReadAll,
        userRequest.authUser.id,
        canManageAssignedSite,
        userRequest.authUser.assignedSiteId,
      ],
    )

    response.json({ data: result.rows })
  },
)

router.post(
  "/tasks",

  requireAnyCapability("manage_tasks"),

  async (request, response) => {
    const userRequest = request as AuthenticatedRequest

    const tenantId = requireTenant(userRequest, response)

    if (!tenantId) return

    const parsed = taskSchema.safeParse(request.body)

    if (!parsed.success) {
      response.status(400).json({
        error: "Données de tâche invalides.",
        details: parsed.error.flatten().fieldErrors,
      })

      return
    }

    const task = parsed.data

    const site = await pool.query(
      `SELECT 1 FROM sites
       WHERE id = $1 AND tenant_id = $2
         AND ($3::boolean OR id = $4::uuid)
         AND status <> 'Archivé'`,

      [
        task.siteId,

        tenantId,

        userRequest.authUser.capabilities.includes("read_company"),

        userRequest.authUser.assignedSiteId,
      ],
    )

    if (site.rowCount === 0) {
      response.status(404).json({ error: "Chantier introuvable." })

      return
    }

    if (task.assignedTo) {
      const assignee = await pool.query(
        `SELECT 1
         FROM users u
         WHERE u.id = $1 AND u.tenant_id = $2 AND u.active = true
           AND (
             u.role::text <> ALL($3::text[])
             OR u.assigned_site_id = $4
           )
           AND ($5::boolean OR u.assigned_site_id = $6::uuid)`,

        [
          task.assignedTo,

          tenantId,

          siteScopedRoles,

          task.siteId,

          userRequest.authUser.capabilities.includes("read_company"),

          userRequest.authUser.assignedSiteId,
        ],
      )

      if (assignee.rowCount === 0) {
        response.status(400).json({
          error:
            "Le membre assigné doit appartenir à l’entreprise et, pour un rôle limité, au chantier choisi.",
        })

        return
      }
    }

    const result = await pool.query(
      `INSERT INTO tasks (tenant_id, site_id, title, description, category, priority, status, due_date, assigned_to, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id, site_id AS "siteId", title, description, category, priority,
                 status, due_date AS "dueDate", assigned_to AS "assignedTo",
                 (SELECT initials FROM users WHERE id = tasks.assigned_to) AS "assigneeInitials",
                 (SELECT full_name FROM users WHERE id = tasks.assigned_to) AS "assigneeName",
                 created_at AS "createdAt", updated_at AS "updatedAt"`,

      [
        tenantId,
        task.siteId,
        task.title,
        task.description,
        task.category,
        task.priority,
        task.status,
        task.dueDate ?? null,
        task.assignedTo ?? null,
        userRequest.authUser.id,
      ],
    )

    response.status(201).json({ data: result.rows[0] })
  },
)

router.patch(
  "/tasks/:id/status",

  requireAnyCapability("manage_tasks", "update_assigned_tasks"),

  async (request, response) => {
    const userRequest = request as AuthenticatedRequest

    const tenantId = requireTenant(userRequest, response)

    if (!tenantId) return

    const id = z.uuid().safeParse(request.params.id)

    const parsed = taskStatusSchema.safeParse(request.body)

    if (!id.success || !parsed.success) {
      response.status(400).json({ error: "Mise à jour de tâche invalide." })

      return
    }

    const canReadAll =
      userRequest.authUser.capabilities.includes("read_company")

    const canManageAssignedSite =
      userRequest.authUser.capabilities.includes("manage_tasks")

    const result = await pool.query(
      `UPDATE tasks SET status = $1, updated_at = now()
       WHERE id = $2 AND tenant_id = $3
         AND (
           $4::boolean
           OR (
             site_id IN (
               SELECT id FROM sites WHERE tenant_id = $3 AND id = $7::uuid
             )
             AND ($6::boolean OR assigned_to = $5)
           )
         )
       RETURNING id, status, updated_at AS "updatedAt"`,

      [
        parsed.data.status,

        id.data,

        tenantId,

        canReadAll,

        userRequest.authUser.id,

        canManageAssignedSite,

        userRequest.authUser.assignedSiteId,
      ],
    )

    if (result.rowCount === 0) {
      response
        .status(404)
        .json({ error: "Tâche introuvable ou non assignée à votre compte." })

      return
    }

    response.json({ data: result.rows[0] })
  },
)

router.get(
  "/reports",

  requireAnyCapability(
    "read_validated_reports",
    "validate_reports",
    "create_reports",
  ),

  async (request, response) => {
    const userRequest = request as AuthenticatedRequest

    const tenantId = requireTenant(userRequest, response)

    if (!tenantId) return

    const canReadAll =
      userRequest.authUser.capabilities.includes("read_company")

    const validatedReportsOnly =
      userRequest.authUser.capabilities.includes("read_validated_reports") &&
      !userRequest.authUser.capabilities.includes("validate_reports") &&
      !userRequest.authUser.capabilities.includes("create_reports")

    const result = await pool.query(
      `SELECT r.id, r.site_id AS "siteId", s.name AS "siteName",
              r.author_id AS "authorId", u.full_name AS "authorName",
              r.work_done AS "workDone", r.crew_count AS "crewCount",
              r.status, r.report_date AS "reportDate", r.created_at AS "createdAt",
              r.validated_at AS "validatedAt"
       FROM reports r
       JOIN sites s ON s.id = r.site_id AND s.tenant_id = r.tenant_id
       JOIN users u ON u.id = r.author_id
       WHERE r.tenant_id = $1
         AND ($2::boolean OR s.id = $3::uuid)
         AND (NOT $4::boolean OR r.status = 'Validé')
       ORDER BY r.report_date DESC, r.created_at DESC`,

      [
        tenantId,

        canReadAll,

        userRequest.authUser.assignedSiteId,

        validatedReportsOnly,
      ],
    )

    response.json({ data: result.rows })
  },
)

router.post(
  "/reports",

  requireAnyCapability("create_reports"),

  async (request, response) => {
    const userRequest = request as AuthenticatedRequest

    const tenantId = requireTenant(userRequest, response)

    if (!tenantId) return

    const parsed = reportSchema.safeParse(request.body)

    if (!parsed.success) {
      response.status(400).json({
        error: "Données de rapport invalides.",
        details: parsed.error.flatten().fieldErrors,
      })

      return
    }

    const report = parsed.data

    const site = await pool.query(
      `SELECT 1 FROM sites
       WHERE id = $1 AND tenant_id = $2
         AND ($3::boolean OR id = $4::uuid)
         AND status <> 'Archivé'`,

      [
        report.siteId,

        tenantId,

        userRequest.authUser.capabilities.includes("read_company"),

        userRequest.authUser.assignedSiteId,
      ],
    )

    if (site.rowCount === 0) {
      response.status(404).json({ error: "Chantier introuvable." })

      return
    }

    const result = await pool.query(
      `INSERT INTO reports (tenant_id, site_id, author_id, work_done, crew_count, report_date)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6::date, CURRENT_DATE))
       RETURNING id, site_id AS "siteId", author_id AS "authorId",
                 work_done AS "workDone", crew_count AS "crewCount",
                 status, report_date AS "reportDate", created_at AS "createdAt"`,

      [
        tenantId,
        report.siteId,
        userRequest.authUser.id,
        report.workDone,
        report.crewCount,
        report.reportDate ?? null,
      ],
    )

    response.status(201).json({ data: result.rows[0] })
  },
)

router.post(
  "/reports/:id/validate",

  requireAnyCapability("validate_reports"),

  async (request, response) => {
    const userRequest = request as AuthenticatedRequest

    const tenantId = requireTenant(userRequest, response)

    if (!tenantId) return

    const id = z.uuid().safeParse(request.params.id)

    if (!id.success) {
      response.status(400).json({ error: "Identifiant de rapport invalide." })

      return
    }

    const result = await pool.query(
      `UPDATE reports
       SET status = 'Validé', validated_by = $1, validated_at = now()
       WHERE id = $2 AND tenant_id = $3 AND status = 'À valider'
         AND (
           $4::boolean
           OR site_id IN (
             SELECT id FROM sites WHERE tenant_id = $3 AND id = $5::uuid
           )
         )
       RETURNING id, status, validated_at AS "validatedAt"`,

      [
        userRequest.authUser.id,

        id.data,

        tenantId,

        userRequest.authUser.capabilities.includes("read_company"),

        userRequest.authUser.assignedSiteId,
      ],
    )

    if (result.rowCount === 0) {
      response.status(404).json({ error: "Rapport à valider introuvable." })

      return
    }

    response.json({ data: result.rows[0] })
  },
)

router.get(
  "/photos",

  requireAnyCapability("capture_photos", "read_assigned"),

  async (request, response) => {
    const userRequest = request as AuthenticatedRequest

    const tenantId = requireTenant(userRequest, response)

    if (!tenantId) return

    const canReadCompany =
      userRequest.authUser.capabilities.includes("read_company")

    const result = await pool.query(
      `SELECT p.id, p.site_id AS "siteId", s.name AS "siteName",
              p.author_id AS "authorId", u.full_name AS "authorName",
              p.caption, p.content_type AS "contentType", p.sha256,
              p.latitude, p.longitude, p.captured_at AS "capturedAt",
              p.created_at AS "createdAt"
       FROM photos p
       JOIN sites s ON s.id = p.site_id AND s.tenant_id = p.tenant_id
       JOIN users u ON u.id = p.author_id AND u.tenant_id = p.tenant_id
       WHERE p.tenant_id = $1
         AND ($2::boolean OR s.id = $3::uuid)
       ORDER BY p.captured_at DESC`,

      [tenantId, canReadCompany, userRequest.authUser.assignedSiteId],
    )

    response.json({ data: result.rows })
  },
)

router.get(
  "/photos/:id/image",

  requireAnyCapability("capture_photos", "read_assigned"),

  async (request, response) => {
    const userRequest = request as AuthenticatedRequest

    const tenantId = requireTenant(userRequest, response)

    if (!tenantId) return

    const id = z.uuid().safeParse(request.params.id)

    if (!id.success) {
      response.status(400).json({ error: "Identifiant de photo invalide." })

      return
    }

    const canReadCompany =
      userRequest.authUser.capabilities.includes("read_company")

    const result = await pool.query(
      `SELECT p.content_type AS "contentType", p.image_data AS "imageData",
              p.sha256
       FROM photos p
       JOIN sites s ON s.id = p.site_id AND s.tenant_id = p.tenant_id
       WHERE p.id = $1 AND p.tenant_id = $2
         AND ($3::boolean OR s.id = $4::uuid)
         AND s.status <> 'Archivé'`,

      [id.data, tenantId, canReadCompany, userRequest.authUser.assignedSiteId],
    )

    const photo = result.rows[0]

    if (!photo) {
      response.status(404).json({ error: "Photo introuvable." })

      return
    }

    response.type(photo.contentType)

    response.setHeader("Cache-Control", "private, no-store")

    response.setHeader("X-Content-SHA256", photo.sha256)

    response.send(photo.imageData)
  },
)

router.post(
  "/photos",

  requireAnyCapability("capture_photos"),

  async (request, response) => {
    const userRequest = request as AuthenticatedRequest

    const tenantId = requireTenant(userRequest, response)

    if (!tenantId) return

    const parsed = photoSchema.safeParse(request.body)

    if (!parsed.success) {
      response.status(400).json({
        error: "Données de photo invalides.",

        details: parsed.error.flatten().fieldErrors,
      })

      return
    }

    const photo = parsed.data

    const imageData = Buffer.from(photo.imageBase64, "base64")

    if (
      imageData.length === 0 ||
      imageData.length > 2 * 1024 * 1024 ||
      imageData.toString("base64") !== photo.imageBase64
    ) {
      response
        .status(400)
        .json({ error: "L’image doit peser au maximum 2 Mo." })

      return
    }

    const validSignature =
      (photo.contentType === "image/jpeg" &&
        imageData[0] === 0xff &&
        imageData[1] === 0xd8 &&
        imageData[2] === 0xff) ||
      (photo.contentType === "image/png" &&
        imageData
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) ||
      (photo.contentType === "image/webp" &&
        imageData.toString("ascii", 0, 4) === "RIFF" &&
        imageData.toString("ascii", 8, 12) === "WEBP")

    if (!validSignature) {
      response.status(400).json({
        error: "Le format réel de l’image ne correspond pas au fichier.",
      })

      return
    }

    const site = await pool.query(
      `SELECT id, name FROM sites
       WHERE id = $1 AND tenant_id = $2
         AND ($3::boolean OR id = $4::uuid)
         AND status <> 'Archivé'`,

      [
        photo.siteId,

        tenantId,

        userRequest.authUser.capabilities.includes("read_company"),

        userRequest.authUser.assignedSiteId,
      ],
    )

    if (!site.rowCount) {
      response
        .status(404)
        .json({ error: "Chantier introuvable ou hors périmètre." })

      return
    }

    const latitude = photo.latitude ?? null

    const longitude = photo.longitude ?? null

    if ((latitude === null) !== (longitude === null)) {
      response.status(400).json({
        error: "La latitude et la longitude doivent être fournies ensemble.",
      })

      return
    }

    const checksum = createHash("sha256").update(imageData).digest("hex")

    const client = await pool.connect()
    try {
      await client.query("BEGIN")
      const capacity = await tenantStorageCapacity(client, tenantId, imageData.length)
      if (!capacity.allowed) {
        await client.query("ROLLBACK")
        response.status(409).json({
          error: `La limite de stockage du plan (${capacity.maxStorageMb} Mo) est atteinte.`,
        })
        return
      }
      const result = await client.query(
        `INSERT INTO photos (
           tenant_id, site_id, author_id, caption, content_type,
           image_data, sha256, latitude, longitude, captured_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, COALESCE($10::timestamptz, now()))
         RETURNING id, site_id AS "siteId", $11::text AS "siteName",
                   author_id AS "authorId", $12::text AS "authorName",
                   caption, content_type AS "contentType", sha256,
                   latitude, longitude, captured_at AS "capturedAt",
                   created_at AS "createdAt"`,
        [
          tenantId,
          photo.siteId,
          userRequest.authUser.id,
          photo.caption,
          photo.contentType,
          imageData,
          checksum,
          latitude,
          longitude,
          photo.capturedAt ?? null,
          site.rows[0].name,
          userRequest.authUser.fullName,
        ],
      )
      await client.query("COMMIT")
      response.status(201).json({ data: result.rows[0] })
    } catch (error) {
      await client.query("ROLLBACK")
      throw error
    } finally {
      client.release()
    }
  },
)

router.get(
  "/attendance",

  requireAnyCapability("clock_in"),

  async (request, response) => {
    const userRequest = request as AuthenticatedRequest

    const tenantId = requireTenant(userRequest, response)

    if (!tenantId) return

    const result = await pool.query(
      `SELECT a.id, a.site_id AS "siteId", s.name AS "siteName",
              a.clock_in_at AS "clockInAt", a.clock_out_at AS "clockOutAt",
              a.clock_in_latitude AS "clockInLatitude",
              a.clock_in_longitude AS "clockInLongitude",
              a.clock_out_latitude AS "clockOutLatitude",
              a.clock_out_longitude AS "clockOutLongitude"
       FROM attendance_records a
       JOIN sites s ON s.id = a.site_id AND s.tenant_id = a.tenant_id
       WHERE a.tenant_id = $1 AND a.user_id = $2
         AND a.clock_in_at >= now() - interval '7 days'
       ORDER BY a.clock_in_at DESC`,

      [tenantId, userRequest.authUser.id],
    )

    response.json({ data: result.rows })
  },
)

router.post(
  "/attendance/clock-in",

  requireAnyCapability("clock_in"),

  async (request, response) => {
    const userRequest = request as AuthenticatedRequest

    const tenantId = requireTenant(userRequest, response)

    if (!tenantId) return

    const parsed = attendanceSchema.safeParse(request.body)

    if (!parsed.success) {
      response.status(400).json({ error: "Coordonnées de pointage invalides." })

      return
    }

    if (!userRequest.authUser.assignedSiteId) {
      response
        .status(403)
        .json({ error: "Aucun chantier n’est affecté à votre compte." })

      return
    }

    const site = await pool.query(
      "SELECT id FROM sites WHERE tenant_id = $1 AND id = $2::uuid AND status = 'En cours'",

      [tenantId, userRequest.authUser.assignedSiteId],
    )

    if (!site.rowCount) {
      response
        .status(404)
        .json({ error: "Votre chantier affecté est introuvable ou inactif." })

      return
    }

    const latitude = parsed.data.latitude ?? null

    const longitude = parsed.data.longitude ?? null

    if ((latitude === null) !== (longitude === null)) {
      response.status(400).json({
        error: "La latitude et la longitude doivent être fournies ensemble.",
      })

      return
    }

    const client = await pool.connect()
    try {
      await client.query("BEGIN")
      const result = await client.query(
        `INSERT INTO attendance_records (
           tenant_id, user_id, site_id, clock_in_latitude, clock_in_longitude
         )
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, site_id AS "siteId", now() AS "clockInAt",
                   NULL::timestamptz AS "clockOutAt",
                   (SELECT name FROM sites WHERE id = $3 AND tenant_id = $1) AS "siteName",
                   clock_in_latitude AS "clockInLatitude",
                   clock_in_longitude AS "clockInLongitude"`,

        [
          tenantId,
          userRequest.authUser.id,
          site.rows[0].id,
          latitude,
          longitude,
        ],
      )
      await writeAuditLog(client, request, {
        actorId: userRequest.authUser.id,
        actorRole: userRequest.authUser.role,
        tenantId,
        targetType: "attendance",
        targetId: result.rows[0].id,
        action: "ATTENDANCE_CLOCKED_IN",
        payloadMasked: {
          siteId: result.rows[0].siteId,
          locationProvided: latitude !== null,
        },
      })
      await client.query("COMMIT")
      response.status(201).json({ data: result.rows[0] })
    } catch (error) {
      await client.query("ROLLBACK")
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "23505"
      ) {
        response
          .status(409)
          .json({ error: "Vous avez déjà un pointage d’arrivée ouvert." })

        return
      }

      throw error
    } finally {
      client.release()
    }
  },
)

router.post(
  "/attendance/clock-out",

  requireAnyCapability("clock_in"),

  async (request, response) => {
    const userRequest = request as AuthenticatedRequest

    const tenantId = requireTenant(userRequest, response)

    if (!tenantId) return

    const parsed = attendanceSchema.safeParse(request.body)

    if (!parsed.success) {
      response.status(400).json({ error: "Coordonnées de pointage invalides." })

      return
    }

    const latitude = parsed.data.latitude ?? null

    const longitude = parsed.data.longitude ?? null

    if ((latitude === null) !== (longitude === null)) {
      response.status(400).json({
        error: "La latitude et la longitude doivent être fournies ensemble.",
      })

      return
    }

    const client = await pool.connect()
    try {
      await client.query("BEGIN")
      const result = await client.query(
        `UPDATE attendance_records
         SET clock_out_at = now(), clock_out_latitude = $1, clock_out_longitude = $2
         WHERE tenant_id = $3 AND user_id = $4 AND clock_out_at IS NULL
         RETURNING id, site_id AS "siteId", clock_in_at AS "clockInAt",
                   clock_out_at AS "clockOutAt",
                   (SELECT name FROM sites WHERE id = attendance_records.site_id AND tenant_id = attendance_records.tenant_id) AS "siteName",
                   clock_in_latitude AS "clockInLatitude",
                   clock_in_longitude AS "clockInLongitude",
                   clock_out_latitude AS "clockOutLatitude",
                   clock_out_longitude AS "clockOutLongitude"`,
        [latitude, longitude, tenantId, userRequest.authUser.id],
      )
      if (!result.rowCount) {
        await client.query("ROLLBACK")
        response.status(404).json({ error: "Aucun pointage ouvert à clôturer." })
        return
      }
      await writeAuditLog(client, request, {
        actorId: userRequest.authUser.id,
        actorRole: userRequest.authUser.role,
        tenantId,
        targetType: "attendance",
        targetId: result.rows[0].id,
        action: "ATTENDANCE_CLOCKED_OUT",
        payloadMasked: {
          siteId: result.rows[0].siteId,
          locationProvided: latitude !== null,
        },
      })
      await client.query("COMMIT")
      response.json({ data: result.rows[0] })
    } catch (error) {
      await client.query("ROLLBACK")
      throw error
    } finally {
      client.release()
    }
  },
)

router.get(
  "/finance",

  requireAnyCapability("manage_finance", "read_finance"),

  async (request, response) => {
    const userRequest = request as AuthenticatedRequest

    const tenantId = requireTenant(userRequest, response)

    if (!tenantId) return

    const [entries, summary] = await Promise.all([
      pool.query(
        `SELECT f.id, f.site_id AS "siteId", s.name AS "siteName",
                f.entry_type AS "entryType", f.category, f.description,
                f.amount_fcfa AS "amountFcfa", f.status, f.due_date AS "dueDate",
                f.occurred_at AS "occurredAt", f.created_at AS "createdAt"
         FROM finance_entries f
         JOIN sites s ON s.id = f.site_id AND s.tenant_id = f.tenant_id
         WHERE f.tenant_id = $1
         ORDER BY f.created_at DESC`,

        [tenantId],
      ),

      pool.query(
        `SELECT
           COALESCE((SELECT SUM(budget_fcfa) FROM sites WHERE tenant_id = $1), 0)::text AS "budgetFcfa",
           COALESCE(SUM(amount_fcfa) FILTER (WHERE entry_type = 'engagement'), 0)::text AS "engagedFcfa",
           COALESCE(SUM(amount_fcfa) FILTER (WHERE entry_type = 'depense' AND status = 'réalisé'), 0)::text AS "expensesFcfa",
           COALESCE(SUM(amount_fcfa) FILTER (WHERE entry_type = 'encaissement' AND status = 'prévu'), 0)::text AS "plannedReceiptsFcfa",
           COALESCE(SUM(amount_fcfa) FILTER (WHERE entry_type = 'encaissement' AND status = 'réalisé'), 0)::text AS "receivedFcfa",
           COALESCE(SUM(amount_fcfa) FILTER (WHERE status = 'réalisé' AND entry_type = 'encaissement'), 0)
             - COALESCE(SUM(amount_fcfa) FILTER (WHERE status = 'réalisé' AND entry_type = 'depense'), 0) AS "cashBalanceFcfa"
         FROM finance_entries WHERE tenant_id = $1`,

        [tenantId],
      ),
    ])

    response.json({ data: entries.rows, summary: summary.rows[0] })
  },
)

router.post(
  "/finance",

  requireAnyCapability("manage_finance"),

  async (request, response) => {
    const userRequest = request as AuthenticatedRequest

    const tenantId = requireTenant(userRequest, response)

    if (!tenantId) return

    const parsed = financeSchema.safeParse(request.body)

    if (!parsed.success) {
      response.status(400).json({
        error: "Données financières invalides.",

        details: parsed.error.flatten().fieldErrors,
      })

      return
    }

    const entry = parsed.data

    const site = await pool.query(
      "SELECT 1 FROM sites WHERE id = $1 AND tenant_id = $2",

      [entry.siteId, tenantId],
    )

    if (!site.rowCount) {
      response
        .status(404)
        .json({ error: "Chantier introuvable dans votre entreprise." })

      return
    }

    const client = await pool.connect()
    try {
      await client.query("BEGIN")
      const result = await client.query(
        `INSERT INTO finance_entries (
           tenant_id, site_id, created_by, entry_type, category, description,
           amount_fcfa, due_date
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, site_id AS "siteId", entry_type AS "entryType", category,
                   description, amount_fcfa AS "amountFcfa", status,
                   due_date AS "dueDate", occurred_at AS "occurredAt",
                   created_at AS "createdAt"`,
        [
          tenantId,
          entry.siteId,
          userRequest.authUser.id,
          entry.entryType,
          entry.category,
          entry.description,
          entry.amountFcfa,
          entry.dueDate ?? null,
        ],
      )
      await writeAuditLog(client, request, {
        actorId: userRequest.authUser.id,
        actorRole: userRequest.authUser.role,
        tenantId,
        targetType: "finance_entry",
        targetId: result.rows[0].id,
        action: "FINANCE_ENTRY_CREATED",
        payloadMasked: {
          entryType: entry.entryType,
          category: entry.category,
          amountFcfa: entry.amountFcfa,
          siteId: entry.siteId,
        },
      })
      await client.query("COMMIT")
      response.status(201).json({ data: result.rows[0] })
    } catch (error) {
      await client.query("ROLLBACK")
      throw error
    } finally {
      client.release()
    }
  },
)

router.post(
  "/finance/:id/realize",

  requireAnyCapability("manage_finance"),

  async (request, response) => {
    const userRequest = request as AuthenticatedRequest

    const tenantId = requireTenant(userRequest, response)

    if (!tenantId) return

    const id = z.uuid().safeParse(request.params.id)

    const parsed = financeStatusSchema.safeParse(request.body)

    if (!id.success || !parsed.success) {
      response.status(400).json({ error: "Mise à jour financière invalide." })

      return
    }

    const client = await pool.connect()
    try {
      await client.query("BEGIN")
      const result = await client.query(
        `UPDATE finance_entries
         SET status = $1, occurred_at = now()
         WHERE id = $2 AND tenant_id = $3 AND status = 'prévu'
         RETURNING id, site_id AS "siteId", entry_type AS "entryType",
                   category, amount_fcfa AS "amountFcfa", status,
                   occurred_at AS "occurredAt"`,
        [parsed.data.status, id.data, tenantId],
      )
      if (!result.rowCount) {
        await client.query("ROLLBACK")
        response
          .status(404)
          .json({ error: "Opération financière prévue introuvable." })
        return
      }
      await writeAuditLog(client, request, {
        actorId: userRequest.authUser.id,
        actorRole: userRequest.authUser.role,
        tenantId,
        targetType: "finance_entry",
        targetId: id.data,
        action: "FINANCE_ENTRY_REALIZED",
        payloadMasked: {
          entryType: result.rows[0].entryType,
          category: result.rows[0].category,
          amountFcfa: result.rows[0].amountFcfa,
          siteId: result.rows[0].siteId,
          status: result.rows[0].status,
        },
      })
      await client.query("COMMIT")
      response.json({ data: result.rows[0] })
    } catch (error) {
      await client.query("ROLLBACK")
      throw error
    } finally {
      client.release()
    }
  },
)

export default router
