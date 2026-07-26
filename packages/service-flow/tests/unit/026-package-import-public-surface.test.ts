import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  collectSymbolImportBindings,
  packageModuleRequest,
  symbolImportReference,
  type SymbolImportBinding,
} from '../../src/parsers/002-symbol-import-bindings.js';
import {
  analyzePackagePublicSurface,
  PACKAGE_PUBLIC_SURFACE_RECORD_CAP,
  type PackageSourceModule,
} from '../../src/parsers/003-package-public-surface.js';
import {
  loadPackageJsonSnapshot,
  type PackageEntrypointManifest,
} from '../../src/parsers/package-json-parser.js';

function source(
  fileName: string,
  text: string,
): ts.SourceFile {
  return ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith('.js') ? ts.ScriptKind.JS : ts.ScriptKind.TS,
  );
}

function module(fileName: string, text: string): PackageSourceModule {
  return { sourceFile: fileName, source: source(fileName, text) };
}

function manifest(
  value: Partial<PackageEntrypointManifest> = {},
): PackageEntrypointManifest {
  return {
    mainPresent: false,
    main: null,
    modulePresent: false,
    module: null,
    exportsPresent: false,
    exportsValue: null,
    ...value,
  };
}

function binding(
  bindings: readonly SymbolImportBinding[],
  localName: string,
): SymbolImportBinding {
  const result = bindings.find((value) => value.localName === localName);
  if (!result) throw new Error(`Missing binding ${localName}`);
  return result;
}

function explicitSurfaceAnalysis(): ReturnType<
  typeof analyzePackagePublicSurface
> {
  return analyzePackagePublicSurface(
    '@neutral/handlers',
    manifest({
      exportsPresent: true,
      exportsValue: {
        '.': './src/index.ts',
        './sub': './src/sub.ts',
      },
    }),
    [
      module('src/index.ts', `
        export { direct as renamed, Tools, overloaded } from './direct';
        export * from './star';
      `),
      module('src/direct.ts', `
        export function direct(): void {}
        export class Tools { static run(): void {} }
        export function overloaded(value: string): void;
        export function overloaded(value: number): void;
        export function overloaded(value: string | number): void { void value; }
      `),
      module('src/star.ts', 'export function starHandler(): void {}'),
      module('src/sub.ts', 'export function subHandler(): void {}'),
      module('src/hidden.ts', 'export function hiddenHandler(): void {}'),
    ],
  );
}

describe('typed symbol import binding fields', () => {
  it('keeps origin, binding shape, aliases, and package subpaths independent', () => {
    const ast = source('consumer.ts', `
      import defaultHandler from '@neutral/handlers';
      import { handle as localHandle, type Contract } from '@neutral/handlers/sub';
      import * as handlers from '@neutral/handlers';
      import { Tools as LocalTools } from './tools';
      const { legacy: localLegacy } = require('@neutral/legacy/sub');
      const legacyNs = require('@neutral/legacy');
      import equalsNs = require('@neutral/equals');
    `);
    const bindings = collectSymbolImportBindings(ast);

    expect(binding(bindings, 'localHandle')).toMatchObject({
      moduleKind: 'package',
      bindingKind: 'esm_named',
      importedName: 'handle',
      requestedPackageName: '@neutral/handlers',
      requestedModuleSubpath: './sub',
      typeOnly: false,
    });
    expect(binding(bindings, 'Contract')).toMatchObject({
      importedName: 'Contract', typeOnly: true,
    });
    expect(binding(bindings, 'handlers')).toMatchObject({
      bindingKind: 'esm_namespace', importedName: null,
      requestedModuleSubpath: '.',
    });
    expect(binding(bindings, 'LocalTools')).toMatchObject({
      moduleKind: 'relative', importedName: 'Tools',
      requestedPackageName: null, requestedModuleSubpath: null,
    });
    expect(binding(bindings, 'localLegacy')).toMatchObject({
      bindingKind: 'cjs_destructured', importedName: 'legacy',
      requestedPackageName: '@neutral/legacy',
      requestedModuleSubpath: './sub',
    });
    expect(binding(bindings, 'legacyNs')).toMatchObject({
      bindingKind: 'cjs_namespace', importedName: null,
    });
    expect(binding(bindings, 'equalsNs')).toMatchObject({
      bindingKind: 'cjs_namespace',
      requestedPackageName: '@neutral/equals',
    });
  });
});

