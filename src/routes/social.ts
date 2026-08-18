import { registerNumericParams } from '../middlewares/numericParams'
import { Router } from 'express'
import {
  followUser, unfollowUser, getFollowStatus, getFollowers, getFollowing,
  acceptFollowRequest, rejectFollowRequest, getFollowRequests,
  getUserLeaderboard, getVenueLeaderboard, getStreakLeaderboard, getSuggestions, getFeed,
  likeActivity, unlikeActivity, getActivityComments, addActivityComment,
  deleteActivityComment,
  getNotifications, markNotificationsRead, getMyCalendar,
} from '../controllers/socialController'
import { reportUser } from '../controllers/reportController'
import { authMiddleware, optionalAuthMiddleware } from '../middlewares/auth'
// E-POSTA DOĞRULAMA KAPISI: yalnız BAŞKASINI ETKİLEYEN / KAYNAK TÜKETEN yazma uçlarında.
// Okuma, iptal, profil ve "kod tekrar gönder" bilerek AÇIK — bkz. middlewares/requireVerified.ts
import { requireVerifiedEmail } from '../middlewares/requireVerified'

const router = Router()
registerNumericParams(router)
router.post('/follow/:username', authMiddleware, requireVerifiedEmail, followUser)
router.delete('/unfollow/:username', authMiddleware, unfollowUser)
router.get('/follow-requests', authMiddleware, getFollowRequests)
router.post('/follow-requests/:username/accept', authMiddleware, acceptFollowRequest)
router.post('/follow-requests/:username/reject', authMiddleware, rejectFollowRequest)
router.get('/status/:username', authMiddleware, getFollowStatus)
router.get('/followers/:username', optionalAuthMiddleware, getFollowers)
router.get('/following/:username', optionalAuthMiddleware, getFollowing)
router.get('/leaderboard/users', getUserLeaderboard)
router.get('/leaderboard/venues', getVenueLeaderboard)
router.get('/leaderboard/streaks', getStreakLeaderboard)
router.get('/my-calendar', authMiddleware, getMyCalendar)
router.get('/suggestions', authMiddleware, getSuggestions)
router.get('/feed', authMiddleware, getFeed)
router.post('/feed/:feedKey/like', authMiddleware, requireVerifiedEmail, likeActivity)
router.delete('/feed/:feedKey/like', authMiddleware, unlikeActivity)
router.get('/feed/:feedKey/comments', optionalAuthMiddleware, getActivityComments)
router.post('/feed/:feedKey/comments', authMiddleware, requireVerifiedEmail, addActivityComment)
// Yorum silme: yazar VEYA aktivite sahibi (yetki kontrolu controller'da; yetkisizde 404)
router.delete('/comments/:commentId', authMiddleware, deleteActivityComment)
router.get('/notifications', authMiddleware, getNotifications)
router.put('/notifications/read', authMiddleware, markNotificationsRead)
router.post('/report', authMiddleware, requireVerifiedEmail, reportUser)
export default router
