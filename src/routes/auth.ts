import { Router } from 'express'
import { register, login, getMe, changePassword, forgotPassword, resetPassword } from '../controllers/authController'
import { authMiddleware } from '../middlewares/auth'

const router = Router()

router.post('/register', register)
router.post('/login', login)
router.get('/me', authMiddleware, getMe)
router.put('/change-password', authMiddleware, changePassword)
router.post('/forgot-password', forgotPassword)
router.post('/reset-password', resetPassword)

export default router
