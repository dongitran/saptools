import fs from 'node:fs';
import path from 'node:path';

import { Command } from 'commander';
import ora from 'ora';

import { discoverApiEntities, type ApiCatalogDiscoveryOptions } from './discovery.js';

interface CliOptions {
  readonly app: string;
  readonly url: string;
  readonly cfHome?: string;
  readonly json?: boolean;
  readonly token?: string;
  readonly out?: string;
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
  .action(async () => {
    const options = program.opts<CliOptions>();

    // Only use spinner if not outputting raw JSON to console
    const isQuiet = options.json === true && options.out === undefined;
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

      const entities = await discoverApiEntities(discoveryOptions);

      spinner?.stop();

      const outputJson = JSON.stringify(entities, null, 2);

      if (options.out !== undefined) {
        fs.writeFileSync(path.resolve(process.cwd(), options.out), outputJson, 'utf8');
        process.stdout.write(`\nSuccessfully saved ${String(entities.length)} endpoints to ${options.out}\n\n`);
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
