import { registerNumericParams } from '../middlewares/numericParams'
import { Router } from 'express'
import {
  instructorLogin,
  instructorForgotPassword,
  instructorSetPassword,
  getInstructorMe,
  instructorRefresh,
  instructorLogout,
} from '../controllers/instructorAuthController'
import {
  getMyInstructorReviews,
  instructorReplyToReview,
  deleteInstructorReply,
} from '../controllers/reviewController'
import {
  updateInstructorMe,
  createInstructorClass,
  createInstructorSession,
  getMyInstructorClasses,
  checkInInstructorBooking,
} from '../controllers/instructorPortalController'
import { getUploadSignature } from '../controllers/uploadController'
import { instructorAuthMiddleware } from '../middlewares/instructorAuth'

const router = Router()
registerNumericParams(router)

// Public (rate-limit index.ts'te)
router.post('/login', instructorLogin)
router.post('/forgot-password', instructorForgotPassword)
router.post('/set-password', instructorSetPassword) // davet + reset aynı uç
// Access token 1 saat → client sessizce yeniler; çıkışta jeton iptal edilir.
router.post('/refresh', instructorRefresh)
router.post('/logout', instructorLogout)

// Korumalı (instructorAuth). Profil düzenleme + kendi dersleri + kendi öğrencisini check-in.
// GÜVENLİK: hepsi req.instructorId'ye scoped; FİNANS (gelir/komisyon/payout) DÖNMEZ.
router.get('/me', instructorAuthMiddleware, getInstructorMe)
router.put('/me', instructorAuthMiddleware, updateInstructorMe)
router.get('/reviews', instructorAuthMiddleware, getMyInstructorReviews)
router.put('/reviews/:id/reply', instructorAuthMiddleware, instructorReplyToReview)
router.delete('/reviews/:id/reply', instructorAuthMiddleware, deleteInstructorReply)
router.get('/classes', instructorAuthMiddleware, getMyInstructorClasses)
router.post('/classes', instructorAuthMiddleware, createInstructorClass)
router.post('/classes/:classId/sessions', instructorAuthMiddleware, createInstructorSession)
router.post('/checkin', instructorAuthMiddleware, checkInInstructorBooking)
// Görsel yükleme imzası (bkz. controllers/uploadController.ts)
router.post('/upload-signature', instructorAuthMiddleware, getUploadSignature)

export default router
