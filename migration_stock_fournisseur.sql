USE positive_distribution;

-- 1. Créer table stock_par_fournisseur (stock réel par fournisseur)
CREATE TABLE IF NOT EXISTS stock_par_fournisseur (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  fournisseur_id INT NOT NULL UNIQUE,
  cartons      DECIMAL(10,1) NOT NULL DEFAULT 0,
  plateaux     INT NOT NULL DEFAULT 0,
  updated_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (fournisseur_id) REFERENCES fournisseurs(id)
);

-- 2. Initialiser avec les fournisseurs existants
INSERT INTO stock_par_fournisseur (fournisseur_id, cartons, plateaux)
SELECT id, 0, 0 FROM fournisseurs WHERE statut = 'actif'
ON DUPLICATE KEY UPDATE fournisseur_id = fournisseur_id;

-- 3. Recalculer le stock réel par fournisseur depuis les mouvements
-- Livraisons reçues par fournisseur
CREATE TEMPORARY TABLE IF NOT EXISTS tmp_livres AS
SELECT fournisseur_id, 
       SUM(quantite_cartons) AS cartons_livres,
       SUM(plateaux_recus)   AS plateaux_livres
FROM livraisons 
WHERE fournisseur_id IS NOT NULL
GROUP BY fournisseur_id;

-- Ventes : répartir les ventes CC aux fournisseurs CC, CT aux fournisseurs CT
-- (simplification : on initialise à 0 et l'utilisateur ajustera si besoin)
-- La vraie logique sera transactionnelle dès maintenant

-- Afficher l'état initial
SELECT f.nom, f.tag, spf.cartons, spf.plateaux
FROM stock_par_fournisseur spf
JOIN fournisseurs f ON f.id = spf.fournisseur_id;

SELECT '✅ Table stock_par_fournisseur créée' AS resultat;
