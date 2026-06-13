import { Router } from 'express'
import { getStats, getAllVenues, approveVenue, getAllUsers, getAllBookings } from '../controllers/adminController'
import { adminAuthMiddleware } from '../middlewares/adminAuth'

const router = Router()

router.use(adminAuthMiddleware)

router.get('/stats', getStats)
router.get('/venues', getAllVenues)
router.put('/venues/:id/approve', approveVenue)
router.get('/users', getAllUsers)
router.get('/bookings', getAllBookings)

export default router
