import { registerNumericParams } from '../middlewares/numericParams'
import { Router } from 'express'
import { sendReminders } from '../controllers/cronController'

const router = Router()
registerNumericParams(router)
router.get('/reminders', sendReminders)

export default router