describe('typed symbol import reference shapes', () => {
  it('classifies identifier, namespace, static, and default-member references', () => {
    const ast = source('consumer.ts', `
      import DefaultHandler from '@neutral/handlers';
      import { handle as localHandle, Tools as LocalTools } from '@neutral/handlers';
      import * as handlers from '@neutral/handlers';
      const legacyNs = require('@neutral/legacy');
      localHandle();
      handlers.handle();
      LocalTools.run();
      DefaultHandler.run();
      legacyNs.handle();
    `);
    const bindings = collectSymbolImportBindings(ast);
    const expressions: ts.Expression[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) expressions.push(node.expression);
      ts.forEachChild(node, visit);
    };
    visit(ast);
    expect(expressions.flatMap((expression) => {
      const reference = symbolImportReference(expression, bindings);
      return reference ? [reference] : [];
    })).toEqual([
      expect.objectContaining({
        referenceShape: 'identifier', requestedPublicName: 'handle',
      }),
      expect.objectContaining({
        moduleKind: 'package',
        referenceShape: 'namespace_member',
        requestedPublicName: 'handle',
      }),
      expect.objectContaining({
        referenceShape: 'static_member',
        requestedPublicName: 'Tools.run',
      }),
      expect.objectContaining({
        referenceShape: 'default_member',
        requestedPublicName: 'default.run',
      }),
      expect.objectContaining({
        referenceShape: 'namespace_member',
        requestedPublicName: 'handle',
      }),
    ]);
  });

  it('keeps nested CommonJS bindings lexical and rejects shadowed require', () => {
    const ast = source('nested-consumer.ts', `
      function first(): void {
        const handlers = require('@neutral/handlers/first');
        handlers.handle();
      }
      function second(): void {
        const handlers = require('@neutral/handlers/second');
        handlers.handle();
      }
      function destructured(): void {
        const { handle: localHandle } = require('@neutral/handlers');
        localHandle();
      }
      function shadowed(require: (name: string) => unknown): void {
        const handlers = require('@neutral/forged');
        handlers.handle();
      }
    `);
    const bindings = collectSymbolImportBindings(ast);
    expect(bindings.filter((item) => item.localName === 'handlers'))
      .toHaveLength(2);
    expect(binding(bindings, 'localHandle')).toMatchObject({
      bindingKind: 'cjs_destructured',
      importedName: 'handle',
    });
    const references: Array<ReturnType<typeof symbolImportReference>> = [];
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)
        && (!ts.isIdentifier(node.expression)
          || node.expression.text !== 'require'))
        references.push(symbolImportReference(node.expression, bindings));
      ts.forEachChild(node, visit);
    };
    visit(ast);
    expect(references).toEqual([
      expect.objectContaining({
        requestedModuleSubpath: './first', requestedPublicName: 'handle',
      }),
      expect.objectContaining({
        requestedModuleSubpath: './second', requestedPublicName: 'handle',
      }),
      expect.objectContaining({
        bindingKind: 'cjs_destructured', requestedPublicName: 'handle',
      }),
      undefined,
    ]);
  });
});

describe('typed package module requests', () => {
  it('normalizes scoped and unscoped package requests and rejects unsafe shapes', () => {
    expect(packageModuleRequest('@neutral/handlers')).toEqual({
      packageName: '@neutral/handlers', moduleSubpath: '.',
    });
    expect(packageModuleRequest('@neutral/handlers/sub-b')).toEqual({
      packageName: '@neutral/handlers', moduleSubpath: './sub-b',
    });
    expect(packageModuleRequest('handlers/sub-b')).toEqual({
      packageName: 'handlers', moduleSubpath: './sub-b',
    });
    for (const value of [
      './relative', '../relative', '@neutral', 'node:fs',
      'handlers/../private', 'handlers\\private', 'handlers/sub?x',
    ]) expect(packageModuleRequest(value)).toBeUndefined();
  });
});

