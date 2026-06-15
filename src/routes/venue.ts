import { Router } from 'express'
import {
  venueRegister, venueLogin, getVenueMe,
  createClass, updateClass, createSession, getVenueBookings,
  createDropInSlot, getVenueDropInSlots
} from '../controllers/venueController'
import { createInstructor, getVenueInstructors, updateInstructor } from '../controllers/instructorController'
import { venueAuthMiddleware, venueApprovedMiddleware } from '../middlewares/venueAuth'

const router = Router()

router.post('/register', venueRegister)
router.post('/login', venueLogin)
router.get('/me', venueAuthMiddleware, getVenueMe)
router.get('/bookings', venueAuthMiddleware, getVenueBookings)
router.post('/classes', venueAuthMiddleware, venueApprovedMiddleware, createClass)
router.put('/classes/:id', venueAuthMiddleware, venueApprovedMiddleware, updateClass)
router.post('/classes/:classId/sessions', venueAuthMiddleware, venueApprovedMiddleware, createSession)
router.get('/instructors', venueAuthMiddleware, getVenueInstructors)
router.post('/instructors', venueAuthMiddleware, venueApprovedMiddleware, createInstructor)
router.put('/instructors/:id', venueAuthMiddleware, venueApprovedMiddleware, updateInstructor)
router.get('/dropin', venueAuthMiddleware, getVenueDropInSlots)
router.post('/dropin', venueAuthMiddleware, venueApprovedMiddleware, createDropInSlot)

export default router
