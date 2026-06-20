import { Router } from 'express'
import { getReferralInfo } from '../controllers/referralController'
import { authMiddleware } from '../middlewares/auth'

const router = Router()

router.get('/', authMiddleware, getReferralInfo)

export default router