describe('package public surface exports', () => {
  it('uses explicit exports as authoritative and follows bounded re-exports', () => {
    const analysis = explicitSurfaceAnalysis();

    expect(analysis.surface).toMatchObject({
      status: 'complete',
      reason: null,
      exportsPresent: true,
      exportsAuthoritative: true,
      recordCap: PACKAGE_PUBLIC_SURFACE_RECORD_CAP,
      omitted: 0,
    });
    expect(analysis.surface.entries).toEqual([
      { entry: '.', modulePath: 'src/index' },
      { entry: './sub', modulePath: 'src/sub' },
    ]);
    expect(analysis.surface.scopes.find((scope) =>
      scope.entry === '.' && scope.publicName === 'renamed')).toMatchObject({
      candidateCount: 1,
      eligibleCandidateCount: 1,
      selectedCandidateCount: 1,
      candidateSetComplete: true,
      targets: [expect.objectContaining({
        sourceFile: 'src/direct.ts', qualifiedName: 'direct',
      })],
    });
    expect(analysis.surface.scopes.find((scope) =>
      scope.publicName === 'Tools.run')).toMatchObject({
      candidateCount: 1, eligibleCandidateCount: 1,
      targets: [expect.objectContaining({
        kind: 'method', qualifiedName: 'Tools.run',
      })],
    });
    expect(analysis.surface.scopes.find((scope) =>
      scope.publicName === 'overloaded')).toMatchObject({
      candidateCount: 3,
      eligibleCandidateCount: 1,
      selectedCandidateCount: 1,
    });
    expect(analysis.surface.scopes.some((scope) =>
      scope.publicName === 'hiddenHandler')).toBe(false);
    expect(analysis.surface.scopes.find((scope) =>
      scope.publicName === 'subHandler')?.entry).toBe('./sub');
  });
});

