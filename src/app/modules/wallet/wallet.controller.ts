import { Request, Response } from 'express';
import httpStatus from 'http-status';
import catchAsync from '../../utils/catchAsync';
import sendResponse from '../../utils/sendResponse';
import { walletService } from './wallet.service';
import { paymentService } from '../payment/payment.service';

// The subject is always req.user (the verified token). Nothing here reads a user id,
// amount or balance from the request.
const getWallet = catchAsync(async (req: Request, res: Response) => {
  const page = Number(req.query.page) || 1;
  const limit = Number(req.query.limit) || 10;
  const { balancePaise, ledger, meta } = await walletService.getWalletView({ userId: req.user.userId }, page, limit);
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Wallet fetched successfully',
    data: { balancePaise, topupLimits: await paymentService.getTopupLimits(), ledger },
    meta,
  });
});

const createOrder = catchAsync(async (req: Request, res: Response) => {
  const data = await paymentService.createOrder({ userId: req.user.userId }, req.body.amountRupees, { ip: req.ip || '' });
  sendResponse(res, { statusCode: httpStatus.CREATED, success: true, message: 'Order created', data });
});

export const walletControllers = { getWallet, createOrder };
