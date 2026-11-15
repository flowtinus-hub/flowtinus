import { readAppSettings } from '../config/app-settings';
import { describeDatabase, openDatabase } from './database';

const { databaseUrl } = readAppSettings();
const db = await openDatabase(databaseUrl);
await db.close();
console.log(`Schema up to date (${describeDatabase(databaseUrl)}).`);
