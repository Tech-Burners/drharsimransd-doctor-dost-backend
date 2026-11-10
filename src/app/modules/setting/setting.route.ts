import { Router } from "express";
import { settingsController } from "./setting.controller";
import auth from "../../middleware/auth";
import { USER_ROLE } from "../user/user.constants";

export const settingsRoutes = Router();


settingsRoutes
     // Route to get the privacy policy
    .get("/privacy", settingsController.getPrivacyPolicy)
    .get("/termAndConditions", settingsController.getTermConditions)
    .get("/cookiesPolicy", settingsController.getCookiesPolicy)
    .get("/:key", settingsController.getDynamicDocuments)
    // Route to create or update the privacy policy
    .put(
          "/", 
          auth(USER_ROLE.ADMIN),
          settingsController.updateSettingsByKey
     );
