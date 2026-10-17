// routes/stock.js
// Stock total dans stock_actuel (source de vérité transactionnelle)
// Stock par fournisseur dans stock_par_fournisseur (table dédiée)
const router = require('express').Router();
const db     = require('../config/db');
const { auth, adminOnly } = require('../middleware/auth');
const { logAction } = require('../middleware/journal');

const PLATEAUX_PAR_CARTON = 12;
const OEUFS_PAR_CARTON    = 360;

function calcStock(total, plat, oeufs) {
  const totalPlateaux = Number(total || 0) * PLATEAUX_PAR_CARTON + Number(plat || 0);
  const totalOeufs    = Number(total || 0) * OEUFS_PAR_CARTON   + Number(oeufs || 0);
  return { totalPlateaux, totalOeufs };
}

async function getStock(dbConn) {
  const conn = dbConn || db;
  const [rows] = await conn.query('SELECT * FROM stock_actuel WHERE id = 1');
  return rows[0] || { cartons: 0, cartons_cc: 0, cartons_ct: 0, plateaux: 0, oeufs: 0 };
}

// Récupérer stock réel par fournisseur depuis stock_par_fournisseur
async function getStockParFournisseur(dbConn) {
  const conn = dbConn || db;

  // S'assurer que tous les fournisseurs actifs ont une entrée
  await conn.query(`
    INSERT IGNORE INTO stock_par_fournisseur (fournisseur_id, cartons, plateaux)
    SELECT id, 0, 0 FROM fournisseurs WHERE statut = 'actif'
  `);

  const [rows] = await conn.query(`
    SELECT spf.fournisseur_id, spf.cartons, spf.plateaux,
           f.nom AS fournisseur_nom, COALESCE(f.tag,'') AS tag,
           CASE WHEN LOWER(f.nom) LIKE '%cameroun%' OR LOWER(f.nom) LIKE '%abakar%' THEN 'CC' ELSE 'CT' END AS type
    FROM stock_par_fournisseur spf
    JOIN fournisseurs f ON f.id = spf.fournisseur_id
    WHERE f.statut = 'actif'
    ORDER BY f.id
  `);

  return rows.map(r => ({
    fournisseur_id:  r.fournisseur_id,
    fournisseur_nom: r.fournisseur_nom,
    tag:             r.tag,
    type:            r.type,
    stock_actuel:    Number(r.cartons || 0),
    plateaux:        Number(r.plateaux || 0),
  }));
}

// Mettre à jour stock_par_fournisseur lors d'une livraison
async function ajouterStockFournisseur(conn, fournisseur_id, cartons, plateaux) {
  await conn.query(`
    INSERT INTO stock_par_fournisseur (fournisseur_id, cartons, plateaux)
    VALUES (?, ?, ?)
    ON DUPLICATE KEY UPDATE
      cartons  = GREATEST(0, cartons  + VALUES(cartons)),
      plateaux = GREATEST(0, plateaux + VALUES(plateaux))
  `, [fournisseur_id, cartons, plateaux]);
}

