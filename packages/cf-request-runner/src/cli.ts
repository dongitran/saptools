import fs from 'node:fs';
import path from 'node:path';

import { Command } from 'commander';
import ora from 'ora';

import { discoverApiEntitiesWithToken, type ApiCatalogDiscoveryOptions } from './discovery.js';
import { buildCurlCommands, formatResponse, promptAndRunRequest } from './runner.js';

interface CliOptions {
  readonly app: string;
  readonly url: string;
  readonly cfHome?: string;
  readonly json?: boolean;
  readonly token?: string;
  readonly out?: string;
  readonly curl?: boolean;
  readonly interactive?: boolean;
}

interface PackageMetadata {
  readonly version: string;
}

const program = new Command();

function readPackageVersion(): string {
  try {
    const raw = fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return isPackageMetadata(parsed) ? parsed.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function isPackageMetadata(value: unknown): value is PackageMetadata {
  return (
    typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && typeof (value as { readonly version?: unknown }).version === 'string'
    && (value as { readonly version: string }).version.length > 0
  );
}

function resolveBearerToken(cliToken: string | undefined): string | undefined {
  const token = cliToken ?? process.env['CF_REQUEST_RUNNER_TOKEN'];
  const trimmed = token?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

program
  .name('cf-request-runner')
  .description('Auto-discover all API endpoints of an SAP CAP CDS service on Cloud Foundry')
  .version(readPackageVersion())
  .requiredOption('-a, --app <appId>', 'CF Application Name')
  .requiredOption('-u, --url <baseUrl>', 'Base URL of the deployed application (e.g., https://my-app.cfapps.us10.hana.ondemand.com)')
  .option('--cf-home <dir>', 'Custom CF_HOME directory (optional)')
  .option('--token <bearerToken>', 'Provide your own Bearer token (bypasses CF XSUAA token fetch)')
  .option('--json', 'Output results in JSON format')
  .option('--out <filePath>', 'Save JSON output to a specific file')
  .option('--curl', 'Output ready-to-run curl commands for every discovered endpoint and method')
  .option('-i, --interactive', 'Interactively select and execute a discovered endpoint')
  .action(async () => {
    const options = program.opts<CliOptions>();

    // Only use spinner if not outputting raw JSON to console
    const isQuiet = (options.json === true && options.out === undefined) || options.curl === true;
    const spinner = isQuiet ? null : ora('Initializing discovery...').start();

    try {
      const discoveryOptions: ApiCatalogDiscoveryOptions = {
        appId: options.app,
        baseUrl: options.url,
        cfHomeDir: options.cfHome,
        token: resolveBearerToken(options.token),
        log: (msg) => {
          if (spinner !== null) {
            spinner.text = msg;
          }
        },
        onDeepDiscoveryStart: () => {
          if (spinner !== null) {
            spinner.text = 'Performing deep discovery on root endpoints...';
          }
        }
      };

      const discoveryResult = await discoverApiEntitiesWithToken(discoveryOptions);
      const { entities, token } = discoveryResult;

      spinner?.stop();

      const outputJson = JSON.stringify(entities, null, 2);

      if (options.out !== undefined) {
        const targetPath = path.resolve(process.cwd(), options.out);
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.writeFileSync(targetPath, outputJson, 'utf8');
        process.stdout.write(`\nSuccessfully saved ${String(entities.length)} endpoints to ${options.out}\n\n`);
      }

      if (options.interactive === true) {
        if (entities.length === 0) {
          process.stdout.write('\nNo API endpoints discovered.\n\n');
          return;
        }
        const result = await promptAndRunRequest({
          appId: options.app,
          baseUrl: options.url,
          token,
          entities,
        });
        process.stdout.write(`\n${formatResponse(result)}\n`);
      } else if (options.curl === true) {
        if (entities.length === 0) {
          process.stdout.write('\nNo API endpoints discovered.\n\n');
          return;
        }
        const commands = buildCurlCommands({
          baseUrl: options.url,
          token,
          entities,
        });
        process.stdout.write(`${commands.join('\n')}\n`);
      } else if (options.json) {
        process.stdout.write(`${outputJson}\n`);
      } else {
        if (entities.length === 0) {
          process.stdout.write('\nNo API endpoints discovered.\n\n');
          return;
        }

        process.stdout.write(`\nDiscovered ${String(entities.length)} API endpoints for ${options.app}:\n\n`);
        for (const entity of entities) {
          process.stdout.write(`- ${entity.name}\n  Path:    ${entity.path}\n  Methods: ${entity.methods.join(', ')}\n\n`);
        }
      }
    } catch (error) {
      spinner?.fail('Discovery failed');
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  });

program.parse(process.argv);