describe('package public surface body eligibility', () => {
  it('keeps declaration-only exposure non-executable and supports exact CommonJS exports', () => {
    const declarations = analyzePackagePublicSurface(
      '@neutral/contracts',
      manifest({
        exportsPresent: true,
        exportsValue: './src/contracts.d.ts',
      }),
      [module(
        'src/contracts.d.ts',
        'export declare function declaredHandler(): void;',
      )],
    );
    expect(declarations.surface.scopes[0]).toMatchObject({
      publicName: 'declaredHandler',
      candidateCount: 1,
      eligibleCandidateCount: 0,
      selectedCandidateCount: 0,
      targets: [expect.objectContaining({
        bodyEligibility: {
          eligible: false, reason: 'ambient_declaration',
        },
      })],
    });

    const commonJs = analyzePackagePublicSurface(
      '@neutral/common',
      manifest({
        exportsPresent: true,
        exportsValue: './src/index.js',
      }),
      [module('src/index.js', `
        function direct() {}
        function internal() {}
        module.exports = { direct, renamed: internal };
      `)],
    );
    expect(commonJs.surface.scopes.map((scope) =>
      scope.publicName)).toEqual(['direct', 'renamed']);
    expect(commonJs.surface.scopes.every((scope) =>
      scope.eligibleCandidateCount === 1)).toBe(true);
  });

  it('rejects shadowed and conditionally mutated CommonJS surfaces', () => {
    const shadowed = analyzePackagePublicSurface(
      '@neutral/shadowed-cjs',
      manifest({
        exportsPresent: true,
        exportsValue: './src/index.js',
      }),
      [module('src/index.js', `
        function hidden() {}
        const exports = {};
        exports.handle = hidden;
        const module = { exports: {} };
        module.exports.other = hidden;
      `)],
    );
    expect(shadowed.surface).toMatchObject({
      status: 'complete', reason: null, scopes: [],
    });

    for (const mutation of [
      "if (flag) delete module.exports.handle;",
      "Object.assign(module.exports, { handle: replacement });",
      "module['exports']['handle'] = replacement;",
      "exports['handle'] = replacement;",
      "({ handle: module.exports.handle } = { handle: replacement });",
      "for (module.exports.handle of [replacement]) { break; }",
      "function mutate() { delete module.exports.handle; } mutate();",
    ]) {
      const analysis = analyzePackagePublicSurface(
        '@neutral/mutated-cjs',
        manifest({
          exportsPresent: true,
          exportsValue: './src/index.js',
        }),
        [module('src/index.js', `
          function handle() {}
          function replacement() {}
          module.exports = { handle };
          ${mutation}
        `)],
      );
      expect(analysis.surface).toMatchObject({
        status: 'unsupported',
        reason: 'unsupported_commonjs_export_shape',
        scopes: [],
      });
    }
  });

  it('fails closed for mutable ESM and aliased CommonJS bodies', () => {
    const mutableEsm = analyzePackagePublicSurface(
      '@neutral/mutable-esm',
      manifest({
        exportsPresent: true,
        exportsValue: './src/index.ts',
      }),
      [module('src/index.ts', `
        export let handle = (): string => 'old';
        handle = (): string => 'replacement';
      `)],
    );
    expect(mutableEsm.surface).toMatchObject({
      status: 'unsupported',
      reason: 'unsupported_mutable_export_binding',
      scopes: [],
    });

    const aliasedCommonJs = analyzePackagePublicSurface(
      '@neutral/mutable-cjs',
      manifest({
        exportsPresent: true,
        exportsValue: './src/index.js',
      }),
      [module('src/index.js', `
        const api = { handle() { return 'old'; } };
        module.exports = api;
        api.handle = () => 'replacement';
      `)],
    );
    expect(aliasedCommonJs.surface).toMatchObject({
      status: 'unsupported',
      reason: 'unsupported_commonjs_export_shape',
      scopes: [],
    });

    const selfMutatingCommonJs = analyzePackagePublicSurface(
      '@neutral/self-mutating-cjs',
      manifest({
        exportsPresent: true,
        exportsValue: './src/index.js',
      }),
      [module('src/index.js', `
        const api = {
          handle() { return 'old'; },
          replace() { this.handle = () => 'replacement'; },
        };
        api.replace();
        module.exports = api;
      `)],
    );
    expect(selfMutatingCommonJs.surface).toMatchObject({
      status: 'unsupported',
      reason: 'unsupported_commonjs_export_shape',
      scopes: [],
    });

    const selfMutatingClass = analyzePackagePublicSurface(
      '@neutral/self-mutating-class',
      manifest({
        exportsPresent: true,
        exportsValue: './src/index.ts',
      }),
      [module('src/index.ts', `
        export class Api {
          static handle() { return 'old'; }
          static replace() {
            this.handle = () => 'replacement';
          }
        }
        Api.replace();
      `)],
    );
    expect(selfMutatingClass.surface).toMatchObject({
      status: 'unsupported',
      reason: 'unsupported_mutable_export_binding',
      scopes: [],
    });
  });
});

describe('package public surface visibility', () => {
  it('does not expose non-public static class members', () => {
    const analysis = analyzePackagePublicSurface(
      '@neutral/visibility',
      manifest({
        exportsPresent: true,
        exportsValue: './src/index.ts',
      }),
      [module('src/index.ts', `
        export class Tools {
          static run(): void {}
          public static explicit(): void {}
          private static hiddenPrivate(): void {}
          protected static hiddenProtected(): void {}
          static #hiddenHash(): void {}
          private static hiddenArrow = (): void => {};
        }
      `)],
    );
    expect(analysis.surface.status).toBe('complete');
    expect(analysis.surface.scopes.map((scope) =>
      scope.publicName)).toEqual(['Tools.explicit', 'Tools.run']);
  });
});

