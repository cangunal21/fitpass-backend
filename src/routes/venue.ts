import { Router } from 'express'
import {
  venueRegister, venueLogin, getVenueMe,
  createClass, updateClass, deleteClass,
  createSession, createRecurringSessions, updateSession, deleteSession,
  getVenueBookings,
  createDropInSlot, getVenueDropInSlots, deleteDropInSlot,
  updateVenueImages
} from '../controllers/venueController'
import { createInstructor, getVenueInstructors, updateInstructor } from '../controllers/instructorController'
import { venueAuthMiddleware, venueApprovedMiddleware } from '../middlewares/venueAuth'
import { createCoupon, getVenueCoupons, deleteCoupon } from '../controllers/couponController'
import { getVenueStats } from '../controllers/statsController'

const router = Router()

router.post('/register', venueRegister)
router.post('/login', venueLogin)
router.get('/me', venueAuthMiddleware, getVenueMe)
router.get('/bookings', venueAuthMiddleware, getVenueBookings)
router.post('/classes', venueAuthMiddleware, venueApprovedMiddleware, createClass)
router.put('/classes/:id', venueAuthMiddleware, venueApprovedMiddleware, updateClass)
router.post('/classes/:classId/sessions', venueAuthMiddleware, venueApprovedMiddleware, createSession)
router.post('/classes/:classId/sessions/recurring', venueAuthMiddleware, venueApprovedMiddleware, createRecurringSessions)
router.get('/instructors', venueAuthMiddleware, getVenueInstructors)
router.post('/instructors', venueAuthMiddleware, venueApprovedMiddleware, createInstructor)
router.put('/instructors/:id', venueAuthMiddleware, venueApprovedMiddleware, updateInstructor)
router.get('/dropin', venueAuthMiddleware, getVenueDropInSlots)
router.post('/dropin', venueAuthMiddleware, venueApprovedMiddleware, createDropInSlot)
router.delete('/classes/:id', venueAuthMiddleware, deleteClass)
router.put('/classes/:classId/sessions/:sessionId', venueAuthMiddleware, updateSession)
router.delete('/classes/:classId/sessions/:sessionId', venueAuthMiddleware, deleteSession)
router.delete('/dropin/:id', venueAuthMiddleware, deleteDropInSlot)
router.put('/images', venueAuthMiddleware, updateVenueImages)
router.get('/stats', venueAuthMiddleware, getVenueStats)
router.get('/coupons', venueAuthMiddleware, getVenueCoupons)
router.post('/coupons', venueAuthMiddleware, venueApprovedMiddleware, createCoupon)
router.delete('/coupons/:id', venueAuthMiddleware, deleteCoupon)

export default router
