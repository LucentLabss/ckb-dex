// Standalone xUDT drip faucet - a separate small service from backend/, so the issuer
// private key never has to live alongside the dex API's own config or database.
import { createExpressServer } from "./app.js";
import AppConfiguration from "./config.js";
import { Database } from "./services/db.js";
import TokenFaucet from "./services/faucet.js";

(async function main() {
  const config = await new AppConfiguration().getEnvironment();

  const database = new Database(config.mongodbUrl);
  await database.connect();

  const faucet = new TokenFaucet(config);
  await faucet.init();

  const app = createExpressServer(faucet);
  const server = app.listen(config.port, () => {
    console.log(`Faucet listening at http://localhost:${config.port}/api/v1/faucet`);
  });

  const shutdown = async (): Promise<void> => {
    console.info("Shutting down faucet");
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    await database.disconnect();
  };

  process.once("SIGINT", () => {
    shutdown().then(() => process.exit(0), (error) => {
      console.error("Shutdown failed", error);
      process.exit(1);
    });
  });

  process.once("SIGTERM", () => {
    shutdown().then(() => process.exit(0), (error) => {
      console.error("Shutdown failed", error);
      process.exit(1);
    });
  });
})().catch((error) => {
  console.error("Fatal faucet startup error", error);
  process.exit(1);
});
