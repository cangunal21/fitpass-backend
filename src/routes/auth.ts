import { registerNumericParams } from '../middlewares/numericParams'
import { Router } from 'express'
import { register, login, getMe, changePassword, forgotPassword, resetPassword, updatePrivacy, updateProfile, updateNotificationSettings, verifyEmail, verifyEmailCode, resendVerification, registerPushToken, deleteAccount, refreshAccessToken, logout } from '../controllers/authController'
import { authMiddleware } from '../middlewares/auth'
import { getUploadSignature } from '../controllers/uploadController'
import { requireVerifiedEmail } from '../middlewares/requireVerified'

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
//
// DOĞRULAMA KAPISI (15 Ağu 2026): bu uç, middlewares/requireVerified.ts'in KENDİ ölçütüne
// göre kapı içinde olmalı — "başkasını etkileyen ya da KAYNAK TÜKETEN yazma uçları". İmzalı
// yükleme doğrudan Cloudinary kotamızı harcıyor: doğrulanmamış (başkasının e-postasıyla açılmış)
// hesaplar toplu kayıtla gigabaytlarca görsel yükleyebilirdi. Klasör kapsamı zaten sızıntıyı
// engelliyordu, ama KOTA TÜKETİMİNİ engellemiyordu.
//
// Kullanıcı mağdur olmuyor: doğrulama kodu 15 dk geçerli ve "tekrar gönder" ucu kapının DIŞINDA
// (satır 25) — yani kodu ulaşmayan kullanıcı yine de kendini doğrulayabiliyor, sonra yükleyebiliyor.
// SALON/EĞİTMEN uçlarına aynı kapı KONULMADI: onlar onaya girebilmek için görsel yüklemek
// zorunda; orada kapı tavuk-yumurta olurdu.
router.post('/upload-signature', authMiddleware, requireVerifiedEmail, getUploadSignature)
router.post('/push-token', authMiddleware, registerPushToken)
router.delete('/account', authMiddleware, deleteAccount)

export default router