// Déduire stock_par_fournisseur lors d'une vente
// On déduit du type de carton vendu (CC → fournisseur Cameroun, CT → fournisseurs CT)
async function deduireStockFournisseur(conn, type_carton, cartons, plateaux) {
  if (type_carton === 'CC') {
    // Déduire du fournisseur CC (Abakar Cameroun)
    await conn.query(`
      UPDATE stock_par_fournisseur spf
      JOIN fournisseurs f ON f.id = spf.fournisseur_id
      SET spf.cartons  = GREATEST(0, spf.cartons  - ?),
          spf.plateaux = GREATEST(0, spf.plateaux - ?)
      WHERE (LOWER(f.nom) LIKE '%cameroun%' OR LOWER(f.nom) LIKE '%abakar%')
        AND f.statut = 'actif'
    `, [cartons, plateaux]);
  } else {
    // Pour CT : déduire proportionnellement des fournisseurs CT
    // Récupérer les stocks CT actuels
    const [ctFourns] = await conn.query(`
      SELECT spf.fournisseur_id, spf.cartons
      FROM stock_par_fournisseur spf
      JOIN fournisseurs f ON f.id = spf.fournisseur_id
      WHERE f.statut = 'actif'
        AND LOWER(f.nom) NOT LIKE '%cameroun%'
        AND LOWER(f.nom) NOT LIKE '%abakar%'
      ORDER BY spf.cartons DESC
    `);
    const totalCT = ctFourns.reduce((s, r) => s + Number(r.cartons), 0);
    if (totalCT <= 0 || ctFourns.length === 0) return;

    // Déduire proportionnellement
    let restCartons  = cartons;
    let restPlateaux = plateaux;
    for (let i = 0; i < ctFourns.length; i++) {
      const f    = ctFourns[i];
      const prop = i < ctFourns.length - 1 ? Number(f.cartons) / totalCT : 1; // dernier prend le reste
      const dedC = i < ctFourns.length - 1 ? Math.round(cartons * prop * 2) / 2 : restCartons;
      const dedP = i < ctFourns.length - 1 ? Math.round(plateaux * prop) : restPlateaux;
      await conn.query(`
        UPDATE stock_par_fournisseur
        SET cartons  = GREATEST(0, cartons  - ?),
            plateaux = GREATEST(0, plateaux - ?)
        WHERE fournisseur_id = ?
      `, [dedC, dedP, f.fournisseur_id]);
      restCartons  -= dedC;
      restPlateaux -= dedP;
    }
  }
}

// Restaurer stock_par_fournisseur lors de la suppression d'une vente
async function restaurerStockFournisseur(conn, type_carton, cartons, plateaux) {
  if (type_carton === 'CC') {
    await conn.query(`
      UPDATE stock_par_fournisseur spf
      JOIN fournisseurs f ON f.id = spf.fournisseur_id
      SET spf.cartons  = spf.cartons  + ?,
          spf.plateaux = spf.plateaux + ?
      WHERE (LOWER(f.nom) LIKE '%cameroun%' OR LOWER(f.nom) LIKE '%abakar%')
        AND f.statut = 'actif'
    `, [cartons, plateaux]);
  } else {
    // Restaurer sur le fournisseur CT qui a le moins de stock (équilibrage)
    const [ctFourns] = await conn.query(`
      SELECT spf.fournisseur_id, spf.cartons
      FROM stock_par_fournisseur spf
      JOIN fournisseurs f ON f.id = spf.fournisseur_id
      WHERE f.statut = 'actif'
        AND LOWER(f.nom) NOT LIKE '%cameroun%'
        AND LOWER(f.nom) NOT LIKE '%abakar%'
      ORDER BY spf.cartons ASC
    `);
    if (!ctFourns.length) return;
    // Distribuer proportionnellement
    const n = ctFourns.length;
    let restC = cartons, restP = plateaux;
    for (let i = 0; i < n; i++) {
      const addC = i < n - 1 ? Math.round((cartons / n) * 2) / 2 : restC;
      const addP = i < n - 1 ? Math.round(plateaux / n) : restP;
      await conn.query(
        'UPDATE stock_par_fournisseur SET cartons = cartons + ?, plateaux = plateaux + ? WHERE fournisseur_id = ?',
        [addC, addP, ctFourns[i].fournisseur_id]
      );
      restC -= addC; restP -= addP;
    }
  }
}

// Annuler l'ajout stock d'une livraison supprimée
async function annulerStockFournisseur(conn, fournisseur_id, cartons, plateaux) {
  await conn.query(`
    UPDATE stock_par_fournisseur
    SET cartons  = GREATEST(0, cartons  - ?),
        plateaux = GREATEST(0, plateaux - ?)
    WHERE fournisseur_id = ?
  `, [cartons, plateaux, fournisseur_id]);
}

