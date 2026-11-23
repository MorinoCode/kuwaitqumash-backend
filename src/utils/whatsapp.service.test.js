import test from "node:test";
import assert from "node:assert/strict";
import { DisconnectReason } from "@whiskeysockets/baileys";
import {
  extractConnectedPhone,
  getReconnectDelayMs,
  isTerminalDisconnectReason,
} from "./whatsapp.service.js";
import {
  usePostgresAuthState,
  clearPostgresAuthState,
} from "./whatsappPgAuthState.js";

test("extractConnectedPhone handles standard JID, device JID, and Baileys v7 LID + phoneNumber", () => {
  assert.equal(
    extractConnectedPhone({ id: "96550123456:14@s.whatsapp.net" }),
    "96550123456"
  );
  assert.equal(
    extractConnectedPhone({ id: "96550123456@s.whatsapp.net" }),
    "96550123456"
  );
  assert.equal(
    extractConnectedPhone({
      id: "123456789012345@lid",
      phoneNumber: "+96550123456@s.whatsapp.net",
    }),
    "96550123456"
  );
  assert.equal(extractConnectedPhone({ id: "123456789012345@lid" }), null);
  assert.equal(extractConnectedPhone(null), null);
});

test("getReconnectDelayMs applies capped exponential backoff", () => {
  assert.equal(getReconnectDelayMs(1), 3000);
  assert.equal(getReconnectDelayMs(2), 6000);
  assert.equal(getReconnectDelayMs(3), 12000);
  assert.equal(getReconnectDelayMs(4), 24000);
  assert.equal(getReconnectDelayMs(5), 30000);
  assert.equal(getReconnectDelayMs(9), 30000);
});

test("isTerminalDisconnectReason flags loggedOut, connectionReplaced, badSession, and forbidden only", () => {
  assert.equal(isTerminalDisconnectReason(DisconnectReason.loggedOut), true);
  assert.equal(isTerminalDisconnectReason(DisconnectReason.connectionReplaced), true);
  assert.equal(isTerminalDisconnectReason(DisconnectReason.badSession), true);
  assert.equal(isTerminalDisconnectReason(DisconnectReason.forbidden), true);

  assert.equal(isTerminalDisconnectReason(DisconnectReason.restartRequired), false);
  assert.equal(isTerminalDisconnectReason(DisconnectReason.connectionLost), false);
  assert.equal(isTerminalDisconnectReason(DisconnectReason.timedOut), false);
  assert.equal(isTerminalDisconnectReason(undefined), false);
});

test("usePostgresAuthState stores, loads, and clears creds and Baileys v7 LID keys", async () => {
  const store = new Map();
  const mockDb = {
    async query(sql, { bind = [] } = {}) {
      if (sql.includes("CREATE TABLE")) return [];
      if (sql.includes("SELECT data_json") && sql.includes("key_id = $2")) {
        const val = store.get(`${bind[0]}:${bind[1]}`);
        return val ? [{ data_json: val }] : [];
      }
      if (sql.includes("SELECT key_id, data_json")) {
        const sessionKey = bind[0];
        const ids = bind[1] || [];
        return ids
          .filter((k) => store.has(`${sessionKey}:${k}`))
          .map((k) => ({ key_id: k, data_json: store.get(`${sessionKey}:${k}`) }));
      }
      if (sql.includes("INSERT INTO public.whatsapp_auth_states")) {
        const sessionKey = bind[0];
        for (let i = 1; i < bind.length; i += 2) {
          store.set(`${sessionKey}:${bind[i]}`, bind[i + 1]);
        }
        return [];
      }
      if (sql.includes("DELETE FROM public.whatsapp_auth_states")) {
        const sessionKey = bind[0];
        if (bind.length === 1) {
          for (const k of Array.from(store.keys())) {
            if (k.startsWith(`${sessionKey}:`)) store.delete(k);
          }
        } else {
          for (const id of bind[1] || []) {
            store.delete(`${sessionKey}:${id}`);
          }
        }
        return [];
      }
      return [];
    },
  };

  const auth = await usePostgresAuthState("qummash_branch_1", mockDb);
  await auth.saveCreds();
  assert.ok(store.has("qummash_branch_1:creds"));

  await auth.state.keys.set({
    "lid-mapping": { "96550123456": "123456@lid" },
    "device-list": { "96550123456": ["0", "1"] },
    tctoken: { "96550123456": Buffer.from("abc") },
  });

  const lidRes = await auth.state.keys.get("lid-mapping", ["96550123456"]);
  assert.equal(lidRes["96550123456"], "123456@lid");

  const tokenRes = await auth.state.keys.get("tctoken", ["96550123456"]);
  assert.ok(Buffer.isBuffer(tokenRes["96550123456"]));
  assert.equal(tokenRes["96550123456"].toString(), "abc");

  await auth.state.keys.set({ "lid-mapping": { "96550123456": null } });
  const afterDel = await auth.state.keys.get("lid-mapping", ["96550123456"]);
  assert.equal(afterDel["96550123456"], null);

  await clearPostgresAuthState("qummash_branch_1", mockDb);
  assert.equal(store.size, 0);
});
