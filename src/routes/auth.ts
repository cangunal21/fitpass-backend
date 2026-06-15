import { Router } from 'express'
import { register, login, getMe, getMyBookingsAuth, changePassword, forgotPassword, resetPassword, updatePrivacy, updateProfile } from '../controllers/authController'
import { authMiddleware } from '../middlewares/auth'

const router = Router()

router.post('/register', register)
router.post('/login', login)
router.get('/me', authMiddleware, getMe)
router.get('/my-bookings', authMiddleware, getMyBookingsAuth)
router.put('/change-password', authMiddleware, changePassword)
router.post('/forgot-password', forgotPassword)
router.post('/reset-password', resetPassword)
router.put('/privacy', authMiddleware, updatePrivacy)
router.put('/profile', authMiddleware, updateProfile)

export default router