// GET /api/stock
router.get('/', auth, async (req, res) => {
  try {
    const s            = await getStock();
    const cartons      = Number(s.cartons || 0);
    const plateaux     = Number(s.plateaux || 0);
    const oeufs        = Number(s.oeufs || 0);
    const totalPlateaux = cartons * PLATEAUX_PAR_CARTON + plateaux;
    const totalOeufs    = cartons * OEUFS_PAR_CARTON    + plateaux * 30 + oeufs;
    const parFournisseur = await getStockParFournisseur();
    res.json({
      ...s,
      totalPlateaux,
      totalOeufs,
      par_fournisseur: parFournisseur,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /api/stock/mouvements
router.get('/mouvements', auth, async (req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT * FROM stock_mouvements ORDER BY date_mouvement DESC, id DESC'
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Erreur serveur' }); }
});

// POST /api/stock/ajustement
router.post('/ajustement', auth, adminOnly, async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const { date_mouvement, cartons_cc, cartons_ct, motif, fournisseur_id } = req.body;
    const cc = parseFloat(cartons_cc || 0);
    const ct = parseFloat(cartons_ct || 0);
    if (!motif) return res.status(400).json({ error: 'Motif requis' });

    const s      = await getStock(conn);
    const newCC  = Math.max(0, Math.round((Number(s.cartons_cc) + cc) * 2) / 2);
    const newCT  = Math.max(0, Math.round((Number(s.cartons_ct) + ct) * 2) / 2);
    const newTot = Math.round((newCC + newCT) * 2) / 2;

    await conn.query(
      'UPDATE stock_actuel SET cartons=?, cartons_cc=?, cartons_ct=? WHERE id=1',
      [newTot, newCC, newCT]
    );
    const dateM = date_mouvement || require('../config/dateHelper').todayLocal();
    await conn.query(
      `INSERT INTO stock_mouvements
       (date_mouvement,type_mouvement,cartons,cartons_cc,cartons_ct,plateaux,oeufs,motif)
       VALUES (?,'ajustement',?,?,?,0,0,?)`,
      [dateM, cc + ct, cc, ct, motif]
    );

    // Si un fournisseur précis est fourni, ajuster aussi son stock
    if (fournisseur_id) {
      await conn.query(`
        INSERT INTO stock_par_fournisseur (fournisseur_id, cartons, plateaux)
        VALUES (?, ?, 0)
        ON DUPLICATE KEY UPDATE cartons = GREATEST(0, cartons + VALUES(cartons))
      `, [fournisseur_id, cc + ct]);
    }

    await conn.commit();
    await logAction(req.user, 'UPDATE', 'stock', `Ajustement CC:${cc} CT:${ct} — ${motif}`);
    res.json({ cartons: newTot, cartons_cc: newCC, cartons_ct: newCT });
  } catch (e) {
    await conn.rollback();
    res.status(500).json({ error: 'Erreur serveur' });
  } finally { conn.release(); }
});

// DELETE /api/stock/mouvements/:id
router.delete('/mouvements/:id', auth, adminOnly, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM stock_mouvements WHERE id=?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Non trouvé' });
    const m = rows[0];
    if (m.reference_type && m.reference_type !== 'ajustement')
      return res.status(400).json({ error: 'Supprimer la vente ou livraison liée' });
    const cc  = Number(m.cartons_cc || 0);
    const ct  = Number(m.cartons_ct || 0);
    const sgn = m.type_mouvement === 'entree' ? -1 : 1;
    await db.query(
      `UPDATE stock_actuel SET
         cartons=GREATEST(0,cartons+?),
         cartons_cc=GREATEST(0,cartons_cc+?),
         cartons_ct=GREATEST(0,cartons_ct+?)
       WHERE id=1`,
      [sgn * (cc + ct), sgn * cc, sgn * ct]
    );
    await db.query('DELETE FROM stock_mouvements WHERE id=?', [req.params.id]);
    await logAction(req.user, 'DELETE', 'stock', `Mouvement #${req.params.id} supprimé`);
    res.json({ message: 'Supprimé' });
  } catch (e) { res.status(500).json({ error: 'Erreur serveur' }); }
});

module.exports = router;
module.exports.getStock                  = getStock;
module.exports.calcStock                 = calcStock;
module.exports.getStockParFournisseur    = getStockParFournisseur;
module.exports.ajouterStockFournisseur   = ajouterStockFournisseur;
module.exports.deduireStockFournisseur   = deduireStockFournisseur;
module.exports.restaurerStockFournisseur = restaurerStockFournisseur;
module.exports.annulerStockFournisseur   = annulerStockFournisseur;
module.exports.syncStock = async (conn) => {
  const s = await getStock(conn);
  return { cartons: Number(s.cartons), cartons_cc: Number(s.cartons_cc), cartons_ct: Number(s.cartons_ct) };
};
