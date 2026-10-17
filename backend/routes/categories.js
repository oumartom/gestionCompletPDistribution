// routes/categories.js — Catégories clients avec prix CC et CT
const router = require('express').Router();
const db     = require('../config/db');
const { auth, adminOnly } = require('../middleware/auth');
const { logAction } = require('../middleware/journal');

// GET /api/categories
router.get('/', auth, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT id, nom, prix_unitaire,
        COALESCE(prix_cc, prix_unitaire) AS prix_cc,
        COALESCE(prix_ct, prix_unitaire) AS prix_ct,
        description, actif, created_at
       FROM categories_clients WHERE actif = 1 ORDER BY prix_unitaire`
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Erreur serveur' }); }
});

// POST /api/categories
router.post('/', auth, adminOnly, async (req, res) => {
  try {
    const { nom, prix_unitaire, prix_cc, prix_ct, description } = req.body;
    if (!nom || !prix_unitaire) return res.status(400).json({ error: 'Nom et prix requis' });
    const pcc = prix_cc || prix_unitaire;
    const pct = prix_ct || prix_unitaire;
    const [result] = await db.query(
      'INSERT INTO categories_clients (nom, prix_unitaire, prix_cc, prix_ct, description) VALUES (?, ?, ?, ?, ?)',
      [nom, prix_unitaire, pcc, pct, description || null]
    );
    await logAction(req.user, 'CREATE', 'categories',
      `Catégorie créée : ${nom} — CC:${pcc} / CT:${pct} FCFA`);
    const [newCat] = await db.query('SELECT * FROM categories_clients WHERE id = ?', [result.insertId]);
    res.status(201).json(newCat[0]);
  } catch (e) { res.status(500).json({ error: 'Erreur serveur' }); }
});

// PUT /api/categories/:id
router.put('/:id', auth, adminOnly, async (req, res) => {
  try {
    const { nom, prix_unitaire, prix_cc, prix_ct, description } = req.body;
    if (!nom || !prix_unitaire) return res.status(400).json({ error: 'Nom et prix requis' });
    const pcc = prix_cc || prix_unitaire;
    const pct = prix_ct || prix_unitaire;
    await db.query(
      'UPDATE categories_clients SET nom=?, prix_unitaire=?, prix_cc=?, prix_ct=?, description=? WHERE id=?',
      [nom, prix_unitaire, pcc, pct, description || null, req.params.id]
    );
    await logAction(req.user, 'UPDATE', 'categories',
      `Catégorie modifiée #${req.params.id} : ${nom} — CC:${pcc} / CT:${pct} FCFA`);
    const [updated] = await db.query('SELECT * FROM categories_clients WHERE id = ?', [req.params.id]);
    res.json(updated[0]);
  } catch (e) { res.status(500).json({ error: 'Erreur serveur' }); }
});

// DELETE /api/categories/:id
router.delete('/:id', auth, adminOnly, async (req, res) => {
  try {
    await db.query('UPDATE categories_clients SET actif = 0 WHERE id = ?', [req.params.id]);
    await logAction(req.user, 'DELETE', 'categories', `Catégorie désactivée #${req.params.id}`);
    res.json({ message: 'Catégorie désactivée' });
  } catch (e) { res.status(500).json({ error: 'Erreur serveur' }); }
});

module.exports = router;
