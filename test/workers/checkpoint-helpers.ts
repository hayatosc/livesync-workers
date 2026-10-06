import { runInDurableObject } from "cloudflare:test";
import { expect } from "vitest";
import type { PersistentVaultDO } from "./entry.js";
/** Explicitly drain maintenance: CouchDB _compact returns 202 while work is pending. */
export async function drainCheckpoint(stub: DurableObjectStub) {
  await runInDurableObject(stub, async (instance: PersistentVaultDO, state) => {
    for (let slices=0; slices<1000; slices++) {
      if (!state.storage.sql.exec("SELECT * FROM checkpoint_work").toArray().length) return;
      await instance.alarm();
    }
    expect.fail("Checkpoint maintenance did not finish");
  });
}

/** Cancel only this test's actors after pending exclusive work, before runtime teardown. */
export async function stopCheckpointAlarms(stubs: DurableObjectStub[]) {
  for (const stub of stubs) await runInDurableObject(stub, async (instance: PersistentVaultDO, state) => {
    const scheduler = instance as unknown as { exclusive(operation: () => Promise<void>): Promise<void> };
    await scheduler.exclusive(async () => { (instance as unknown as {scheduleIndexing():Promise<void>}).scheduleIndexing=async()=>{}; await state.storage.deleteAlarm(); });
  });
}

/** Force a checkpoint turn only in tests targeting one snapshot boundary. */
export async function advanceCheckpoint(instance: PersistentVaultDO, state: DurableObjectState) {
  state.storage.sql.exec("INSERT INTO meta (key,value) VALUES ('maintenance_turn','checkpoint') ON CONFLICT(key) DO UPDATE SET value='checkpoint'");
  await instance.alarm();
}
