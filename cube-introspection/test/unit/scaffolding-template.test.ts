import YAML from 'js-yaml';

import {
  ScaffoldingTemplate,
  SchemaFormat,
} from '../../src/scaffolding/ScaffoldingTemplate';

const driver = {
  quoteIdentifier: (name) => `"${name}"`,
};

const mySqlDriver = {
  quoteIdentifier: (name) => `\`${name}\``,
};

const bigQueryDriver = {
  quoteIdentifier(identifier) {
    const nestedFields = identifier.split('.');
    return nestedFields
      .map((name) => {
        if (name.match(/^[a-z0-9_]+$/)) {
          return name;
        }
        return `\`${identifier}\``;
      })
      .join('.');
  },
};

const dbSchema = {
  public: {
    orders: [
      {
        name: 'id',
        type: 'integer',
        attributes: [],
      },
      {
        name: 'amount',
        type: 'integer',
        attributes: [],
      },
      {
        name: 'customerId',
        type: 'integer',
        attributes: [],
      },
    ],
    customers: [
      {
        name: 'id',
        type: 'integer',
        attributes: [],
      },
      {
        name: 'visit_count',
        type: 'integer',
        attributes: [],
      },
      {
        name: 'name',
        type: 'character varying',
        attributes: [],
      },
      {
        name: 'account_id',
        type: 'integer',
        attributes: [],
      },
    ],
    accounts: [
      {
        name: 'id',
        type: 'integer',
        attributes: [],
      },
      {
        name: 'username',
        type: 'character varying',
        attributes: [],
      },
      {
        name: 'password',
        type: 'character varying',
        attributes: [],
      },
      {
        name: 'failure_count',
        type: 'integer',
        attributes: [],
      },
    ],
  },
};

const schemasWithPrimaryAndForeignKeys = {
  public: {
    orders: [
      {
        name: 'test',
        type: 'integer',
        attributes: ['primaryKey']
      },
      {
        name: 'id',
        type: 'integer',
        attributes: []
      },
      {
        name: 'amount',
        type: 'integer',
        attributes: []
      },
      {
        name: 'customerKey',
        type: 'string',
        attributes: [],
        foreign_keys: [
          {
            target_table: 'customers',
            target_column: 'id'
          }
        ]
      }
    ],
    customers: [
      {
        name: 'id',
        type: 'string',
        attributes: []
      },
      {
        name: 'name',
        type: 'character varying',
        attributes: []
      },
      {
        name: 'account_id',
        type: 'integer',
        attributes: []
      }
    ],
    accounts: [
      {
        name: 'id',
        type: 'integer',
        attributes: []
      },
      {
        name: 'username',
        type: 'character varying',
        attributes: []
      },
      {
        name: 'password',
        type: 'character varying',
        attributes: ['primaryKey']
      },
      {
        name: 'failure_count',
        type: 'integer',
        attributes: []
      },
      {
        name: 'account_status',
        type: 'character varying',
        attributes: []
      }
    ],
  }
};

