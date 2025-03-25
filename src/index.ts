import { FillBot } from "./bot.js";

const fillBot = new FillBot();

async function shutdown() {
    try {
      console.log("Received shutdown signal...");
      await fillBot.shutdown();
  
      console.log("Cleanup complete, shutting down...");
      process.exit(0);
    } catch (error) {
      console.error(error);
      process.exit(1);
    }
  }
  
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  fillBot.start();