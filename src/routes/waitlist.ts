import { registerNumericParams } from '../middlewares/numericParams'
import { Router } from 'express'
import { joinWaitlist, leaveWaitlist, getWaitlistStatus } from '../controllers/waitlistController'
import { authMiddleware } from '../middlewares/auth'

const router = Router()
registerNumericParams(router)

router.post('/sessions/:sessionId', authMiddleware, joinWaitlist)
router.delete('/sessions/:sessionId', authMiddleware, leaveWaitlist)
router.get('/sessions/:sessionId/status', authMiddleware, getWaitlistStatus)

export default router
