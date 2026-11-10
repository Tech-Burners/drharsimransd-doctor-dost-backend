



import { createLogger, format, transports } from "winston";
import DailyRotateFile from "winston-daily-rotate-file";
import path from "path";
import { Request, Response, NextFunction } from "express";

import {
  blue,
  green,
  greenBright,
  magenta,
  red,
  yellow,
  yellowBright,
} from "colorette";


// Define log file paths
const LOGS_DIR = path.join(process.cwd(), 'logs');
const ERROR_LOG_PATH = path.join(LOGS_DIR, 'app.log');  // For error logs in JSONL format
const RESPONSE_LOG_PATH = path.join(LOGS_DIR, 'ResponseTime.log');  // For response time logs in JSONL format

// Ensure the log directory exists
import fs from 'fs';
if (!fs.existsSync(LOGS_DIR)) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

export const logger = createLogger({
  level: "info",
  format: format.combine(
    format.timestamp({ format: "DD-MM-YYYY HH:mm:ss" }),
    format.errors({ stack: true }),
    format.splat(),
    format.json(),
  ),
  transports: [
    new DailyRotateFile({
      filename: path.join("logs", "error-%DATE%.log"),
      datePattern: "YYYY-MM-DD",
      level: "error",
    }),
    new DailyRotateFile({
      filename: path.join("logs", "combined-%DATE%.log"),
      datePattern: "YYYY-MM-DD",
    }),
    new transports.Console({
      format: format.combine(format.colorize(), format.simple()),
    }),
  ],
});

// JSONL format for error and response logs
const jsonlFormat = format.printf((info) => JSON.stringify(info));

// Error line logger - for logging errors in JSONL format in `app.log`
export const errorLineLogger = createLogger({
  level: "error",
  format: format.combine(
    format.timestamp({ format: () => new Date().toISOString() }),
    jsonlFormat
  ),
  transports: [
    new transports.File({
      filename: ERROR_LOG_PATH,
      level: "error",
      format: format.combine(format.timestamp({ format: () => new Date().toISOString() }), jsonlFormat),
    }),
  ],
});

// Response time logger - for logging response time in JSONL format in `ResponseTime.log`
export const responseLineLogger = createLogger({
  level: "info",
  format: format.combine(
    format.timestamp({ format: () => new Date().toISOString() }),
    jsonlFormat
  ),
  transports: [
    new transports.File({
      filename: RESPONSE_LOG_PATH,
      level: "info",
      format: format.combine(format.timestamp({ format: () => new Date().toISOString() }), jsonlFormat),
    }),
  ],
});


// Middleware to log requests and responses with emojis and extra information
export const logHttpRequests = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const startTime = Date.now();

  res.on("finish", () => {
    const colorizeByStatusCode = (statusCode: number) => {
      if (statusCode >= 200 && statusCode < 300) {
        return green(`${statusCode} 🎉`); // Successful responses
      } else if (statusCode >= 400 && statusCode < 500) {
        return red(`${statusCode} ⚠️`); // Client errors
      } else if (statusCode >= 500) {
        return yellow(`${statusCode} 🔥`); // Server errors
      }
      return blue(`${statusCode} ❗`); // Default color
    };
    const colorizeByMethod = (method: string) => {
      if (method === "GET") {
        return green(method + " 🔍"); // GET requests (read)
      } else if (method === "POST") {
        return blue(method + " ✏️"); // POST requests (create)
      } else if (method === "PATCH") {
        return yellow(method + " ✨"); // PATCH requests (update)
      } else if (method === "PUT") {
        return yellowBright(method + " 🛠️"); // PUT requests (replace)
      }
      return red(method + " " + "some error 😢☹️"); // Default for unknown methods
    };

    // Log the request information with method, status, and response time in ms
    // logger.info({
    //   message: ` 🌐 Incoming Request: ${colorizeByMethod(req.method)} ${colorizeByStatusCode(res.statusCode)} ${magenta(req.originalUrl)} ⏱️ Response Time: ${yellowBright(`${Date.now() - startTime} ms`)}`,
    //   size: res.get("Content-Length") || 0,
    //   // additionalInfo: `🖥️ IP: ${req.ip} | Host: ${req.hostname} | User-Agent: ${req.get("User-Agent")}`,
    // });

    const clientIp = req.ip
      ? req.ip.startsWith("::ffff:")
        ? req.ip.substring(7)
        : req.ip
      : "Unknown IP";

    logger.info({
      message: `🖥️ IP: ${clientIp} 📅: ${new Date().toLocaleDateString("en-US", { weekday: "long" })} 🌐 Incoming Request: ${colorizeByMethod(req.method)} ${colorizeByStatusCode(res.statusCode)} ${magenta(req.originalUrl)} ⏱️ Response Time: ${yellowBright(`${Date.now() - startTime} ms`)}`,
      size: res.get("Content-Length") || 0,
    });
  });

  next();
};



// Error handler middleware to log errors in JSONL format in app.log
export const logErrorHandler = (err: any, req: Request, res: Response, next: NextFunction) => {

  errorLineLogger.error({
    timestamp: new Date().toISOString(),
    level: 'error',
    message: err.message,
    stack: err.stack,
    method: req.method,
    url: req.originalUrl,
    status: res.statusCode,
    ip: req.ip,
    userAgent: req.get('User-Agent') || '',
  });

  next(err);
};