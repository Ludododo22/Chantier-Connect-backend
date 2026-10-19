import { Router } from "express"

import { rateLimit } from "express-rate-limit"

import { z } from "zod"

import { pool } from "../db.js"

const router = Router()

const registrationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Trop de demandes. Réessayez dans quelques minutes." },
})

const registrationSchema = z.object({
  companyName: z.string().trim().min(2).max(160),
  adminFullName: z.string().trim().min(2).max(120),
  adminEmail: z.email().trim().toLowerCase(),
  phone: z.string().trim().max(30),
  message: z.string().trim().min(10).max(2000),
  consent: z.literal(true),
  website: z.string().max(200),
})

router.post("/", registrationLimiter, async (request, response) => {
  const parsed = registrationSchema.safeParse(request.body)

  if (!parsed.success) {
    response.status(400).json({
      error: "Vérifiez les informations et votre consentement.",
      details: parsed.error.flatten().fieldErrors,
    })
    return
  }

  if (parsed.data.website) {
    response.status(202).json({ message: "Votre demande a bien été reçue." })
    return
  }

  const { companyName, adminFullName, adminEmail, phone, message } = parsed.data
  await pool.query(
    `INSERT INTO registration_requests
       (company_name, admin_full_name, admin_email, phone, message, consent_at)
     VALUES ($1, $2, $3, NULLIF($4, ''), $5, now())`,
    [companyName, adminFullName, adminEmail, phone, message],
  )

  response.status(201).json({
    message:
      "Votre demande est transmise à notre équipe. Aucun compte n’est créé avant validation.",
  })
})

export default router
