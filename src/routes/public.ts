import { Router } from 'express'
import {
  getSessions,
  getSessionById,
  getVenues,
  getVenueById,
  getCategories,
  getDropInSlots,
  getDropInSlotById,
  getNeighborhoods,
  getVenuesList,
  getUserActivities,
  submitComplaint,
} from '../controllers/publicController'

const router = Router()

router.get('/sessions', getSessions)
router.get('/sessions/:id', getSessionById)
router.get('/venues', getVenues)
router.get('/venues-list', getVenuesList)
router.get('/venues/:id', getVenueById)
router.get('/categories', getCategories)
router.get('/dropin', getDropInSlots)
router.get('/dropin/:id', getDropInSlotById)
router.get('/neighborhoods', getNeighborhoods)
router.get('/users/:username', getUserActivities)
router.post('/complaint', submitComplaint)

export default router
