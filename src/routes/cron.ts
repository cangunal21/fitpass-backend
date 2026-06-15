import { Router } from 'express'
import { sendReminders } from '../controllers/cronController'

const router = Router()
router.get('/reminders', sendReminders)

export default router
