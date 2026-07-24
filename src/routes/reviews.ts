import { registerNumericParams } from '../middlewares/numericParams'
import { Router } from 'express'
import { createReview, getVenueReviews, getInstructorReviews, replyToReview, deleteReviewReply } from '../controllers/reviewController'
import { authMiddleware, optionalAuthMiddleware } from '../middlewares/auth'
import { venueAuthMiddleware } from '../middlewares/venueAuth'

const router = Router()
registerNumericParams(router)

router.post('/', authMiddleware, createReview)
// optionalAuth: private salon/hoca yanıtını yalnız yorumu yazan kullanıcıya gösterebilmek için
router.get('/venue/:venueId', optionalAuthMiddleware, getVenueReviews)
router.get('/instructor/:instructorId', optionalAuthMiddleware, getInstructorReviews)
router.put('/:id/reply', venueAuthMiddleware, replyToReview)
router.delete('/:id/reply', venueAuthMiddleware, deleteReviewReply)

export default router
