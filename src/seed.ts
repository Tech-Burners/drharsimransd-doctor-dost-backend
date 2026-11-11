// Seed script: creates the single PlatformSetting document and one admin user from env.
// Safe to run repeatedly; it never overwrites or duplicates anything.
//   npm run seed
import 'dotenv/config';
import mongoose from 'mongoose';
import config from './app/config';
import createDefaultAdmin from './app/DB/createDefaultAdmin';
import { PlatformSetting } from './app/modules/platformSetting/platformSetting.model';
import { User } from './app/modules/user/user.model';
import { USER_ROLE } from './app/modules/user/user.constants';
import { connectMongo } from './shared/db';
import { logger } from './shared/logger';

export const seed = async (): Promise<void> => {
  if (!config.admin_email || !config.admin_password) {
    throw new Error('ADMIN_EMAIL and ADMIN_PASSWORD must be set to seed the admin user');
  }

  if (await PlatformSetting.exists({})) {
    logger.info('PlatformSetting already exists, left unchanged');
  } else {
    // Schema defaults. dayStartTime is a placeholder: when the night window ends is an
    // open client question (see CLAUDE.md), so it is not decided here.
    await PlatformSetting.create({});
    logger.info('PlatformSetting created with schema defaults');
  }

  if (await User.exists({ role: USER_ROLE.ADMIN })) {
    logger.info('Admin user already exists, left unchanged');
  } else {
    await createDefaultAdmin();
    logger.info({ email: config.admin_email }, 'Admin user created');
  }
};

if (require.main === module) {
  connectMongo()
    .then(seed)
    .then(() => mongoose.disconnect())
    .catch(async (err) => {
      logger.error({ err }, 'seed failed');
      await mongoose.disconnect().catch(() => undefined);
      process.exit(1);
    });
}
