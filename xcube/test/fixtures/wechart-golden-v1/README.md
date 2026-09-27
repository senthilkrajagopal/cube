# wechart's golden sealing vectors (scheme v1)

Copied from wechart at its commit `b5391da`, so xcube's tests check them without wechart's checkout:

- `golden-v1.json`: `packages/core/src/data-sources/golden-v1.json`;
- `dev-credential-key.pem` and `dev-credential-key.pub.jwk`: `infra/xcube/`, the development key the envelopes are sealed to.

**Development values only.** The key is wechart's compose key, committed there too. It protects nothing, and must never be used outside development and tests.

`test/unit/credentials.test.ts` opens every envelope and compares every binding with `secretAadV1`. When wechart changes the file, copy it again, and the test says whether the two copies of the binding still agree.
