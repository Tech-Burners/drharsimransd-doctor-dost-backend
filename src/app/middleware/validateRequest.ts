import { NextFunction, Request, Response } from 'express';
import { AnyZodObject } from 'zod';
import catchAsync from '../utils/catchAsync';

/**
 * zod validation at the route boundary. Schemas are shaped
 * z.object({ body?, query?, params?, files?, file?, cookies? }).
 */
const validateRequest = (schema: AnyZodObject) => {
  return catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    await schema.parseAsync({
      body: req.body,
      query: req.query,
      params: req.params,
      files: req.files,
      file: req.file,
      cookies: req.cookies,
    });

    next();
  });
};

export default validateRequest;
