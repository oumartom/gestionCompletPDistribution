// routes/depenses.js — Gestion des depenses via Afrocaisse
const router = require('express').Router();
const db     = require('../config/db');
const { auth, adminOnly } = require('../middleware/auth');
const { logAction } = require('../middleware/journal');

// Types de depenses
const TYPES_DEPENSES = [
  'Carburant',
  'Reparation vehicule',
  'Entretien vehicule',
  'Salaire',
  'Loyer',
  'Transport province',
  'Prime chauffeur',
  'Autre',
];

// ─── GET /api/depenses/types ───────────────────────────────
router.get('/types', auth, adminOnly, (req, res) => {
  res.json(TYPES_DEPENSES);
});

// ─── GET /api/depenses/afrocaisse ─────────────────────────
// Solde actuel de l'Afrocaisse
router.get('/afrocaisse', auth, adminOnly, async (req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT solde FROM afrocaisse_mouvements ORDER BY id DESC LIMIT 1'
    );
    if (rows.length) return res.json({ solde: Number(rows[0].solde) });
    // Aucun mouvement — lire le solde initial
    const [si] = await db.query(
      'SELECT valeur FROM parametres WHERE cle = "afrocaisse_initial"'
    );
    res.json({ solde: si.length ? Number(si[0].valeur) : 0 });
  } catch (e) { res.status(500).json({ error: 'Erreur serveur' }); }
});

