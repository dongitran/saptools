import ts from 'typescript';
export function createSourceFile(filePath: string, text: string): ts.SourceFile { return ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, filePath.endsWith('.js') ? ts.ScriptKind.JS : ts.ScriptKind.TS); }
