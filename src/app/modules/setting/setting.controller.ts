import { Request, Response } from "express";
import sendResponse from "../../utils/sendResponse";
import httpStatus from "http-status";
import { settingsService } from "./settting.service";

// Get the privacy policy
const getPrivacyPolicy = async (req: Request, res: Response) => {
        const policy = await settingsService.getSettingsByKey({key: "privacyPolicy"});

        sendResponse(res, {
            statusCode: httpStatus.OK,
            success: true,
            message: "Privacy policy retrieved successfully",
            data: policy || null,
        });
};

// Get the term conditions
const getTermConditions = async (req: Request, res: Response) => {
        const policy = await settingsService.getSettingsByKey({key: "termsAndConditions"});

        sendResponse(res, {
            statusCode: httpStatus.OK,
            success: true,
            message: "Term and conditions retrieved successfully",
            data: policy || null,
        });
};

// Get the term conditions
const getCookiesPolicy = async (req: Request, res: Response) => {
        const policy = await settingsService.getSettingsByKey({key: "cookiesPolicy"});

        sendResponse(res, {
            statusCode: httpStatus.OK,
            success: true,
            message: "Cookies policy retrieved successfully",
            data: policy || null,
        });
};

const getDynamicDocuments = async (req: Request, res: Response) => {
  const { key } = req.params as { 
    key: "privacyPolicy" | "cookiesPolicy" | "termsAndConditions"; 
  };

  const document = await settingsService.getSettingsByKey({ key });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: `${key} retrieved successfully`,
    data: document || null,
  });
};

// Update the privacy policy
const updateSettingsByKey = async (req: Request, res: Response) => {
    try {
        const { key, content } = req.body;
        const updatedPolicy = await settingsService.updateSettingsByKey(key, content);

        sendResponse(res, {
            statusCode: httpStatus.OK,
            success: true,
            message: `${key}  updated successfully`,
            data: updatedPolicy,
        });
    } catch (error: any) {
        console.error("Error updating privacy policy:", error.message);
        sendResponse(res, {
            statusCode: httpStatus.INTERNAL_SERVER_ERROR,
            success: false,
            message: `Failed to update settings`,
            data: null,
        });
    }
};

export const settingsController = {
    getPrivacyPolicy,
    getTermConditions,
    getCookiesPolicy,
    getDynamicDocuments,
    updateSettingsByKey
};