// ─── GET /api/depenses/mouvements ─────────────────────────
router.get('/mouvements', auth, adminOnly, async (req, res) => {
  try {
    const { date_debut, date_fin } = req.query;
    let sql = 'SELECT * FROM afrocaisse_mouvements WHERE 1=1';
    const params = [];
    if (date_debut) { sql += ' AND DATE(date_mouvement) >= ?'; params.push(date_debut); }
    if (date_fin)   { sql += ' AND DATE(date_mouvement) <= ?'; params.push(date_fin); }
    sql += ' ORDER BY id DESC';
    const [rows] = await db.query(sql, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Erreur serveur' }); }
});

// ─── GET /api/depenses ────────────────────────────────────
router.get('/', auth, adminOnly, async (req, res) => {
  try {
    const { annee, mois, date_debut, date_fin, type } = req.query;
    let sql = 'SELECT * FROM depenses WHERE 1=1';
    const params = [];
    if (annee) { sql += ' AND YEAR(DATE(date_depense)) = ?';  params.push(annee); }
    if (mois)  { sql += ' AND MONTH(DATE(date_depense)) = ?'; params.push(mois); }
    if (date_debut) { sql += ' AND DATE(date_depense) >= ?'; params.push(date_debut); }
    if (date_fin)   { sql += ' AND DATE(date_depense) <= ?'; params.push(date_fin); }
    if (type)       { sql += ' AND type_depense = ?';  params.push(type); }
    sql += ' ORDER BY date_depense DESC, id DESC';
    const [rows] = await db.query(sql, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Erreur serveur' }); }
});

// ─── POST /api/depenses/alimenter ─────────────────────────
// Transfert banque → Afrocaisse
router.post('/alimenter', auth, adminOnly, async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const { montant, date_mouvement, description } = req.body;
    const mt = parseFloat(montant);
    if (!mt || mt <= 0) return res.status(400).json({ error: 'Montant invalide' });

    // Solde afrocaisse avant
    const [lastAf] = await conn.query(
      'SELECT solde FROM afrocaisse_mouvements ORDER BY id DESC LIMIT 1'
    );
    const [siAf] = await conn.query(
      'SELECT valeur FROM parametres WHERE cle = "afrocaisse_initial"'
    );
    const soldePrevAf = lastAf.length ? Number(lastAf[0].solde)
      : (siAf.length ? Number(siAf[0].valeur) : 0);
    const nouveauSoldeAf = soldePrevAf + mt;

    // Insérer mouvement afrocaisse (entrée)
    await conn.query(
      `INSERT INTO afrocaisse_mouvements
       (date_mouvement, type_mouvement, montant, solde, description)
       VALUES (?, 'entree', ?, ?, ?)`,
      [date_mouvement || require('../config/dateHelper').todayLocal(),
       mt, nouveauSoldeAf,
       description || `Alimentation depuis banque : ${mt} FCFA`]
    );

    // Déduire de la banque
    const [lastBq] = await conn.query(
      'SELECT solde FROM banque_mouvements ORDER BY id DESC LIMIT 1'
    );
    const [siBq] = await conn.query(
      'SELECT valeur FROM parametres WHERE cle = "solde_banque_initial"'
    );
    const soldePrevBq = lastBq.length ? Number(lastBq[0].solde)
      : (siBq.length ? Number(siBq[0].valeur) : 0);
    const nouveauSoldeBq = soldePrevBq - mt;

    await conn.query(
      `INSERT INTO banque_mouvements
       (date_mouvement, description, reference, encaissement, decaissement, solde, categorie)
       VALUES (?, ?, NULL, 0, ?, ?, 'autre')`,
      [date_mouvement || require('../config/dateHelper').todayLocal(),
       description || `Virement vers Afrocaisse : ${mt} FCFA`,
       mt, nouveauSoldeBq]
    );

    await conn.commit();
    await logAction(req.user, 'CREATE', 'depenses',
      `Alimentation Afrocaisse : ${mt} FCFA depuis banque`);

    res.json({
      message: 'Afrocaisse alimentee',
      montant: mt,
      nouveau_solde_afrocaisse: nouveauSoldeAf,
      nouveau_solde_banque: nouveauSoldeBq,
    });
  } catch (e) {
    await conn.rollback();
    console.error(e);
    res.status(500).json({ error: 'Erreur serveur' });
  } finally { conn.release(); }
});

// ─── POST /api/depenses ───────────────────────────────────
// Enregistrer une depense (prelevee de l'Afrocaisse)
router.post('/', auth, adminOnly, async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const { type_depense, montant, date_depense, beneficiaire, description } = req.body;
    const mt = parseFloat(montant);
    if (!type_depense || !mt || mt <= 0)
      return res.status(400).json({ error: 'Type et montant requis' });

    // Vérifier solde afrocaisse
    const [lastAf] = await conn.query(
      'SELECT solde FROM afrocaisse_mouvements ORDER BY id DESC LIMIT 1'
    );
    const [siAf] = await conn.query(
      'SELECT valeur FROM parametres WHERE cle = "afrocaisse_initial"'
    );
    const soldeAf = lastAf.length ? Number(lastAf[0].solde)
      : (siAf.length ? Number(siAf[0].valeur) : 0);

    if (mt > soldeAf) {
      await conn.rollback();
      return res.status(400).json({
        error: `Solde Afrocaisse insuffisant. Disponible : ${soldeAf} FCFA. Depense : ${mt} FCFA`
      });
    }

    const dateD = date_depense || require('../config/dateHelper').todayLocal();
    const nouveauSoldeAf = soldeAf - mt;

    // Insérer la dépense
    const [result] = await conn.query(
      `INSERT INTO depenses
       (type_depense, montant, date_depense, beneficiaire, description)
       VALUES (?, ?, ?, ?, ?)`,
      [type_depense, mt, dateD, beneficiaire || null, description || null]
    );

    // Mouvement afrocaisse (sortie)
    await conn.query(
      `INSERT INTO afrocaisse_mouvements
       (date_mouvement, type_mouvement, montant, solde, description, depense_id)
       VALUES (?, 'sortie', ?, ?, ?, ?)`,
      [dateD, mt, nouveauSoldeAf,
       `${type_depense}${beneficiaire ? ' — ' + beneficiaire : ''}`,
       result.insertId]
    );

    await conn.commit();
    await logAction(req.user, 'CREATE', 'depenses',
      `Depense ${type_depense} : ${mt} FCFA${beneficiaire ? ' — ' + beneficiaire : ''}`);

    const [newDep] = await db.query('SELECT * FROM depenses WHERE id = ?', [result.insertId]);
    res.status(201).json({
      ...newDep[0],
      nouveau_solde_afrocaisse: nouveauSoldeAf,
    });
  } catch (e) {
    await conn.rollback();
    console.error(e);
    res.status(500).json({ error: e.message || 'Erreur serveur' });
  } finally { conn.release(); }
});

