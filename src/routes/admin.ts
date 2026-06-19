import { Router } from 'express'
import { getStats, getAllVenues, approveVenue, getAllUsers, getAllBookings, suspendVenue, deleteVenue, banUser, getAllCoupons, adminDeleteCoupon, getCategories, createCategory, deleteCategory } from '../controllers/adminController'
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
router.get('/categories', getCategories)
router.post('/categories', createCategory)
router.delete('/categories/:id', deleteCategory)

export default router
