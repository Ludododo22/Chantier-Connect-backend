import bcrypt from "bcryptjs"
import type { NextFunction, Request, Response } from "express"
import jwt from "jsonwebtoken"
import { pool } from "./db.js"
import { config } from "./config.js"
import { roleAccess } from "./role-access.js"
import type {
  AuthenticatedRequest,
  AuthUser,
  Capability,
  UserRole,
} from "./types.js"

interface UserRow {
  id: string
  email: string
  phone: string | null
  password_hash?: string
  full_name: string
  initials: string
  role: UserRole
  role_label: string
  tenant_id: string | null
  tenant_name: string
  tenant_plan: string
  assigned_site: string | null
  assigned_site_id: string | null
  assigned_site_name: string | null
  session_version: number
  requires_user_consent: boolean
  sensitive_data_consented: boolean
  must_change_password: boolean
  sections: string[]
  capabilities: Capability[]
  tenant_status?: string | null
  subscription_status?: string | null
  subscription_not_expired?: boolean
  has_profile_photo?: boolean
}

const sessionCookie = "cc_session"
const cookieOptions = {
  httpOnly: true,
  secure: config.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
}

export function publicUser(user: AuthUser) {
  return {
    id: user.id,
    email: user.email,
    phone: user.phone,
    fullName: user.fullName,
    initials: user.initials,
    role: user.role,
    roleLabel: user.roleLabel,
    tenantId: user.tenantId,
    tenantName: user.tenantName,
    tenantPlan: user.tenantPlan,
    assignedSite: user.assignedSite,
    assignedSiteId: user.assignedSiteId,
    requiresUserConsent: user.requiresUserConsent,
    sensitiveDataConsented: user.sensitiveDataConsented,
    mustChangePassword: user.mustChangePassword,
    sections: user.sections,
    capabilities: user.capabilities,
    profilePhotoUrl: user.profilePhotoUrl,
  }
}

function asAuthUser(row: UserRow): AuthUser {
  const access = roleAccess[row.role]
  return {
    id: row.id,
    email: row.email,
    phone: row.phone,
    fullName: row.full_name,
    initials: row.initials,
    role: row.role,
    roleLabel: access.label,
    tenantId: row.tenant_id,
    tenantName: row.tenant_name,
    tenantPlan: row.tenant_plan,
    assignedSite: row.assigned_site_name ?? row.assigned_site,
    assignedSiteId: row.assigned_site_id,
    sessionVersion: row.session_version,
    requiresUserConsent: row.requires_user_consent,
    sensitiveDataConsented: row.sensitive_data_consented,
    mustChangePassword: row.must_change_password,
    sections: access.sections,
    capabilities: access.capabilities,
    profilePhotoUrl: row.has_profile_photo
      ? "/api/auth/profile/photo"
      : null,
  }
}

function getSessionToken(request: Request): string | null {
  const cookieHeader = request.headers.cookie
  if (!cookieHeader) return null

  for (const cookie of cookieHeader.split(";")) {
    const [name, ...valueParts] = cookie.trim().split("=")
    if (name !== sessionCookie) continue
    try {
      return decodeURIComponent(valueParts.join("="))
    } catch {
      return null
    }
  }
  return null
}

