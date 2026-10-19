import bcrypt from "bcryptjs"

import { createHash } from "node:crypto"

import { Router } from "express"

import { z } from "zod"

import { authenticate, requireAnyCapability, requireTenant } from "../auth.js"

import { pool } from "../db.js"

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
    WHERE t.tenant_id = $1 AND t.created_by = $2
    UNION ALL
    SELECT 'Rapport', 'Rapport journalier', r.status,
      s.name, r.created_at
    FROM reports r
    JOIN sites s ON s.id = r.site_id AND s.tenant_id = r.tenant_id
    WHERE r.tenant_id = $1 AND r.author_id = $2
    UNION ALL
    SELECT 'Photo', p.caption, 'Photo ajoutée',
      s.name, p.created_at
    FROM photos p
    JOIN sites s ON s.id = p.site_id AND s.tenant_id = p.tenant_id
    WHERE p.tenant_id = $1 AND p.author_id = $2
    UNION ALL
    SELECT 'Pointage', 'Pointage chantier',
      CASE WHEN a.clock_out_at IS NULL THEN 'Entrée enregistrée' ELSE 'Journée clôturée' END,
      s.name, a.clock_in_at
    FROM attendance_records a
    JOIN sites s ON s.id = a.site_id AND s.tenant_id = a.tenant_id
    WHERE a.tenant_id = $1 AND a.user_id = $2
    UNION ALL
    SELECT 'Finance', f.description,
      CASE f.entry_type WHEN 'encaissement' THEN 'Encaissement' WHEN 'depense' THEN 'Dépense' ELSE 'Engagement' END,
      s.name, f.created_at
    FROM finance_entries f
    JOIN sites s ON s.id = f.site_id AND s.tenant_id = f.tenant_id
    WHERE f.tenant_id = $1 AND f.created_by = $2
    UNION ALL
    SELECT 'Dossier de paiement', d.subject, d.status,
      s.name, d.created_at
    FROM payment_dossiers d
    JOIN sites s ON s.id = d.site_id AND s.tenant_id = d.tenant_id
    WHERE d.tenant_id = $1 AND d.created_by = $2
  ) activity
  ORDER BY activity.occurred_at DESC
  LIMIT 8`,
      [tenantId, userRequest.authUser.id],
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

  status: z.enum(["En cours", "En pause", "Terminé"]).default("En cours"),

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

  assignedSite: z.string().trim().min(2).max(120).nullable().optional(),

  temporaryPassword: z.string().min(12).max(128),
})

const updateMemberSchema = z.object({
  role: managedRoleSchema,

  assignedSite: z.string().trim().min(2).max(120).nullable(),

  active: z.boolean(),
})

function initialsFromName(name: string) {
  return name

    .split(/\s+/)

    .slice(0, 2)

    .map((part) => part[0]!.toLocaleUpperCase("fr-FR"))

    .join("")
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
              u.assigned_site AS "assignedSite", u.active,
              u.created_at AS "createdAt"
       FROM users u
       WHERE u.tenant_id = $1
         AND ($5::boolean OR u.active = true)
         AND (
              $2::boolean
              OR u.id = $3
              OR ($4::text IS NOT NULL AND u.assigned_site = $4)
         )
       ORDER BY u.active DESC, u.full_name`,

      [
        tenantId,

        canReadAll,

        userRequest.authUser.id,

        userRequest.authUser.assignedSite,

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

    const assignedSite = member.assignedSite?.trim() || null

    const siteRequired = siteScopedRoles.includes(member.role)

    if (siteRequired && !assignedSite) {
      response
        .status(400)
        .json({ error: "Un chantier doit être affecté à ce rôle." })

      return
    }

    if (assignedSite) {
      const site = await pool.query(
        "SELECT 1 FROM sites WHERE tenant_id = $1 AND name = $2",

        [tenantId, assignedSite],
      )

      if (!site.rowCount) {
        response.status(400).json({
          error: "Le chantier choisi n’appartient pas à cette entreprise.",
        })

        return
      }
    }

    const passwordHash = await bcrypt.hash(member.temporaryPassword, 12)

    try {
      const result = await pool.query(
        `INSERT INTO users (
           tenant_id, email, phone, password_hash, full_name, initials,
           role, role_label, tenant_name, tenant_plan, assigned_site,
           sections, capabilities
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         RETURNING id, email, phone, full_name AS "fullName", initials,
                   role, role_label AS "roleLabel", assigned_site AS "assignedSite",
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

          assignedSite,

          JSON.stringify(access.sections),

          JSON.stringify(access.capabilities),
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
        response
          .status(409)
          .json({ error: "Un compte utilise déjà cet email ou ce numéro." })

        return
      }

      throw error
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

    const assignedSite = member.assignedSite?.trim() || null

    if (siteScopedRoles.includes(member.role) && !assignedSite) {
      response
        .status(400)
        .json({ error: "Un chantier doit être affecté à ce rôle." })

      return
    }

    if (assignedSite) {
      const site = await pool.query(
        "SELECT 1 FROM sites WHERE tenant_id = $1 AND name = $2",

        [tenantId, assignedSite],
      )

      if (!site.rowCount) {
        response.status(400).json({
          error: "Le chantier choisi n’appartient pas à cette entreprise.",
        })

        return
      }
    }

    const result = await pool.query(
      `UPDATE users
       SET role = $1, role_label = $2, assigned_site = $3, active = $4,
           sections = $5, capabilities = $6
       WHERE id = $7 AND tenant_id = $8 AND role <> 'ADMIN_ENTERPRISE'
       RETURNING id, email, phone, full_name AS "fullName", initials,
                 role, role_label AS "roleLabel", assigned_site AS "assignedSite",
                 active, created_at AS "createdAt"`,

      [
        member.role,

        access.label,

        assignedSite,

        member.active,

        JSON.stringify(access.sections),

        JSON.stringify(access.capabilities),

        id.data,

        tenantId,
      ],
    )

    if (!result.rowCount) {
      response
        .status(404)
        .json({ error: "Membre introuvable ou accès protégé." })

      return
    }

    response.json({ data: result.rows[0] })
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

    const result = await pool.query(
      `UPDATE users
       SET active = false
       WHERE id = $1 AND tenant_id = $2 AND role <> 'ADMIN_ENTERPRISE'
       RETURNING id, email, phone, full_name AS "fullName", initials,
                 role, role_label AS "roleLabel", assigned_site AS "assignedSite",
                 active, created_at AS "createdAt"`,

      [id.data, tenantId],
    )

    if (!result.rowCount) {
      response
        .status(404)
        .json({ error: "Membre introuvable ou compte protégé." })

      return
    }

    response.json({ data: result.rows[0] })
  },
)

router.get(
  "/sites",

  requireAnyCapability("manage_sites", "manage_finance", "read_assigned"),

  async (request, response) => {
    const userRequest = request as AuthenticatedRequest

    const tenantId = requireTenant(userRequest, response)

    if (!tenantId) return

    const canReadAll =
      userRequest.authUser.capabilities.includes("manage_sites") ||
      userRequest.authUser.capabilities.includes("manage_finance")

    const canReadBudget =
      userRequest.authUser.capabilities.includes("manage_finance")

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
               CASE WHEN $5::boolean THEN COUNT(DISTINCT t.assigned_to)::integer ELSE NULL END AS "teamCount"
       FROM sites s
       LEFT JOIN tasks t ON t.site_id = s.id AND t.tenant_id = s.tenant_id
       WHERE s.tenant_id = $1
          AND ($2::boolean OR s.name = $3)
       GROUP BY s.id
       ORDER BY s.created_at DESC`,

      [
        tenantId,
        canReadAll,
        userRequest.authUser.assignedSite,
        canReadBudget,
        canReadSiteDetails,
      ],
    )

    response.json({ data: result.rows })
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

    const result = await pool.query(
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

    response.status(201).json({ data: result.rows[0] })
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
      userRequest.authUser.assignedSite !== null

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
             s.name = $5
             AND ($4::boolean OR t.assigned_to = $3)
           )
         )
       ORDER BY t.due_date NULLS LAST, t.created_at DESC`,

      [
        tenantId,
        canReadAll,
        userRequest.authUser.id,
        canManageAssignedSite,
        userRequest.authUser.assignedSite,
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
         AND ($3::boolean OR name = $4)`,

      [
        task.siteId,

        tenantId,

        userRequest.authUser.capabilities.includes("read_company"),

        userRequest.authUser.assignedSite,
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
             OR u.assigned_site = (
               SELECT name FROM sites WHERE id = $4 AND tenant_id = $2
             )
           )
           AND ($5::boolean OR u.assigned_site = $6)`,

        [
          task.assignedTo,

          tenantId,

          siteScopedRoles,

          task.siteId,

          userRequest.authUser.capabilities.includes("read_company"),

          userRequest.authUser.assignedSite,
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
               SELECT id FROM sites WHERE tenant_id = $3 AND name = $7
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

        userRequest.authUser.assignedSite,
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
         AND ($2::boolean OR s.name = $3)
         AND (NOT $4::boolean OR r.status = 'Validé')
       ORDER BY r.report_date DESC, r.created_at DESC`,

      [
        tenantId,

        canReadAll,

        userRequest.authUser.assignedSite,

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
         AND ($3::boolean OR name = $4)`,

      [
        report.siteId,

        tenantId,

        userRequest.authUser.capabilities.includes("read_company"),

        userRequest.authUser.assignedSite,
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
             SELECT id FROM sites WHERE tenant_id = $3 AND name = $5
           )
         )
       RETURNING id, status, validated_at AS "validatedAt"`,

      [
        userRequest.authUser.id,

        id.data,

        tenantId,

        userRequest.authUser.capabilities.includes("read_company"),

        userRequest.authUser.assignedSite,
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
         AND ($2::boolean OR s.name = $3)
       ORDER BY p.captured_at DESC`,

      [tenantId, canReadCompany, userRequest.authUser.assignedSite],
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
         AND ($3::boolean OR s.name = $4)`,

      [id.data, tenantId, canReadCompany, userRequest.authUser.assignedSite],
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
         AND ($3::boolean OR name = $4)`,

      [
        photo.siteId,

        tenantId,

        userRequest.authUser.capabilities.includes("read_company"),

        userRequest.authUser.assignedSite,
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

    const result = await pool.query(
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

    response.status(201).json({ data: result.rows[0] })
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

    if (!userRequest.authUser.assignedSite) {
      response
        .status(403)
        .json({ error: "Aucun chantier n’est affecté à votre compte." })

      return
    }

    const site = await pool.query(
      "SELECT id FROM sites WHERE tenant_id = $1 AND name = $2 AND status = 'En cours'",

      [tenantId, userRequest.authUser.assignedSite],
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

    try {
      const result = await pool.query(
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

      response.status(201).json({ data: result.rows[0] })
    } catch (error) {
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

    const result = await pool.query(
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
      response.status(404).json({ error: "Aucun pointage ouvert à clôturer." })

      return
    }

    response.json({ data: result.rows[0] })
  },
)

router.get(
  "/finance",

  requireAnyCapability("manage_finance"),

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

    const result = await pool.query(
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

    response.status(201).json({ data: result.rows[0] })
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

    const result = await pool.query(
      `UPDATE finance_entries
       SET status = $1, occurred_at = now()
       WHERE id = $2 AND tenant_id = $3 AND status = 'prévu'
       RETURNING id, status, occurred_at AS "occurredAt"`,

      [parsed.data.status, id.data, tenantId],
    )

    if (!result.rowCount) {
      response
        .status(404)
        .json({ error: "Opération financière prévue introuvable." })

      return
    }

    response.json({ data: result.rows[0] })
  },
)

export default router
