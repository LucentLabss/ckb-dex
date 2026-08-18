import { createExpressServer } from "./app.js";
import AppConfiguration from "./config.js";
import { Database } from "./services";
import type { Express } from "express";
import { Config } from "./types";

export let config: Config | undefined = undefined;

(async function main() {
  config = await new AppConfiguration().getEnvironment();
  const databaseConnection = new Database(config.mongodbUrl);

  /**Connect to database before any other server startup action */
  databaseConnection.connect()

  const app = createExpressServer(config);

  const server = app.listen(config.port, () => {
    console.log(`Server listening at: http://localhost:${config?.port}/api/v${config?.apiVersion}`)
  })

  const shutdown = async (): Promise<void> => {
    console.info('Shutting down Veil backend API');
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    await databaseConnection.disconnect();
  };

  /** For Graceful shutdown */
  process.once('SIGINT', () => {
    shutdown().then(() => process.exit(0), (error) => {
      console.error('Shutdown failed');
      process.exit(1);
    });
  });

  process.once('SIGTERM', () => {
    shutdown().then(() => process.exit(0), (error) => {
      console.error('Shutdown failed');
      process.exit(1);
    });
  });
})()