describe('package public surface entrypoint identity', () => {
  it('does not infer a compiled JavaScript entry from TypeScript source', () => {
    const mismatch = analyzePackagePublicSurface(
      '@neutral/source-only',
      manifest({
        exportsPresent: true,
        exportsValue: './src/index.js',
      }),
      [module('src/index.ts', 'export function handler(): void {}')],
    );
    expect(mismatch.surface).toMatchObject({
      status: 'incomplete',
      reason: 'public_surface_entry_target_not_indexed',
    });

    const exact = analyzePackagePublicSurface(
      '@neutral/javascript',
      manifest({
        exportsPresent: true,
        exportsValue: './src/index.js',
      }),
      [module('src/index.js', 'export function handler() {}')],
    );
    expect(exact.surface.scopes).toEqual([
      expect.objectContaining({
        publicName: 'handler',
        eligibleCandidateCount: 1,
      }),
    ]);
  });
});

describe('package public surface unsupported shapes', () => {
  it('fails closed for unsupported export maps, cycles, and missing entry targets', () => {
    const modules = [
      module('src/index.ts', "export * from './cycle';"),
      module('src/cycle.ts', "export * from './index';"),
      module('src/internal.ts', 'export function handler(): void {}'),
    ];
    expect(analyzePackagePublicSurface(
      '@neutral/wildcard',
      manifest({
        exportsPresent: true,
        exportsValue: { './*': './src/*.ts' },
      }),
      modules,
    ).surface).toMatchObject({
      status: 'unsupported', reason: 'unsupported_exports_map_shape',
    });
    expect(analyzePackagePublicSurface(
      '@neutral/cycle',
      manifest({
        exportsPresent: true,
        exportsValue: './src/index.ts',
      }),
      modules,
    ).surface).toMatchObject({
      status: 'incomplete', reason: 'public_surface_reexport_cycle',
    });
    expect(analyzePackagePublicSurface(
      '@neutral/missing',
      manifest({
        exportsPresent: true,
        exportsValue: { '.': './src/missing.ts' },
      }),
      modules,
    ).surface).toMatchObject({
      status: 'incomplete',
      reason: 'public_surface_entry_target_not_indexed',
    });
  });
});

describe('package public surface retention', () => {
  it('retains only complete proof groups within the global record cap', () => {
    const functions = Array.from(
      { length: 260 },
      (_, index) => `export function handler${String(index).padStart(3, '0')}(): void {}`,
    ).join('\n');
    const analysis = analyzePackagePublicSurface(
      '@neutral/large',
      manifest({
        exportsPresent: true,
        exportsValue: './src/index.ts',
      }),
      [module('src/index.ts', functions)],
    );
    expect(analysis.surface).toMatchObject({
      status: 'complete',
      recordCap: 256,
      shown: 255,
    });
    expect(analysis.surface.total).toBeGreaterThan(analysis.surface.shown);
    expect(analysis.surface.omitted).toBe(
      analysis.surface.total - analysis.surface.shown,
    );
    expect(analysis.surface.scopes.some((scope) =>
      scope.publicName === 'handler259')).toBe(false);
    expect(analysis.surface.scopes.every((scope) =>
      scope.targets.length === scope.candidateCount)).toBe(true);
  });
});

describe('package public surface manifest', () => {
  it('publishes literal package entrypoint manifest fields without weakening facts', async () => {
    const root = await mkdtemp(path.join(
      os.tmpdir(), 'service-flow-package-manifest-',
    ));
    await writeFile(path.join(root, 'package.json'), JSON.stringify({
      name: '@neutral/manifest',
      main: './src/main.js',
      module: './src/module.js',
      exports: { '.': './src/index.js' },
    }));
    const snapshot = await loadPackageJsonSnapshot(root, { strict: true });
    expect(snapshot.facts.packageName).toBe('@neutral/manifest');
    expect(snapshot.manifest).toEqual({
      mainPresent: true,
      main: './src/main.js',
      modulePresent: true,
      module: './src/module.js',
      exportsPresent: true,
      exportsValue: { '.': './src/index.js' },
    });
  });
});
