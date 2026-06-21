import { Router } from 'express'
import {
  followUser, unfollowUser, getFollowStatus, getFollowers, getFollowing,
  getUserLeaderboard, getVenueLeaderboard, getSuggestions, getFeed,
  likeActivity, unlikeActivity, getActivityComments, addActivityComment,
  getNotifications, markNotificationsRead,
} from '../controllers/socialController'
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
router.get('/feed', authMiddleware, getFeed)
router.post('/feed/:feedKey/like', authMiddleware, likeActivity)
router.delete('/feed/:feedKey/like', authMiddleware, unlikeActivity)
router.get('/feed/:feedKey/comments', getActivityComments)
router.post('/feed/:feedKey/comments', authMiddleware, addActivityComment)
router.get('/notifications', authMiddleware, getNotifications)
router.put('/notifications/read', authMiddleware, markNotificationsRead)
export default router
