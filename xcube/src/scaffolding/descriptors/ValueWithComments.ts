// Vendored from @cubejs-backend/schema-compiler 1.7.45 (src/scaffolding),
// Copyright Cube Dev, Inc., Apache-2.0, and changed: see ../../NOTICE.
export class ValueWithComments {
  public constructor(
    public readonly value: any,
    public readonly comments: string[]
  ) {
  }
}
