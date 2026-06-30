import jwt from 'jsonwebtoken'

const JWT_SECRET = process.env.JWT_SECRET || 'fitpass-secret-key-change-in-production'
const JWT_EXPIRES_IN = '30d'

export const generateToken = (payload: { userId?: number; venueId?: number; email: string; role?: string }) => {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN })
}

export const verifyToken = (token: string) => {
  return jwt.verify(token, JWT_SECRET) as { userId?: number; venueId?: number; email: string; role?: string }
}
