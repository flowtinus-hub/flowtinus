import { appKeyring } from '../shared/config/app-keyring';
import { readAppSettings } from '../shared/config/app-settings';
import { describeDatabase } from '../shared/database/database';
import { openDatabaseOrExit } from '../shared/database/open-or-exit';
import { seedDev, seedLocal } from '../shared/database/seed-dev';
import { createLogger } from '../shared/logging/logger';
import { processName } from '../shared/runtime/container-name';
import { followRunEvents } from '../features/runs/run-events';
import { createApp } from './app';

const config = readAppSettings();
const logger = createLogger({ service: 'api', instance: await processName(), level: config.logLevel, format: config.logFormat });
const db = await openDatabaseOrExit(config.databaseUrl);
if (config.localRepo) {
    await seedLocal(db);
} else if (config.environment === 'DEV') {
    await seedDev(db);
}

const keyring = appKeyring(config, line => logger.warn(line));
// the runs go on in the supervisor (another process): what they do reaches the editor through Postgres NOTIFY
await followRunEvents(db);
const app = createApp(db, config.environment, keyring, logger, {
    editorUrl: config.editorUrl,
    git: { clonesDir: config.gitClonesDir, localRepo: config.localRepo },
});

// the environments' branches are fetched on their interval, in the server only (never the supervisors); a local server
// has no remote: it scans its clone instead
if (app.diskPoller) {
    app.diskPoller.start();
} else {
    app.gitPoller.start();
}

logger.info(`api on :${config.port}`, {
    port: config.port,
    environment: config.environment,
    ...(config.localRepo ? { localRepo: config.localRepo } : {}),
    database: describeDatabase(config.databaseUrl),
    logLevel: config.logLevel,
});
// seconds a connection may stay quiet (Bun's default, 10, closes a run's SSE stream while it waits for a worker)
export default { port: config.port, fetch: app.fetch, idleTimeout: 60 };
