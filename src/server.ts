const dns = require("dns");
dns.setServers(['8.8.8.8', '8.8.4.4']);


import {  createServer, Server } from 'http';
import app from './app';
import colors from 'colors'; // Ensure correct import
import config from './app/config';
import createDefaultAdmin from './app/DB/createDefaultAdmin';
import { initSocketIO } from './socketIo';
import { logger } from './shared/logger';
import { connectMongo } from './shared/db';
import { captureException, flushSentry, initSentry } from './shared/sentry';
// import { startSubscriptionCronJobs } from './app/modules/payment/payment.cron';
import 'dotenv/config';

initSentry('api');

// Create a new HTTP server
const socketServer = createServer();


let server: Server;

async function main() {
  try {

    const dbStartTime = Date.now();
    const loadingFrames = ["🌍", "🌎", "🌏"]; // Loader animation frames
    let frameIndex = 0;

    // Start the connecting animation
    const loader = setInterval(() => {
      process.stdout.write(
        `\rMongoDB connecting ${loadingFrames[frameIndex]} Please wait 😢`,
      );
      frameIndex = (frameIndex + 1) % loadingFrames.length;
    }, 300); // Update frame every 300ms


    // console.log('config.database_url', config.database_url);


    // Connect to MongoDB with a timeout
    // maxPoolSize comes from MONGO_MAX_POOL_SIZE (see shared/db.ts).
    await connectMongo();


    // Stop the connecting animation
    clearInterval(loader);
    logger.info(
      `\r✅ Mongodb connected successfully in ${Date.now() - dbStartTime}ms`,
    );

    // ✅ START CRON JOBS HERE
    // startSubscriptionCronJobs();

    //create a defult admin
    createDefaultAdmin()


    // Start HTTP server
    server = createServer(app);

    server.listen(Number(config.port), () => {
      console.log(
        colors.green(`---> DoctorDost server is listening on  : http://${config.ip}:${config.port}`).bold,
      );
    // Initialize Socket.IO
    initSocketIO(socketServer);

    });
  } catch (err) {
    console.error('Error starting the server:', err);
    console.log(err);
  }
}

main();

// Graceful shutdown for unhandled rejections
process.on('unhandledRejection', async (err) => {
  logger.error({ err }, 'Unhandled rejection detected');
  captureException(err);
  await flushSentry();
  if (server) {
    server.close(() => {
      process.exit(1);
    });
  }
  process.exit(1); // Ensure process exits
});

// Graceful shutdown for uncaught exceptions
process.on('uncaughtException', (err) => {
  logger.error({ err }, 'Uncaught exception detected');
  captureException(err);
  if (server) {
    server.close(() => {
      process.exit(1);
    });
  }
});
