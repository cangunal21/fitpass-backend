import { Router } from 'express'
import {
  getSessions,
  getSessionById,
  getVenues,
  getVenueById,
  getCategories,
} from '../controllers/publicController'

const router = Router()

router.get('/sessions', getSessions)
router.get('/sessions/:id', getSessionById)
router.get('/venues', getVenues)
router.get('/venues/:id', getVenueById)
router.get('/categories', getCategories)

export default router
