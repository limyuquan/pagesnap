import 'fake-indexeddb/auto';
import { afterEach } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { closeDb } from '@/shared/db';

afterEach(async () => {
  fakeBrowser.reset();
  await closeDb();
  // Fresh database for every test.
  indexedDB.deleteDatabase('pagesnap');
});
