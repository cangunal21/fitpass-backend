import { Router } from 'express'

// Sayısal olması gereken route parametreleri (:id, :venueId, ...).
// :username gibi string param'lar listede yok → etkilenmez.
const NUMERIC = ['id', 'venueId', 'sessionId', 'slotId', 'classId', 'reviewId', 'reportId', 'couponId', 'instructorId', 'userId']

/**
 * Sayısal ID param'larını route controller'a girMEDEN önce doğrular.
 * Sayı olmayan ID (örn. "abc") gelirse Prisma'ya gitmeden 400 döner → "NaN → 500" bug'ı tek yerde biter.
 * Her router'da `const router = Router()` sonrası bir kez çağrılır (oturan sistem; whack-a-mole değil).
 */
// Postgres int4 üst sınırı — bunu aşan ID'ler "out of range" ile 500 verir, önle.
const INT4_MAX = 2147483647

export function registerNumericParams(router: Router) {
  for (const name of NUMERIC) {
    router.param(name, (req, res, next, val) => {
      const n = Number(val)
      if (!Number.isInteger(n) || n < 1 || n > INT4_MAX) return res.status(400).json({ error: 'Geçersiz ID.' })
      next()
    })
  }
}
