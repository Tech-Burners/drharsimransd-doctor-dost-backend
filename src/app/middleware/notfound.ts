/* eslint-disable no-unused-vars */
/* eslint-disable @typescript-eslint/no-unused-vars */

import { NextFunction, Request, Response } from 'express';
import { toEnvelope } from '../utils/sendResponse';

const notFound = (req: Request, res: Response, next: NextFunction): any => {
  return res.status(404).json(
    toEnvelope({
      success: false,
      message: 'API Not Found !!',
      data: null,
      meta: { requestId: req.id },
    }),
  );
};

export default notFound;
