import { registerNumericParams } from '../middlewares/numericParams'
import { Router } from 'express'
import { createBooking, getMyBookings, cancelBooking, joinDropIn, checkInBooking, checkInDropIn, getTransferOptions, transferBooking } from '../controllers/bookingController'
import { authMiddleware } from '../middlewares/auth'
// E-POSTA DOĞRULAMA KAPISI: yalnız BAŞKASINI ETKİLEYEN / KAYNAK TÜKETEN yazma uçlarında.
// Okuma, iptal, profil ve "kod tekrar gönder" bilerek AÇIK — bkz. middlewares/requireVerified.ts
import { requireVerifiedEmail } from '../middlewares/requireVerified'
import { venueAuthMiddleware, venueApprovedMiddleware } from '../middlewares/venueAuth'

const router = Router()
registerNumericParams(router)

router.post('/', authMiddleware, requireVerifiedEmail, createBooking)
router.get('/my', authMiddleware, getMyBookings)
router.put('/:id/cancel', authMiddleware, cancelBooking)
router.get('/:id/transfer-options', authMiddleware, getTransferOptions)
router.put('/:id/transfer', authMiddleware, transferBooking)
router.post('/dropin/:slotId/join', authMiddleware, requireVerifiedEmail, joinDropIn)
// venueApprovedMiddleware ŞART: venueAuthMiddleware yalnız isActive/isSuspended bakıyor,
// isApproved'a BAKMIYOR. Admin bir salonun onayını geri aldığında (adminController.approveVenue
// yalnız isApproved yazar; isActive true, isSuspended false kalır) salon check-in yapmaya devam
// edebiliyordu: kullanıcıya puan/streak/rozet/tier ilerlemesi veriliyor ve o salona yorum yazma
// kapısı (reviewController: `if (!booking.checkedIn)`) açılıyordu. Yani platformdan kaldırılmış
// salon puan üretmeye devam ediyordu. Eğitmen realm'inde bu kapı ZATEN vardı
// (instructorPortalController: `!iv.isApproved → 403`); asimetri salonun kendi realm'indeydi.
router.post('/checkin', venueAuthMiddleware, venueApprovedMiddleware, checkInBooking)
router.post('/dropin-checkin', venueAuthMiddleware, venueApprovedMiddleware, checkInDropIn)

export default router
