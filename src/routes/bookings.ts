import { registerNumericParams } from '../middlewares/numericParams'
import { Router } from 'express'
import { createBooking, getMyBookings, cancelBooking, joinDropIn, checkInBooking, checkInDropIn, getTransferOptions, transferBooking } from '../controllers/bookingController'
import { authMiddleware } from '../middlewares/auth'
import { venueAuthMiddleware } from '../middlewares/venueAuth'

const router = Router()
registerNumericParams(router)

router.post('/', authMiddleware, createBooking)
router.get('/my', authMiddleware, getMyBookings)
router.put('/:id/cancel', authMiddleware, cancelBooking)
router.get('/:id/transfer-options', authMiddleware, getTransferOptions)
router.put('/:id/transfer', authMiddleware, transferBooking)
router.post('/dropin/:slotId/join', authMiddleware, joinDropIn)
router.post('/checkin', venueAuthMiddleware, checkInBooking)
router.post('/dropin-checkin', venueAuthMiddleware, checkInDropIn)

export default router
