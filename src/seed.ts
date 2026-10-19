import bcrypt from "bcryptjs"

import "dotenv/config"

import { pool } from "./db.js"

import { roleAccess } from "./role-access.js"

import type { UserRole } from "./types.js"

const tenantId = "10000000-0000-4000-8000-000000000001"

const users: Array<{
  id: string

  email: string

  phone: string | null

  fullName: string

  initials: string

  role: UserRole

  tenantId: string | null

  tenantName: string

  tenantPlan: string

  assignedSite: string | null
}> = [
  {
    id: "30000000-0000-4000-8000-000000000001",

    email: "editeur@chantierconnect.ga",

    phone: null,

    fullName: "Ariane Nkoghe",

    initials: "AN",

    role: "EDITOR",

    tenantId: null,

    tenantName: "Chantier Connect",

    tenantPlan: "Back-office éditeur",

    assignedSite: null,
  },

  {
    id: "30000000-0000-4000-8000-000000000002",

    email: "admin@okoume-btp.ga",

    phone: "+24177000001",

    fullName: "Estelle Moundounga",

    initials: "EM",

    role: "ADMIN_ENTERPRISE",

    tenantId,

    tenantName: "Okoumé BTP",

    tenantPlan: "Plan PME",

    assignedSite: null,
  },

  {
    id: "30000000-0000-4000-8000-000000000003",

    email: "conducteur@okoume-btp.ga",

    phone: "+24177000002",

    fullName: "Jean Moussavou",

    initials: "JM",

    role: "CONDUCTEUR",

    tenantId,

    tenantName: "Okoumé BTP",

    tenantPlan: "Plan PME",

    assignedSite: "Résidence Les Palmiers",
  },

  {
    id: "30000000-0000-4000-8000-000000000004",

    email: "chef@okoume-btp.ga",

    phone: "+24177000003",

    fullName: "Arnaud Mba",

    initials: "AM",

    role: "CHEF_CHANTIER",

    tenantId,

    tenantName: "Okoumé BTP",

    tenantPlan: "Accès terrain",

    assignedSite: "Résidence Les Palmiers",
  },

  {
    id: "30000000-0000-4000-8000-000000000005",

    email: "compagnon@okoume-btp.ga",

    phone: "+24177000004",

    fullName: "Paul Obiang",

    initials: "PO",

    role: "COMPAGNON",

    tenantId,

    tenantName: "Okoumé BTP",

    tenantPlan: "Accès terrain",

    assignedSite: "Résidence Les Palmiers",
  },

  {
    id: "30000000-0000-4000-8000-000000000006",

    email: "sous-traitant@elecplus.ga",

    phone: "+24177000005",

    fullName: "Olivier Essono",

    initials: "OE",

    role: "SOUS_TRAITANT",

    tenantId,

    tenantName: "Okoumé BTP",

    tenantPlan: "Accès externe limité",

    assignedSite: "Centre médical Owendo",
  },

  {
    id: "30000000-0000-4000-8000-000000000007",

    email: "comptable@okoume-btp.ga",

    phone: "+24177000006",

    fullName: "Nadia Kombila",

    initials: "NK",

    role: "COMPTABLE",

    tenantId,

    tenantName: "Okoumé BTP",

    tenantPlan: "Plan PME",

    assignedSite: null,
  },

  {
    id: "30000000-0000-4000-8000-000000000008",

    email: "client@ministere.ga",

    phone: "+24177000007",

    fullName: "Benoît Ndong",

    initials: "BN",

    role: "MAITRE_OUVRAGE",

    tenantId,

    tenantName: "Okoumé BTP",

    tenantPlan: "Portail client",

    assignedSite: "École Nzeng-Ayong",
  },
]

const sites = [
  {
    id: "20000000-0000-4000-8000-000000000001",
    name: "Résidence Les Palmiers",
    location: "Libreville · Batterie IV",
    progress: 68,
    budget: 285_000_000,
  },

  {
    id: "20000000-0000-4000-8000-000000000002",
    name: "École Nzeng-Ayong",
    location: "Libreville · Nzeng-Ayong",
    progress: 42,
    budget: 172_000_000,
  },

  {
    id: "20000000-0000-4000-8000-000000000003",
    name: "Centre médical Owendo",
    location: "Owendo · Zone portuaire",
    progress: 31,
    budget: 214_000_000,
  },
]