export async function authenticate(
  request: Request,
  response: Response,
  next: NextFunction,
) {
  const token = getSessionToken(request)
  if (!token) {
    response.status(401).json({ error: "Authentification requise." })
    return
  }

  let userId: string
  let sessionVersion = 0
  try {
    const payload = jwt.verify(token, config.JWT_SECRET)
    if (typeof payload === "string" || typeof payload.sub !== "string") {
      response.status(401).json({ error: "Session invalide." })
      return
    }
    userId = payload.sub
    sessionVersion = typeof payload.sv === "number" ? payload.sv : 0
  } catch {
    response.status(401).json({ error: "Session expirée ou invalide." })
    return
  }

  const result = await pool.query<UserRow>(
    `SELECT u.id, u.email, u.phone, u.full_name, u.initials, u.role,
            u.role_label, u.tenant_id, u.tenant_name, u.tenant_plan,
            u.assigned_site, u.assigned_site_id, assigned.name AS assigned_site_name,
            u.session_version, u.requires_user_consent, u.must_change_password,
            (u.sensitive_data_consented_at IS NOT NULL) AS sensitive_data_consented,
            u.sections, u.capabilities,
            t.status AS tenant_status, s.status AS subscription_status,
            (s.renews_at IS NOT NULL AND s.renews_at >= CURRENT_DATE) AS subscription_not_expired,
            (u.profile_photo_data IS NOT NULL) AS has_profile_photo
     FROM users u
     LEFT JOIN sites assigned
       ON assigned.id = u.assigned_site_id AND assigned.tenant_id = u.tenant_id
     LEFT JOIN tenants t ON t.id = u.tenant_id
     LEFT JOIN tenant_subscriptions s ON s.tenant_id = u.tenant_id
     WHERE u.id = $1 AND u.active = true`,
    [userId],
  )
  const row = result.rows[0]
  if (!row) {
    response.status(401).json({ error: "Compte introuvable ou désactivé." })
    return
  }

  if (
    row.must_change_password &&
    !(
      request.method === "POST" &&
      request.originalUrl.split("?")[0] === "/api/auth/first-password"
    )
  ) {
    response.status(403).json({
      error: "Vous devez remplacer votre mot de passe provisoire avant de continuer.",
      code: "PASSWORD_CHANGE_REQUIRED",
    })
    return
  }

  if (row.session_version !== sessionVersion) {
    response.status(401).json({ error: "Cette session a Ã©tÃ© rÃ©voquÃ©e." })
    return
  }

  const hasValidTenantAccess =
    !row.tenant_id ||
    ((row.tenant_status === "Actif" || row.tenant_status === "Essai") &&
      (row.subscription_status === "Actif" || row.subscription_status === "Essai") &&
      row.subscription_not_expired)

  if (!hasValidTenantAccess) {
    response.status(401).json({
      error: "Votre accès a été suspendu. Contactez votre administrateur ou le support.",
    })
    return
  }

  request.authUser = asAuthUser(row)
  next()
}

export function requireAnyCapability(...required: Capability[]) {
  return (request: Request, response: Response, next: NextFunction) => {
    const user = request.authUser
    if (!user || !required.some((item) => user.capabilities.includes(item))) {
      response.status(403).json({ error: "Action non autorisée." })
      return
    }
    next()
  }
}

export function requireTenant(
  request: AuthenticatedRequest,
  response: Response,
): string | null {
  if (!request.authUser.tenantId) {
    response.status(403).json({ error: "Cette ressource exige un espace entreprise." })
    return null
  }
  return request.authUser.tenantId
}

export async function authenticatePassword(
  identifier: string,
  password: string,
): Promise<AuthUser | null> {
  const normalized = identifier.trim().toLowerCase()
  const result = await pool.query<UserRow>(
    `SELECT u.id, u.email, u.phone, u.password_hash, u.full_name, u.initials,
            u.role, u.role_label, u.tenant_id, u.tenant_name, u.tenant_plan,
            u.assigned_site, u.assigned_site_id, assigned.name AS assigned_site_name,
            u.session_version, u.requires_user_consent, u.must_change_password,
            (u.sensitive_data_consented_at IS NOT NULL) AS sensitive_data_consented,
            u.sections, u.capabilities,
            t.status AS tenant_status, s.status AS subscription_status,
            (s.renews_at IS NOT NULL AND s.renews_at >= CURRENT_DATE) AS subscription_not_expired,
            (u.profile_photo_data IS NOT NULL) AS has_profile_photo
     FROM users u
     LEFT JOIN sites assigned
       ON assigned.id = u.assigned_site_id AND assigned.tenant_id = u.tenant_id
     LEFT JOIN tenants t ON t.id = u.tenant_id
     LEFT JOIN tenant_subscriptions s ON s.tenant_id = u.tenant_id
     WHERE u.active = true
       AND (lower(u.email) = $1 OR u.phone = $2)
     LIMIT 1`,
    [normalized, identifier.trim()],
  )
  const row = result.rows[0]
  if (!row?.password_hash || !(await bcrypt.compare(password, row.password_hash))) return null

  const hasValidTenantAccess =
    !row.tenant_id ||
    ((row.tenant_status === "Actif" || row.tenant_status === "Essai") &&
      (row.subscription_status === "Actif" || row.subscription_status === "Essai") &&
      row.subscription_not_expired)

  if (!hasValidTenantAccess) return null

  return asAuthUser(row)
}

export function issueSession(response: Response, user: AuthUser, rememberMe: boolean) {
  const lifetimeSeconds = rememberMe ? 7 * 24 * 60 * 60 : 12 * 60 * 60
  const token = jwt.sign({ sub: user.id, sv: user.sessionVersion }, config.JWT_SECRET, {
    expiresIn: lifetimeSeconds,
  })
  response.cookie(sessionCookie, token, {
    ...cookieOptions,
    maxAge: lifetimeSeconds * 1000,
  })
}

export function clearSession(response: Response) {
  response.clearCookie(sessionCookie, cookieOptions)
}
