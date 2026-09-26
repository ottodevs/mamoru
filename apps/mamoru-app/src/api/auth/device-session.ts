import type { Context } from 'hono'
import { getSignedCookie, setSignedCookie } from 'hono/cookie'
import type { Db } from '../env.ts'
import type { ProductAuthPort, ProductSession } from './port.ts'

// Sprint candidate for ProductAuthPort: an anonymous device session, HMAC-SHA256 signed cookie.
// Open line 1 (Better Auth) stays open: this candidate has no recovery method (FR-ONB-002).

export const SESSION_COOKIE = 'mamoru_session'
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60
const COOKIE_PREFIX = 'host' as const
const USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export class DeviceSessionAuth implements ProductAuthPort {
  constructor(
    private readonly db: Db,
    private readonly secret: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async current(c: Context): Promise<ProductSession | null> {
    const raw = await getSignedCookie(c, this.secret, SESSION_COOKIE, COOKIE_PREFIX)
    if (!raw) return null
    const [userId, issued] = raw.split(':')
    if (!userId || !USER_ID.test(userId) || !issued || !/^\d+$/.test(issued)) return null
    const age = Math.floor(this.now().getTime() / 1000) - Number(issued)
    if (age < 0 || age > SESSION_TTL_SECONDS) return null
    const row = await this.db.prepare('SELECT user_id, email FROM users WHERE user_id = ?').bind(userId).first<{ user_id: string; email: string | null }>()
    if (!row) return null
    return row.email ? { userId: row.user_id, email: row.email } : { userId: row.user_id }
  }

  async ensure(c: Context): Promise<ProductSession> {
    const existing = await this.current(c)
    if (existing) return existing
    const now = this.now()
    const userId = crypto.randomUUID()
    await this.db.prepare('INSERT INTO users (user_id, email, created_at) VALUES (?, NULL, ?)').bind(userId, now.toISOString()).run()
    await setSignedCookie(c, SESSION_COOKIE, `${userId}:${Math.floor(now.getTime() / 1000)}`, this.secret, {
      prefix: COOKIE_PREFIX,
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      maxAge: SESSION_TTL_SECONDS,
    })
    return { userId }
  }
}
