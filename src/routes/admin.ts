import { registerNumericParams } from '../middlewares/numericParams'
import { Router } from 'express'
import { getStats, getAllVenues, approveVenue, getAllUsers, getAllBookings, suspendVenue, deleteVenue, banUser, getAllCoupons, adminDeleteCoupon, getCategories, createCategory, deleteCategory, updateCategory, getPendingVenueImages, reviewVenueImages, getAllInstructors, verifyInstructor } from '../controllers/adminController'
import { getReports, resolveReport } from '../controllers/reportController'
import { adminAuthMiddleware } from '../middlewares/adminAuth'

const router = Router()
registerNumericParams(router)

router.use(adminAuthMiddleware)

router.get('/stats', getStats)
router.get('/venues', getAllVenues)
router.put('/venues/:id/approve', approveVenue)
router.get('/venue-images/pending', getPendingVenueImages)
router.put('/venue-images/:id/review', reviewVenueImages)
router.get('/reports', getReports)
router.put('/reports/:id/resolve', resolveReport)
router.get('/users', getAllUsers)
router.get('/bookings', getAllBookings)
router.put('/venues/:id/suspend', suspendVenue)
router.delete('/venues/:id', deleteVenue)
router.put('/users/:id/ban', banUser)
router.get('/coupons', getAllCoupons)
router.delete('/coupons/:id', adminDeleteCoupon)
router.get('/categories', getCategories)
router.post('/categories', createCategory)
router.put('/categories/:id', updateCategory)
router.delete('/categories/:id', deleteCategory)
router.get('/instructors', getAllInstructors)
router.put('/instructors/:id/verify', verifyInstructor)

export default router
