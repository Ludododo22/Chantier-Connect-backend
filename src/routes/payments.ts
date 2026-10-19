import { Router } from "express"

import { z } from "zod"

import { authenticate, requireAnyCapability, requireTenant } from "../auth.js"

import { pool } from "../db.js"

import type { AuthenticatedRequest } from "../types.js"

const router = Router()

router.use(authenticate, requireAnyCapability("manage_finance"))

const paymentSchema = z.object({
  siteId: z.uuid(),

  subject: z.string().trim().min(2).max(180),

  amountFcfa: z.number().int().positive().max(9_000_000_000_000),

  dueDate: z.iso.date().nullable().optional(),
})

const paymentStatusSchema = z.object({
  status: z.enum([
    "En préparation",

    "Prêt à transmettre",

    "En instruction",

    "À corriger",

    "Payé",

    "Refusé",
  ]),
})

const transitions: Record<string, string[]> = {
  "En préparation": ["Prêt à transmettre"],

  "Prêt à transmettre": ["En instruction", "À corriger"],

  "En instruction": ["À corriger", "Payé", "Refusé"],

  "À corriger": ["En préparation", "Prêt à transmettre"],

  Payé: [],

  Refusé: [],
}

router.get("/", async (request, response) => {
  const userRequest = request as AuthenticatedRequest

  const tenantId = requireTenant(userRequest, response)

  if (!tenantId) return

  const [entries, summary] = await Promise.all([
    pool.query(
      `SELECT d.id, d.reference, d.site_id AS "siteId", s.name AS "siteName",
              d.subject, d.amount_fcfa AS "amountFcfa", d.status, d.due_date AS "dueDate",
              d.created_at AS "createdAt", d.updated_at AS "updatedAt"
       FROM payment_dossiers d
       JOIN sites s ON s.id = d.site_id AND s.tenant_id = d.tenant_id
       WHERE d.tenant_id = $1
       ORDER BY d.created_at DESC`,

      [tenantId],
    ),

    pool.query(
      `SELECT status, count(*)::int AS count, COALESCE(sum(amount_fcfa), 0)::text AS "amountFcfa"
       FROM payment_dossiers
       WHERE tenant_id = $1
       GROUP BY status`,

      [tenantId],
    ),
  ])

  response.json({ data: entries.rows, summary: summary.rows })
})

router.post("/", async (request, response) => {
  const userRequest = request as AuthenticatedRequest

  const tenantId = requireTenant(userRequest, response)

  if (!tenantId) return

  const parsed = paymentSchema.safeParse(request.body)

  if (!parsed.success) {
    response.status(400).json({
      error: "Données du dossier de paiement invalides.",
      details: parsed.error.flatten().fieldErrors,
    })

    return
  }

  const dossier = parsed.data

  const site = await pool.query(
    "SELECT 1 FROM sites WHERE id = $1 AND tenant_id = $2",

    [dossier.siteId, tenantId],
  )

  if (!site.rowCount) {
    response
      .status(404)
      .json({ error: "Chantier introuvable dans votre entreprise." })

    return
  }

  const referenceResult = await pool.query<{ reference: string }>(
    `SELECT 'DP-' || to_char(CURRENT_DATE, 'YYYY') || '-' ||
            lpad(nextval('payment_dossier_reference_seq')::text, 6, '0') AS reference`,
  )

  const result = await pool.query(
    `INSERT INTO payment_dossiers (
       tenant_id, site_id, created_by, reference, subject, amount_fcfa, due_date
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, reference, site_id AS "siteId", subject,
               amount_fcfa AS "amountFcfa", status, due_date AS "dueDate",
               created_at AS "createdAt", updated_at AS "updatedAt"`,

    [
      tenantId,

      dossier.siteId,

      userRequest.authUser.id,

      referenceResult.rows[0]!.reference,

      dossier.subject,

      dossier.amountFcfa,

      dossier.dueDate ?? null,
    ],
  )

  response.status(201).json({ data: result.rows[0] })
})

router.patch("/:id/status", async (request, response) => {
  const userRequest = request as AuthenticatedRequest

  const tenantId = requireTenant(userRequest, response)

  if (!tenantId) return

  const id = z.uuid().safeParse(request.params.id)

  const parsed = paymentStatusSchema.safeParse(request.body)

  if (!id.success || !parsed.success) {
    response
      .status(400)
      .json({ error: "Identifiant ou statut de dossier invalide." })

    return
  }

  const current = await pool.query<{ status: string }>(
    "SELECT status FROM payment_dossiers WHERE id = $1 AND tenant_id = $2",

    [id.data, tenantId],
  )

  const existing = current.rows[0]

  if (!existing) {
    response.status(404).json({ error: "Dossier de paiement introuvable." })

    return
  }

  if (!transitions[existing.status]?.includes(parsed.data.status)) {
    response.status(409).json({
      error: `Transition impossible : ${existing.status} vers ${parsed.data.status}.`,
    })

    return
  }

  const result = await pool.query(
    `UPDATE payment_dossiers
     SET status = $1, updated_at = now()
     WHERE id = $2 AND tenant_id = $3
     RETURNING id, status, updated_at AS "updatedAt"`,

    [parsed.data.status, id.data, tenantId],
  )

  response.json({ data: result.rows[0] })
})

export default router
