import { CharStream, type Token } from 'antlr4';
import Python3Lexer from '@cubejs-backend/schema-compiler/dist/src/parser/Python3Lexer';

/** One `name` of a dotted chain, at [start, stop] in the text it was read from. */
export interface Segment {
  text: string;
  start: number;
  stop: number;
}

/** `a.b.c` in load position: not an attribute of a call's result, a keyword argument or a lambda's parameter. */
export type Chain = Segment[];

export interface Replacement {
  start: number;
  stop: number;
  text: string;
}

function tokens(code: string): Token[] {
  const lexer = new Python3Lexer(new CharStream(code));
  lexer.removeErrorListeners();
  return lexer.getAllTokens();
}

/**
 * Every dotted name chain in a Python expression, as Cube's own lexer reads
 * it (Cube parses YAML expressions with this grammar, `YamlCompiler.ts`).
 * Names inside string literals are not tokens, so they are never chains.
 */
export function chainsIn(code: string): Chain[] {
  const all = tokens(code);
  const { NAME, DOT, LAMBDA, COLON, COMMA, ASSIGN, OPEN_PAREN, CLOSE_PAREN, OPEN_BRACK, CLOSE_BRACK, OPEN_BRACE } = Python3Lexer;
  const closers = new Set([CLOSE_PAREN, CLOSE_BRACK, Python3Lexer.CLOSE_BRACE, Python3Lexer.TEMPLATE_CLOSE_BRACE]);
  const openers = new Set([OPEN_PAREN, OPEN_BRACK, OPEN_BRACE]);

  const chains: Chain[] = [];
  // Lambda parameters in scope: each lives until its lambda's group closes.
  const locals: { names: Set<string>; depth: number }[] = [];
  let depth = 0;

  for (let i = 0; i < all.length; i++) {
    const token = all[i];
    if (openers.has(token.type)) {
      depth++;
    } else if (closers.has(token.type)) {
      depth--;
      while (locals.length && locals[locals.length - 1].depth > depth) {
        locals.pop();
      }
    } else if (token.type === LAMBDA) {
      const names = new Set<string>();
      let j = i + 1;
      for (; j < all.length && all[j].type !== COLON; j++) {
        if (all[j].type === NAME) {
          names.add(all[j].text);
        }
      }
      locals.push({ names, depth });
      i = j;
    } else if (token.type === COMMA) {
      // A lambda's body ends at a comma at its own depth.
      while (locals.length && locals[locals.length - 1].depth === depth) {
        locals.pop();
      }
    } else if (token.type === NAME && all[i - 1]?.type !== DOT
      && all[i + 1]?.type !== ASSIGN && !locals.some((l) => l.names.has(token.text))) {
      const chain: Chain = [{ text: token.text, start: token.start, stop: token.stop }];
      let j = i + 1;
      while (all[j]?.type === DOT && all[j + 1]?.type === NAME) {
        chain.push({ text: all[j + 1].text, start: all[j + 1].start, stop: all[j + 1].stop });
        j += 2;
      }
      chains.push(chain);
      i = j - 1;
    }
  }
  return chains;
}

/**
 * `f"<text>"` as Cube's YAML compiler writes a SQL field before parsing it
 * (`YamlCompiler.escapeDoubleQuotes`), with, for each character of the code,
 * the index of the character of `text` it came from (-1 for added ones).
 */
export function fStringOf(text: string): { code: string; origin: number[] } {
  const out: string[] = [];
  const origin: number[] = [];
  const push = (s: string, from: number) => {
    for (let k = 0; k < s.length; k++) {
      out.push(s[k]);
      origin.push(k === s.length - 1 ? from : -1);
    }
  };
  type State = { inStr?: boolean; inFormattedStr?: boolean; inTemplate?: boolean; depth?: number };
  const stack: State[] = [];
  const peek = () => stack[stack.length - 1] || { inStr: true, inFormattedStr: true };

  push('f"', -1);
  origin[origin.length - 1] = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === 'f' && text[i + 1] === '"' && !peek().inStr) {
      out.push('f', '"');
      origin.push(i, i + 1);
      i += 1;
      stack.push({ inFormattedStr: true, inStr: true });
    } else if (c === '"' && !peek().inStr) {
      push('"', i);
      stack.push({ inStr: true });
    } else if (c === '"' && stack.length === 0) {
      push('\\"', i);
    } else if (c === '"' && peek().inStr) {
      push(c, i);
      stack.pop();
    } else if (c === '`' && stack.length === 0) {
      push('\\`', i);
    } else if (c === '`' && peek().inStr) {
      push(c, i);
      stack.pop();
    } else if (c === '\\' && (text[i + 1] === '{' || text[i + 1] === '}') && stack.length === 0) {
      out.push('\\', text[i + 1]);
      origin.push(i, i + 1);
      i += 1;
    } else if (c === '{' && peek()?.inFormattedStr) {
      push(c, i);
      stack.push({ inTemplate: true, depth: 1 });
    } else if (c === '{' && peek()?.inTemplate) {
      push(c, i);
      peek().depth = (peek().depth || 0) + 1;
    } else if (c === '}' && peek()?.inTemplate) {
      push(c, i);
      const current = peek();
      current.depth = (current.depth || 0) - 1;
      if (current.depth === 0) {
        stack.pop();
      }
    } else {
      push(c, i);
    }
  }
  push('"', -1);
  origin[origin.length - 1] = -1;
  return { code: out.join(''), origin };
}

/** The chains of a SQL-like field, positioned in the field's own text. */
export function chainsInFString(text: string): Chain[] {
  const { code, origin } = fStringOf(text);
  return chainsIn(code).map((chain) => chain.map((segment) => ({
    text: segment.text,
    start: origin[segment.start],
    stop: origin[segment.stop],
  }))).filter((chain) => chain.every((s) => s.start >= 0 && s.stop >= 0));
}

/** `text` with each replacement applied; replacements must not overlap. */
export function applyReplacements(text: string, replacements: Replacement[]): string {
  let result = text;
  for (const r of [...replacements].sort((a, b) => b.start - a.start)) {
    result = result.slice(0, r.start) + r.text + result.slice(r.stop + 1);
  }
  return result;
}
