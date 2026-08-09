import { registerNumericParams } from '../middlewares/numericParams'
import { Router } from 'express'
import { getMyVenueReviews } from '../controllers/reviewController'
import {
  venueRegister, venueLogin, getVenueMe, venueForgotPassword, venueResetPassword,
  updateVenueProfile, changeVenuePassword,
  createClass, updateClass, deleteClass,
  createSession, createRecurringSessions, updateSession, deleteSession,
  getVenueBookings,
  createDropInSlot, getVenueDropInSlots, deleteDropInSlot,
  updateVenueImages
} from '../controllers/venueController'
import { createInstructor, getVenueInstructors, updateInstructor, deleteInstructor, inviteInstructor } from '../controllers/instructorController'
import { submitSubMerchant, refreshSubMerchantStatus } from '../controllers/submerchantController'
import { venueAuthMiddleware, venueApprovedMiddleware, venueVerifiedMiddleware } from '../middlewares/venueAuth'
import { createCoupon, getVenueCoupons, deleteCoupon } from '../controllers/couponController'
import { getVenueStats, getVenueRevenue } from '../controllers/statsController'

const router = Router()
registerNumericParams(router)

router.post('/register', venueRegister)
router.post('/login', venueLogin)
router.post('/forgot-password', venueForgotPassword)
router.post('/reset-password', venueResetPassword)
router.get('/me', venueAuthMiddleware, getVenueMe)
router.get('/bookings', venueAuthMiddleware, getVenueBookings)
router.post('/classes', venueAuthMiddleware, venueApprovedMiddleware, venueVerifiedMiddleware, createClass)
router.put('/classes/:id', venueAuthMiddleware, venueApprovedMiddleware, updateClass)
router.post('/classes/:classId/sessions', venueAuthMiddleware, venueApprovedMiddleware, venueVerifiedMiddleware, createSession)
router.post('/classes/:classId/sessions/recurring', venueAuthMiddleware, venueApprovedMiddleware, venueVerifiedMiddleware, createRecurringSessions)
// Alt-üye (ödeme/işyeri bilgileri) onboarding — admin onayı sonrası panelden
router.post('/submerchant', venueAuthMiddleware, venueApprovedMiddleware, submitSubMerchant)
router.post('/submerchant/refresh', venueAuthMiddleware, refreshSubMerchantStatus)
router.get('/instructors', venueAuthMiddleware, getVenueInstructors)
router.post('/instructors', venueAuthMiddleware, venueApprovedMiddleware, createInstructor)
router.put('/instructors/:id', venueAuthMiddleware, venueApprovedMiddleware, updateInstructor)
router.delete('/instructors/:id', venueAuthMiddleware, venueApprovedMiddleware, deleteInstructor)
router.post('/instructors/:id/invite', venueAuthMiddleware, venueApprovedMiddleware, inviteInstructor)
router.get('/dropin', venueAuthMiddleware, getVenueDropInSlots)
router.post('/dropin', venueAuthMiddleware, venueApprovedMiddleware, venueVerifiedMiddleware, createDropInSlot)
// SİLME uçlarında onay kapısı BİLEREK YOK: onayı kaldırılan salon kendi dersini/seansını iptal
// edebilmeli — aksi halde müşteriler rezervasyonlarıyla ortada kalır (silme müşteriye iptal+iade
// bildirimi gönderir, bu istenen davranış).
router.delete('/classes/:id', venueAuthMiddleware, deleteClass)
// GÜNCELLEME ise farklı: kardeş uçların (createClass/updateClass/createSession/createRecurring)
// hepsinde venueApprovedMiddleware var, burada UNUTULMUŞTU. Onayı kaldırılmış bir salon seans
// saatini değiştirip rezervasyonlu müşterilere 3 kanaldan (in-app + push + e-posta) bildirim
// göndermeye devam edebiliyordu. Değiştirme = yeni taahhüt → onay gerekir.
router.put('/classes/:classId/sessions/:sessionId', venueAuthMiddleware, venueApprovedMiddleware, updateSession)
router.delete('/classes/:classId/sessions/:sessionId', venueAuthMiddleware, deleteSession)
router.delete('/dropin/:id', venueAuthMiddleware, deleteDropInSlot)
router.put('/images', venueAuthMiddleware, updateVenueImages)
router.put('/profile', venueAuthMiddleware, updateVenueProfile)
router.put('/change-password', venueAuthMiddleware, changeVenuePassword)
router.get('/stats', venueAuthMiddleware, getVenueStats)
router.get('/revenue', venueAuthMiddleware, getVenueRevenue)
router.get('/coupons', venueAuthMiddleware, getVenueCoupons)
// Salonun KENDİ yorumları — public uçtan farkı: salon kendi ÖZEL yanıtını da görür.
router.get('/reviews', venueAuthMiddleware, getMyVenueReviews)
router.post('/coupons', venueAuthMiddleware, venueApprovedMiddleware, createCoupon)
router.delete('/coupons/:id', venueAuthMiddleware, deleteCoupon)

export default router
