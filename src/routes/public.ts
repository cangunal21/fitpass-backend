import { registerNumericParams } from '../middlewares/numericParams'
import { Router } from 'express'
import {
  getSessions,
  getSessionById,
  getForYouSessions,
  getVenues,
  getVenueById,
  getCategories,
  getDropInSlots,
  getDropInSlotById,
  getNeighborhoods,
  getCities,
  getVenuesList,
  getUserActivities,
  submitComplaint,
  searchUsers,
  getInstructorById,
  getInstructors,
} from '../controllers/publicController'
import { validateCoupon } from '../controllers/couponController'
import { optionalAuthMiddleware } from '../middlewares/auth'

const router = Router()
registerNumericParams(router)

router.get('/sessions', getSessions)
router.get('/for-you', optionalAuthMiddleware, getForYouSessions)
router.get('/sessions/:id', getSessionById)
router.get('/venues', getVenues)
router.get('/venues-list', getVenuesList)
router.get('/venues/:id', getVenueById)
router.get('/categories', getCategories)
router.get('/dropin', getDropInSlots)
router.get('/dropin/:id', getDropInSlotById)
router.get('/neighborhoods', getNeighborhoods)
router.get('/cities', getCities)
router.get('/users/:username', optionalAuthMiddleware, getUserActivities)
router.post('/complaint', submitComplaint)
router.get('/users-search', searchUsers)
// optionalAuthMiddleware: uç herkese açık kalır ama token varsa kullanıcı kimliği dolar →
// validateCoupon kişi-başı limiti ölçebilir (aksi halde "geçerli" der, rezervasyon reddederdi).
router.post('/validate-coupon', optionalAuthMiddleware, validateCoupon)
// Liste ucu, ':id'den ÖNCE tanımlanmalıydı diye düşünülebilir ama Express'te '/instructors' ve
// '/instructors/:id' farklı yollar — çakışma yok.
router.get('/instructors', getInstructors)
router.get('/instructors/:id', optionalAuthMiddleware, getInstructorById)

export default router
