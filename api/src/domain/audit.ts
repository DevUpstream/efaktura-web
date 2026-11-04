import { auditLog } from "../db/schema.js";
import type { Db } from "../db/types.js";

export interface Actor { userId?: number; agentKeyId?: number; ip?: string }

export async function audit(db: Db, actor: Actor, e: {
  clientId?: number | null; entity: string; entityId: string | number; action: string; changes?: unknown;
}) {
  await db.insert(auditLog).values({
    userId: actor.userId, agentKeyId: actor.agentKeyId, ip: actor.ip,
    clientId: e.clientId ?? null, entity: e.entity, entityId: String(e.entityId), action: e.action,
    changes: e.changes ?? null,
  });
}
