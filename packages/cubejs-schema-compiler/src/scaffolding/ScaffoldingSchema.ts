import inflection from 'inflection';
import R from 'ramda';
import { notEmpty } from '@cubejs-backend/shared';
import { UserError } from '../compiler';
import { toSnakeCase } from './utils';

export enum ColumnType {
  Time = 'time',
  Number = 'number',
  String = 'string',
  Boolean = 'boolean',
}

/**
 * The Cube type scaffolding gives a column of this data source type, from the
 * type's name alone.
 */
export function columnTypeOf(dataType: string): ColumnType {
  const type = dataType.toLowerCase();

  if (['time', 'date'].find(t => type.includes(t))) {
    return ColumnType.Time;
  } else if ([
    'int', // integer, bigint, smallint, tinyint, mediumint, uint8, uint16, uint32, uint64, uinteger, ubigint, usmallint, hugeint, byteint, etc.
    'dec', // decimal
    'double', // double, double precision
    'numb', // number
    'numeric', // numeric, bignumeric
    'float', // float, float4, float8, float32, float64, binary_float
    'real', // real
    'serial', // serial, bigserial, smallserial
    'money', // money, smallmoney
  ].find(t => type.includes(t))) {
    // enums are not Numbers
    return ColumnType.Number;
  } else if (['bool'].find(t => type.includes(t))) {
    return ColumnType.Boolean;
  }

  return ColumnType.String;
}

export enum MemberType {
  Measure = 'measure',
  Dimension = 'dimension',
  None = 'none',
}

export type Dimension = {
  name: string;
  types: any[];
  title: string;
  isPrimaryKey?: boolean;
  type?: any;
};

export type TableName = string | [string, string];

export type JoinRelationship = 'hasOne' | 'hasMany' | 'belongsTo';

type ColumnsToJoin = {
  cubeToJoin: string;
  columnToJoin: string;
  tableName: TableName;
};

export type CubeDescriptorMember = {
  name: string;
  title: string;
  memberType: MemberType;
  type?: string;
  types: string[];
  isId?: boolean;
  included?: boolean;
  isPrimaryKey?: boolean;
};

export type Join = {
  thisTableColumn: string;
  thisTableColumnIncludedAsDimension?: boolean;
  tableName: TableName;
  cubeToJoin: string;
  columnToJoin: string;
  columnToJoinIncludedAsDimension?: boolean;
  relationship: JoinRelationship;
};

export type CubeDescriptor = {
  cube: string;
  tableName: TableName;
  table: string;
  schema: string;
  members: CubeDescriptorMember[];
  joins: Join[];
};

export type TableSchema = {
  cube: string;
  tableName: TableName;
  schema: any;
  table: any;
  measures: any[];
  dimensions: Dimension[];
  drillMembers?: Dimension[];
  joins: Join[];
};

const MEASURE_DICTIONARY = [
  'amount',
  'price',
  'count',
  'balance',
  'total',
  'number',
  'cost',
  'qty',
  'quantity',
  'duration',
  'value',
];

const idRegex = '_id$|id$';

type ForeignKey = {
  // Absent when the driver doesn't say which schema the target is in.
  // eslint-disable-next-line camelcase
  target_schema?: string;
  // eslint-disable-next-line camelcase
  target_table: string;
  // eslint-disable-next-line camelcase
  target_column: string;
};

type ColumnData = {
  name: string,
  type: string,
  attributes: string[],
  // eslint-disable-next-line camelcase
  foreign_keys?: ForeignKey[],
};

export type DatabaseSchema = Record<string, { [key: string]: ColumnData[] }>;

type TableData = {
  schema: string,
  table: string,
  tableName: TableName;
  tableDefinition: ColumnData[],
};

type ScaffoldingSchemaOptions = {
  includeNonDictionaryMeasures?: boolean;
  snakeCase?: boolean;
  /**
   * The cube name for a table, in place of the one made from the table's name
   * alone, e.g. to tell apart tables of the same name in different schemas.
   * Nothing keeps the default.
   */
  cubeNameFor?: (schema: string, table: string) => string | undefined;
};

export class ScaffoldingSchema {
  private tableNamesToTables: Record<string, TableData[]> = {};

  public constructor(
    private readonly dbSchema: DatabaseSchema,
    private readonly options: ScaffoldingSchemaOptions = {}
  ) {}

