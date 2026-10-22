import { Router } from "express"

import { z } from "zod"

import { authenticate, requireAnyCapability, requireTenant } from "../auth.js"
import { writeAuditLog } from "../audit-log.js"
import { pool } from "../db.js"
import type { AuthenticatedRequest } from "../types.js"

const router = Router()

router.use(authenticate)

const invoiceSchema = z.object({
  siteId: z.uuid(),
  supplierName: z.string().trim().min(2).max(180),
  invoiceReference: z.string().trim().min(1).max(100),
  category: z.string().trim().min(2).max(100),
  description: z.string().trim().max(2000).default(""),
  amountFcfa: z.number().int().positive().max(9_000_000_000_000),
  invoiceDate: z.iso.date().nullable().optional(),
  dueDate: z.iso.date().nullable().optional(),
})

router.get(
  "/",
  requireAnyCapability("manage_finance", "manage_finance_planning"),
  async (request, response) => {
    const userRequest = request as AuthenticatedRequest
    const tenantId = requireTenant(userRequest, response)
    if (!tenantId) return
    const result = await pool.query(
      `SELECT invoice.id, invoice.site_id AS "siteId", site.name AS "siteName",
              invoice.supplier_name AS "supplierName",
              invoice.invoice_reference AS "invoiceReference",
              invoice.category, invoice.description,
              invoice.amount_fcfa::text AS "amountFcfa",
              invoice.invoice_date AS "invoiceDate",
              invoice.due_date AS "dueDate", invoice.status,
              invoice.payment_reference AS "paymentReference",
              invoice.paid_at AS "paidAt",
              invoice.created_at AS "createdAt",
              invoice.updated_at AS "updatedAt"
       FROM supplier_invoices invoice
       JOIN sites site ON site.id = invoice.site_id
         AND site.tenant_id = invoice.tenant_id
       WHERE invoice.tenant_id = $1
       ORDER BY invoice.created_at DESC`,
      [tenantId],
    )
    response.json({ data: result.rows })
  },
)

