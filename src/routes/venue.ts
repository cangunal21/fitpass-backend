import { Router } from 'express'
import {
  venueRegister, venueLogin, getVenueMe,
  createClass, updateClass, createSession, getVenueBookings
} from '../controllers/venueController'
import { venueAuthMiddleware } from '../middlewares/venueAuth'

const router = Router()

router.post('/register', venueRegister)
router.post('/login', venueLogin)
router.get('/me', venueAuthMiddleware, getVenueMe)
router.get('/bookings', venueAuthMiddleware, getVenueBookings)
router.post('/classes', venueAuthMiddleware, createClass)
router.put('/classes/:id', venueAuthMiddleware, updateClass)
router.post('/classes/:classId/sessions', venueAuthMiddleware, createSession)

export default router
