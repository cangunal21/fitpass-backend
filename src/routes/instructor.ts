import { registerNumericParams } from '../middlewares/numericParams'
import { Router } from 'express'
import {
  instructorLogin,
  instructorForgotPassword,
  instructorSetPassword,
  getInstructorMe,
} from '../controllers/instructorAuthController'
import {
  getMyInstructorReviews,
  instructorReplyToReview,
  deleteInstructorReply,
} from '../controllers/reviewController'
import { instructorAuthMiddleware } from '../middlewares/instructorAuth'

const router = Router()
registerNumericParams(router)

// Public (rate-limit index.ts'te)
router.post('/login', instructorLogin)
router.post('/forgot-password', instructorForgotPassword)
router.post('/set-password', instructorSetPassword) // davet + reset aynı uç

// Korumalı (instructorAuth) — FİNANS/CHECK-IN ucu YOK
router.get('/me', instructorAuthMiddleware, getInstructorMe)
router.get('/reviews', instructorAuthMiddleware, getMyInstructorReviews)
router.put('/reviews/:id/reply', instructorAuthMiddleware, instructorReplyToReview)
router.delete('/reviews/:id/reply', instructorAuthMiddleware, deleteInstructorReply)

export default router