router.post(
  "/",
  requireAnyCapability("manage_finance", "manage_finance_planning"),
  async (request, response) => {
    const userRequest = request as AuthenticatedRequest
    const tenantId = requireTenant(userRequest, response)
    if (!tenantId) return
    const parsed = invoiceSchema.safeParse(request.body)
    if (!parsed.success) {
      response.status(400).json({
        error: "Facture fournisseur invalide.",
        details: parsed.error.flatten().fieldErrors,
      })
      return
    }
    const client = await pool.connect()
    try {
      await client.query("BEGIN")
      const result = await client.query(
        `INSERT INTO supplier_invoices (
           tenant_id, site_id, created_by, supplier_name, invoice_reference,
           category, description, amount_fcfa, invoice_date, due_date
         )
         SELECT $1, site.id, $2, $4, $5, $6, $7, $8, $9, $10
         FROM sites site
         WHERE site.id = $3 AND site.tenant_id = $1
         RETURNING id, site_id AS "siteId", supplier_name AS "supplierName",
                   invoice_reference AS "invoiceReference", category, description,
                   amount_fcfa::text AS "amountFcfa", invoice_date AS "invoiceDate",
                   due_date AS "dueDate", status, payment_reference AS "paymentReference",
                   paid_at AS "paidAt", created_at AS "createdAt",
                   updated_at AS "updatedAt"`,
        [
          tenantId,
          userRequest.authUser.id,
          parsed.data.siteId,
          parsed.data.supplierName,
          parsed.data.invoiceReference,
          parsed.data.category,
          parsed.data.description,
          parsed.data.amountFcfa,
          parsed.data.invoiceDate ?? null,
          parsed.data.dueDate ?? null,
        ],
      )
      if (!result.rowCount) {
        await client.query("ROLLBACK")
        response.status(404).json({ error: "Chantier introuvable dans l’entreprise." })
        return
      }
      await writeAuditLog(client, request, {
        actorId: userRequest.authUser.id,
        actorRole: userRequest.authUser.role,
        tenantId,
        targetType: "supplier_invoice",
        targetId: result.rows[0].id,
        action: "SUPPLIER_INVOICE_CREATED",
        payloadMasked: {
          siteId: parsed.data.siteId,
          invoiceReference: parsed.data.invoiceReference,
          amountFcfa: parsed.data.amountFcfa,
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
    const parsed = invoiceSchema.safeParse(request.body)
    if (!id.success || !parsed.success) {
      response.status(400).json({ error: "Mise à jour de facture invalide." })
      return
    }
    const client = await pool.connect()
    try {
      await client.query("BEGIN")
      const current = await client.query<{ status: string }>(
        "SELECT status FROM supplier_invoices WHERE id = $1 AND tenant_id = $2 FOR UPDATE",
        [id.data, tenantId],
      )
      if (!current.rowCount) {
        await client.query("ROLLBACK")
        response.status(404).json({ error: "Facture fournisseur introuvable." })
        return
      }
      if (current.rows[0]!.status !== "En préparation") {
        await client.query("ROLLBACK")
        response.status(409).json({
          error: "Une facture soumise au contrôle ne peut plus être modifiée.",
        })
        return
      }
      const result = await client.query(
        `UPDATE supplier_invoices invoice
         SET site_id = site.id, supplier_name = $1, invoice_reference = $2,
             category = $3, description = $4, amount_fcfa = $5,
             invoice_date = $6, due_date = $7, updated_at = now()
         FROM sites site
         WHERE invoice.id = $8 AND invoice.tenant_id = $9
           AND invoice.status = 'En préparation'
           AND site.id = $10 AND site.tenant_id = $9
         RETURNING invoice.id, invoice.site_id AS "siteId",
                   invoice.supplier_name AS "supplierName",
                   invoice.invoice_reference AS "invoiceReference",
                   invoice.category, invoice.description,
                   invoice.amount_fcfa::text AS "amountFcfa",
                   invoice.invoice_date AS "invoiceDate",
                   invoice.due_date AS "dueDate", invoice.status,
                   invoice.payment_reference AS "paymentReference",
                   invoice.paid_at AS "paidAt",
                   invoice.created_at AS "createdAt",
                   invoice.updated_at AS "updatedAt"`,
        [
          parsed.data.supplierName,
          parsed.data.invoiceReference,
          parsed.data.category,
          parsed.data.description,
          parsed.data.amountFcfa,
          parsed.data.invoiceDate ?? null,
          parsed.data.dueDate ?? null,
          id.data,
          tenantId,
          parsed.data.siteId,
        ],
      )
      if (!result.rowCount) {
        await client.query("ROLLBACK")
        response.status(404).json({ error: "Chantier introuvable dans l’entreprise." })
        return
      }
      await writeAuditLog(client, request, {
        actorId: userRequest.authUser.id,
        actorRole: userRequest.authUser.role,
        tenantId,
        targetType: "supplier_invoice",
        targetId: id.data,
        action: "SUPPLIER_INVOICE_UPDATED",
        payloadMasked: {
          invoiceReference: parsed.data.invoiceReference,
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

router.patch(
  "/:id/submit",
  requireAnyCapability("manage_finance_planning"),
  async (request, response) => {
    const userRequest = request as AuthenticatedRequest
    const tenantId = requireTenant(userRequest, response)
    if (!tenantId) return
    const id = z.uuid().safeParse(request.params.id)
    if (!id.success) {
      response.status(400).json({ error: "Identifiant de facture invalide." })
      return
    }
    const client = await pool.connect()
    try {
      await client.query("BEGIN")
      const result = await client.query(
        `UPDATE supplier_invoices
         SET status = 'À contrôler', updated_at = now()
         WHERE id = $1 AND tenant_id = $2 AND status = 'En préparation'
         RETURNING id, status`,
        [id.data, tenantId],
      )
      if (!result.rowCount) {
        await client.query("ROLLBACK")
        response.status(409).json({
          error: "Seule une facture en préparation peut être soumise au contrôle.",
        })
        return
      }
      await writeAuditLog(client, request, {
        actorId: userRequest.authUser.id,
        actorRole: userRequest.authUser.role,
        tenantId,
        targetType: "supplier_invoice",
        targetId: id.data,
        action: "SUPPLIER_INVOICE_SUBMITTED",
        payloadMasked: {},
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

router.patch(
  "/:id/status",
  requireAnyCapability("manage_finance"),
  async (request, response) => {
    const userRequest = request as AuthenticatedRequest
    const tenantId = requireTenant(userRequest, response)
    if (!tenantId) return
    const id = z.uuid().safeParse(request.params.id)
    const parsed = z.object({
      status: z.enum(["Approuvée", "Payée", "Refusée"]),
      paymentReference: z.string().trim().min(2).max(120).optional(),
    }).safeParse(request.body)
    if (!id.success || !parsed.success) {
      response.status(400).json({ error: "Mise à jour du statut invalide." })
      return
    }
    if (parsed.data.status === "Payée" && !parsed.data.paymentReference) {
      response.status(400).json({
        error: "La référence du paiement est requise pour enregistrer une facture payée.",
      })
      return
    }
    const client = await pool.connect()
    try {
      await client.query("BEGIN")
      const current = await client.query<{
        site_id: string
        supplier_name: string
        invoice_reference: string
        category: string
        amount_fcfa: string
        due_date: string | null
        status: string
      }>(
        `SELECT site_id, supplier_name, invoice_reference, category,
                amount_fcfa::text, due_date, status
         FROM supplier_invoices
         WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
        [id.data, tenantId],
      )
      const invoice = current.rows[0]
      if (!invoice) {
        await client.query("ROLLBACK")
        response.status(404).json({ error: "Facture fournisseur introuvable." })
        return
      }
      const allowed =
        (invoice.status === "À contrôler" &&
          ["Approuvée", "Refusée"].includes(parsed.data.status)) ||
        (invoice.status === "Approuvée" && parsed.data.status === "Payée")
      if (!allowed) {
        await client.query("ROLLBACK")
        response.status(409).json({
          error: `Transition impossible : ${invoice.status} vers ${parsed.data.status}.`,
        })
        return
      }
      const result = await client.query(
        `UPDATE supplier_invoices
         SET status = $1, payment_reference = $2,
             paid_at = CASE WHEN $1 = 'Payée' THEN now() ELSE NULL END,
             updated_at = now()
         WHERE id = $3 AND tenant_id = $4
         RETURNING id, status, payment_reference AS "paymentReference",
                   paid_at AS "paidAt", updated_at AS "updatedAt"`,
        [
          parsed.data.status,
          parsed.data.status === "Payée" ? parsed.data.paymentReference : null,
          id.data,
          tenantId,
        ],
      )
      if (parsed.data.status === "Payée") {
        await client.query(
          `INSERT INTO finance_entries (
             tenant_id, site_id, created_by, entry_type, category, description,
             amount_fcfa, status, due_date, occurred_at
           )
           VALUES ($1, $2, $3, 'depense', $4, $5, $6, 'réalisé', $7, now())`,
          [
            tenantId,
            invoice.site_id,
            userRequest.authUser.id,
            invoice.category,
            `Facture fournisseur ${invoice.supplier_name} · ${invoice.invoice_reference} · paiement ${parsed.data.paymentReference}`,
            Number(invoice.amount_fcfa),
            invoice.due_date,
          ],
        )
      }
      await writeAuditLog(client, request, {
        actorId: userRequest.authUser.id,
        actorRole: userRequest.authUser.role,
        tenantId,
        targetType: "supplier_invoice",
        targetId: id.data,
        action: "SUPPLIER_INVOICE_STATUS_CHANGED",
        payloadMasked: {
          status: parsed.data.status,
          paymentReferenceProvided: Boolean(parsed.data.paymentReference),
          siteId: invoice.site_id,
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
