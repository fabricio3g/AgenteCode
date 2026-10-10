import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/** Pure request/response code must not grow a dependency on app state or transport. */
describe('chat domain boundaries', () => {
  it('keeps wire contracts and formatting free of stores, IPC, UI and network clients', () => {
    const directory = path.resolve(process.cwd(), 'src/lib/services/chat');
    const violations: string[] = [];
    const forbidden = /^(?:node:|electron$|openai$|\$lib\/(?:stores|features|components|ui)\/|\$lib\/services\/(?:bridge|chat-api)$)|^(?:\.\.\/)*(?:bridge|chat-api)(?:\.ts)?$/;
    for (const name of readdirSync(directory).filter(name => name.endsWith('.ts') && !name.endsWith('.spec.ts'))) {
      const source = ts.createSourceFile(name, readFileSync(path.join(directory, name), 'utf8'), ts.ScriptTarget.Latest, true);
      function check(node: ts.Node) {
        if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly && ts.isStringLiteral(node.moduleSpecifier) && forbidden.test(node.moduleSpecifier.text)) violations.push(`${name}: ${node.moduleSpecifier.text}`);
        if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && ts.isStringLiteral(node.arguments[0]) && forbidden.test(node.arguments[0].text)) violations.push(`${name}: ${node.arguments[0].text}`);
        ts.forEachChild(node, check);
      }
      check(source);
    }
    expect(violations).toEqual([]);
  });
});
