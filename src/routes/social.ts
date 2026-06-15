import { Router } from 'express'
import { followUser, unfollowUser, getFollowStatus, getFollowers, getFollowing } from '../controllers/socialController'
import { authMiddleware } from '../middlewares/auth'

const router = Router()
router.post('/follow/:username', authMiddleware, followUser)
router.delete('/unfollow/:username', authMiddleware, unfollowUser)
router.get('/status/:username', authMiddleware, getFollowStatus)
router.get('/followers/:username', getFollowers)
router.get('/following/:username', getFollowing)
export default router
