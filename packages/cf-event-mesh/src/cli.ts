import { createRequire } from 'node:module';

import { Command } from 'commander';
import ora from 'ora';

import { getEventMeshBindingsForApp } from './cfClient.js';
import { EventMeshAmqpListener, type NormalizedEventMessage } from './eventMeshAmqpListener.js';
import { publishEventToMesh, publishEventToMeshQueue } from './eventMeshPublishClient.js';

const require = createRequire(import.meta.url);

export function buildCli(): Command {
  const program = new Command();

  program
    .name('cf-event-mesh')
    .description('Listen and publish messages to SAP Event Mesh from SAP BTP Cloud Foundry')
    .version('0.1.0');

  program
    .command('publish')
    .description('Publish a message to an SAP Event Mesh topic or queue')
    .argument('<app>', 'CF app name to read bindings from')
    .argument('<destination>', 'Destination name (topic or queue)')
    .argument('<payload>', 'Message payload')
    .option('-q, --queue', 'Publish to a queue instead of a topic', false)
    .option('-c, --content-type <type>', 'Content type of the payload', 'application/json')
    .action(async (app: string, destination: string, payload: string, options: { queue: boolean; contentType: string }) => {
      const spinner = ora(`Fetching bindings for ${app}...`).start();
      try {
        const bindings = await getEventMeshBindingsForApp(app);
        if (bindings.length === 0) {
          spinner.fail(`No enterprise-messaging bindings found for app ${app}`);
          process.exit(1);
        }
        const binding = bindings[0];
        if (!binding) {
          spinner.fail(`No enterprise-messaging bindings found for app ${app}`);
          process.exit(1);
        }
        spinner.text = `Publishing message to ${options.queue ? 'queue' : 'topic'} ${destination}...`;
        
        const status = options.queue
          ? await publishEventToMeshQueue(binding, destination, payload, options.contentType)
          : await publishEventToMesh(binding, destination, payload, options.contentType);
        
        spinner.succeed(`Successfully published message (HTTP ${String(status)})`);
      } catch (error) {
        spinner.fail(`Failed to publish message: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    });

  program
    .command('listen')
    .description('Listen to an SAP Event Mesh queue')
    .argument('<app>', 'CF app name to read bindings from')
    .option('-a, --ack', 'Acknowledge messages to consume them from the queue (default: false)', false)
    .action(async (app: string, queue: string, options: { ack: boolean }) => {
      const spinner = ora(`Fetching bindings for ${app}...`).start();
      try {
        const bindings = await getEventMeshBindingsForApp(app);
        if (bindings.length === 0) {
          spinner.fail(`No enterprise-messaging bindings found for app ${app}`);
          process.exit(1);
        }
        const binding = bindings[0];
        if (!binding) {
          spinner.fail(`No enterprise-messaging bindings found for app ${app}`);
          process.exit(1);
        }
        spinner.text = `Connecting to AMQP endpoint for queue ${queue}...`;
        
         
        const amqpModule = require('@sap/xb-msg-amqp-v100') as unknown;
        
        const listener = new EventMeshAmqpListener(binding, queue, {
          onConnected: (desc) => {
            spinner.succeed(`Connected to Event Mesh: ${desc}`);
            process.stdout.write(`Listening for messages on queue: ${queue}... (Press Ctrl+C to exit)\n`);
          },
          onMessage: (message: NormalizedEventMessage) => {
            process.stdout.write('\n--- New Message ---\n');
            process.stdout.write(`Topic: ${message.topic ?? 'N/A'}\n`);
            process.stdout.write(`Message ID: ${message.messageId ?? 'N/A'}\n`);
            process.stdout.write(`Content Type: ${message.contentType}\n`);
            process.stdout.write(`Headers: ${JSON.stringify(message.headers, null, 2)}\n`);
            process.stdout.write('Body:\n');
            try {
              if (message.contentType.includes('json')) {
                process.stdout.write(`${JSON.stringify(JSON.parse(message.body.toString('utf8')), null, 2)}\n`);
              } else {
                process.stdout.write(`${message.body.toString('utf8')}\n`);
              }
            } catch {
              process.stdout.write(`${message.body.toString('utf8')}\n`);
            }
            process.stdout.write('-------------------\n\n');
          },
          onError: (err) => {
            process.stderr.write(`\n[Error] ${err}\n`);
          }
        }, amqpModule as { Client: new (opts: unknown) => never }, { autoAck: options.ack });
        
        await listener.start();
        
        // Handle shutdown
        process.on('SIGINT', () => {
          process.stdout.write('\nShutting down listener...\n');
          listener.stop();
          process.exit(0);
        });
        
      } catch (error) {
        spinner.fail(`Failed to listen: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    });

  return program;
}

if (import.meta.url === `file://${process.argv[1] ?? ''}`) {
  try {
    await buildCli().parseAsync(process.argv);
  } catch (err: unknown) {
    const errorString = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${errorString}\n`);
    process.exit(1);
  }
}
