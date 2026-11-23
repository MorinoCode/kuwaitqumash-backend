import {
  BufferJSON,
  initAuthCreds,
  proto,
} from "@whiskeysockets/baileys";
import { QueryTypes } from "sequelize";
import sequelize from "../config/database.js";
import logger from "./logger.js";

let tableEnsured = false;

export const ensureWhatsAppAuthTable = async (db = sequelize) => {
  if (tableEnsured && db === sequelize) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS public.whatsapp_auth_states (
      session_key TEXT NOT NULL,
      key_id TEXT NOT NULL,
      data_json TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (session_key, key_id)
    );
  `);
  if (db === sequelize) {
    tableEnsured = true;
  }
};

export const clearPostgresAuthState = async (sessionKey, db = sequelize) => {
  try {
    await ensureWhatsAppAuthTable(db);
    await db.query(
      `DELETE FROM public.whatsapp_auth_states WHERE session_key = $1`,
      { bind: [sessionKey], type: QueryTypes.DELETE },
    );
  } catch (err) {
    logger.warn("Failed to clear PostgreSQL WhatsApp auth state", {
      component: "whatsapp-pg-auth",
      sessionKey,
      error: err?.message,
    });
  }
};

const serializeValue = (value) => JSON.stringify(value, BufferJSON.replacer);

const deserializeValue = (raw) => {
  if (typeof raw !== "string") return null;
  return JSON.parse(raw, BufferJSON.reviver);
};

/**
 * Baileys v7 production-ready PostgreSQL auth state.
 * Supports all Signal key categories including v7 LID keys:
 * lid-mapping, device-list, tctoken, pre-key, session, sender-key,
 * sender-key-memory, app-state-sync-key, app-state-sync-version.
 */
export const usePostgresAuthState = async (sessionKey, db = sequelize) => {
  await ensureWhatsAppAuthTable(db);

  const readKey = async (keyId) => {
    const rows = await db.query(
      `SELECT data_json
       FROM public.whatsapp_auth_states
       WHERE session_key = $1 AND key_id = $2
       LIMIT 1`,
      { bind: [sessionKey, keyId], type: QueryTypes.SELECT },
    );
    if (!rows?.length) return null;
    return deserializeValue(rows[0].data_json);
  };

  const writeKey = async (keyId, data) => {
    await db.query(
      `INSERT INTO public.whatsapp_auth_states (session_key, key_id, data_json, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (session_key, key_id)
       DO UPDATE SET data_json = EXCLUDED.data_json, updated_at = NOW()`,
      {
        bind: [sessionKey, keyId, serializeValue(data)],
        type: QueryTypes.INSERT,
      },
    );
  };

  const creds = (await readKey("creds")) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          if (!Array.isArray(ids) || ids.length === 0) return data;

          const keyIds = ids.map((id) => `${type}-${id}`);
          const rows = await db.query(
            `SELECT key_id, data_json
             FROM public.whatsapp_auth_states
             WHERE session_key = $1 AND key_id = ANY($2::text[])`,
            { bind: [sessionKey, keyIds], type: QueryTypes.SELECT },
          );

          const map = new Map();
          for (const row of rows || []) {
            map.set(row.key_id, deserializeValue(row.data_json));
          }

          for (const id of ids) {
            let value = map.get(`${type}-${id}`) ?? null;
            if (type === "app-state-sync-key" && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            data[id] = value;
          }
          return data;
        },
        set: async (categories) => {
          const upserts = [];
          const deletes = [];

          for (const [category, entries] of Object.entries(categories || {})) {
            for (const [id, value] of Object.entries(entries || {})) {
              const keyId = `${category}-${id}`;
              if (value !== null && value !== undefined) {
                upserts.push([keyId, serializeValue(value)]);
              } else {
                deletes.push(keyId);
              }
            }
          }

          if (upserts.length > 0) {
            const valuesSql = upserts
              .map((_, idx) => `($1, $${idx * 2 + 2}, $${idx * 2 + 3}, NOW())`)
              .join(", ");
            const bind = [sessionKey];
            for (const [k, v] of upserts) {
              bind.push(k, v);
            }
            await db.query(
              `INSERT INTO public.whatsapp_auth_states (session_key, key_id, data_json, updated_at)
               VALUES ${valuesSql}
               ON CONFLICT (session_key, key_id)
               DO UPDATE SET data_json = EXCLUDED.data_json, updated_at = NOW()`,
              { bind, type: QueryTypes.INSERT },
            );
          }

          if (deletes.length > 0) {
            await db.query(
              `DELETE FROM public.whatsapp_auth_states
               WHERE session_key = $1 AND key_id = ANY($2::text[])`,
              { bind: [sessionKey, deletes], type: QueryTypes.DELETE },
            );
          }
        },
      },
    },
    saveCreds: async () => {
      await writeKey("creds", creds);
    },
  };
};
