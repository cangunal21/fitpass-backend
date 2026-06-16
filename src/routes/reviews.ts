import { Router } from 'express'
import { createReview, getVenueReviews, replyToReview, deleteReviewReply } from '../controllers/reviewController'
import { authMiddleware } from '../middlewares/auth'
import { venueAuthMiddleware } from '../middlewares/venueAuth'

const router = Router()

router.post('/', authMiddleware, createReview)
router.get('/venue/:venueId', getVenueReviews)
router.put('/:id/reply', venueAuthMiddleware, replyToReview)
router.delete('/:id/reply', venueAuthMiddleware, deleteReviewReply)

export default router
