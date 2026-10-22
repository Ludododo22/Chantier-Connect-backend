import { Router } from "express"

import { z } from "zod"

import { authenticate, requireAnyCapability, requireTenant } from "../auth.js"

import { pool } from "../db.js"

import { writeAuditLog } from "../audit-log.js"

import type { AuthenticatedRequest } from "../types.js"

const router = Router()

router.use(authenticate)

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
  paymentReference: z.string().trim().min(2).max(120).optional(),
})

const transitions: Record<string, string[]> = {
  "En préparation": ["Prêt à transmettre"],

  "Prêt à transmettre": ["En instruction", "À corriger"],

  "En instruction": ["À corriger", "Payé", "Refusé"],

  "À corriger": ["En préparation", "Prêt à transmettre"],

  Payé: [],

  Refusé: [],
}

router.get("/", requireAnyCapability("manage_finance", "read_finance"), async (request, response) => {
  const userRequest = request as AuthenticatedRequest

  const tenantId = requireTenant(userRequest, response)

  if (!tenantId) return

  const [entries, summary] = await Promise.all([
    pool.query(
      `SELECT d.id, d.reference, d.site_id AS "siteId", s.name AS "siteName",
              d.subject, d.amount_fcfa AS "amountFcfa", d.status,
              d.payment_reference AS "paymentReference", d.due_date AS "dueDate",
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

router.post(
  "/",
  requireAnyCapability("manage_finance", "manage_finance_planning"),
  async (request, response) => {
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

    const client = await pool.connect()
    try {
      await client.query("BEGIN")
      const result = await client.query(
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
      await writeAuditLog(client, request, {
        actorId: userRequest.authUser.id,
        actorRole: userRequest.authUser.role,
        tenantId,
        targetType: "payment_dossier",
        targetId: result.rows[0].id,
        action: "PAYMENT_DOSSIER_CREATED",
        payloadMasked: {
          reference: result.rows[0].reference,
          siteId: dossier.siteId,
          amountFcfa: dossier.amountFcfa,
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

router.patch(
  "/:id",
  requireAnyCapability("manage_finance", "manage_finance_planning"),
  async (request, response) => {
    const userRequest = request as AuthenticatedRequest
    const tenantId = requireTenant(userRequest, response)
    if (!tenantId) return
    const id = z.uuid().safeParse(request.params.id)
    const parsed = paymentSchema.safeParse(request.body)
    if (!id.success || !parsed.success) {
      response.status(400).json({ error: "Mise à jour du dossier invalide." })
      return
    }
    const client = await pool.connect()
    try {
      await client.query("BEGIN")
      const current = await client.query<{
        status: string
        site_id: string
        subject: string
        amount_fcfa: string
        due_date: string | null
      }>(
        `SELECT status, site_id, subject, amount_fcfa::text, due_date
         FROM payment_dossiers WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
        [id.data, tenantId],
      )
      if (!current.rowCount) {
        await client.query("ROLLBACK")
        response.status(404).json({ error: "Dossier de paiement introuvable." })
        return
      }
      if (current.rows[0]!.status !== "En préparation") {
        await client.query("ROLLBACK")
        response.status(409).json({
          error: "Un dossier déjà transmis ne peut plus être modifié.",
        })
        return
      }
      const site = await client.query(
        "SELECT 1 FROM sites WHERE id = $1 AND tenant_id = $2",
        [parsed.data.siteId, tenantId],
      )
      if (!site.rowCount) {
        await client.query("ROLLBACK")
        response
          .status(404)
          .json({ error: "Chantier introuvable dans votre entreprise." })
        return
      }
      const result = await client.query(
        `UPDATE payment_dossiers
         SET site_id = $1, subject = $2, amount_fcfa = $3,
             due_date = $4, updated_at = now()
         WHERE id = $5 AND tenant_id = $6 AND status = 'En préparation'
         RETURNING id, reference, site_id AS "siteId", subject,
                   amount_fcfa AS "amountFcfa", status,
                   due_date AS "dueDate", created_at AS "createdAt",
                   updated_at AS "updatedAt"`,
        [
          parsed.data.siteId,
          parsed.data.subject,
          parsed.data.amountFcfa,
          parsed.data.dueDate ?? null,
          id.data,
          tenantId,
        ],
      )
      await writeAuditLog(client, request, {
        actorId: userRequest.authUser.id,
        actorRole: userRequest.authUser.role,
        tenantId,
        targetType: "payment_dossier",
        targetId: id.data,
        action: "PAYMENT_DOSSIER_UPDATED",
        payloadMasked: {
          reference: result.rows[0].reference,
          siteId: parsed.data.siteId,
          amountFcfa: parsed.data.amountFcfa,
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

router.patch("/:id/status", requireAnyCapability("manage_finance"), async (request, response) => {
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
  if (parsed.data.status === "Payé" && !parsed.data.paymentReference) {
    response.status(400).json({
      error: "La référence d’encaissement est obligatoire pour clôturer une situation.",
    })
    return
  }

  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    const current = await client.query<{
      status: string
      site_id: string
      subject: string
      amount_fcfa: string
      due_date: string | null
    }>(
      `SELECT status, site_id, subject, amount_fcfa::text, due_date
       FROM payment_dossiers WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
      [id.data, tenantId],
    )
    const existing = current.rows[0]
    if (!existing) {
      await client.query("ROLLBACK")
      response.status(404).json({ error: "Dossier de paiement introuvable." })
      return
    }
    if (!transitions[existing.status]?.includes(parsed.data.status)) {
      await client.query("ROLLBACK")
      response.status(409).json({
        error: `Transition impossible : ${existing.status} vers ${parsed.data.status}.`,
      })
      return
    }
    const result = await client.query(
      `UPDATE payment_dossiers
       SET status = $1, payment_reference = $2, updated_at = now()
       WHERE id = $3 AND tenant_id = $4
       RETURNING id, status, payment_reference AS "paymentReference",
                 updated_at AS "updatedAt"`,
      [
        parsed.data.status,
        parsed.data.status === "Payé" ? parsed.data.paymentReference : null,
        id.data,
        tenantId,
      ],
    )
    if (parsed.data.status === "Payé") {
      const dossier = current.rows[0]!
      await client.query(
        `INSERT INTO finance_entries (
           tenant_id, site_id, created_by, entry_type, category, description,
           amount_fcfa, status, due_date, occurred_at
         )
         VALUES ($1, $2, $3, 'encaissement', 'Situation de travaux', $4,
                 $5, 'réalisé', $6, now())`,
        [
          tenantId,
          dossier.site_id,
          userRequest.authUser.id,
          `Encaissement ${dossier.subject} · ${parsed.data.paymentReference}`,
          dossier.amount_fcfa,
          dossier.due_date,
        ],
      )
    }
    await writeAuditLog(client, request, {
      actorId: userRequest.authUser.id,
      actorRole: userRequest.authUser.role,
      tenantId,
      targetType: "payment_dossier",
      targetId: id.data,
      action: "PAYMENT_DOSSIER_STATUS_CHANGED",
      payloadMasked: {
        previousStatus: existing.status,
        status: parsed.data.status,
        paymentReferenceProvided:
          parsed.data.status === "Payé" && Boolean(parsed.data.paymentReference),
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
})

export default router
