# Chantier Connect — Backend

API Express/Node indépendante du frontend. Elle utilise PostgreSQL via `pg` et se déploie sur un hébergeur Node (Render, Railway, Fly.io ou VPS). Cloudflare ne se connecte pas à PostgreSQL : il relaie les requêtes `/api/*` vers cette API.

## Configuration

Copiez `.env.example` vers `.env` en développement et renseignez :

- `DATABASE_URL` : chaîne PostgreSQL Supabase (de préférence le pooler en mode session, port 5432).
- `DATABASE_SSL=true` pour Supabase et la production. Le backend vérifie le
  certificat TLS PostgreSQL avec le CA versionné `prod-ca-2021.crt`; gardez ce
  fichier présent à la racine du projet déployé.
- `JWT_SECRET` : clé aléatoire d’au moins 64 caractères en production.
- `RESEND_API_KEY`, `EMAIL_FROM` et `APP_ORIGIN` : configuration facultative de l’envoi des liens de réinitialisation. `EMAIL_FROM` doit être une adresse/domaine validé par Resend et `APP_ORIGIN` l’origine HTTPS publique du frontend en production.
- `NODE_ENV=production` et `PORT` (le port fourni par l’hébergeur).

Ne commitez jamais `.env`, et ne lancez pas les données de démonstration en production.

## Déploiement Node

- Répertoire racine du service : `backend/` si le dépôt frontend/backend reste dans un dépôt parent ; sinon la racine du dépôt backend.
- Installation : `npm install`
- Build : `npm run build`
- Démarrage : `npm start`
- Health check : `/api/health`

Configurez les variables runtime dans le gestionnaire de secrets de l’hébergeur. Appliquez les migrations SQL de `migrations/` à Supabase une seule fois, dans l’ordre numérique, avant d’ouvrir l’API au public. `npm run migrate` utilise `DATABASE_URL` et `DATABASE_SSL`; vérifiez d’abord l’impact des migrations sur une base de recette. N’exécutez jamais `npm run seed` en production.

La migration `010_platform_administration.sql` ajoute les journaux d’audit, les jetons de réinitialisation, le consentement aux accès support et les clés d’affectation chantier. Son script de retour arrière est dans `migrations/rollback/010_platform_administration.sql`; il est manuel et doit être évalué avant exécution, car les états « Archivé » sont ramenés aux états disponibles dans l’ancienne version. Sans les variables Resend, la demande publique de réinitialisation garde une réponse générique anti-énumération mais aucun email n’est transmis; configurez les trois variables pour activer ce parcours.

La migration `012_site_project_details.sql` enrichit les chantiers avec leur description, leur ville/province, le maître d’ouvrage, la nature des travaux, la référence du marché et le délai prévu. Appliquez-la avant de déployer la version API qui enregistre ces informations.

La migration `013_company_budget_and_supplier_invoices.sql` ajoute les budgets annuels de fonctionnement, le circuit des factures fournisseurs et la référence d’encaissement des situations clients. Appliquez les migrations `012` et `013` avant le déploiement de l’API correspondante.

La migration `014_site_contract_and_cost_budgets.sql` sépare l’enveloppe de coûts prévue du montant contractuel facturé au client. Les anciennes valeurs sont reprises comme enveloppes de coûts, puisqu’elles étaient comparées aux engagements; la colonne historique reste synchronisée pour permettre une transition sans interruption. Appliquez-la avant de déployer la nouvelle version API.

La progression d’un chantier est calculée par l’API à partir du ratio de tâches « Terminée » sur les tâches définies (0 % sans tâche); elle ne peut plus être saisie directement. Le budget annuel de fonctionnement est distinct des coûts prévus et des montants contractuels des chantiers. L’espace Budget compare les enveloppes de coûts aux engagements/prévisions de dépenses; le montant contractuel correspond à la recette facturable au client et n’est pas utilisé pour mesurer les dépassements de coûts. L’Admin entreprise peut créer et corriger les engagements/prévisions tant qu’ils restent prévus, et les dossiers clients tant qu’ils sont en préparation. Seul le rôle Comptable peut marquer une écriture comme réalisée ou faire évoluer le statut d’un dossier transmis. La confirmation d’une situation encaissée exige une référence et crée, dans la même transaction, une entrée de trésorerie réalisée; le paiement d’une facture fournisseur suit le même principe côté dépenses.

Les factures fournisseurs sont obligatoirement liées à un chantier dans cette version; les justificatifs ne sont pas téléversés et les frais généraux sans chantier ne sont pas couverts par le circuit de factures.

L’accès d’un tenant est valable jusqu’à la date `renews_at` incluse; dès le lendemain, la connexion et toutes les routes authentifiées de ses utilisateurs (administrateur et membres) sont refusées. Un abonnement `Actif` ou `Essai` doit obligatoirement avoir une date de fin égale ou postérieure au jour courant. Une date absente ou échue bloque l’accès. Lors du déploiement de cette règle, vérifiez les abonnements existants sans date et renseignez leur validité depuis l’espace Éditeur avant qu’ils ne soient utilisés; aucune durée historique n’est inventée automatiquement. La résiliation/suspension par l’Éditeur est immédiate et peut être effectuée même si le plan est désactivé; la réactivation requiert un plan actif et une nouvelle date valide.

L’hébergeur doit fournir une URL HTTPS publique. Le Worker Cloudflare transmet cookies, méthode, chemin, query string et corps HTTP au backend.

## Développement local

```powershell
Copy-Item .env.example .env
npm install
npm run migrate
npm run dev
```

Le serveur écoute sur `PORT` (3001 par défaut). Pour utiliser le frontend local, démarrez-le séparément ; son proxy Vite cible `http://127.0.0.1:3001` par défaut.

## Dépôt indépendant

Ce dossier est publié séparément dans
[`Ludododo22/Chantier-Connect-backend`](https://github.com/Ludododo22/Chantier-Connect-backend).
À la racine de ce dépôt, utilisez `npm install`, `npm run build` et `npm start`.
Les secrets locaux (`.env`), dépendances (`node_modules/`) et sorties de build
(`dist/`) sont exclus par `.gitignore`.
