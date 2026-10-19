# Comptes de démonstration

Les comptes ci-dessous sont créés dans PostgreSQL par `pnpm db:seed`. Tous
utilisent la valeur définie dans `DEMO_SEED_PASSWORD` du fichier `.env` local.
Les mots de passe sont hachés avec bcrypt avant stockage. Le chargement de ces
comptes est refusé lorsque `NODE_ENV=production`.

| Espace | Identifiant | Mot de passe local |
|---|---|---|
| Éditeur | `editeur@chantierconnect.ga` | Valeur locale de `DEMO_SEED_PASSWORD` |
| Administrateur entreprise | `admin@okoume-btp.ga` | Valeur locale de `DEMO_SEED_PASSWORD` |
| Conducteur de travaux | `conducteur@okoume-btp.ga` | Valeur locale de `DEMO_SEED_PASSWORD` |
| Chef de chantier | `chef@okoume-btp.ga` | Valeur locale de `DEMO_SEED_PASSWORD` |
| Compagnon | `compagnon@okoume-btp.ga` | Valeur locale de `DEMO_SEED_PASSWORD` |
| Sous-traitant | `sous-traitant@elecplus.ga` | Valeur locale de `DEMO_SEED_PASSWORD` |
| Comptable | `comptable@okoume-btp.ga` | Valeur locale de `DEMO_SEED_PASSWORD` |
| Maître d’ouvrage | `client@ministere.ga` | Valeur locale de `DEMO_SEED_PASSWORD` |

Tous les comptes de démonstration partagent le même mot de passe, défini dans
le fichier `.env` local. Il doit contenir au moins 12 caractères. Une valeur
courte telle que `12345678` n’est pas acceptée lors du chargement des comptes.
Le mot de passe réel reste dans `.env` et ne doit pas être copié dans ce
document ni dans un fichier versionné.
Pour le poste de développement actuel, les identifiants et le mot de passe
partagé sont également consignés dans `DEMO_USERS.local.md`. Ce fichier est
ignoré par Git et ne doit jamais être ajouté au dépôt.
Les onglets d’un même navigateur partagent la session du compte connecté. Les
changements de compte sont désormais synchronisés entre ces onglets ; pour
tester plusieurs rôles, connectez-vous avec l’identifiant de chaque compte.

## Démarrage local

1. Renseignez `DATABASE_URL`, `JWT_SECRET` et `DEMO_SEED_PASSWORD` dans `.env`.
   Le mot de passe de démonstration doit faire au moins 12 caractères. Générer
   un secret de session local avec `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`.
2. Créez la base PostgreSQL `chantier_connect` avec un utilisateur disposant des
   droits de création de tables.
3. Lancez `pnpm.cmd db:migrate`, puis `pnpm.cmd db:seed` sous PowerShell Windows
   (ou `pnpm db:migrate` et `pnpm db:seed` dans un shell compatible).
4. Lancez l’application complète avec `pnpm.cmd dev:full` sous PowerShell
   Windows (ou `pnpm dev:full` dans un shell compatible) et ouvrez
   `http://localhost:8443`.

L’API Express écoute sur le port 3001 et Vite relaie `/api` vers celle-ci.
`GET /api/health` vérifie aussi la connexion PostgreSQL.

## Hiérarchie et isolation

- L’éditeur accède uniquement au back-office commercial et technique.
- Les comptes entreprise sont isolés par `tenant_id` dans les requêtes API.
- Les permissions de lecture et d’écriture sont vérifiées côté serveur.
- Les mots de passe ne sont jamais fournis par l’API et les sessions utilisent
  un cookie HTTP-only.
- Tous les utilisateurs peuvent modifier leur nom, leur email et leur téléphone
  dans leur profil. L’email modifié devient leur nouvel identifiant de
  connexion. Le rôle, les permissions et l’affectation chantier restent
  contrôlés par l’entreprise.

## Rôles et périmètres

Les permissions effectives sont définies dans `backend/src/role-access.ts` et
recalculées par l’API à chaque authentification. Les anciennes valeurs de rôles
enregistrées dans la base ne peuvent donc pas élargir un accès. Les comptes à
périmètre chantier doivent avoir un chantier affecté; sans affectation, ils ne
reçoivent aucune donnée de chantier.

