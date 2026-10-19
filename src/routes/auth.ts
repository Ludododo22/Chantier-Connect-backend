import { Router } from "express"

import { rateLimit } from "express-rate-limit"

import { z } from "zod"

import { pool } from "../db.js"

import { getPlatformRequestLimit } from "../platform-settings.js"

import {
  authenticate,
  authenticatePassword,
  clearSession,
  issueSession,
  publicUser,
} from "../auth.js"

const router = Router()

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,

  limit: async () => getPlatformRequestLimit(),

  skipSuccessfulRequests: true,

  standardHeaders: "draft-8",

  legacyHeaders: false,

  message: { error: "Trop de tentatives. Réessayez dans 15 minutes." },
})

const loginSchema = z.object({
  identifier: z.string().trim().min(1).max(254),

  password: z.string().min(1).max(256),

  rememberMe: z.boolean().default(false),
})

const profileSchema = z.object({
  fullName: z.string().trim().min(2).max(120),

  email: z.email().trim().toLowerCase(),

  phone: z.string().trim().max(30).nullable(),
})

const profilePhotoSchema = z.object({
  contentType: z.enum(["image/jpeg", "image/png", "image/webp"]),
  imageBase64: z.string().min(1).max(2_800_000),
})

router.post("/login", loginLimiter, async (request, response) => {
  const parsed = loginSchema.safeParse(request.body)

  if (!parsed.success) {
    response.status(400).json({
      error: "Identifiant ou mot de passe requis.",

      details: parsed.error.flatten().fieldErrors,
    })

    return
  }

  const user = await authenticatePassword(
    parsed.data.identifier,
    parsed.data.password,
  )

  if (!user) {
    response
      .status(401)
      .json({ error: "Identifiant ou mot de passe incorrect." })

    return
  }

  issueSession(response, user, parsed.data.rememberMe)

  response.json({ user: publicUser(user) })
})

router.get("/profile/photo", authenticate, async (request, response) => {
  const result = await pool.query<{
    profile_photo_data: Buffer | null
    profile_photo_content_type: string | null
  }>(
    `SELECT profile_photo_data, profile_photo_content_type
     FROM users WHERE id = $1 AND active = true`,
    [request.authUser!.id],
  )
  const photo = result.rows[0]
  if (!photo?.profile_photo_data || !photo.profile_photo_content_type) {
    response.status(404).json({ error: "Aucune photo de profil enregistrée." })
    return
  }
  response.setHeader("Cache-Control", "private, no-store")
  response.setHeader("X-Content-Type-Options", "nosniff")
  response.type(photo.profile_photo_content_type).send(photo.profile_photo_data)
})

router.put("/profile/photo", authenticate, async (request, response) => {
  const parsed = profilePhotoSchema.safeParse(request.body)
  if (!parsed.success) {
    response.status(400).json({ error: "Photo ou format invalide." })
    return
  }

  const image = Buffer.from(parsed.data.imageBase64, "base64")
  const canonicalBase64 = image.toString("base64").replace(/=+$/, "")
  if (
    image.length === 0 ||
    image.length > 2 * 1024 * 1024 ||
    canonicalBase64 !== parsed.data.imageBase64.replace(/=+$/, "")
  ) {
    response.status(400).json({ error: "La photo doit peser au maximum 2 Mo." })
    return
  }

  const { contentType } = parsed.data
  const validSignature =
    (contentType === "image/jpeg" && image.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) ) ||
    (contentType === "image/png" && image.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) ||
    (contentType === "image/webp" && image.toString("ascii", 0, 4) === "RIFF" && image.toString("ascii", 8, 12) === "WEBP")
  if (!validSignature) {
    response.status(400).json({ error: "Le contenu ne correspond pas au format image choisi." })
    return
  }

  const updated = await pool.query(
    `UPDATE users
     SET profile_photo_data = $1, profile_photo_content_type = $2
     WHERE id = $3 AND active = true
     RETURNING id`,
    [image, contentType, request.authUser!.id],
  )
  if (!updated.rowCount) {
    response.status(401).json({ error: "Votre compte n’est plus actif." })
    return
  }
  response.json({ data: { profilePhotoUrl: "/api/auth/profile/photo" } })
})

router.delete("/profile/photo", authenticate, async (request, response) => {
  await pool.query(
    `UPDATE users
     SET profile_photo_data = NULL, profile_photo_content_type = NULL
     WHERE id = $1 AND active = true`,
    [request.authUser!.id],
  )
  response.status(204).end()
})

router.patch("/profile", authenticate, async (request, response) => {
  const parsed = profileSchema.safeParse(request.body)

  if (!parsed.success) {
    response.status(400).json({
      error: "Vérifiez votre nom, votre email et votre téléphone.",

      details: parsed.error.flatten().fieldErrors,
    })

    return
  }

  if (parsed.data.phone && parsed.data.phone.length < 7) {
    response.status(400).json({
      error: "Le numéro de téléphone doit contenir au moins 7 caractères.",
    })

    return
  }

  const { fullName, email, phone } = parsed.data

  const normalizedPhone = phone || null

  const initials = fullName

    .split(/\s+/)

    .slice(0, 2)

    .map((part) => part[0]!.toLocaleUpperCase("fr-FR"))

    .join("")

  try {
    const updated = await pool.query(
      `UPDATE users
       SET full_name = $1, initials = $2, email = $3, phone = $4
       WHERE id = $5 AND active = true
       RETURNING id`,

      [fullName, initials, email, normalizedPhone, request.authUser!.id],
    )

    if (!updated.rowCount) {
      response.status(401).json({ error: "Votre compte n’est plus actif." })

      return
    }
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "23505"
    ) {
      response.status(409).json({
        error: "Cet email ou ce numéro de téléphone est déjà utilisé.",
      })

      return
    }

    throw error
  }

  response.json({
    user: publicUser({
      ...request.authUser!,

      fullName,

      initials,

      email,

      phone: normalizedPhone,
    }),
  })
})

router.get("/me", authenticate, (request, response) => {
  response.json({ user: publicUser(request.authUser!) })
})

router.post("/logout", (_request, response) => {
  clearSession(response)

  response.status(204).end()
})

export default router
