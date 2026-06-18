import { Router } from 'express'
import { getStats, getAllVenues, approveVenue, getAllUsers, getAllBookings, suspendVenue, deleteVenue, banUser, getAllCoupons, adminDeleteCoupon } from '../controllers/adminController'
import { adminAuthMiddleware } from '../middlewares/adminAuth'

const router = Router()

router.use(adminAuthMiddleware)

router.get('/stats', getStats)
router.get('/venues', getAllVenues)
router.put('/venues/:id/approve', approveVenue)
router.get('/users', getAllUsers)
router.get('/bookings', getAllBookings)
router.put('/venues/:id/suspend', suspendVenue)
router.delete('/venues/:id', deleteVenue)
router.put('/users/:id/ban', banUser)
router.get('/coupons', getAllCoupons)
router.delete('/coupons/:id', adminDeleteCoupon)

export default router
