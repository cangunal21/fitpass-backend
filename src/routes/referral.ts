import { registerNumericParams } from '../middlewares/numericParams'
import { Router } from 'express'
import { getReferralInfo } from '../controllers/referralController'
import { authMiddleware } from '../middlewares/auth'

const router = Router()
registerNumericParams(router)

router.get('/', authMiddleware, getReferralInfo)

export default router
