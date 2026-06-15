import { Request, Response } from 'express'
import prisma from '../utils/prisma'

export const followUser = async (req: Request, res: Response) => {
  try {
    const followerId = (req as any).userId
    const { username } = req.params
    const target = await prisma.user.findUnique({ where: { username }, select: { id: true } })
    if (!target) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' })
    if (target.id === followerId) return res.status(400).json({ error: 'Kendinizi takip edemezsiniz.' })

    const existing = await prisma.follow.findUnique({ where: { followerId_followingId: { followerId, followingId: target.id } } })
    if (existing) return res.status(400).json({ error: 'Zaten takip ediyorsunuz.' })

    await prisma.follow.create({ data: { followerId, followingId: target.id, status: 'accepted' } })
    return res.json({ message: 'Takip edildi.' })
  } catch (err) { return res.status(500).json({ error: 'Sunucu hatası.' }) }
}

export const unfollowUser = async (req: Request, res: Response) => {
  try {
    const followerId = (req as any).userId
    const { username } = req.params
    const target = await prisma.user.findUnique({ where: { username }, select: { id: true } })
    if (!target) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' })

    await prisma.follow.deleteMany({ where: { followerId, followingId: target.id } })
    return res.json({ message: 'Takip bırakıldı.' })
  } catch (err) { return res.status(500).json({ error: 'Sunucu hatası.' }) }
}

export const getFollowStatus = async (req: Request, res: Response) => {
  try {
    const followerId = (req as any).userId
    const { username } = req.params
    const target = await prisma.user.findUnique({ where: { username }, select: { id: true } })
    if (!target) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' })

    const follow = await prisma.follow.findUnique({ where: { followerId_followingId: { followerId, followingId: target.id } } })
    const followers = await prisma.follow.count({ where: { followingId: target.id } })
    const following = await prisma.follow.count({ where: { followerId: target.id } })
    return res.json({ isFollowing: !!follow, followers, following })
  } catch (err) { return res.status(500).json({ error: 'Sunucu hatası.' }) }
}

export const getFollowers = async (req: Request, res: Response) => {
  try {
    const { username } = req.params
    const user = await prisma.user.findUnique({ where: { username }, select: { id: true } })
    if (!user) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' })

    const follows = await prisma.follow.findMany({
      where: { followingId: user.id },
      include: { follower: { select: { id: true, username: true, fullName: true, avatarUrl: true, tier: { select: { name: true, colorHex: true, iconUrl: true } } } } }
    })
    return res.json({ followers: follows.map(f => f.follower) })
  } catch (err) { return res.status(500).json({ error: 'Sunucu hatası.' }) }
}

export const getFollowing = async (req: Request, res: Response) => {
  try {
    const { username } = req.params
    const user = await prisma.user.findUnique({ where: { username }, select: { id: true } })
    if (!user) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' })

    const follows = await prisma.follow.findMany({
      where: { followerId: user.id },
      include: { following: { select: { id: true, username: true, fullName: true, avatarUrl: true, tier: { select: { name: true, colorHex: true, iconUrl: true } } } } }
    })
    return res.json({ following: follows.map(f => f.following) })
  } catch (err) { return res.status(500).json({ error: 'Sunucu hatası.' }) }
}
