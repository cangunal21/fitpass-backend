import { registerNumericParams } from '../middlewares/numericParams'
import { Router } from 'express'
import { joinWaitlist, leaveWaitlist, getWaitlistStatus } from '../controllers/waitlistController'
import { authMiddleware } from '../middlewares/auth'
// E-POSTA DOĞRULAMA KAPISI: yalnız BAŞKASINI ETKİLEYEN / KAYNAK TÜKETEN yazma uçlarında.
// Okuma, iptal, profil ve "kod tekrar gönder" bilerek AÇIK — bkz. middlewares/requireVerified.ts
import { requireVerifiedEmail } from '../middlewares/requireVerified'

const router = Router()
registerNumericParams(router)

router.post('/sessions/:sessionId', authMiddleware, requireVerifiedEmail, joinWaitlist)
router.delete('/sessions/:sessionId', authMiddleware, leaveWaitlist)
router.get('/sessions/:sessionId/status', authMiddleware, getWaitlistStatus)

export default router
