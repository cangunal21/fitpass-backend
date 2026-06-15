import { Router } from 'express'
import { createReview, getVenueReviews } from '../controllers/reviewController'
import { authMiddleware } from '../middlewares/auth'

const router = Router()

router.post('/', authMiddleware, createReview)
router.get('/venue/:venueId', getVenueReviews)

export default router