describe('ScaffoldingTemplate', () => {
  describe('JavaScript formatter', () => {
    it('template', () => {
      const template = new ScaffoldingTemplate(dbSchema, driver);

      template.generateFilesByTableNames([
        'public.orders',
        ['public', 'customers'],
        'public.accounts',
      ]).forEach((it) => {
        expect(it.content).toMatchSnapshot(it.fileName);
      });
    });

    it('template with snake case', () => {
      const template = new ScaffoldingTemplate(dbSchema, driver, {
        snakeCase: true,
      });

      template.generateFilesByTableNames([
        'public.orders',
        ['public', 'customers'],
        'public.accounts',
      ]).forEach((it) => {
        expect(it.content).toMatchSnapshot(it.fileName);
      });
    });

    it('escaping back tick', () => {
      const template = new ScaffoldingTemplate(
        {
          public: {
            someOrders: [
              {
                name: 'id',
                type: 'integer',
                attributes: [],
              },
              {
                name: 'amount',
                type: 'integer',
                attributes: [],
              },
              {
                name: 'someDimension',
                type: 'string',
                attributes: [],
              },
            ],
          },
        },
        mySqlDriver,
        {
          snakeCase: true
        }
      );

      template.generateFilesByTableNames(['public.someOrders']).forEach((it) => {
        expect(it.content).toMatchSnapshot(it.fileName);
      });
    });

    it('big query nested fields', () => {
      const template = new ScaffoldingTemplate(
        {
          public: {
            orders: [
              {
                name: 'id',
                type: 'integer',
                attributes: [],
              },
              {
                name: 'some.dimension.inside',
                type: 'string',
                attributes: [],
              },
            ],
          },
        },
        bigQueryDriver,
        {
          snakeCase: true
        }
      );

      template.generateFilesByTableNames(['public.orders'])
        .forEach((it) => expect(it.content).toMatchSnapshot(it.fileName));
    });

    it('should add options if passed', () => {
      const schemaContext = {
        dataSource: 'testDataSource',
      };

      const template = new ScaffoldingTemplate(
        {
          public: {
            orders: [
              {
                name: 'id',
                type: 'integer',
                attributes: [],
              },
              {
                name: 'some.dimension.inside',
                type: 'string',
                attributes: [],
              },
            ],
          },
        },
        bigQueryDriver,
        {
          snakeCase: true
        }
      );

      template.generateFilesByTableNames(['public.orders'], schemaContext).forEach((it) => {
        expect(it.content).toMatchSnapshot(it.fileName);
      });
    });

    it('uses dimension refs instead of table columns for join sql', () => {
      const template = new ScaffoldingTemplate(
        schemasWithPrimaryAndForeignKeys,
        driver,
        {
          format: SchemaFormat.JavaScript,
          snakeCase: true,
        }
      );

      template.generateFilesByTableNames(['public.orders', 'public.customers']).forEach((it) => {
        expect(it.content).toMatchSnapshot(it.fileName);
      });
    });
  });

  describe('Yaml formatter', () => {
    it('generates schema for base driver', () => {
      const template = new ScaffoldingTemplate(dbSchema, driver, {
        format: SchemaFormat.Yaml,
        snakeCase: true
      });

      template.generateFilesByTableNames([
        'public.orders',
        ['public', 'customers'],
        'public.accounts',
      ]).forEach((it) => {
        expect(it.content).toMatchSnapshot(it.fileName);
      });
    });

    it('generates schema for MySQL driver', () => {
      const template = new ScaffoldingTemplate(
        {
          public: {
            accounts: dbSchema.public.accounts,
          },
        },
        mySqlDriver,
        {
          format: SchemaFormat.Yaml,
          snakeCase: true
        }
      );

      template.generateFilesByTableNames(['public.accounts']).forEach((it) => {
        expect(it.content).toMatchSnapshot(it.fileName);
      });
    });

    it('generates schema with a catalog', () => {
      const template = new ScaffoldingTemplate(
        {
          public: {
            accounts: dbSchema.public.accounts,
          },
        },
        driver,
        {
          format: SchemaFormat.Yaml,
          snakeCase: true,
          catalog: 'hello_catalog'
        }
      );

      template.generateFilesByTableNames(['public.accounts']).forEach((it) => {
        expect(it.content).toMatchSnapshot(it.fileName);
      });
    });

    describe('keeps every column it maps', () => {
      const cubeOf = (schema, tableNames) => {
        const [file] = new ScaffoldingTemplate(schema, driver, {
          format: SchemaFormat.Yaml,
          snakeCase: true,
        }).generateFilesByTableNames(tableNames);

        return (YAML.load(file.content) as any).cubes[0];
      };
      const members = (list) => list.map(({ name, sql, type, primary_key: primaryKey }) => ({
        name, sql, type, ...(primaryKey ? { primary_key: primaryKey } : {}),
      }));

      it('names two columns whose member names coincide apart', () => {
        const cube = cubeOf({
          public: {
            sales: [
              { name: 'id', type: 'integer', attributes: ['primaryKey'] },
              { name: 'Amount', type: 'numeric', attributes: [] },
              { name: 'amount', type: 'numeric', attributes: [] },
            ],
          },
        }, ['public.sales']);

        expect(members(cube.measures)).toEqual([
          { name: 'count', sql: undefined, type: 'count' },
          { name: 'amount', sql: '{CUBE}."Amount"', type: 'sum' },
          { name: 'amount_2', sql: 'amount', type: 'sum' },
        ]);
      });

      it('keeps the count measure when a column is named count', () => {
        const cube = cubeOf({
          public: {
            tallies: [
              { name: 'id', type: 'integer', attributes: ['primaryKey'] },
              { name: 'count', type: 'integer', attributes: [] },
            ],
          },
        }, ['public.tallies']);

        expect(members(cube.measures)).toEqual([
          { name: 'count', sql: undefined, type: 'count' },
          { name: 'count_2', sql: 'count', type: 'sum' },
        ]);
      });

      it('names a dimension and a measure from one column apart', () => {
        const cube = cubeOf({
          public: {
            ledgers: [
              { name: 'entry_total', type: 'integer', attributes: ['primaryKey'] },
            ],
          },
        }, ['public.ledgers']);

        expect(members(cube.dimensions)).toEqual([
          { name: 'entry_total', sql: 'entry_total', type: 'number', primary_key: true },
        ]);
        expect(members(cube.measures)).toEqual([
          { name: 'count', sql: undefined, type: 'count' },
          { name: 'entry_total_2', sql: 'entry_total', type: 'sum' },
        ]);
      });

      it('keeps a time-typed primary key a primary key, once', () => {
        const cube = cubeOf({
          public: {
            ticks: [
              { name: 'at', type: 'timestamp with time zone', attributes: ['primaryKey'] },
              { name: 'venue', type: 'text', attributes: [] },
            ],
          },
        }, ['public.ticks']);

        expect(members(cube.dimensions)).toEqual([
          { name: 'at', sql: 'at', type: 'time', primary_key: true },
          { name: 'venue', sql: 'venue', type: 'string' },
        ]);
      });

      it('joins on a renamed member by its new name', () => {
        const [lines] = new ScaffoldingTemplate({
          public: {
            lines: [
              { name: 'id', type: 'integer', attributes: ['primaryKey'] },
              { name: 'Order_Id', type: 'text', attributes: [] },
              { name: 'order_id', type: 'text', attributes: [], foreign_keys: [{ target_table: 'orders', target_column: 'id' }] },
            ],
            orders: [
              { name: 'id', type: 'text', attributes: ['primaryKey'] },
            ],
          },
        }, driver, { format: SchemaFormat.Yaml, snakeCase: true })
          .generateFilesByTableNames(['public.lines', 'public.orders'])
          .map(file => (YAML.load(file.content) as any).cubes[0]);

        expect(members(lines.dimensions).map(({ name, sql }) => [name, sql])).toEqual([
          ['id', 'id'],
          ['order_id', '{CUBE}."Order_Id"'],
          ['order_id_2', 'order_id'],
        ]);
        expect(lines.joins).toEqual([
          { name: 'orders', sql: '{CUBE.order_id_2} = {orders.id}', relationship: 'many_to_one' },
        ]);
      });

      it('joins on a renamed member of the cube it joins by that member\'s new name', () => {
        const [lines] = new ScaffoldingTemplate({
          public: {
            lines: [
              { name: 'id', type: 'integer', attributes: ['primaryKey'] },
              { name: 'order_code', type: 'text', attributes: [], foreign_keys: [{ target_table: 'orders', target_column: 'code' }] },
            ],
            orders: [
              { name: 'Code', type: 'text', attributes: [] },
              { name: 'code', type: 'text', attributes: ['primaryKey'] },
            ],
          },
        }, driver, { format: SchemaFormat.Yaml, snakeCase: true })
          .generateFilesByTableNames(['public.lines', 'public.orders'])
          .map(file => (YAML.load(file.content) as any).cubes[0]);

        expect(lines.joins).toEqual([
          { name: 'orders', sql: '{CUBE.order_code} = {orders.code_2}', relationship: 'many_to_one' },
        ]);
      });

      it('leaves a column its own name when only a numbered name would take it', () => {
        const cube = cubeOf({
          public: {
            people: [
              { name: 'id', type: 'integer', attributes: ['primaryKey'] },
              { name: 'Name', type: 'text', attributes: [] },
              { name: 'name', type: 'text', attributes: [] },
              { name: 'name_2', type: 'text', attributes: [] },
            ],
          },
        }, ['public.people']);

        expect(members(cube.dimensions).map(({ name, sql }) => [name, sql])).toEqual([
          ['id', 'id'],
          ['name', '{CUBE}."Name"'],
          ['name_3', 'name'],
          ['name_2', 'name_2'],
        ]);
      });

      it('names each cube\'s members from its own table when another cube has its name', () => {
        const [publicSales, crmSales] = new ScaffoldingTemplate({
          public: {
            sales: [
              { name: 'id', type: 'integer', attributes: ['primaryKey'] },
              { name: 'Amount', type: 'numeric', attributes: [] },
              { name: 'amount', type: 'numeric', attributes: [] },
            ],
          },
          crm: {
            sales: [
              { name: 'id', type: 'integer', attributes: ['primaryKey'] },
              { name: 'amount', type: 'numeric', attributes: [] },
            ],
          },
        }, driver, { format: SchemaFormat.Yaml, snakeCase: true })
          .generateFilesByTableNames(['public.sales', 'crm.sales'])
          .map(file => (YAML.load(file.content) as any).cubes[0]);

        expect(members(publicSales.measures)).toEqual([
          { name: 'count', sql: undefined, type: 'count' },
          { name: 'amount', sql: '{CUBE}."Amount"', type: 'sum' },
          { name: 'amount_2', sql: 'amount', type: 'sum' },
        ]);
        expect(members(crmSales.measures)).toEqual([
          { name: 'count', sql: undefined, type: 'count' },
          { name: 'amount', sql: 'amount', type: 'sum' },
        ]);
      });

      it('numbers names the same way in camelCase', () => {
        const [file] = new ScaffoldingTemplate({
          public: {
            tallies: [
              { name: 'id', type: 'integer', attributes: ['primaryKey'] },
              { name: 'Amount', type: 'numeric', attributes: [] },
              { name: 'amount', type: 'numeric', attributes: [] },
              { name: 'count', type: 'integer', attributes: [] },
              { name: 'Visit Count', type: 'integer', attributes: [] },
            ],
          },
        }, driver).generateFilesByTableNames(['public.tallies']);

        expect(file.content).toContain([
          '  measures: {',
          '    count: {',
          '      type: `count`',
          '    },',
          '    ',
          '    amount: {',
          // eslint-disable-next-line no-template-curly-in-string
          '      sql: `${CUBE}."Amount"`,',
          '      type: `sum`',
          '    },',
          '    ',
          '    amount_2: {',
          '      sql: `amount`,',
          '      type: `sum`',
          '    },',
          '    ',
          '    count_2: {',
          '      sql: `count`,',
          '      type: `sum`',
          '    },',
          '    ',
          '    visitCount: {',
          // eslint-disable-next-line no-template-curly-in-string
          '      sql: `${CUBE}."Visit Count"`,',
          '      type: `sum`',
          '    }',
          '  },',
        ].join('\n'));
      });
    });

    it('uses dimension refs instead of table columns for join sql', () => {
      const template = new ScaffoldingTemplate(
        schemasWithPrimaryAndForeignKeys,
        driver,
        {
          format: SchemaFormat.Yaml,
          snakeCase: true,
        }
      );

      template.generateFilesByTableNames(['public.orders', 'public.customers']).forEach((it) => {
        expect(it.content).toMatchSnapshot(it.fileName);
      });
    });
  });
});
