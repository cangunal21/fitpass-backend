import { registerNumericParams } from '../middlewares/numericParams'
import { Router } from 'express'
import { getStats, getAllVenues, approveVenue, getAllUsers, getAllBookings, suspendVenue, deleteVenue, banUser, getCategories, createCategory, deleteCategory, updateCategory, getPendingVenueImages, reviewVenueImages, getAllInstructors, verifyInstructor, approveInstructor, getComplaints, resolveComplaint , getVenueEvents, getVenueRetention, getPlatformAnalytics, getSeansGeriBildirim } from '../controllers/adminController'
import { getReports, resolveReport } from '../controllers/reportController'
import { adminAuthMiddleware } from '../middlewares/adminAuth'

const router = Router()
registerNumericParams(router)

router.use(adminAuthMiddleware)

router.get('/stats', getStats)
// SATICI İZLEME (26 Ağu 2026): platform bugüne dek yalnız son durumu biliyordu.
router.get('/venue-events', getVenueEvents)
router.get('/venue-retention', getVenueRetention)
router.get('/platform-analytics', getPlatformAnalytics)
// Gizli seans geri bildirimi — YALNIZ yönetici; hiçbir public/salon ucundan dönmez.
router.get('/seans-geri-bildirim', getSeansGeriBildirim)
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
router.get('/categories', getCategories)
router.post('/categories', createCategory)
router.put('/categories/:id', updateCategory)
router.delete('/categories/:id', deleteCategory)
router.get('/instructors', getAllInstructors)
router.put('/instructors/:id/verify', verifyInstructor)
// Mekânsız (bireysel) eğitmenin YAYIN onayı — `verify` (mavi tik) ile ayrı şey.
router.put('/instructors/:id/approve', approveInstructor)
router.get('/complaints', getComplaints)
router.put('/complaints/:id/resolve', resolveComplaint)

export default router
