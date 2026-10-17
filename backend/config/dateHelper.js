// Helper date — N'Djamena UTC+1
// Railway tourne en UTC, on ajoute 1h manuellement
function todayLocal() {
  const now    = new Date();
  // UTC+1 : ajouter 3600 secondes
  const local  = new Date(now.getTime() + 3600 * 1000);
  const year   = local.getUTCFullYear();
  const month  = String(local.getUTCMonth() + 1).padStart(2, '0');
  const day    = String(local.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

module.exports = { todayLocal };
