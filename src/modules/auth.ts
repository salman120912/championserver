import { Context, Next } from "koa"
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-key-that-is-long-and-secure';

interface CustomContext extends Context {
  state: {
    user?: { userId: string; email: string; iat: number; exp: number; }
  };
}

const verifyToken = async (ctx: CustomContext) => {
  try {
    const authHeader = ctx.request.get("Authorization")
    if (!authHeader) {
      ctx.throw(401, "No authorization header")
    }

    const token = authHeader.split(" ")[1]
    if (!token) {
      ctx.throw(401, "No token provided")
    }

    const decoded = jwt.verify(token, JWT_SECRET);
    ctx.state.user = decoded as CustomContext['state']['user'];

  } catch (error: any) {
    console.error("Auth error:", error.message)
    ctx.throw(401, error.message || "Invalid access token")
  }
}

/**
 * Public endpoint with no authentication
 */
export const none = async (_ctx: Context, next: Next) => {
  await next()
}

/**
 * Bearer token required in "Authorization" header
 */
export const required = async (ctx: CustomContext, next: Next) => {
  await verifyToken(ctx)
  if(ctx.status !== 401) {
    await next()
  }
}
