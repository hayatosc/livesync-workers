import { it, expect } from "vitest";
import { authorizedVaults, vaultBindings, vaultConfigs, vaultFor, vaultHost, semanticSearchOn } from "./host.js";
import type { Env } from "./env.js";
import { vaultObjectName } from "livesync-workers";
const env = {
  SESSION_SECRET: "test-secret",
  CONTENT_BUCKET: {},
  FTS_BUCKET: {},
  VAULT_DB: {},
  ALICE_PASSWORD: "alice-secret",
  BOB_PASSWORD: "bob-secret",
  VAULTS_JSON: JSON.stringify([
    {
      vaultId: "stable-a",
      tenantId: "tenant-a",
      databaseName: "work",
      displayName: "仕事",
      ownerId: "admin",
      readers: ["viewer"],
      username: "alice",
      passwordSecret: "ALICE_PASSWORD",
    },
    {
      vaultId: "stable-b",
      tenantId: "tenant-b",
      databaseName: "private",
      displayName: "個人",
      ownerId: "bob",
      username: "bob",
      passwordSecret: "BOB_PASSWORD",
    },
  ]),
} as unknown as Env;
it("authorizes every vault selection and credential without trusting key prefixes", async () => {
  const host = vaultHost(env);
  const alice = await host.verifyCredential("alice", "alice-secret");
  expect(alice?.vaultId).toBe("stable-a");
  expect(await host.verifyCredential("alice", "bob-secret")).toBeNull();
  expect(authorizedVaults(env, "viewer").map((vault) => vault.vaultId)).toEqual(["stable-a"]);
  expect(authorizedVaults(env, "viewer", true)).toEqual([]);
  expect(() => vaultFor(env, "stable-b", "admin")).toThrow("access denied");
  expect(() => vaultFor(env, "stable-a", "viewer", true)).toThrow("access denied");
  expect(vaultFor(env, "stable-a", "viewer").ref.vaultId).toBe("stable-a");
  await expect(
    host.loadVaultPolicy({ tenantId: "tenant-b", vaultId: "stable-a", databaseName: "work" }),
  ).rejects.toThrow("Unknown vault");
  expect(vaultObjectName(alice!)).toBe(vaultObjectName({ ...alice!, databaseName: "renamed" }));
  expect(semanticSearchOn(env)).toBe(false);
  expect(vaultBindings(env).fileMirror).toBe(true);
});
it("rejects duplicate selectors and unknown credential secret references", () => {
  const configs = vaultConfigs(env);
  expect(() => vaultConfigs({ ...env, VAULTS_JSON: JSON.stringify([configs[0], configs[0]]) })).toThrow("Duplicate");
  expect(() =>
    vaultConfigs({ ...env, VAULTS_JSON: JSON.stringify([{ ...configs[0], passwordSecret: "bad-secret" }]) }),
  ).toThrow("Invalid");
});
