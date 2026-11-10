import OpenAI from "openai";
import config from "../config"; // adjust path if needed

/**
 * 🔹 OpenAI Client
 * Make sure OPENAI_API_KEY is set in .env
 */
export const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || config.openai_api_key,
});
