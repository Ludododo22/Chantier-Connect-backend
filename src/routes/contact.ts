import { Router } from "express"

import { rateLimit } from "express-rate-limit"

import { z } from "zod"

import { pool } from "../db.js"

const router = Router()

const contactLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Trop de demandes. Réessayez dans quelques minutes." },
})

const contactSchema = z.object({
  fullName: z.string().trim().min(2).max(120),
  email: z.email().trim().max(254),
  phone: z.string().trim().max(30),
  company: z.string().trim().max(160),
  topic: z.enum([
    "Demander une démonstration",
    "Information sur une formule",
    "Autre demande",
  ]),
  message: z.string().trim().min(10).max(3000),
  consent: z.literal(true),
  website: z.string().max(200),
})

router.post("/", contactLimiter, async (request, response) => {
  const parsed = contactSchema.safeParse(request.body)

  if (!parsed.success) {
    response.status(400).json({
      error: "Vérifiez les champs du formulaire et votre consentement.",
      details: parsed.error.flatten().fieldErrors,
    })
    return
  }

  if (parsed.data.website) {
    response.status(202).json({ message: "Votre demande a été reçue." })
    return
  }

  const { fullName, email, phone, company, topic, message } = parsed.data
  await pool.query(
    `INSERT INTO contact_requests
       (full_name, email, phone, company, topic, message, consent_at)
     VALUES ($1, $2, NULLIF($3, ''), NULLIF($4, ''), $5, $6, now())`,
    [fullName, email.toLowerCase(), phone, company, topic, message],
  )

  response.status(201).json({
    message: "Votre demande a bien été transmise. Notre équipe vous recontactera.",
  })
})

export default router
