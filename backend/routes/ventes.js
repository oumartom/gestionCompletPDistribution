// routes/ventes.js — avec déduction automatique avance client
const router    = require('express').Router();
const db        = require('../config/db');
const { auth, adminOnly } = require('../middleware/auth');
const { logAction } = require('../middleware/journal');
const { deduireStockFournisseur, restaurerStockFournisseur } = require('./stock');

router.get('/', auth, async (req, res) => {
  try {
    const { annee, mois, date, client_id, statut, date_debut, date_fin } = req.query;
    let sql = `SELECT v.*, c.nom as client_nom, c.zone as client_zone,
                      c.categorie as client_cat, c.solde_avance,
                      cat.nom as categorie_nom, cat.prix_unitaire as prix_categorie
               FROM ventes v
               LEFT JOIN clients c ON v.client_id = c.id
               LEFT JOIN categories_clients cat ON c.categorie_id = cat.id
               WHERE 1=1`;
    const params = [];
    if (annee)     { sql += ' AND YEAR(DATE(v.date_vente)) = ?';  params.push(annee); }
    if (mois)      { sql += ' AND MONTH(DATE(v.date_vente)) = ?'; params.push(mois); }
    if (date)      { sql += ' AND DATE(v.date_vente) = ?';         params.push(date); }
    if (date_debut) { sql += ' AND DATE(v.date_vente) >= ?'; params.push(date_debut); }
    if (date_fin)   { sql += ' AND DATE(v.date_vente) <= ?'; params.push(date_fin); }
    if (client_id)  { sql += ' AND v.client_id = ?';   params.push(client_id); }
    if (statut === 'solde')   sql += ' AND v.solde <= 0';
    if (statut === 'impaye')  sql += ' AND v.solde > 0';
    sql += ' ORDER BY v.date_vente DESC, v.id DESC';
    const [rows] = await db.query(sql, params);
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.post('/', auth, async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const {
      date_vente, client_id, observations,
      quantite_cc, prix_cc, plateaux_cc = 0, oeufs_cc = 0,
      quantite_ct, prix_ct, plateaux_ct = 0, oeufs_ct = 0,
      quantite, prix_unitaire, type_carton,
    } = req.body;

    // Cartons uniquement (pas de conversion plateaux)
    const qteCC   = parseFloat(quantite_cc || 0) || 0;
    const qteCT   = parseFloat(quantite_ct || 0) || 0;
    const platCC  = parseInt(plateaux_cc)  || 0;
    const platCT  = parseInt(plateaux_ct)  || 0;
    const oeufCC  = parseInt(oeufs_cc)     || 0;
    const oeufCT  = parseInt(oeufs_ct)     || 0;
    const puCC    = parseInt(prix_cc  || prix_unitaire || 0);
    const puCT    = parseInt(prix_ct  || prix_unitaire || 0);

    // Mode ancienne API
    const ancienMode = !quantite_cc && !quantite_ct && quantite;
    const qteAncien  = ancienMode ? parseFloat(quantite) || 0 : 0;
    const typeAncien = type_carton || 'CT';

    if (!client_id) {
      conn.release();
      return res.status(400).json({ error: 'Client requis' });
    }
    if (!ancienMode && qteCC <= 0 && qteCT <= 0 && platCC <= 0 && platCT <= 0) {
      conn.release();
      return res.status(400).json({ error: 'Quantité requise (cartons ou plateaux)' });
    }

    // Vérifier le stock — seulement pour les cartons complets
    const [stockRows] = await conn.query('SELECT cartons, cartons_cc, cartons_ct, plateaux FROM stock_actuel WHERE id = 1');
    const stockCC      = Number(stockRows[0]?.cartons_cc || 0);
    const stockCT      = Number(stockRows[0]?.cartons_ct || 0);
    const stockPlateaux = Number(stockRows[0]?.plateaux   || 0);

    if (!ancienMode) {
      if (qteCC > 0 && qteCC > stockCC) {
        conn.release();
        return res.status(400).json({ error: `Stock CC insuffisant. Disponible : ${stockCC} crt CC. Demandé : ${qteCC}.` });
      }
      if (qteCT > 0 && qteCT > stockCT) {
        conn.release();
        return res.status(400).json({ error: `Stock CT insuffisant. Disponible : ${stockCT} crt CT. Demandé : ${qteCT}.` });
      }
    } else {
      const dispo = typeAncien === 'CC' ? stockCC : stockCT;
      if (qteAncien > dispo) {
        conn.release();
        return res.status(400).json({ error: `Stock ${typeAncien} insuffisant. Disponible : ${dispo} crt.` });
      }
    }

    // Récupérer info client (avance, solde)
    const [cliRows] = await conn.query('SELECT * FROM clients WHERE id = ?', [client_id]);
    const client = cliRows[0];
    if (!client) { conn.release(); return res.status(404).json({ error: 'Client introuvable' }); }

    // Calculer le total global — cartons + plateaux proportionnels
    const totalCC = ancienMode ? 0 : Math.round(qteCC * puCC + (platCC / 12) * puCC + (oeufCC / 360) * puCC);
    const totalCT = ancienMode ? 0 : Math.round(qteCT * puCT + (platCT / 12) * puCT + (oeufCT / 360) * puCT);
    const totalGlobal = ancienMode
      ? Math.round(qteAncien * parseInt(prix_unitaire))
      : totalCC + totalCT;

    // Gérer l'avance client
    let avanceUtilisee = 0;
    let soldeAvanceRestant = Number(client.solde_avance || 0);
    if (soldeAvanceRestant > 0) {
      avanceUtilisee = Math.min(soldeAvanceRestant, totalGlobal);
      soldeAvanceRestant -= avanceUtilisee;
      await conn.query('UPDATE clients SET solde_avance = ? WHERE id = ?', [soldeAvanceRestant, client_id]);
    }
    const soldeVente = totalGlobal - avanceUtilisee;

    // Générer numéro de vente
    const [lastV] = await conn.query('SELECT MAX(id) as max_id FROM ventes');
    const nextId  = (lastV[0].max_id || 0) + 1;
    const { todayLocal } = require('../config/dateHelper');
    const dateStr = (date_vente || todayLocal()).replace(/-/g, '');
    const numero  = `VTE-${dateStr}-${String(nextId).padStart(3, '0')}`;

    const insertedIds = [];

    if (ancienMode) {
      const [res1] = await conn.query(
        `INSERT INTO ventes (date_vente, numero, client_id, quantite, plateaux_vendus, prix_unitaire, total, paiement, solde, type_carton, observations)
         VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
        [date_vente, numero, client_id, qteAncien, parseInt(prix_unitaire), totalGlobal,
         avanceUtilisee, soldeVente, typeAncien, observations || null]
      );
      insertedIds.push({ id: res1.insertId, type: typeAncien, qte: qteAncien });
      const isCC = typeAncien === 'CC';
      await conn.query(
        `UPDATE stock_actuel SET
           cartons    = GREATEST(0, cartons    - ?),
           cartons_cc = GREATEST(0, cartons_cc - ?),
           cartons_ct = GREATEST(0, cartons_ct - ?)
         WHERE id = 1`,
        [qteAncien, isCC ? qteAncien : 0, isCC ? 0 : qteAncien]
      );
      await conn.query(
        `INSERT INTO stock_mouvements (date_mouvement, type_mouvement, cartons, cartons_cc, cartons_ct, plateaux, oeufs, motif, reference_id, reference_type)
         VALUES (?, 'sortie', ?, ?, ?, 0, 0, ?, ?, 'vente')`,
        [date_vente, qteAncien, isCC ? qteAncien : 0, isCC ? 0 : qteAncien,
         `Vente ${typeAncien} a ${client.nom} - ${qteAncien} cartons`, res1.insertId]
      );
    } else {
      const descCC = qteCC > 0 || platCC > 0 ? `${qteCC} C${platCC > 0 ? ' + ' + platCC + ' plat.' : ''}${oeufCC > 0 ? ' + ' + oeufCC + ' oeufs' : ''} [CC]` : '';
      const descCT = qteCT > 0 || platCT > 0 ? `${qteCT} C${platCT > 0 ? ' + ' + platCT + ' plat.' : ''}${oeufCT > 0 ? ' + ' + oeufCT + ' oeufs' : ''} [CT]` : '';
      const obs = observations || [descCC, descCT].filter(Boolean).join(' | ') || null;

      // Vérifier si les colonnes plateaux_vendus/oeufs_vendus existent
      let hasPlateauxCol = false;
      try {
        await conn.query('SELECT plateaux_vendus FROM ventes LIMIT 1');
        hasPlateauxCol = true;
      } catch(e) { hasPlateauxCol = false; }

      const insertVente = async (num, qte, plat, oeufs, pu, total, typeC) => {
        if (hasPlateauxCol) {
          return conn.query(
            `INSERT INTO ventes (date_vente, numero, client_id, quantite, plateaux_vendus, oeufs_vendus, prix_unitaire, total, paiement, solde, type_carton, observations)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
            [date_vente, num, client_id, qte, plat || 0, oeufs || 0, pu, total, total, typeC, obs]
          );
        } else {
          // Fallback sans les colonnes plateaux (avant migration)
          const obsComplet = obs || (plat > 0 ? `${qte} cartons + ${plat} plateaux` : null);
          return conn.query(
            `INSERT INTO ventes (date_vente, numero, client_id, quantite, prix_unitaire, total, paiement, solde, type_carton, observations)
             VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
            [date_vente, num, client_id, qte, pu, total, total, typeC, obsComplet]
          );
        }
      };

      if (qteCC > 0 || platCC > 0) {
        const [r1] = await insertVente(`${numero}CC`, qteCC, platCC, oeufCC, puCC, totalCC, 'CC');
        insertedIds.push({ id: r1.insertId, type: 'CC', qte: qteCC, plateaux: platCC, total: totalCC });
        if (qteCC > 0) await conn.query(
          'UPDATE stock_actuel SET cartons=GREATEST(0,cartons-?), cartons_cc=GREATEST(0,cartons_cc-?) WHERE id=1',
          [qteCC, qteCC]
        );
        if (platCC > 0) await conn.query(
          'UPDATE stock_actuel SET plateaux=GREATEST(0,plateaux-?) WHERE id=1', [platCC]
        );
        // Déduire du stock fournisseur CC
        await deduireStockFournisseur(conn, 'CC', qteCC, platCC);
        await conn.query(
          `INSERT INTO stock_mouvements (date_mouvement, type_mouvement, cartons, cartons_cc, cartons_ct, plateaux, oeufs, motif, reference_id, reference_type)
           VALUES (?, 'sortie', ?, ?, 0, ?, ?, ?, ?, 'vente')`,
          [date_vente, qteCC, qteCC, platCC, oeufCC,
           `Vente CC a ${client.nom} — ${qteCC}C${platCC > 0 ? ' + ' + platCC + 'plat.' : ''}`, r1.insertId]
        );
      }
      if (qteCT > 0 || platCT > 0) {
        const [r2] = await insertVente(`${numero}CT`, qteCT, platCT, oeufCT, puCT, totalCT, 'CT');
        insertedIds.push({ id: r2.insertId, type: 'CT', qte: qteCT, plateaux: platCT, total: totalCT });
        if (qteCT > 0) await conn.query(
          'UPDATE stock_actuel SET cartons=GREATEST(0,cartons-?), cartons_ct=GREATEST(0,cartons_ct-?) WHERE id=1',
          [qteCT, qteCT]
        );
        if (platCT > 0) await conn.query(
          'UPDATE stock_actuel SET plateaux=GREATEST(0,plateaux-?) WHERE id=1', [platCT]
        );
        // Déduire du stock fournisseurs CT (proportionnel)
        await deduireStockFournisseur(conn, 'CT', qteCT, platCT);
        await conn.query(
          `INSERT INTO stock_mouvements (date_mouvement, type_mouvement, cartons, cartons_cc, cartons_ct, plateaux, oeufs, motif, reference_id, reference_type)
           VALUES (?, 'sortie', ?, 0, ?, ?, ?, ?, ?, 'vente')`,
          [date_vente, qteCT, qteCT, platCT, oeufCT,
           `Vente CT a ${client.nom} — ${qteCT}C${platCT > 0 ? ' + ' + platCT + 'plat.' : ''}`, r2.insertId]
        );
      }
    }

    // Mettre à jour solde client
    await conn.query(
      'UPDATE clients SET solde_global = solde_global + ? WHERE id = ?',
      [soldeVente, client_id]
    );

    // Synchroniser stock_actuel depuis les mouvements
    await conn.commit();

    const msg = avanceUtilisee > 0
      ? `Distribution enregistrée — Avance déduite : ${avanceUtilisee} FCFA`
      : 'Distribution enregistrée';
    await logAction(req.user, 'CREATE', 'ventes',
      `Vente ${numero} — ${client.nom} — Total: ${totalGlobal} FCFA`);

    res.status(201).json({ message: msg, ids: insertedIds, total: totalGlobal, avance_deduite: avanceUtilisee });
  } catch (e) {
    await conn.rollback();
    console.error(e);
    res.status(500).json({ error: e.message || 'Erreur serveur' });
  } finally { conn.release(); }
});


router.put('/:id', auth, async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const { date_vente, client_id, quantite, prix_unitaire, observations } = req.body;
    const qte = parseInt(quantite), pu = parseInt(prix_unitaire);
    const total = qte * pu;

    const [oldRows] = await conn.query('SELECT * FROM ventes WHERE id = ?', [req.params.id]);
    if (!oldRows.length) return res.status(404).json({ error: 'Vente non trouvée' });
    const old = oldRows[0];
    const diff = qte - old.quantite;

    const [stockRows] = await conn.query('SELECT cartons FROM stock_actuel WHERE id = 1');
    if (diff > (stockRows[0]?.cartons || 0))
      return res.status(400).json({ error: 'Stock insuffisant' });

    await conn.query(
      `UPDATE ventes SET date_vente=?, client_id=?, quantite=?, prix_unitaire=?, total=?, solde=?, observations=? WHERE id=?`,
      [date_vente, client_id, qte, pu, total, total, observations||null, req.params.id]
    );

    if (diff !== 0)
      await conn.query('UPDATE stock_actuel SET cartons = cartons - ? WHERE id = 1', [diff]);

    await conn.query(
      'UPDATE clients SET solde_global = solde_global - ? + ? WHERE id = ?',
      [Number(old.total), total, old.client_id]
    );

    await conn.commit();
    await logAction(req.user, 'UPDATE', 'ventes', `Vente #${req.params.id} modifiée`);
    const [updated] = await db.query('SELECT * FROM ventes WHERE id = ?', [req.params.id]);
    res.json(updated[0]);
  } catch (e) {
    await conn.rollback();
    res.status(500).json({ error: 'Erreur serveur' });
  } finally { conn.release(); }
});

router.delete('/:id', auth, adminOnly, async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query('SELECT * FROM ventes WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Vente non trouvée' });
    const v = rows[0];
    const qte      = Number(v.quantite || 0);
    const plat     = Number(v.plateaux_vendus || 0);
    const typeCart = v.type_carton || 'CT';
    const isCC     = typeCart === 'CC';

    // Restaurer le solde client
    await conn.query(
      'UPDATE clients SET solde_global = GREATEST(0, solde_global - ?) WHERE id = ?',
      [Number(v.solde), v.client_id]
    );

    // Restaurer le stock global (cartons + plateaux)
    await conn.query(
      `UPDATE stock_actuel SET
         cartons    = cartons    + ?,
         cartons_cc = cartons_cc + ?,
         cartons_ct = cartons_ct + ?,
         plateaux   = plateaux   + ?
       WHERE id = 1`,
      [qte, isCC ? qte : 0, isCC ? 0 : qte, plat]
    );

    // Restaurer le stock par fournisseur
    await restaurerStockFournisseur(conn, typeCart, qte, plat);

    // Supprimer les mouvements stock liés
    await conn.query('DELETE FROM stock_mouvements WHERE reference_id=? AND reference_type="vente"', [req.params.id]);
    await conn.query('DELETE FROM ventes WHERE id = ?', [req.params.id]);

    await conn.commit();
    await logAction(req.user, 'DELETE', 'ventes',
      `Vente #${req.params.id} supprimée — stock restauré (+${qte} crt${plat > 0 ? ' + ' + plat + ' plat.' : ''} ${typeCart})`);
    res.json({ message: 'Vente supprimée, stock et solde client restaurés' });
  } catch (e) {
    await conn.rollback();
    console.error(e);
    res.status(500).json({ error: 'Erreur serveur' });
  } finally { conn.release(); }
});

module.exports = router;
