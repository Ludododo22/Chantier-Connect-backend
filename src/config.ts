import { z } from "zod"

const environmentSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),

  PORT: z.coerce.number().int().min(1).max(65535).default(3001),

  DATABASE_URL: z.string().min(1, "DATABASE_URL est obligatoire."),

  DATABASE_SSL: z

    .enum(["true", "false"])

    .default("false")

    .transform((value) => value === "true"),

  JWT_SECRET: z
    .string()
    .min(32, "JWT_SECRET doit contenir au moins 32 caractères."),

  RESEND_API_KEY: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().trim().min(1).optional(),
  ),

  EMAIL_FROM: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().trim().min(3).optional(),
  ),

  APP_ORIGIN: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.url()
      .refine((value) => {
        const url = new URL(value)
        return (
          url.pathname === "/" &&
          !url.search &&
          !url.hash &&
          !url.username &&
          !url.password
        )
      })
      .optional(),
  ),
})

const result = environmentSchema.safeParse(process.env)

if (!result.success) {
  console.error(
    "Configuration backend invalide :",
    result.error.flatten().fieldErrors,
  )

  throw new Error("Vérifiez les variables d’environnement requises.")
}

const productionConfigurationErrors: string[] = []

if (result.data.NODE_ENV === "production") {
  if (!result.data.DATABASE_SSL) {
    productionConfigurationErrors.push("DATABASE_SSL doit être activé.")
  }

  const isPlaceholderSecret =
    /^(replace-with|change-me|changeme|your[-_]|example)/i.test(
      result.data.JWT_SECRET,
    )

  const hasEnoughSecretVariety = new Set(result.data.JWT_SECRET).size >= 16

  if (
    result.data.JWT_SECRET.length < 64 ||
    isPlaceholderSecret ||
    !hasEnoughSecretVariety
  ) {
    productionConfigurationErrors.push(
      "JWT_SECRET doit être une clé aléatoire d’au moins 64 caractères.",
    )
  }
}

if (productionConfigurationErrors.length > 0) {
  console.error(
    "Configuration de production invalide :",

    productionConfigurationErrors,
  )

  throw new Error("Corrigez les prérequis de configuration de production.")
}

export const config = result.data
