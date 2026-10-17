// routes/livraisons.js — avec upload fichier et modification
const router    = require('express').Router();
const db        = require('../config/db');
const { auth, adminOnly } = require('../middleware/auth');
const upload    = require('../middleware/upload');
const { logAction } = require('../middleware/journal');
const { syncStock, ajouterStockFournisseur, annulerStockFournisseur } = require('./stock');

// GET /api/livraisons
router.get('/', auth, async (req, res) => {
  try {
    const { date, annee, mois } = req.query;
    let sql = `SELECT l.*, f.nom as fournisseur_nom, COALESCE(f.tag,'') as fournisseur_tag
               FROM livraisons l LEFT JOIN fournisseurs f ON l.fournisseur_id = f.id WHERE 1=1`;
    const params = [];
    if (annee) { sql += ' AND YEAR(DATE(l.date_livraison)) = ?';  params.push(annee); }
    if (mois)  { sql += ' AND MONTH(DATE(l.date_livraison)) = ?'; params.push(mois); }
    if (date)  { sql += ' AND DATE(l.date_livraison) = ?';        params.push(date); }
    sql += ' ORDER BY l.date_livraison DESC, l.id DESC';
    const [rows] = await db.query(sql, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Erreur serveur' }); }
});

// POST /api/livraisons — avec fichier optionnel
router.post('/', auth, upload.single('fichier'), async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const {
      date_livraison, quantite_cartons, plateaux_recus,
      fournisseur_id, fournisseur, notes
    } = req.body;

    // Cartons et plateaux reçus
    const cartonsRecus  = parseFloat(quantite_cartons) || 0;
    const plateauxRecus = parseInt(plateaux_recus)     || 0;

    if (cartonsRecus <= 0 && plateauxRecus <= 0) {
      conn.release();
      return res.status(400).json({ error: 'Quantité invalide (cartons ou plateaux requis)' });
    }

    const fichier = req.file ? req.file.filename : null;

    // Récupérer fournisseur (nom + tag)
    let fournisseurNom = fournisseur || 'Fournisseur';
    let fournisseurTag = '';
    let typeCarton     = 'CT';
    if (fournisseur_id) {
      const [fRows] = await conn.query('SELECT nom, tag FROM fournisseurs WHERE id = ?', [fournisseur_id]);
      if (fRows.length) {
        fournisseurNom = fRows[0].nom;
        fournisseurTag = fRows[0].tag || '';
        const fNom = fournisseurNom.toLowerCase();
        if (fNom.includes('cameroun') || fNom.includes('abakar') || fNom.includes(' cc')) {
          typeCarton = 'CC';
        }
      }
    }

    // ── Conversion plateaux en cartons ──
    // Stock actuel de plateaux
    const [stockRow] = await conn.query('SELECT plateaux, cartons, cartons_cc, cartons_ct FROM stock_actuel WHERE id=1');
    const stockPlateauxActuel = parseInt(stockRow[0]?.plateaux || 0);

    // Total plateaux = stock actuel + plateaux reçus
    const totalPlateaux  = stockPlateauxActuel + plateauxRecus;
    const cartonsDepPlat = Math.floor(totalPlateaux / 12); // cartons complets issus des plateaux
    const plateauxRestes = totalPlateaux % 12;             // plateaux qui restent

    // Total cartons à ajouter au stock
    const cartonsAjoutes = cartonsRecus + cartonsDepPlat;

    // Enregistrer la livraison avec plateaux_recus
    const [result] = await conn.query(
      'INSERT INTO livraisons (date_livraison, quantite_cartons, plateaux_recus, fournisseur_id, fournisseur, notes, fichier_facture) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [date_livraison, cartonsRecus, plateauxRecus, fournisseur_id || null,
       fournisseurNom, notes || null, fichier]
    );

    const isCC = typeCarton === 'CC';

    // Mettre à jour le stock global
    await conn.query(
      `UPDATE stock_actuel SET
         cartons    = cartons + ?,
         cartons_cc = cartons_cc + ?,
         cartons_ct = cartons_ct + ?,
         plateaux   = ?
       WHERE id = 1`,
      [cartonsAjoutes, isCC ? cartonsAjoutes : 0, isCC ? 0 : cartonsAjoutes, plateauxRestes]
    );

    // Mettre à jour le stock du fournisseur spécifique
    if (fournisseur_id) {
      await ajouterStockFournisseur(conn, fournisseur_id, cartonsAjoutes, plateauxRestes);
    }

    // Motif clair avec tag et plateaux
    const tag     = fournisseurTag ? ` [${fournisseurTag}]` : '';
    let motif     = `Livraison ${typeCarton}${tag} du ${date_livraison} — ${fournisseurNom}`;
    if (plateauxRecus > 0) {
      motif += ` (${cartonsRecus} cartons + ${plateauxRecus} plateaux → +${cartonsAjoutes} cartons en stock)`;
    }

    await conn.query(
      `INSERT INTO stock_mouvements (date_mouvement, type_mouvement, cartons, cartons_cc, cartons_ct, plateaux, oeufs, motif, reference_id, reference_type)
       VALUES (?, 'entree', ?, ?, ?, ?, 0, ?, ?, 'livraison')`,
      [date_livraison, cartonsAjoutes, isCC ? cartonsAjoutes : 0, isCC ? 0 : cartonsAjoutes,
       plateauxRecus, motif, result.insertId]
    );

    // ── Facture fournisseur automatique ──
    if (fournisseur_id) {
      const [prixRows] = await conn.query(
        'SELECT prix_unitaire FROM prix_achat WHERE fournisseur_id = ? AND actif = 1 ORDER BY date_effet DESC LIMIT 1',
        [fournisseur_id]
      );

      if (prixRows.length) {
        const prixUnit  = Number(prixRows[0].prix_unitaire);
        const totalFact = Math.round(cartonsRecus * prixUnit + (plateauxRecus / 12) * prixUnit);

        const [fournRows] = await conn.query(
          'SELECT solde_compte FROM fournisseurs WHERE id = ?', [fournisseur_id]
        );
        const soldeActuel = fournRows.length ? Number(fournRows[0].solde_compte || 0) : 0;

        // Si crédit disponible (solde négatif) → l'appliquer automatiquement
        const creditDispo   = soldeActuel < 0 ? Math.abs(soldeActuel) : 0;
        const paiementAuto  = Math.min(creditDispo, totalFact);
        const soldeFact     = totalFact - paiementAuto;

        // Nouveau solde_compte = solde actuel + total facture
        // La livraison crée toujours une dette du total de la facture
        // Si on avait un crédit (solde négatif), la dette le compense progressivement
        // Exemples :
        //   solde=0,       facture=1 180 000 → nouveau=1 180 000 (dette)
        //   solde=-500K,   facture=1 180 000 → nouveau=680 000   (dette réduite du crédit)
        //   solde=-2M,     facture=1 180 000 → nouveau=-820 000  (crédit diminué)
        //   solde=500K,    facture=1 180 000 → nouveau=1 680 000  (dette cumulée)
        const nouveauSolde = soldeActuel + totalFact;

        // Créer la facture
        const [lastFact] = await conn.query('SELECT MAX(id) as max_id FROM factures_fournisseur');
        const numeroFact  = 'FACT-' + String((lastFact[0].max_id || 0) + 1).padStart(4, '0');

        const [factResult] = await conn.query(
          `INSERT INTO factures_fournisseur
           (numero, fournisseur_id, date_facture, quantite, prix_unitaire, total, paiement, solde, observations, livraison_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [numeroFact, fournisseur_id, date_livraison, cartonsRecus, prixUnit, totalFact,
           paiementAuto, soldeFact,
           `Facture auto - livraison ${cartonsRecus} cartons${plateauxRecus > 0 ? ' + ' + plateauxRecus + ' plateaux' : ''} du ${date_livraison}`,
           result.insertId]
        );

        // Mettre à jour solde_compte fournisseur — synchronisation immédiate
        await conn.query(
          'UPDATE fournisseurs SET solde_compte = ? WHERE id = ?',
          [nouveauSolde, fournisseur_id]
        );

        // Si du crédit a été consommé, enregistrer le paiement automatique
        if (paiementAuto > 0) {
          await conn.query(
            `INSERT INTO paiements_fournisseur (facture_id, date_paiement, montant, mode, observation)
             VALUES (?, ?, ?, 'credit_avance', ?)`,
            [factResult.insertId, date_livraison, paiementAuto,
             `Consommation automatique credit d avance (credit disponible : ${creditDispo} FCFA)`]
          );
        }

        await logAction(req.user, 'CREATE', 'livraisons',
          `Facture ${numeroFact} creee auto — ${cartonsRecus} crt x ${prixUnit} = ${totalFact} FCFA` +
          (paiementAuto > 0 ? ` — Credit consomme: ${paiementAuto} FCFA` : '') +
          ` — Nouveau solde compte fournisseur: ${nouveauSolde} FCFA`
        );
      }
    }

    await conn.commit();
    await logAction(req.user, 'CREATE', 'livraisons', `Livraison de ${cartonsRecus} cartons${plateauxRecus > 0 ? " + " + plateauxRecus + " plateaux" : ""} — ${fournisseurNom}`);

    const [newLiv] = await db.query(
      `SELECT l.*, f.nom as fournisseur_nom FROM livraisons l
       LEFT JOIN fournisseurs f ON l.fournisseur_id = f.id WHERE l.id = ?`, [result.insertId]
    );
    res.status(201).json(newLiv[0]);
  } catch (e) {
    await conn.rollback();
    console.error(e);
    res.status(500).json({ error: 'Erreur serveur' });
  } finally { conn.release(); }
});

// PUT /api/livraisons/:id — modifier quantité, fournisseur, notes + fichier
router.put('/:id', auth, adminOnly, upload.single('fichier'), async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query('SELECT * FROM livraisons WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Livraison non trouvée' });
    const old = rows[0];

    const { date_livraison, quantite_cartons, fournisseur, notes } = req.body;
    const newQte = parseInt(quantite_cartons);
    if (!newQte || newQte <= 0) return res.status(400).json({ error: 'Quantité invalide' });

    const fichier = req.file ? req.file.filename : old.fichier_facture;
    const diff = newQte - old.quantite_cartons;

    await conn.query(
      'UPDATE livraisons SET date_livraison=?, quantite_cartons=?, fournisseur=?, notes=?, fichier_facture=? WHERE id=?',
      [date_livraison, newQte, fournisseur || null, notes || null, fichier, req.params.id]
    );

    // Ajuster le stock selon la différence
    if (diff !== 0) {
      await conn.query('UPDATE stock_actuel SET cartons = cartons + ? WHERE id = 1', [diff]);
      await conn.query(
        `INSERT INTO stock_mouvements (date_mouvement, type_mouvement, cartons, plateaux, oeufs, motif, reference_id, reference_type)
         VALUES (?, ?, ?, 0, 0, ?, ?, 'livraison')`,
        [date_livraison, diff > 0 ? 'entree' : 'sortie', Math.abs(diff),
         `Modification livraison — ajustement ${diff > 0 ? '+' : ''}${diff} cartons`, req.params.id]
      );
    }

    await conn.commit();
    await logAction(req.user, 'UPDATE', 'livraisons', `Livraison #${req.params.id} modifiée — ${newQte} cartons`);
    const [updated] = await db.query('SELECT * FROM livraisons WHERE id = ?', [req.params.id]);
    res.json(updated[0]);
  } catch (e) {
    await conn.rollback();
    res.status(500).json({ error: 'Erreur serveur' });
  } finally { conn.release(); }
});

// DELETE /api/livraisons/:id
router.delete('/:id', auth, adminOnly, async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query('SELECT * FROM livraisons WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Non trouvé' });
    const liv = rows[0];

    // Déterminer le type CC/CT depuis le fournisseur
    let isCC = false;
    if (liv.fournisseur_id) {
      const [fRows] = await conn.query('SELECT nom FROM fournisseurs WHERE id = ?', [liv.fournisseur_id]);
      if (fRows.length) {
        const nom = fRows[0].nom.toLowerCase();
        isCC = nom.includes('cameroun') || nom.includes('abakar');
      }
    }

    // Restaurer le stock global
    await conn.query(
      `UPDATE stock_actuel SET
         cartons    = GREATEST(0, cartons    - ?),
         cartons_cc = GREATEST(0, cartons_cc - ?),
         cartons_ct = GREATEST(0, cartons_ct - ?)
       WHERE id = 1`,
      [liv.quantite_cartons,
       isCC ? liv.quantite_cartons : 0,
       isCC ? 0 : liv.quantite_cartons]
    );
    await conn.query('DELETE FROM stock_mouvements WHERE reference_id = ? AND reference_type = "livraison"', [req.params.id]);

    // Restaurer le stock du fournisseur spécifique
    if (liv.fournisseur_id) {
      await annulerStockFournisseur(conn, liv.fournisseur_id, liv.quantite_cartons, 0);
    }

    // Restaurer le solde_compte fournisseur si une facture auto existe
    if (liv.fournisseur_id) {
      const [factures] = await conn.query(
        'SELECT * FROM factures_fournisseur WHERE livraison_id = ?', [req.params.id]
      );
      for (const fact of factures) {
        await conn.query(
          'UPDATE fournisseurs SET solde_compte = solde_compte - ? WHERE id = ?',
          [Number(fact.total), liv.fournisseur_id]
        );
        await conn.query('DELETE FROM paiements_fournisseur WHERE facture_id = ?', [fact.id]);
        await conn.query('DELETE FROM factures_fournisseur WHERE id = ?', [fact.id]);
      }
    }

    await conn.query('DELETE FROM livraisons WHERE id = ?', [req.params.id]);
    await conn.commit();
    await logAction(req.user, 'DELETE', 'livraisons', `Livraison #${req.params.id} supprimée — stock et solde fournisseur restaurés`);
    res.json({ message: 'Livraison supprimée, solde fournisseur restauré' });
  } catch (e) {
    await conn.rollback();
    console.error(e);
    res.status(500).json({ error: 'Erreur serveur' });
  } finally { conn.release(); }
});

module.exports = router;
