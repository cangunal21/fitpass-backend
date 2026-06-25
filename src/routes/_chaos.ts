import { Router } from 'express'

// ⚠️ SADECE TEST İÇİN. Yalnızca CHAOS_TEST=true iken index.ts tarafından mount edilir;
// Railway/prod'da bu env hiçbir zaman set edilmez → route'lar mevcut bile olmaz.
// Amaç: hata güvenlik ağlarının (Express error middleware + process handler'ları) gerçekten
// çalıştığını, tek bir hatanın sunucuyu düşürmediğini kanıtlamak.
const router = Router()

// 1) Senkron throw → Express 5 yakalar → error middleware → 500 (çökme yok)
router.get('/throw-sync', () => { throw new Error('CHAOS: senkron throw') })

// 2) Async throw (await sonrası) → Express 5 yakalar → 500 (request asılı kalmaz)
router.get('/throw-async', async () => {
  await new Promise(r => setTimeout(r, 5))
  throw new Error('CHAOS: async throw')
})

// 3) next(err) ile hata → error middleware → 500
router.get('/next-error', (_req, _res, next) => { next(new Error('CHAOS: next(err)')) })

// 4) İsteğe bağlı OLMAYAN, yakalanmamış promise reddi (.catch yok) → unhandledRejection handler
//    devreye girer, sunucu AYAKTA kalır.
router.get('/reject-unhandled', (_req, res) => {
  Promise.reject(new Error('CHAOS: yakalanmamış promise reddi'))
  res.json({ ok: true, note: 'unhandledRejection tetiklendi' })
})

// 5) setTimeout içinde throw → uncaughtException handler devreye girer, sunucu AYAKTA kalır.
router.get('/uncaught', (_req, res) => {
  setTimeout(() => { throw new Error('CHAOS: uncaughtException') }, 10)
  res.json({ ok: true, note: 'uncaughtException tetiklendi' })
})

export default router
