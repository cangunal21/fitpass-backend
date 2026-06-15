import { Router } from 'express'
import { addFavorite, removeFavorite, getFavoriteStatus, getMyFavorites, getUserFavorites } from '../controllers/favoriteController'
import { authMiddleware } from '../middlewares/auth'

const router = Router()

router.get('/my', authMiddleware, getMyFavorites)
router.get('/status/:venueId', authMiddleware, getFavoriteStatus)
router.post('/:venueId', authMiddleware, addFavorite)
router.delete('/:venueId', authMiddleware, removeFavorite)
router.get('/user/:username', getUserFavorites) // public

export default router
