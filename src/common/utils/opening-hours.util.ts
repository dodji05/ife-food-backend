/**
 * Calcule si un établissement est ouvert à l'instant T.
 *
 * Fuseau de référence : Africa/Porto-Novo (UTC+1, sans DST au Bénin).
 * Le décalage est appliqué manuellement (+1 h sur getTime()) de façon à
 * fonctionner correctement quel que soit le fuseau du serveur.
 *
 * Format attendu pour openingHours :
 *   { mon: { open: '08:00', close: '22:00' }, tue: null, ... }
 * Un jour absent, null, ou avec open/close null = fermé ce jour.
 * Supporte les slots passant minuit (ex : open='22:00', close='02:00').
 */
export function computeIsOpen(dbIsOpen: boolean, openingHours: unknown): boolean {
  if (
    !openingHours ||
    typeof openingHours !== 'object' ||
    Object.keys(openingHours as object).length === 0
  ) {
    return dbIsOpen;
  }

  const now   = new Date();
  const benin = new Date(now.getTime() + 60 * 60 * 1000); // UTC+1

  const dayKeys      = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
  const todayKey     = dayKeys[benin.getUTCDay()];
  const yesterdayKey = dayKeys[(benin.getUTCDay() + 6) % 7];
  const nowMinutes   = benin.getUTCHours() * 60 + benin.getUTCMinutes();

  const parseSlot = (slot: unknown): [number, number] | null => {
    if (!slot || typeof slot !== 'object') return null;
    const s     = slot as Record<string, unknown>;
    const open  = typeof s['open']  === 'string' ? (s['open']  as string) : null;
    const close = typeof s['close'] === 'string' ? (s['close'] as string) : null;
    if (!open || !close) return null; // null/absent = jour fermé
    const [oh, om] = open.split(':').map(Number);
    const [ch, cm] = close.split(':').map(Number);
    if ([oh, om, ch, cm].some(Number.isNaN)) return null;
    return [oh * 60 + om, ch * 60 + cm];
  };

  const oh = openingHours as Record<string, unknown>;

  // Slot du jour courant
  const today = parseSlot(oh[todayKey]);
  if (today) {
    const [open, close] = today;
    if (close > open) {
      if (nowMinutes >= open && nowMinutes < close) return true;
    } else if (close < open) {
      // Slot passant minuit → ouvert si >= heure d'ouverture
      if (nowMinutes >= open) return true;
    }
  }

  // Slot d'hier qui passe minuit et qu'on est encore dedans
  const yesterday = parseSlot(oh[yesterdayKey]);
  if (yesterday) {
    const [open, close] = yesterday;
    if (close < open && nowMinutes < close) return true;
  }

  return false;
}
