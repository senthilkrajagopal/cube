/**
 * What Cube finds by the type name `tdv`, for a data source's queue (its
 * default concurrency) and, without xcube's `dialectFactory`, its dialect:
 * Cube has no TDV driver, and throws on a type it can't resolve. Registered
 * in Cube's list of types by `drivers.ts`. Cube never makes the driver from
 * it: xcube makes each from its connection.
 */
import { XcubeTdvQuery } from '../model/tdv-dialect';

export default class TdvType {
  public static dialectClass() {
    return XcubeTdvQuery;
  }

  public constructor() {
    throw new Error('A TDV data source is made from its connection (xcube\'s DRIVERS.tdv), never from Cube\'s environment');
  }
}
