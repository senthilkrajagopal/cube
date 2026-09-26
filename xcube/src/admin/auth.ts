import crypto from 'crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

import type { TokenVerifier } from '../security/verifier';

function digest(token: string): Buffer {
  return crypto.createHash('sha256').update(token, 'utf8').digest();
}

/**
 * Authentication for the admin routes: the service credential (an RS256
 * token signed by a configured service key, `aud` the service audience,
 * `role: service`), or a bearer token from a list, so an old and a new
 * token both work during a rotation. Every configured token is compared, in
 * constant time. A user's token is refused here, as an admin token is on
 * Cube's own routes.
 */
export function adminAuth(tokens: string[], verifier?: TokenVerifier): RequestHandler {
  const digests = tokens.map(digest);

  return (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization || '';
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    let ok = false;
    let model: string | undefined;
    if (match) {
      const given = digest(match[1]);
      for (const expected of digests) {
        // No early exit: the time taken doesn't depend on which token matched.
        ok = crypto.timingSafeEqual(given, expected) || ok;
      }
      if (!ok && verifier?.serviceConfigured && match[1].split('.').length === 3) {
        try {
          ({ model } = verifier.verifyServiceToken(match[1]));
          ok = true;
        } catch {
          ok = false;
        }
      }
    }
    if (!ok) {
      res.status(401).set('WWW-Authenticate', 'Bearer realm="xcube"').json({
        error: 'The service credential or an xcube admin token is required',
        code: 'unauthorized',
      });
      return;
    }
    if (model !== undefined && req.params.model !== model) {
      // A service token naming a model is for that model alone: not another's, nor the routes of every model.
      res.status(403).json({ error: `This service token is for model "${model}"`, code: 'forbidden' });
      return;
    }
    next();
  };
}
