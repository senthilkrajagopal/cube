/**
 * What Cube finds by the type name `impala`, which it looks up for a data
 * source's queue (its default concurrency) and, without xcube's
 * `dialectFactory`, its dialect: Cube has no Impala driver, and throws on a
 * type it can't resolve. Registered in Cube's list of types by `drivers.ts`.
 * Cube never makes the driver from it: xcube makes each from its connection.
 */
import { XcubeImpalaQuery } from '../model/impala-dialect';

export default class ImpalaType {
  public static dialectClass() {
    return XcubeImpalaQuery;
  }

  public constructor() {
    throw new Error('An Impala data source is made from its connection (xcube\'s DRIVERS.impala), never from Cube\'s environment');
  }
}
