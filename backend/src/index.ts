// Starts the backend HTTP and WebSocket services after MongoDB is ready and handles graceful shutdown.
import { createExpressServer } from "./app.js";
import DexOrderBot from "./bot/index.js";
import AppConfiguration from "./config.js";
import { Database } from "./services";
import { Config } from "./types";

export let config: Config | undefined = undefined;

(async function main() {
  config = await new AppConfiguration().getEnvironment();
  const databaseConnection = new Database(config.mongodbUrl);

  /**Connect to database before any other server startup action */
  await databaseConnection.connect();

  const app = createExpressServer(config, {
    isReady: () => databaseConnection.isConnected(),
  });

  const server = app.listen(config.port, () => {
    console.log(`Server listening at: http://localhost:${config?.port}/api/v${config?.apiVersion}`)
  })

  const realtime = (app as any).locals.realtime;
  if (realtime) {
    realtime.attach(server);
  }

  //Start dex order bot
  const dexOrderBot = new DexOrderBot(config);
  dexOrderBot.start();

  const shutdown = async (): Promise<void> => {
    console.info('Shutting down Veil backend API');
    dexOrderBot.stop();
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
      console.error('Shutdown failed', error);
      process.exit(1);
    });
  });

  process.once('SIGTERM', () => {
    shutdown().then(() => process.exit(0), (error) => {
      console.error('Shutdown failed', error);
      process.exit(1);
    });
  });
})().catch((error) => {
  console.error("Fatal startup error", error);
  process.exit(1);
});