async function seed() {
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "Le chargement des comptes de démonstration est interdit en production.",
    )
  }

  const password = process.env.DEMO_SEED_PASSWORD

  if (!password || password.length < 12) {
    throw new Error(
      "Définissez DEMO_SEED_PASSWORD (au moins 12 caractères) dans .env.",
    )
  }

  const passwordHash = await bcrypt.hash(password, 12)

  const client = await pool.connect()

  try {
    await client.query("BEGIN")

    await client.query(
      `INSERT INTO tenants (id, name, plan) VALUES ($1, 'Okoumé BTP', 'Plan PME')
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, plan = EXCLUDED.plan`,

      [tenantId],
    )

    for (const user of users) {
      await client.query(
        `INSERT INTO users (
           id, tenant_id, email, phone, password_hash, full_name, initials, role,
           role_label, tenant_name, tenant_plan, assigned_site, sections, capabilities
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         ON CONFLICT (id) DO UPDATE SET
           tenant_id = EXCLUDED.tenant_id, email = EXCLUDED.email, phone = EXCLUDED.phone,
           password_hash = EXCLUDED.password_hash,
           full_name = EXCLUDED.full_name, initials = EXCLUDED.initials,
           role = EXCLUDED.role, role_label = EXCLUDED.role_label,
           tenant_name = EXCLUDED.tenant_name, tenant_plan = EXCLUDED.tenant_plan,
           assigned_site = EXCLUDED.assigned_site, sections = EXCLUDED.sections,
           capabilities = EXCLUDED.capabilities`,

        [
          user.id,
          user.tenantId,
          user.email,
          user.phone,
          passwordHash,
          user.fullName,

          user.initials,
          user.role,
          roleAccess[user.role].label,
          user.tenantName,
          user.tenantPlan,

          user.assignedSite,
          JSON.stringify(roleAccess[user.role].sections),

          JSON.stringify(roleAccess[user.role].capabilities),
        ],
      )
    }

    for (const site of sites) {
      await client.query(
        `INSERT INTO sites (id, tenant_id, name, location, progress, budget_fcfa)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, location = EXCLUDED.location,
           progress = EXCLUDED.progress, budget_fcfa = EXCLUDED.budget_fcfa`,

        [
          site.id,
          tenantId,
          site.name,
          site.location,
          site.progress,
          site.budget,
        ],
      )
    }

    const tasks = [
      [
        "40000000-0000-4000-8000-000000000001",
        sites[0]!,
        "Contrôler le ferraillage du niveau 2",
        users[4]!,
        "Haute",
        "En cours",
        1,
      ],

      [
        "40000000-0000-4000-8000-000000000002",
        sites[0]!,
        "Préparer la réception des matériaux",
        users[3]!,
        "Normale",
        "À faire",
        3,
      ],

      [
        "40000000-0000-4000-8000-000000000003",
        sites[2]!,
        "Installer les conduits électriques du bloc A",
        users[5]!,
        "Haute",
        "En cours",
        2,
      ],

      [
        "40000000-0000-4000-8000-000000000004",
        sites[1]!,
        "Photographier les fondations",
        users[7]!,
        "Normale",
        "À faire",
        4,
      ],
    ] as const

    for (const [id, site, title, assignee, priority, status, days] of tasks) {
      await client.query(
        `INSERT INTO tasks (id, tenant_id, site_id, title, category, priority, status, due_date, assigned_to, created_by)
         VALUES ($1, $2, $3, $4, 'Travaux', $5, $6, CURRENT_DATE + $7::integer, $8, $9)
         ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, assigned_to = EXCLUDED.assigned_to`,

        [
          id,
          tenantId,
          site.id,
          title,
          priority,
          status,
          days,
          assignee.id,
          users[1]!.id,
        ],
      )
    }

    await client.query(
      `INSERT INTO reports (id, tenant_id, site_id, author_id, work_done, crew_count, status)
       VALUES ($1, $2, $3, $4, $5, 12, 'À valider')
       ON CONFLICT (id) DO NOTHING`,

      [
        "50000000-0000-4000-8000-000000000001",

        tenantId,

        sites[0]!.id,

        users[3]!.id,

        "Coulage de la dalle du niveau 2 et vérification du ferraillage.",
      ],
    )

    await client.query("COMMIT")

    console.info(
      `Comptes de démonstration créés ou actualisés : ${users.length}`,
    )
  } catch (error) {
    await client.query("ROLLBACK")

    throw error
  } finally {
    client.release()

    await pool.end()
  }
}

seed().catch((error: unknown) => {
  console.error("Échec du chargement des données de démonstration :", error)

  process.exitCode = 1
})
