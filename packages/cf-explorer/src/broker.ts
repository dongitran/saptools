import process from "node:process";
import { fileURLToPath } from "node:url";

import { runBrokerFromEnv, shutdownActiveBroker } from "./broker/explorer-broker.js";

export { runBrokerFromEnv } from "./broker/explorer-broker.js";

process.on("SIGTERM", () => {
  shutdownActiveBroker(0);
});

process.on("SIGINT", () => {
  shutdownActiveBroker(130);
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await runBrokerFromEnv();
}
