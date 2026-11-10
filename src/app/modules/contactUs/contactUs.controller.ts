import catchAsync from "../../utils/catchAsync";
import { Request, Response } from "express";
import { ContactService } from "./contactUs.service";
import sendResponse from "../../utils/sendResponse";



export const contactUs = catchAsync(async (req: Request, res: Response) => {
  const result = await ContactService.contactUs(req.body);

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Message sent successfully",
    data: result,
  });
});
