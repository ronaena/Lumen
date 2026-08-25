import { z } from 'zod';
import type { ApiRequest, ApiResponse } from '../http/ApiRouter';
import type { ApiDeps } from '../ApiDeps';
import type { AdminAuditLogRepository } from '../../repositories/AdminAuditLogRepository';
import { mapErrorToHttp, VALIDATION_FAILED, NOT_FOUND } from '../errors/mapErrorToHttp';

/**
 * Admin-only voice management (Voice Management v1, approved workstream). Every handler
 * here is registered with { adminOnly: true } in server.ts -- the actual authorization
 * enforcement lives in exactly one place (ApiRouter.handle()), not duplicated here.
 *
 * "Enable/disable voice" is implemented as toggling isActive on a voice's
 * VoiceProviderMapping row(s), not a new column on `voices` itself -- the `voices` table
 * has no isActive field, and adding one would have been a second, undiscussed schema
 * change beyond the approved users.role migration. A voice with no active provider
 * mapping is already functionally unusable for narration (findMapping/getEligibleProviders
 * both require an active mapping), so this achieves the real functional intent using only
 * the already-approved schema. Documented here explicitly as a deliberate interpretation,
 * not a hidden shortcut.
 *
 * Admin Audit Log v1: auditLogRepo is passed as a separate parameter to the four
 * mutation handlers (not added to ApiDeps, matching the exact pattern already used for
 * authService), and is itself optional -- absent means audit logging is a no-op, never a
 * crash, so every existing test file that doesn't care about audit logging is unaffected.
 */

const CreateVoiceBody = z.object({
  displayName: z.string().min(1),
  role: z.enum(['narrator', 'character']).default('narrator'),
  language: z.string().min(1),
});

const UpdateVoiceBody = z.object({
  displayName: z.string().min(1).optional(),
  role: z.enum(['narrator', 'character']).optional(),
  language: z.string().min(1).optional(),
});

const CreateMappingBody = z.object({
  provider: z.enum(['elevenlabs', 'google_cloud_tts']),
  providerVoiceId: z.string().min(1),
  providerModel: z.string().optional(),
});

const UpdateMappingBody = z.object({
  providerVoiceId: z.string().min(1).optional(),
  providerModel: z.string().optional(),
  isActive: z.boolean().optional(),
});

