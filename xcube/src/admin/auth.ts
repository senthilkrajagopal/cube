import crypto from 'crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

function digest(token: string): Buffer {
  return crypto.createHash('sha256').update(token, 'utf8').digest();
}

/**
 * Bearer-token authentication for the admin routes, against a list, so an
 * old and a new token both work during a rotation. Every configured token is
 * compared, in constant time. A Cube JWT is just an unknown token here, and
 * an admin token is no JWT for Cube's own routes.
 */
export function adminAuth(tokens: string[]): RequestHandler {
  const digests = tokens.map(digest);

  return (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization || '';
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    let ok = false;
    if (match) {
      const given = digest(match[1]);
      for (const expected of digests) {
        // No early exit: the time taken doesn't depend on which token matched.
        ok = crypto.timingSafeEqual(given, expected) || ok;
      }
    }
    if (!ok) {
      res.status(401).set('WWW-Authenticate', 'Bearer realm="xcube"').json({
        error: 'A valid xcube admin token is required',
        code: 'unauthorized',
      });
      return;
    }
    next();
  };
}
