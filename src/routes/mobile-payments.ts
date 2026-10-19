import { Router } from "express"

import { z } from "zod"

import { authenticate, requireAnyCapability, requireTenant } from "../auth.js"

import { pool } from "../db.js"

import type { AuthenticatedRequest } from "../types.js"

const router = Router()

const providerKeySchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{1,39}$/)

const intentSchema = z.object({
  invoiceId: z.uuid(),
  provider: providerKeySchema,
  phoneNumber: z.string().trim().min(6).max(32),
})

function providerUnavailable(response: Parameters<Parameters<typeof router.post>[1]>[1]) {
  response.status(503).json({
    code: "MOBILE_PAYMENT_PROVIDER_NOT_CONFIGURED",
    error: "Aucun fournisseur de paiement mobile n’est encore configuré.",
  })
}

router.post("/webhooks/:provider", (request, response) => {
  if (!providerKeySchema.safeParse(request.params.provider).success) {
    response.status(400).json({ error: "Fournisseur de paiement invalide." })
    return
  }
  providerUnavailable(response)
})

router.use(authenticate, requireAnyCapability("manage_company"))

router.get("/invoices", async (request, response) => {
  const userRequest = request as AuthenticatedRequest
  const tenantId = requireTenant(userRequest, response)
  if (!tenantId) return

  const result = await pool.query(
    `SELECT id, invoice_number AS "invoiceNumber",
            description, amount_fcfa AS "amountFcfa", 'XAF' AS currency,
            issued_at AS "issuedAt", due_at AS "dueAt", status
     FROM platform_invoices
     WHERE tenant_id = $1
     ORDER BY created_at DESC`,
    [tenantId],
  )
  response.json({ data: result.rows })
})

router.post("/intents", async (request, response) => {
  const userRequest = request as AuthenticatedRequest
  const tenantId = requireTenant(userRequest, response)
  if (!tenantId) return

  const parsed = intentSchema.safeParse(request.body)
  const idempotencyKey = z.string().min(8).max(120).safeParse(
    request.get("Idempotency-Key"),
  )
  if (!parsed.success || !idempotencyKey.success) {
    response.status(400).json({
      error: "Facture, fournisseur, téléphone ou clé d’idempotence invalide.",
      ...(parsed.success ? {} : { details: parsed.error.flatten().fieldErrors }),
    })
    return
  }

  const invoice = await pool.query(
    `SELECT id FROM platform_invoices
     WHERE id = $1 AND tenant_id = $2 AND status = 'À payer'`,
    [parsed.data.invoiceId, tenantId],
  )
  if (!invoice.rowCount) {
    response.status(404).json({ error: "Facture impayée introuvable." })
    return
  }

  providerUnavailable(response)
})

router.get("/intents/:id", async (request, response) => {
  const userRequest = request as AuthenticatedRequest
  const tenantId = requireTenant(userRequest, response)
  if (!tenantId) return

  const id = z.uuid().safeParse(request.params.id)
  if (!id.success) {
    response.status(400).json({ error: "Identifiant de paiement invalide." })
    return
  }

  const result = await pool.query(
    `SELECT a.id, a.provider_key AS provider, a.status,
            a.amount_fcfa AS "amountFcfa", a.currency,
            a.provider_reference AS "providerReference",
            a.created_at AS "createdAt", a.completed_at AS "completedAt"
     FROM platform_mobile_payment_attempts a
     JOIN platform_invoices i ON i.id = a.invoice_id
     WHERE a.id = $1 AND i.tenant_id = $2`,
    [id.data, tenantId],
  )
  if (!result.rowCount) {
    response.status(404).json({ error: "Tentative de paiement introuvable." })
    return
  }
  response.json({ data: result.rows[0] })
})

export default router