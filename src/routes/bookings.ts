import { Router } from 'express'
import { createBooking, getMyBookings, cancelBooking } from '../controllers/bookingController'
import { authMiddleware } from '../middlewares/auth'

const router = Router()

router.post('/', authMiddleware, createBooking)
router.get('/my', authMiddleware, getMyBookings)
router.put('/:id/cancel', authMiddleware, cancelBooking)

export default router
