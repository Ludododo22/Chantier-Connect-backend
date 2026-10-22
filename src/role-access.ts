import type { Capability, UserRole } from "./types.js"

export interface RoleAccess {
  label: string
  sections: string[]
  capabilities: Capability[]
}

export const roleAccess: Record<UserRole, RoleAccess> = {
  EDITOR: {
    label: "Super administratrice",
    sections: ["Tableau de bord", "Entreprises", "Utilisateurs", "Journal d’audit", "Abonnements", "Support", "Paramètres", "Profil"],
    capabilities: ["manage_platform"],
  },
  ADMIN_ENTERPRISE: {
    label: "Administratrice entreprise",
    sections: ["Tableau de bord", "Chantiers", "Mes tâches", "Photos", "Rapports", "Équipe", "Budget", "Dossiers de paiement", "Trésorerie", "Factures fournisseurs", "Paramètres", "Profil"],
    capabilities: ["manage_company", "manage_team", "manage_sites", "manage_tasks", "capture_photos", "create_reports", "validate_reports", "manage_finance_planning", "manage_company_budget", "read_finance", "read_company"],
  },
  CONDUCTEUR: {
    label: "Conducteur de travaux",
    sections: ["Tableau de bord", "Chantiers", "Mes tâches", "Photos", "Rapports", "Équipe", "Profil"],
    capabilities: ["manage_tasks", "capture_photos", "validate_reports", "read_assigned", "read_team"],
  },
  CHEF_CHANTIER: {
    label: "Chef de chantier",
    sections: ["Tableau de bord", "Chantiers", "Mes tâches", "Photos", "Rapports", "Équipe", "Pointage", "Profil"],
    capabilities: ["manage_tasks", "capture_photos", "create_reports", "clock_in", "read_assigned", "read_team"],
  },
  COMPAGNON: {
    label: "Compagnon",
    sections: ["Tableau de bord", "Mes tâches", "Photos", "Pointage", "Profil"],
    capabilities: ["capture_photos", "clock_in", "update_assigned_tasks", "read_assigned"],
  },
  SOUS_TRAITANT: {
    label: "Sous-traitant invité",
    sections: ["Tableau de bord", "Mes tâches", "Photos", "Profil"],
    capabilities: ["capture_photos", "update_assigned_tasks", "read_assigned"],
  },
  COMPTABLE: {
    label: "Comptable",
    sections: ["Tableau de bord", "Budget", "Dossiers de paiement", "Trésorerie", "Factures fournisseurs", "Rapports", "Profil"],
    capabilities: ["manage_finance", "read_company", "read_validated_reports"],
  },
  MAITRE_OUVRAGE: {
    label: "Maître d’ouvrage · lecture seule",
    sections: ["Tableau de bord", "Chantiers", "Photos", "Rapports", "Profil"],
    capabilities: ["read_assigned", "read_validated_reports"],
  },
}

export const siteScopedRoles: UserRole[] = [
  "CONDUCTEUR",
  "CHEF_CHANTIER",
  "COMPAGNON",
  "SOUS_TRAITANT",
  "MAITRE_OUVRAGE",
]
