import { registerNumericParams } from '../middlewares/numericParams'
import { Router } from 'express'
import { register, login, getMe, changePassword, forgotPassword, resetPassword, updatePrivacy, updateProfile, updateNotificationSettings, verifyEmail, verifyEmailCode, resendVerification, registerPushToken, deleteAccount, refreshAccessToken, logout } from '../controllers/authController'
import { authMiddleware } from '../middlewares/auth'
import { getUploadSignature } from '../controllers/uploadController'

const router = Router()
registerNumericParams(router)

router.post('/register', register)
router.post('/login', login)
router.post('/refresh', refreshAccessToken)
router.post('/logout', logout)
router.get('/me', authMiddleware, getMe)
router.put('/change-password', authMiddleware, changePassword)
router.post('/forgot-password', forgotPassword)
router.post('/reset-password', resetPassword)
router.put('/privacy', authMiddleware, updatePrivacy)
router.put('/profile', authMiddleware, updateProfile)
router.put('/notifications', authMiddleware, updateNotificationSettings)
router.post('/verify-email', verifyEmail) // eski link akışı (yolda kalmış e-postalar için)
// KAYIT AKIŞININ İKİNCİ ADIMI — 6 haneli kod. authMiddleware'li: kullanıcı kendi hesabını
// doğruluyor, e-posta gövdede taşınmıyor (enumerasyon yüzeyi yok).
router.post('/verify-code', authMiddleware, verifyEmailCode)
router.post('/resend-verification', authMiddleware, resendVerification)
// GÖRSEL YÜKLEME İMZASI — bkz. controllers/uploadController.ts. Üç realm'de de var; klasörü
// sunucu belirlediği için her hesap yalnız kendi klasörüne yükleyebilir.
router.post('/upload-signature', authMiddleware, getUploadSignature)
router.post('/push-token', authMiddleware, registerPushToken)
router.delete('/account', authMiddleware, deleteAccount)

export default router
