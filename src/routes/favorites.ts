import { registerNumericParams } from '../middlewares/numericParams'
import { Router } from 'express'
import { addFavorite, removeFavorite, getFavoriteStatus, getMyFavorites, getUserFavorites } from '../controllers/favoriteController'
import { authMiddleware } from '../middlewares/auth'

const router = Router()
registerNumericParams(router)

router.get('/my', authMiddleware, getMyFavorites)
router.get('/status/:venueId', authMiddleware, getFavoriteStatus)
router.post('/:venueId', authMiddleware, addFavorite)
router.delete('/:venueId', authMiddleware, removeFavorite)
router.get('/user/:username', getUserFavorites) // public

export default router