  public resolveTableName(tableName: TableName) {
    let tableParts;
    if (Array.isArray(tableName)) {
      tableParts = tableName;
    } else {
      tableParts = tableName.match(/(["`].*?["`]|[^`".]+)+(?=\s*|\s*$)/g);
    }

    if (tableParts.length === 2) {
      this.resolveTableDefinition(tableName);
      return tableName;
    } else if (tableParts.length === 1 && typeof tableName === 'string') {
      const schema = Object.keys(this.dbSchema).find(
        (tableSchema) => this.dbSchema[tableSchema][tableName] ||
          this.dbSchema[tableSchema][inflection.tableize(tableName)]
      );
      if (!schema) {
        throw new UserError(`Can't find any table with '${tableName}' name`);
      }
      if (this.dbSchema[schema][tableName]) {
        return `${schema}.${tableName}`;
      }
      if (this.dbSchema[schema][inflection.tableize(tableName)]) {
        return `${schema}.${inflection.tableize(tableName)}`;
      }
    }

    throw new UserError(
      'Table names should be in <table> or <schema>.<table> format'
    );
  }

  public cubeDescriptors(tableNames: TableName[]): CubeDescriptor[] {
    const cubes = this.generateForTables(tableNames);

    function member(type: MemberType) {
      return (value: Omit<CubeDescriptorMember, 'memberType'>) => ({
        memberType: type,
        ...R.pick(['name', 'title', 'types', 'isPrimaryKey', 'included', 'isId'], value)
      });
    }

    return cubes.map((cube) => ({
      cube: cube.cube,
      tableName: cube.tableName,
      table: cube.table,
      schema: cube.schema,
      members: (cube.measures || []).map(member(MemberType.Measure))
        .concat((cube.dimensions || []).map(member(MemberType.Dimension))),
      joins: cube.joins
    }));
  }

  public generateForTables(tableNames: TableName[]) {
    this.prepareTableNamesToTables(tableNames);
    return tableNames.map(tableName => this.tableSchema(tableName, true));
  }

  protected prepareTableNamesToTables(tableNames: TableName[]) {
    this.tableNamesToTables = R.pipe(
      // @ts-ignore
      R.unnest,
      R.groupBy(n => n[0]),
      R.map(groupedNameToDef => groupedNameToDef.map(nameToDef => nameToDef[1]))
    )(
      // @ts-ignore
      tableNames.map(tableName => {
        const [schema, table] = this.parseTableName(tableName);
        const tableDefinition = this.resolveTableDefinition(tableName);
        const definition: TableData = {
          schema, table, tableDefinition, tableName
        };
        const tableizeName = inflection.tableize(this.fixCase(table));
        const parts = tableizeName.split('_');
        const tableNamesFromParts = R.range(0, parts.length - 1).map(toDrop => inflection.tableize(R.drop(toDrop, parts).join('_')));
        const names = R.uniq([table, tableizeName].concat(tableNamesFromParts));
        return names.map(n => [n, definition]);
      })
    ) as any;
  }

  public resolveTableDefinition(tableName: TableName) {
    const [schema, table] = this.parseTableName(tableName);
    if (!this.dbSchema[schema]) {
      throw new UserError(`Can't resolve ${tableName}: '${schema}' does not exist`);
    }
    if (!this.dbSchema[schema][table]) {
      throw new UserError(`Can't resolve ${tableName}: '${table}' does not exist`);
    }
    return this.dbSchema[schema][table];
  }

  protected tableSchema(tableName: TableName, includeJoins: boolean): TableSchema {
    const [schema, table] = this.parseTableName(tableName);
    const tableDefinition = this.resolveTableDefinition(tableName);
    const dimensions = this.dimensions(tableDefinition);

    return {
      cube: this.cubeName(schema, table),
      tableName,
      schema,
      table,
      measures: this.numberMeasures(tableDefinition),
      dimensions,
      joins: includeJoins ? this.joins(tableName, tableDefinition) : []
    };
  }

  protected parseTableName(tableName: TableName): [string, string] {
    let schemaAndTable;
    if (Array.isArray(tableName)) {
      schemaAndTable = tableName;
    } else {
      schemaAndTable = tableName.match(/(["`].*?["`]|[^`".]+)+(?=\s*|\s*$)/g);
    }
    if (schemaAndTable.length !== 2) {
      throw new UserError(`Incorrect format for '${tableName}'. Should be in '<schema>.<table>' format`);
    }
    return schemaAndTable;
  }

  protected dimensions(tableDefinition: ColumnData[]): Dimension[] {
    return this.dimensionColumns(tableDefinition).map(column => {
      const res: Dimension = {
        name: column.name,
        types: [column.columnType || this.columnType(column)],
        title: inflection.titleize(column.name),
      };

      if (column.columnType !== 'time') {
        res.isPrimaryKey = column.attributes?.includes('primaryKey') ||
          this.fixCase(column.name) === 'id';
      }
      return res;
    });
  }

  protected numberMeasures(tableDefinition: ColumnData[]) {
    return tableDefinition.filter(
      column => (!column.name.startsWith('_') &&
        (this.columnType(column) === 'number') &&
        (this.options.includeNonDictionaryMeasures ? this.fixCase(column.name) !== 'id' : this.fromMeasureDictionary(column)))
    ).map(column => ({
      name: column.name,
      types: ['sum', 'avg', 'min', 'max'],
      title: inflection.titleize(column.name),
      ...(this.options.includeNonDictionaryMeasures ? { included: this.fromMeasureDictionary(column) } : null)
    }));
  }

  protected fromMeasureDictionary(column) {
    return !column.name.match(new RegExp(idRegex, 'i')) && !!MEASURE_DICTIONARY.find(word => this.fixCase(column.name).endsWith(word));
  }

  protected dimensionColumns(tableDefinition: ColumnData[]): Array<ColumnData & { columnType?: string }> {
    const dimensionColumns = tableDefinition.filter(
      column => !column.name.startsWith('_') && ['string', 'boolean'].includes(this.columnType(column)) ||
        column.attributes?.includes('primaryKey') ||
        this.fixCase(column.name) === 'id'
    );

    // A key column is a dimension already, as a key, whatever its type: listed
    // again as a time, it would replace the key under the same name.
    const timeColumns = R.pipe(
      // @ts-ignore
      R.filter((column: ColumnData) => !column.name.startsWith('_') && this.columnType(column) === 'time' &&
        !dimensionColumns.includes(column)),
      R.sortBy(column => this.timeColumnIndex(column)),
      // @ts-ignore
      R.map(column => ({ ...column, columnType: 'time' })) // TODO do we need it?
      // @ts-ignore
    )(tableDefinition);

    return dimensionColumns.concat(timeColumns);
  }

  private fixCase(value: string) {
    if (this.options.snakeCase) {
      return toSnakeCase(value);
    }

    return value.toLocaleLowerCase();
  }

  protected cubeName(schema: string, table: string): string {
    return this.options.cubeNameFor?.(schema, table) ??
      (this.options.snakeCase ? toSnakeCase(table) : inflection.camelize(table));
  }

  /**
   * Of the tables a join could target, those in `schema` when there are any,
   * and otherwise those `elsewhere` picks: a table of the same name in
   * another schema is a different table.
   */
  private preferSchema(
    definitions: TableData[],
    schema: string,
    elsewhere: (definitions: TableData[]) => TableData[],
  ): TableData[] {
    const inSchema = definitions.filter(definition => definition.schema === schema);

    return inSchema.length ? inSchema : elsewhere(definitions);
  }

  protected joins(tableName: TableName, tableDefinition: ColumnData[]): Join[] {
    const [thisSchema] = this.parseTableName(tableName);

    return R.unnest(tableDefinition
      .map(column => {
        let columnsToJoin: ColumnsToJoin[] = [];

        if (column.foreign_keys?.length) {
          column.foreign_keys.forEach(fk => {
            const [targetTableDefinition] = this.preferSchema(
              (this.tableNamesToTables[fk.target_table] || []).filter(t => t.table === fk.target_table),
              fk.target_schema ?? thisSchema,
              // A key that names its target's schema means that schema's table or none.
              others => (fk.target_schema == null ? others : []),
            );
            if (targetTableDefinition) {
              columnsToJoin.push({
                cubeToJoin: this.cubeName(targetTableDefinition.schema, targetTableDefinition.table),
                columnToJoin: fk.target_column,
                tableName: targetTableDefinition.tableName
              });
            }
          });
        } else if ((column.name.match(new RegExp(idRegex, 'i')) && this.fixCase(column.name) !== 'id')) {
          const withoutId = column.name.replace(new RegExp(idRegex, 'i'), '');
          const tablesToJoin = this.tableNamesToTables[withoutId] ||
          this.tableNamesToTables[inflection.tableize(withoutId)] ||
          this.tableNamesToTables[this.fixCase(withoutId)] ||
          this.tableNamesToTables[(inflection.tableize(this.fixCase(withoutId)))];

          if (!tablesToJoin) {
            return null;
          }

          columnsToJoin = this.preferSchema(
            tablesToJoin,
            thisSchema,
            // By its name alone, a column means a table in another schema only when that
            // is the one table its name could mean: of several, any would be a guess.
            others => (others.length === 1 ? others : []),
          ).map(definition => {
            if (tableName === definition.tableName) {
              return null;
            }
            let columnForJoin = definition.tableDefinition.find(c => this.fixCase(c.name) === this.fixCase(column.name));
            columnForJoin = columnForJoin || definition.tableDefinition.find(c => this.fixCase(c.name) === 'id');
            if (!columnForJoin) {
              return null;
            }
            return {
              cubeToJoin: this.cubeName(definition.schema, definition.table),
              columnToJoin: columnForJoin.name,
              tableName: definition.tableName
            };
          }).filter(notEmpty);
        }

        if (!columnsToJoin.length) {
          return null;
        }

        return columnsToJoin.map<Join>(columnToJoin => ({
          thisTableColumn: column.name,
          tableName: columnToJoin.tableName,
          cubeToJoin: columnToJoin.cubeToJoin,
          columnToJoin: columnToJoin.columnToJoin,
          relationship: 'belongsTo'
        }));
      })
      .filter(notEmpty));
  }

  protected timeColumnIndex(column): number {
    const name = this.fixCase(column.name);
    if (name.indexOf('create') !== -1) {
      return 0;
    } else if (name.indexOf('update') !== -1) {
      return 1;
    } else {
      return 2;
    }
  }

  protected columnType(column): ColumnType {
    return columnTypeOf(this.fixCase(column.type));
  }
}
