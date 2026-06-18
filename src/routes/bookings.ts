import { Router } from 'express'
import { createBooking, getMyBookings, cancelBooking, joinDropIn, checkInBooking } from '../controllers/bookingController'
import { authMiddleware } from '../middlewares/auth'
import { venueAuthMiddleware } from '../middlewares/venueAuth'

const router = Router()

router.post('/', authMiddleware, createBooking)
router.get('/my', authMiddleware, getMyBookings)
router.put('/:id/cancel', authMiddleware, cancelBooking)
router.post('/dropin/:slotId/join', authMiddleware, joinDropIn)
router.post('/checkin', venueAuthMiddleware, checkInBooking)

export default router
