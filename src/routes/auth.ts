import { registerNumericParams } from '../middlewares/numericParams'
import { Router } from 'express'
import { register, login, getMe, changePassword, forgotPassword, resetPassword, updatePrivacy, updateProfile, updateNotificationSettings, verifyEmail, resendVerification, registerPushToken, deleteAccount } from '../controllers/authController'
import { authMiddleware } from '../middlewares/auth'

const router = Router()
registerNumericParams(router)

router.post('/register', register)
router.post('/login', login)
router.get('/me', authMiddleware, getMe)
router.put('/change-password', authMiddleware, changePassword)
router.post('/forgot-password', forgotPassword)
router.post('/reset-password', resetPassword)
router.put('/privacy', authMiddleware, updatePrivacy)
router.put('/profile', authMiddleware, updateProfile)
router.put('/notifications', authMiddleware, updateNotificationSettings)
router.post('/verify-email', verifyEmail)
router.post('/resend-verification', authMiddleware, resendVerification)
router.post('/push-token', authMiddleware, registerPushToken)
router.delete('/account', authMiddleware, deleteAccount)

export default router
