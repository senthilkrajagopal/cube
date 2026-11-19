/**
 * What Cube finds by the type name `teradata`, for a data source's queue (its
 * default concurrency) and, without xcube's `dialectFactory`, its dialect:
 * Cube has no Teradata driver, and throws on a type it can't resolve. Registered
 * in Cube's list of types by `drivers.ts`. Cube never makes the driver from
 * it: xcube makes each from its connection.
 */
import { XcubeTeradataQuery } from '../model/teradata-dialect';

export default class TeradataType {
  public static dialectClass() {
    return XcubeTeradataQuery;
  }

  public constructor() {
    throw new Error('A Teradata data source is made from its connection (xcube\'s DRIVERS.teradata), never from Cube\'s environment');
  }
}
