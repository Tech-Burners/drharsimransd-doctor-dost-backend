import express from "express";
import { contactUs } from "./contactUs.controller";

const router = express.Router();

// POST /api/v1/contact
router.post("/", contactUs);

export const ContactRoutes = router;
