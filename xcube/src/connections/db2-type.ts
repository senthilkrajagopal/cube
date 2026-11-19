/**
 * What Cube finds by the type name `db2`, for a data source's queue (its
 * default concurrency) and, without xcube's `dialectFactory`, its dialect:
 * Cube has no Db2 driver, and throws on a type it can't resolve. Registered
 * in Cube's list of types by `drivers.ts`. Cube never makes the driver from
 * it: xcube makes each from its connection.
 */
import { XcubeDb2Query } from '../model/db2-dialect';

export default class Db2Type {
  public static dialectClass() {
    return XcubeDb2Query;
  }

  public constructor() {
    throw new Error('A Db2 data source is made from its connection (xcube\'s DRIVERS.db2), never from Cube\'s environment');
  }
}
