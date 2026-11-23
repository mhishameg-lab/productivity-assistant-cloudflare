export async function getOrCreateChannelUser(db, channel, externalUserId, createdAt) {
  if (!channel || !externalUserId || !createdAt) {
    throw new TypeError("Channel, external user ID, and creation time are required.");
  }

  await db.prepare(
    `INSERT INTO users (id, channel, external_user_id, created_at)
     VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(channel, external_user_id) DO NOTHING`
  ).bind(`USER-${crypto.randomUUID()}`, channel, externalUserId, createdAt).run();

  const user = await db.prepare(
    `SELECT id, channel, external_user_id
       FROM users
      WHERE channel = ?1 AND external_user_id = ?2`
  ).bind(channel, externalUserId).first();

  if (!user) throw new Error("Could not retrieve the channel user record.");
  return user;
}

export async function claimChannelUpdate(db, update, userId, now, leaseSeconds = 120) {
  if (!update || !update.channel || !update.id || !userId) {
    throw new TypeError("Update identity and user are required.");
  }
  const nowMs = Date.parse(now);
  if (Number.isNaN(nowMs) || !Number.isInteger(leaseSeconds) || leaseSeconds < 1) {
    throw new TypeError("Update claim timestamp or lease is invalid.");
  }
  const leaseUntil = new Date(nowMs + leaseSeconds * 1000).toISOString();
  const result = await db.prepare(
    `INSERT INTO channel_updates (
       id, channel, external_update_id, user_id, received_at,
       processing_status, lease_until, attempt_count
     ) VALUES (?1, ?2, ?3, ?4, ?5, 'processing', ?6, 1)
     ON CONFLICT(channel, external_update_id) DO UPDATE SET
       user_id = excluded.user_id,
       received_at = excluded.received_at,
       processing_status = 'processing',
       lease_until = excluded.lease_until,
       attempt_count = channel_updates.attempt_count + 1
     WHERE channel_updates.processing_status = 'failed'
        OR (channel_updates.processing_status = 'processing'
            AND channel_updates.lease_until < ?5)
     RETURNING id`
  ).bind(
    `UPD-${crypto.randomUUID()}`,
    update.channel,
    update.id,
    userId,
    now,
    leaseUntil
  ).first();

  return result ? { claimed: true, id: result.id } : { claimed: false };
}

export async function finishChannelUpdate(db, update, status, processedAt) {
  if (!["processed", "processed_with_error", "failed"].includes(status)) {
    throw new TypeError("Update result status is invalid.");
  }
  const result = await db.prepare(
    `UPDATE channel_updates
        SET processing_status = ?1,
            processed_at = ?2,
            lease_until = NULL
      WHERE channel = ?3 AND external_update_id = ?4
        AND processing_status = 'processing'`
  ).bind(status, processedAt, update.channel, update.id).run();

  if (!result.meta || result.meta.changes !== 1) {
    throw new Error("Could not finalize the claimed channel update.");
  }
}

export async function insertChannelMessage(db, message) {
  const id = `MSG-${crypto.randomUUID()}`;
  await db.prepare(
    `INSERT INTO channel_messages (
       id, channel, external_chat_id, external_message_id, user_id,
       direction, message_type, category, content, related_task_id,
       related_routine_id, delivery_status, error_details, callback_information,
       created_at
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
     ON CONFLICT(channel, external_chat_id, external_message_id, direction) DO NOTHING`
  ).bind(
    id,
    message.channel,
    message.conversationId || null,
    message.externalMessageId || null,
    message.userId || null,
    message.direction,
    message.type,
    message.category || null,
    message.content || null,
    message.relatedTaskId || null,
    message.relatedRoutineId || null,
    message.deliveryStatus || null,
    message.errorDetails || null,
    message.callbackInformation || null,
    message.createdAt
  ).run();
  return id;
}

export async function insertChannelAction(db, action) {
  const id = `ACT-${crypto.randomUUID()}`;
  await db.prepare(
    `INSERT INTO channel_actions (
       id, channel, user_id, external_action_id, action_identifier,
       action_name, related_record_id, result, error_details, created_at
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
     ON CONFLICT(channel, external_action_id) DO UPDATE SET
       result = excluded.result,
       error_details = excluded.error_details`
  ).bind(
    id,
    action.channel,
    action.userId,
    action.externalActionId,
    action.identifier,
    action.actionName,
    action.relatedRecordId || null,
    action.result,
    action.errorDetails || null,
    action.createdAt
  ).run();
  return id;
}

export async function logSystemEvent(db, event) {
  await db.prepare(
    `INSERT INTO system_logs (
       id, occurred_at, severity, component, event_type, description,
       related_record_id, error_message
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
  ).bind(
    `SYS-${crypto.randomUUID()}`,
    event.occurredAt,
    event.severity,
    event.component,
    event.eventType,
    event.description,
    event.relatedRecordId || null,
    event.errorMessage || null
  ).run();
}

export async function logSyncEvent(db, event) {
  await db.prepare(
    `INSERT INTO sync_logs (
       id, source, operation, occurred_at, result, error_details,
       retry_count, related_record_id
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
  ).bind(
    `SYNC-${crypto.randomUUID()}`,
    event.source,
    event.operation,
    event.occurredAt,
    event.result,
    event.errorDetails || "",
    Number(event.retryCount || 0),
    event.relatedRecordId || null
  ).run();
}

export async function getConversationState(db, userId, now) {
  const row = await db.prepare(
    `SELECT state_json, expires_at
       FROM conversations
      WHERE user_id = ?1`
  ).bind(userId).first();
  if (!row) return null;
  if (row.expires_at && row.expires_at <= now) {
    await clearConversationState(db, userId);
    return null;
  }
  try {
    return JSON.parse(row.state_json);
  } catch {
    await clearConversationState(db, userId);
    throw new Error("Stored conversation state is invalid and has been cleared.");
  }
}

export async function setConversationState(db, userId, state, now, ttlSeconds = 3600) {
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1) {
    throw new TypeError("Conversation state lifetime is invalid.");
  }
  const expiresAt = new Date(Date.parse(now) + ttlSeconds * 1000).toISOString();
  await db.prepare(
    `INSERT INTO conversations (user_id, state_json, expires_at, updated_at)
     VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(user_id) DO UPDATE SET
       state_json = excluded.state_json,
       expires_at = excluded.expires_at,
       updated_at = excluded.updated_at`
  ).bind(userId, JSON.stringify(state), expiresAt, now).run();
}

export async function clearConversationState(db, userId) {
  await db.prepare("DELETE FROM conversations WHERE user_id = ?1").bind(userId).run();
}

export async function getTaskCreationRequest(db, requestId) {
  return db.prepare(
    `SELECT id, google_task_id, status, error_details
       FROM mini_app_requests
      WHERE id = ?1`
  ).bind(requestId).first();
}

export async function startTaskCreationRequest(db, requestId, createdAt) {
  await db.prepare(
    `INSERT INTO mini_app_requests (id, created_at, status, error_details)
     VALUES (?1, ?2, 'Started', '')
     ON CONFLICT(id) DO NOTHING`
  ).bind(requestId, createdAt).run();
}

export async function updateTaskCreationRequest(db, requestId, googleTaskId, status, errorDetails = "") {
  const result = await db.prepare(
    `UPDATE mini_app_requests
        SET google_task_id = COALESCE(?1, google_task_id),
            status = ?2,
            error_details = ?3
      WHERE id = ?4`
  ).bind(googleTaskId || null, status, errorDetails, requestId).run();
  if (!result.meta || result.meta.changes !== 1) {
    throw new Error("Could not update the task creation request.");
  }
}
