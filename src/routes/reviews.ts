import { registerNumericParams } from '../middlewares/numericParams'
import { Router } from 'express'
import { createReview, gizliGeriBildirim, getPendingRatings, getVenueReviews, getInstructorReviews, replyToReview, deleteReviewReply } from '../controllers/reviewController'
import { authMiddleware, optionalAuthMiddleware } from '../middlewares/auth'
// E-POSTA DOĞRULAMA KAPISI: yalnız BAŞKASINI ETKİLEYEN / KAYNAK TÜKETEN yazma uçlarında.
// Okuma, iptal, profil ve "kod tekrar gönder" bilerek AÇIK — bkz. middlewares/requireVerified.ts
import { requireVerifiedEmail } from '../middlewares/requireVerified'
import { venueAuthMiddleware } from '../middlewares/venueAuth'

const router = Router()
registerNumericParams(router)

router.post('/', authMiddleware, requireVerifiedEmail, createReview)
// GİZLİ geri bildirim — yalnız yöneticiye gider, hiçbir public uçtan dönmez.
// createReview'dan AYRI: check-in aramaz, çünkü "hoca gelmedi" vakasında check-in yoktur.
router.post('/gizli-geri-bildirim', authMiddleware, requireVerifiedEmail, gizliGeriBildirim)
// Puanlanmayı bekleyen dersler (mobil puanlama modalı bunu çeker). Statik path → dinamiklerden önce.
router.get('/pending', authMiddleware, getPendingRatings)
// optionalAuth: private salon/hoca yanıtını yalnız yorumu yazan kullanıcıya gösterebilmek için
router.get('/venue/:venueId', optionalAuthMiddleware, getVenueReviews)
router.get('/instructor/:instructorId', optionalAuthMiddleware, getInstructorReviews)
router.put('/:id/reply', venueAuthMiddleware, replyToReview)
router.delete('/:id/reply', venueAuthMiddleware, deleteReviewReply)

export default router
