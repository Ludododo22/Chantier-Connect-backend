# Chantier Connect — Backend

API Express/Node indépendante du frontend. Elle utilise PostgreSQL via `pg` et se déploie sur un hébergeur Node (Render, Railway, Fly.io ou VPS). Cloudflare ne se connecte pas à PostgreSQL : il relaie les requêtes `/api/*` vers cette API.

## Configuration

Copiez `.env.example` vers `.env` en développement et renseignez :

- `DATABASE_URL` : chaîne PostgreSQL Supabase (de préférence le pooler en mode session, port 5432).
- `DATABASE_SSL=true` pour Supabase et la production.
- `JWT_SECRET` : clé aléatoire d’au moins 64 caractères en production.
- `NODE_ENV=production` et `PORT` (le port fourni par l’hébergeur).

Ne commitez jamais `.env`, et ne lancez pas les données de démonstration en production.

## Déploiement Node

- Répertoire racine du service : `backend/` si le dépôt frontend/backend reste dans un dépôt parent ; sinon la racine du dépôt backend.
- Installation : `npm install`
- Build : `npm run build`
- Démarrage : `npm start`
- Health check : `/api/health`

Configurez les variables runtime dans le gestionnaire de secrets de l’hébergeur. Appliquez les migrations SQL de `migrations/` à Supabase une seule fois, dans l’ordre numérique, avant d’ouvrir l’API au public. `npm run migrate` utilise `DATABASE_URL` et `DATABASE_SSL`; vérifiez d’abord l’impact des migrations sur une base de recette. N’exécutez jamais `npm run seed` en production.

La migration `010_platform_administration.sql` ajoute les journaux d’audit, les jetons de réinitialisation, le consentement aux accès support et les affectations chantier. La migration `011_temporary_password_and_storage_limits.sql` ajoute l’obligation de changer le mot de passe provisoire à la première connexion et les limites de stockage des plans. Les scripts de retour arrière sont dans `migrations/rollback/`; ils sont manuels et doivent être évalués avant exécution.

L’accès d’un tenant est valable jusqu’à la date `renews_at` incluse; dès le lendemain, la connexion et les routes authentifiées sont refusées. Un abonnement `Actif` ou `Essai` doit avoir une date de fin valide; une date absente ou échue bloque l’accès. Vérifiez les abonnements existants avant le déploiement et ne déduisez pas de durée historique.

L’hébergeur doit fournir une URL HTTPS publique. Le Worker Cloudflare transmet cookies, méthode, chemin, query string et corps HTTP au backend.

## Développement local

```powershell
Copy-Item .env.example .env
npm install
npm run migrate
npm run dev
```

Le serveur écoute sur `PORT` (3001 par défaut). Pour utiliser le frontend local, démarrez-le séparément ; son proxy Vite cible `http://127.0.0.1:3001` par défaut.

## Dépôt GitHub indépendant

Créez le dépôt `Ludododo22/Chantier-Connect-backend`, puis exécutez ces commandes depuis ce dossier :

```powershell
git init
git add README.md
git add .
git commit -m "first commit"
git branch -M main
git remote add origin https://github.com/Ludododo22/Chantier-Connect-backend.git
git push -u origin main
```

`git add .` inclut les sources, migrations et manifestes sans les fichiers ignorés comme `.env`.
