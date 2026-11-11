import { Request, Response } from 'express';
import httpStatus from 'http-status';
import catchAsync from '../../utils/catchAsync';
import sendResponse from '../../utils/sendResponse';
import { callService } from './call.service';

// Controllers unwrap and delegate. The subject is always req.user (the verified token).
const actorOf = (req: Request) => ({ userId: req.user.userId as string, role: req.user.role as string });

const start = catchAsync(async (req: Request, res: Response) => {
  const data = await callService.start(actorOf(req), { doctorId: req.body.doctorId, isUrgent: req.body.isUrgent });
  sendResponse(res, { statusCode: httpStatus.CREATED, success: true, message: 'Calling the doctor', data });
});

const accept = catchAsync(async (req: Request, res: Response) => {
  const data = await callService.accept(actorOf(req), req.params.id);
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: 'Call accepted', data });
});

const reject = catchAsync(async (req: Request, res: Response) => {
  const data = await callService.reject(actorOf(req), req.params.id);
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: 'Call rejected', data });
});

const end = catchAsync(async (req: Request, res: Response) => {
  const data = await callService.requestEnd(actorOf(req), req.params.id);
  sendResponse(res, { statusCode: httpStatus.ACCEPTED, success: true, message: 'End noted; the call is closed from the server-side events', data });
});

const list = catchAsync(async (req: Request, res: Response) => {
  const { rows, meta } = await callService.list(actorOf(req), Number(req.query.page) || 1, Number(req.query.limit) || 10);
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: 'Calls fetched successfully', data: rows, meta });
});

const getOne = catchAsync(async (req: Request, res: Response) => {
  const data = await callService.getOne(actorOf(req), req.params.id);
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: 'Call fetched successfully', data });
});

export const callControllers = { start, accept, reject, end, list, getOne };