| Rôle | Périmètre de lecture | Actions métier |
|---|---|---|
| Éditeur | Back-office Chantier Connect; pas de tenant d’entreprise | Gestion des entreprises et essais, plans et abonnements, support, paramètres de plateforme et indicateurs agrégés. N’accède jamais aux contenus métier des tenants. |
| Administrateur entreprise | Tous les chantiers et membres de son entreprise | Gestion des chantiers, équipe, tâches, rapports, photos, budget, dossiers de paiement, trésorerie et paramètres de l’entreprise. |
| Conducteur de travaux | Un seul chantier affecté; équipe, tâches, rapports et photos de ce chantier | Créer et mettre à jour les tâches du chantier, déposer des photos, créer et valider ses rapports. Aucun accès aux autres chantiers, à la création de chantiers ou aux finances de l’entreprise. |
| Chef de chantier | Un seul chantier affecté; équipe, tâches, rapports et photos de ce chantier | Gérer les tâches et rapports de ce chantier, photos et pointage. |
| Compagnon | Son chantier affecté et ses propres tâches assignées sur ce chantier | Mettre à jour ses tâches, déposer des photos et pointer. |
| Sous-traitant | Son chantier affecté et ses propres tâches assignées sur ce chantier | Mettre à jour ses tâches et déposer des photos. |
| Comptable | Toutes les données financières de l’entreprise et uniquement les rapports validés | Créer et suivre les opérations financières et dossiers de paiement; aucune gestion des opérations terrain. |
| Maître d’ouvrage | Un seul chantier affecté; photos et rapports validés de ce chantier | Consultation en lecture seule. |

Les routes API appliquent le périmètre au serveur : les rôles limités ne peuvent
pas contourner l’interface en demandant un autre chantier, une tâche ou un
rapport hors périmètre. L’administrateur entreprise peut affecter les rôles
limités à un chantier depuis Équipe; il ne peut pas modifier son propre accès ni
les droits d’un autre administrateur entreprise.

L’administrateur entreprise peut créer des comptes pour les rôles Conducteur,
Chef de chantier, Compagnon, Sous-traitant, Comptable et Maître d’ouvrage. Le
mot de passe provisoire est fourni par l’administrateur au moment de la création
et haché avant stockage; il faut le transmettre au membre de manière sécurisée.
Un chantier doit être affecté aux rôles limités à un chantier, y compris au
Conducteur. Les rôles et capacités sont recalculés côté serveur quand le rôle ou
l’affectation change.
Les membres peuvent être désactivés sans supprimer leur historique métier.
Dans l’espace Équipe, l’action « Supprimer » révoque l’accès et archive le
membre au lieu d’effacer les références historiques; les comptes archivés sont
consultables dans le filtre « Désactivés ».
Les compagnons et sous-traitants peuvent mettre à jour uniquement leurs tâches
assignées; le maître d’ouvrage conserve un accès strictement en lecture seule.

L’authentification, l’équipe, les chantiers, les tâches, les rapports, les
photos, le pointage, les opérations budgétaires, les dossiers de paiement, les
paramètres entreprise et le back-office éditeur disposent de routes API et de
données PostgreSQL avec les contrôles de rôle correspondants. Les statistiques
éditeur sont agrégées et ne retournent pas le contenu des tenants. Les plans,
abonnements et tickets support sont persistés; les paramètres de limitation des
tentatives de connexion sont appliqués par l’API. Après une mise à jour,
appliquez les migrations avec `pnpm.cmd db:migrate` sous PowerShell Windows.

Les photos acceptent les formats JPEG, PNG et WebP jusqu’à 2 Mo. Leur empreinte
SHA-256 et leur horodatage sont enregistrés; le partage de la position GPS est
facultatif et demande l’autorisation du navigateur. Le pointage d’arrivée et de
départ est réservé aux comptes disposant de la capacité `clock_in` et n’autorise
qu’un seul service ouvert par personne.

Le budget et la trésorerie utilisent le budget contractuel des chantiers et les
engagements, encaissements et dépenses enregistrés par les utilisateurs ayant
la capacité `manage_finance`. Les opérations planifiées peuvent être marquées
comme réalisées; les totaux sont recalculés à partir de PostgreSQL.

Les dossiers de paiement sont enregistrés par entreprise avec une référence,
un montant, un chantier et une transition de statut vérifiée par l’API. La
création d’une entreprise éditeur initialise un abonnement d’essai et un compte
administrateur; le mot de passe provisoire est choisi lors de la création et
doit être transmis au bénéficiaire de façon sécurisée. Aucun email d’invitation,
paiement en ligne ou relance automatique n’est envoyé par l’application.
