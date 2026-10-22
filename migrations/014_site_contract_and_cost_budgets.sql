ALTER TABLE sites
  ADD COLUMN cost_budget_fcfa bigint NOT NULL DEFAULT 0
    CHECK (cost_budget_fcfa >= 0),
  ADD COLUMN contract_amount_fcfa bigint
    CHECK (contract_amount_fcfa >= 0);

UPDATE sites
SET cost_budget_fcfa = budget_fcfa;

CREATE FUNCTION sync_site_cost_budget_columns()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.cost_budget_fcfa = 0 AND NEW.budget_fcfa <> 0 THEN
      NEW.cost_budget_fcfa := NEW.budget_fcfa;
    ELSE
      NEW.budget_fcfa := NEW.cost_budget_fcfa;
    END IF;
  ELSIF NEW.cost_budget_fcfa IS DISTINCT FROM OLD.cost_budget_fcfa
      AND NEW.budget_fcfa IS NOT DISTINCT FROM OLD.budget_fcfa THEN
    NEW.budget_fcfa := NEW.cost_budget_fcfa;
  ELSIF NEW.budget_fcfa IS DISTINCT FROM OLD.budget_fcfa
      AND NEW.cost_budget_fcfa IS NOT DISTINCT FROM OLD.cost_budget_fcfa THEN
    NEW.cost_budget_fcfa := NEW.budget_fcfa;
  ELSIF NEW.cost_budget_fcfa IS DISTINCT FROM NEW.budget_fcfa THEN
    RAISE EXCEPTION 'Cost budget compatibility values must match';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER sites_sync_cost_budget_columns
  BEFORE INSERT OR UPDATE ON sites
  FOR EACH ROW
  EXECUTE FUNCTION sync_site_cost_budget_columns();

COMMENT ON COLUMN sites.cost_budget_fcfa IS
  'Prévision des coûts nécessaires à la réalisation des travaux, distincte du montant facturé au client.';

COMMENT ON COLUMN sites.contract_amount_fcfa IS
  'Montant contractuel facturé au client, distinct de l’enveloppe de coûts du chantier.';

COMMENT ON COLUMN sites.budget_fcfa IS
  'Colonne de compatibilité historique synchronisée avec cost_budget_fcfa.';
