import { registerNumericParams } from '../middlewares/numericParams'
import { Router } from 'express'
import { sendReminders, imhaEt } from '../controllers/cronController'

const router = Router()
registerNumericParams(router)
router.get('/reminders', sendReminders)
// Saklama süresi dolan kayıtların imhası (Gizlilik Politikası Bölüm 7 + 11.3).
router.post('/imha', imhaEt)

export default router
