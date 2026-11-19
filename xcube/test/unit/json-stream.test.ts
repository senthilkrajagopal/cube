import express from 'express';
import request from 'supertest';

import { isMetaAnswer, jsonPieces, writeJson } from '../../src/json-stream';

const whole = (value: unknown) => [...jsonPieces(value)].join('');

describe('jsonPieces', () => {
  test('joined, is JSON.stringify\'s text', () => {
    const values: unknown[] = [
      { cubes: [{ name: 'a', measures: [{ name: 'a.count', meta: { x: `q"${String.fromCharCode(0x2028)}é\u{1F600}` } }] }, { name: 'b', dimensions: [] }], compilerId: 'c' },
      { cubes: [], viewGroups: [{ name: 'g', views: ['v'] }] },
      { a: undefined, b: () => 1, c: null, d: [undefined, () => 2, Symbol('s'), new Date(0), 1.5], e: { f: undefined, g: [1, { h: 2 }] } },
      { nested: { deeper: { deepest: [1, 2, { x: 'y' }] } } },
      [],
      {},
      [1, 'two', null, [3]],
      'text',
      7,
      null,
    ];
    values.forEach((value) => expect(whole(value)).toBe(JSON.stringify(value)));
  });

  test('no piece holds more than one entry of the top object\'s arrays', () => {
    const cubes = Array.from({ length: 50 }, (_, i) => ({ name: `c${i}`, dimensions: Array.from({ length: 20 }, (__, j) => ({ name: `d${j}` })) }));
    const longest = Math.max(...[...jsonPieces({ cubes })].map((p) => p.length));
    expect(longest).toBe(Math.max(...cubes.map((c) => JSON.stringify(c).length)));
  });
});

describe('writeJson', () => {
  const app = (body: unknown, status?: number) => express().get('/', async (_req, res) => {
    await writeJson(res, body, status);
  });

  test('answers as res.json would: the same bytes and content type', async () => {
    const cubes = Array.from({ length: 3000 }, (_, i) => ({ name: `cube_${i}`, title: 'x'.repeat(200), dimensions: [{ name: `cube_${i}.id` }] }));
    const body = { cubes, compilerId: 'id' };
    const streamed = await request(app(body)).get('/').expect(200);
    const plain = await request(express().get('/', (_req, res) => { res.json(body); })).get('/').expect(200);
    expect(streamed.text).toBe(plain.text);
    expect(streamed.headers['content-type']).toBe(plain.headers['content-type']);
    expect(streamed.text.length).toBeGreaterThan(256 * 1024);
  });

  test('keeps a status', async () => {
    await request(app({ cubes: [] }, 202)).get('/').expect(202, '{"cubes":[]}');
  });
});

describe('isMetaAnswer', () => {
  test('is an object with a cubes array', () => {
    expect(isMetaAnswer({ cubes: [] })).toBe(true);
    expect(isMetaAnswer({ cubes: 'no' })).toBe(false);
    expect(isMetaAnswer({ data: [] })).toBe(false);
    expect(isMetaAnswer(null)).toBe(false);
    expect(isMetaAnswer([])).toBe(false);
  });
});
