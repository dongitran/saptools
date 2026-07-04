---
name: cf-event-mesh
description: Use when a task involves listening to or publishing messages to SAP Event Mesh on SAP BTP Cloud Foundry. Useful for interacting with event queues and topics directly from the CLI without needing an external client.
---

# CF Event Mesh

## Purpose

Use `cf-event-mesh` to interact with SAP Event Mesh (default plan, not Advanced Event Mesh) via the command line. It discovers credentials automatically from `cf env <app-name>` and allows you to listen to queues using AMQP or publish messages to queues/topics using REST.

If `cf-event-mesh` is missing, install it from `@saptools/cf-event-mesh`: `npm install -g @saptools/cf-event-mesh`.

## First Steps

1. Determine the target Cloud Foundry app that is bound to the `enterprise-messaging` service.
2. Ensure you are currently logged in (`cf login`) and targeting the correct space (`cf target -s <space> -o <org>`) where the app resides.
3. Identify whether the user needs to **listen** to a queue or **publish** a message.

## Command Choice

Use `listen` to subscribe to an AMQP queue and output incoming messages to stdout:

```bash
cf-event-mesh listen <app-name> <queue-name>
cf-event-mesh listen <app-name> <queue-name> --ack
```

> **Note on Acknowledgements:**
> By default, the listener does NOT acknowledge messages (`autoAck: false`), meaning messages remain in the queue and can be processed by real consumers later. This is safe for debugging.
> Use the `--ack` flag if you explicitly want to acknowledge (remove) the messages from the queue as they are received.

Use `publish` to send a message payload to a topic or queue via REST:

```bash
cf-event-mesh publish <app-name> queue <queue-name> '{"hello":"world"}'
cf-event-mesh publish <app-name> topic <topic-name> '{"hello":"world"}'
```

The payload should be a valid string, typically JSON.

## Output And State

- The `listen` command streams incoming AMQP messages to `stdout`. It will keep running until interrupted (`Ctrl+C`).
- The `publish` command outputs a success confirmation or an error message and then exits.
- Both commands fetch `VCAP_SERVICES` dynamically using `cf curl /v3/apps/<guid>/env`.

Do not paste credential values (like `clientid`, `clientsecret`, `uri`) in clear text when reporting back.

## Behavior Notes

- `cf-event-mesh` relies on the `enterprise-messaging` service bindings inside the provided `<app-name>`.
- The CLI automatically handles OAuth2 token fetching using the `clientid`, `clientsecret`, and `tokenendpoint` from the service binding.
- For `listen`, it connects via AMQPS to the URI provided in the `amqp10ws` protocol array.
- For `publish`, it connects via HTTPS to the URI provided in the `httprest` protocol array.

## Troubleshooting

If the command fails with `App not found`, verify that the app name is correct and you are targeting the correct CF space:

```bash
cf target
cf apps
```

If the command fails with `No Event Mesh binding found`, verify that the app is actually bound to an `enterprise-messaging` service instance:

```bash
cf services
cf env <app-name>
```

If `publish` fails with HTTP 403 Forbidden or 404 Not Found, ensure the topic or queue exists in the Event Mesh dashboard and the service key/binding has the appropriate publish rules (e.g., namespace prefixes).

If `listen` connects but receives no messages, verify the queue name (often prefixed with a namespace like `company/app/1/MyQueue`) and check if other consumers are actively pulling and acknowledging messages before the CLI can see them.
