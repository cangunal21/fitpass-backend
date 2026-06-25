import { Router } from 'express'

// Sayısal olması gereken route parametreleri (:id, :venueId, ...).
// :username gibi string param'lar listede yok → etkilenmez.
const NUMERIC = ['id', 'venueId', 'sessionId', 'slotId', 'classId', 'reviewId', 'reportId', 'couponId', 'instructorId', 'userId']

/**
 * Sayısal ID param'larını route controller'a girMEDEN önce doğrular.
 * Sayı olmayan ID (örn. "abc") gelirse Prisma'ya gitmeden 400 döner → "NaN → 500" bug'ı tek yerde biter.
 * Her router'da `const router = Router()` sonrası bir kez çağrılır (oturan sistem; whack-a-mole değil).
 */
export function registerNumericParams(router: Router) {
  for (const name of NUMERIC) {
    router.param(name, (req, res, next, val) => {
      if (isNaN(parseInt(val as string))) return res.status(400).json({ error: 'Geçersiz ID.' })
      next()
    })
  }
}