// ─── PUT /api/depenses/:id — modifier une dépense ────────
router.put('/:id', auth, adminOnly, async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query('SELECT * FROM depenses WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Dépense non trouvée' });
    const ancienne = rows[0];

    const { type_depense, montant, date_depense, beneficiaire, description } = req.body;
    const nvMontant = Number(montant);
    const diff      = nvMontant - Number(ancienne.montant); // différence à appliquer

    // Mettre à jour la dépense
    await conn.query(
      'UPDATE depenses SET type_depense=?, montant=?, date_depense=?, beneficiaire=?, description=? WHERE id=?',
      [type_depense, nvMontant, date_depense, beneficiaire || null, description || null, req.params.id]
    );

    // Mettre à jour le mouvement ApproCaisse lié (si diff)
    if (Math.abs(diff) > 0) {
      await conn.query(
        'UPDATE afrocaisse_mouvements SET montant = ? WHERE depense_id = ?',
        [nvMontant, req.params.id]
      );
      // Recalculer tous les soldes ApproCaisse depuis le début
      await recalculerSoldesAfrocaisse(conn);
    }

    await conn.commit();
    await logAction(req.user, 'UPDATE', 'depenses',
      `Dépense #${req.params.id} modifiée — ${type_depense} ${nvMontant} FCFA`);
    const [updated] = await db.query('SELECT * FROM depenses WHERE id = ?', [req.params.id]);
    res.json(updated[0]);
  } catch (e) {
    await conn.rollback();
    console.error(e);
    res.status(500).json({ error: e.message || 'Erreur serveur' });
  } finally { conn.release(); }
});

// ─── DELETE /api/depenses/:id ─────────────────────────────
router.delete('/:id', auth, adminOnly, async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query('SELECT * FROM depenses WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Depense non trouvee' });
    const dep = rows[0];

    // Supprimer le mouvement afrocaisse lié ET la dépense
    await conn.query('DELETE FROM afrocaisse_mouvements WHERE depense_id = ?', [req.params.id]);
    await conn.query('DELETE FROM depenses WHERE id = ?', [req.params.id]);

    // Recalculer tous les soldes ApproCaisse pour corriger les cumuls
    await recalculerSoldesAfrocaisse(conn);

    await conn.commit();
    await logAction(req.user, 'DELETE', 'depenses',
      `Depense #${req.params.id} supprimee — ${dep.type_depense} ${dep.montant} FCFA — ApproCaisse restaurée`);
    res.json({ message: 'Dépense supprimée et ApproCaisse restaurée' });
  } catch (e) {
    await conn.rollback();
    console.error(e);
    res.status(500).json({ error: e.message || 'Erreur serveur' });
  } finally { conn.release(); }
});

// Fonction utilitaire : recalculer les soldes cumulatifs ApproCaisse
async function recalculerSoldesAfrocaisse(conn) {
  const [mouvts] = await conn.query(
    'SELECT id, type_mouvement, montant FROM afrocaisse_mouvements ORDER BY id ASC'
  );
  const [si] = await conn.query('SELECT valeur FROM parametres WHERE cle = "afrocaisse_initial"');
  let solde = si.length ? Number(si[0].valeur) : 0;

  for (const m of mouvts) {
    if (m.type_mouvement === 'entree') solde += Number(m.montant);
    else solde -= Number(m.montant);
    await conn.query('UPDATE afrocaisse_mouvements SET solde = ? WHERE id = ?', [solde, m.id]);
  }
}

// ─── GET /api/depenses/stats ──────────────────────────────
router.get('/stats', auth, adminOnly, async (req, res) => {
  try {
    const { date_debut, date_fin } = req.query;
    let sql = `SELECT type_depense,
                 COUNT(*) as nb,
                 SUM(montant) as total
               FROM depenses WHERE 1=1`;
    const params = [];
    if (date_debut) { sql += ' AND DATE(date_depense) >= ?'; params.push(date_debut); }
    if (date_fin)   { sql += ' AND DATE(date_depense) <= ?'; params.push(date_fin); }
    sql += ' GROUP BY type_depense ORDER BY total DESC';
    const [rows] = await db.query(sql, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Erreur serveur' }); }
});

module.exports = router;
