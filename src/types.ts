import type { Request } from "express"

export type Capability =
  | "manage_platform"
  | "manage_company"
  | "manage_team"
  | "manage_sites"
  | "manage_tasks"
  | "capture_photos"
  | "create_reports"
  | "validate_reports"
  | "clock_in"
  | "update_assigned_tasks"
  | "manage_finance"
  | "read_company"
  | "read_assigned"
  | "read_team"
  | "read_validated_reports"

export type UserRole =
  | "EDITOR"
  | "ADMIN_ENTERPRISE"
  | "CONDUCTEUR"
  | "CHEF_CHANTIER"
  | "COMPAGNON"
  | "SOUS_TRAITANT"
  | "COMPTABLE"
  | "MAITRE_OUVRAGE"

export interface AuthUser {
  id: string
  email: string
  phone: string | null
  fullName: string
  initials: string
  role: UserRole
  roleLabel: string
  tenantId: string | null
  tenantName: string
  tenantPlan: string
  assignedSite: string | null
  sections: string[]
  capabilities: Capability[]
  profilePhotoUrl: string | null
}

declare global {
  namespace Express {
    interface Request {
      authUser?: AuthUser
    }
  }
}

export type AuthenticatedRequest = Request & { authUser: AuthUser }
