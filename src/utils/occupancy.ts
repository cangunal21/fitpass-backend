import prisma from './prisma'

/**
 * SEANS DOLULUĞU — tek kaynak.
 *
 * Doluluk = onaylı + bekleyen rezervasyonların groupSize TOPLAMI (satır sayısı DEĞİL;
 * bir rezervasyon birden çok kişilik olabilir). Tanım bookingController.createBooking
 * içindeki kapasite kapısıyla birebir aynı olmak ZORUNDA: iki yer ayrışırsa listede
 * "yer var" görünen seans rezervasyon anında reddedilir (ya da tersi).
 *
 * Class_Session.capacity o seansın TOPLAM kapasitesidir ve rezervasyonla azalmaz;
 * kalan yer her zaman burada hesaplanır.
 */
export async function getOccupancyMap(sessionIds: number[]): Promise<Map<number, number>> {
  const map = new Map<number, number>()
  if (!sessionIds.length) return map

  const rows = await prisma.booking.groupBy({
    by: ['sessionId'],
    where: { sessionId: { in: sessionIds }, status: { in: ['confirmed', 'pending'] } },
    _sum: { groupSize: true },
  })
  for (const r of rows) {
    if (r.sessionId != null) map.set(r.sessionId, r._sum.groupSize || 0)
  }
  return map
}

/** Tek seansın doluluğu (yukarıdaki tanımın tekil hâli). */
export async function getOccupancy(sessionId: number): Promise<number> {
  const agg = await prisma.booking.aggregate({
    where: { sessionId, status: { in: ['confirmed', 'pending'] } },
    _sum: { groupSize: true },
  })
  return agg._sum.groupSize || 0
}

/** Kalan yer — asla negatif dönmez (kapasite sonradan düşürülmüşse 0'a sabitlenir). */
export function spotsLeftOf(capacity: number | null | undefined, occupied: number): number {
  if (capacity == null) return 0
  return Math.max(0, capacity - occupied)
}