async function audit(
  auditLogRepo: AdminAuditLogRepository | undefined,
  entry: {
    adminUserId: string;
    action: string;
    targetType: string;
    targetId: string | null;
    result: 'success' | 'failure';
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  if (!auditLogRepo) return;
  try {
    await auditLogRepo.record(entry);
  } catch {
    // Never let an audit-log write failure surface as, or be confused with, a failure
    // of the actual admin action it's describing.
  }
}

export async function handleListAllVoices(deps: ApiDeps, _req: ApiRequest): Promise<ApiResponse> {
  const voices = await deps.voiceRepo.listAll();
  return { status: 200, body: voices };
}

export async function handleCreateVoice(
  deps: ApiDeps,
  auditLogRepo: AdminAuditLogRepository | undefined,
  req: ApiRequest,
): Promise<ApiResponse> {
  const parsed = CreateVoiceBody.safeParse(req.body);
  if (!parsed.success) return { status: 400, body: VALIDATION_FAILED(parsed.error.message).body };
  try {
    const voice = await deps.voiceRepo.create(parsed.data);
    await audit(auditLogRepo, {
      adminUserId: req.identity!.userId,
      action: 'VOICE_CREATED',
      targetType: 'voice',
      targetId: voice.id,
      result: 'success',
      metadata: { displayName: voice.displayName },
    });
    return { status: 201, body: voice };
  } catch (error) {
    await audit(auditLogRepo, {
      adminUserId: req.identity!.userId,
      action: 'VOICE_CREATED',
      targetType: 'voice',
      targetId: null,
      result: 'failure',
      metadata: { displayName: parsed.data.displayName },
    });
    return mapErrorToHttp(error);
  }
}

export async function handleUpdateVoice(
  deps: ApiDeps,
  auditLogRepo: AdminAuditLogRepository | undefined,
  req: ApiRequest,
): Promise<ApiResponse> {
  const parsed = UpdateVoiceBody.safeParse(req.body);
  if (!parsed.success) return { status: 400, body: VALIDATION_FAILED(parsed.error.message).body };
  const voiceId = req.params.voiceId!;
  const existing = await deps.voiceRepo.findById(voiceId);
  if (!existing) {
    await audit(auditLogRepo, {
      adminUserId: req.identity!.userId,
      action: 'VOICE_UPDATED',
      targetType: 'voice',
      targetId: voiceId,
      result: 'failure',
    });
    return NOT_FOUND;
  }
  const updated = await deps.voiceRepo.update(voiceId, parsed.data);
  await audit(auditLogRepo, {
    adminUserId: req.identity!.userId,
    action: 'VOICE_UPDATED',
    targetType: 'voice',
    targetId: voiceId,
    result: updated ? 'success' : 'failure',
    metadata: { changedFields: Object.keys(parsed.data) },
  });
  return { status: 200, body: updated };
}

/** Read-only -- lets the admin UI show which voices currently have usable (active) provider mappings. */
export async function handleListMappingsForVoice(deps: ApiDeps, req: ApiRequest): Promise<ApiResponse> {
  const voiceId = req.params.voiceId!;
  const voice = await deps.voiceRepo.findById(voiceId);
  if (!voice) return NOT_FOUND;
  const mappings = await deps.voiceRepo.listMappingsForVoice(voiceId);
  return { status: 200, body: mappings };
}

export async function handleCreateMapping(
  deps: ApiDeps,
  auditLogRepo: AdminAuditLogRepository | undefined,
  req: ApiRequest,
): Promise<ApiResponse> {
  const parsed = CreateMappingBody.safeParse(req.body);
  if (!parsed.success) return { status: 400, body: VALIDATION_FAILED(parsed.error.message).body };
  const voiceId = req.params.voiceId!;
  const voice = await deps.voiceRepo.findById(voiceId);
  if (!voice) {
    await audit(auditLogRepo, {
      adminUserId: req.identity!.userId,
      action: 'MAPPING_CREATED',
      targetType: 'voice_provider_mapping',
      targetId: null,
      result: 'failure',
      metadata: { provider: parsed.data.provider },
    });
    return NOT_FOUND;
  }
  try {
    const mapping = await deps.voiceRepo.createMapping({ voiceId, ...parsed.data });
    // providerVoiceId is deliberately never stored -- only its provider and active
    // state, per the explicit approved restriction on this exact field.
    await audit(auditLogRepo, {
      adminUserId: req.identity!.userId,
      action: 'MAPPING_CREATED',
      targetType: 'voice_provider_mapping',
      targetId: mapping.id,
      result: 'success',
      metadata: { provider: mapping.provider, isActive: mapping.isActive },
    });
    return { status: 201, body: mapping };
  } catch (error) {
    await audit(auditLogRepo, {
      adminUserId: req.identity!.userId,
      action: 'MAPPING_CREATED',
      targetType: 'voice_provider_mapping',
      targetId: null,
      result: 'failure',
      metadata: { provider: parsed.data.provider },
    });
    return mapErrorToHttp(error);
  }
}

export async function handleUpdateMapping(
  deps: ApiDeps,
  auditLogRepo: AdminAuditLogRepository | undefined,
  req: ApiRequest,
): Promise<ApiResponse> {
  const parsed = UpdateMappingBody.safeParse(req.body);
  if (!parsed.success) return { status: 400, body: VALIDATION_FAILED(parsed.error.message).body };
  const mappingId = req.params.mappingId!;
  const existing = await deps.voiceRepo.findMappingById(mappingId);
  if (!existing || existing.voiceId !== req.params.voiceId) {
    await audit(auditLogRepo, {
      adminUserId: req.identity!.userId,
      action: 'MAPPING_UPDATED',
      targetType: 'voice_provider_mapping',
      targetId: mappingId,
      result: 'failure',
    });
    return NOT_FOUND;
  }
  const updated = await deps.voiceRepo.updateMapping(mappingId, parsed.data);
  // changedFields lists which fields changed, never their values -- providerVoiceId's
  // own value is never stored, only the fact that it (or another field) changed.
  const changedFields = Object.keys(parsed.data);
  await audit(auditLogRepo, {
    adminUserId: req.identity!.userId,
    action: 'MAPPING_UPDATED',
    targetType: 'voice_provider_mapping',
    targetId: mappingId,
    result: updated ? 'success' : 'failure',
    metadata: { changedFields },
  });
  return { status: 200, body: updated };
}
