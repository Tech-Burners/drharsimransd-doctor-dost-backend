import { Router } from "express";
import { userRoutes } from "../modules/user/user.route";
import { authRoutes } from "../modules/auth/auth.route";
import { otpRoutes } from "../modules/otp/otp.routes";
import { settingsRoutes } from "../modules/setting/setting.route";
import { ContactRoutes } from "../modules/contactUs/contactUs.route";
import { healthRoutes } from "../modules/health/health.route";

const router = Router();

const moduleRoutes = [
  {
    path: '/health',
    route: healthRoutes,
  },
  {
    path: '/users',
    route: userRoutes,
  },
  {
    path: '/auth',
    route: authRoutes,
  },
  {
    path: "/otp",
    route: otpRoutes
  },
  {
    path: "/settings",
    route: settingsRoutes
  },

  {
    path: "/contactUs",
    route: ContactRoutes
  }

];

moduleRoutes.forEach((route) => router.use(route.path, route.route));

export default router;