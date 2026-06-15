import { Router } from 'express'
import { followUser, unfollowUser, getFollowStatus, getFollowers, getFollowing, getUserLeaderboard, getVenueLeaderboard, getSuggestions } from '../controllers/socialController'
import { authMiddleware } from '../middlewares/auth'

const router = Router()
router.post('/follow/:username', authMiddleware, followUser)
router.delete('/unfollow/:username', authMiddleware, unfollowUser)
router.get('/status/:username', authMiddleware, getFollowStatus)
router.get('/followers/:username', getFollowers)
router.get('/following/:username', getFollowing)
router.get('/leaderboard/users', getUserLeaderboard)
router.get('/leaderboard/venues', getVenueLeaderboard)
router.get('/suggestions', authMiddleware, getSuggestions)
export default router
