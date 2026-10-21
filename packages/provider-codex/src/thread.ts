import { opaqueId } from './mapper.js'
import type { DebuggerToolDefinition } from '@abele/provider-contract'
import { checkEffective, policyFingerprint, type PolicyPaths } from './policy.js'
import { isCodexAuthenticated } from './auth.js'
import { codexModelAvailable, validCodexModel, validCodexCatalog } from './models.js'

export interface NativeBinding {
  workspace_path: string
  policy_fingerprint: string
  model: string
}
/** A recorded thread may only be resumed in the workspace, policy and model it was bound under. */
export function checkNativeBinding(
  paths: PolicyPaths,
  model: string | undefined,
  native_session_id?: string,
  binding?: NativeBinding
) {
  if (
    native_session_id &&
    (!opaqueId(native_session_id) ||
      binding?.workspace_path !== paths.workspace ||
      binding?.policy_fingerprint !== policyFingerprint(paths) ||
      !validCodexModel(binding?.model) ||
      (model !== undefined && binding?.model !== model))
  )
    throw new Error('codex_native_binding_mismatch')
}
/** Handshake, policy and login checks, then a new or exactly the recorded thread. */
export async function openCodexThread(
  request: (method: string, params?: unknown) => Promise<any>,
  initialized: () => Promise<void>,
  options: {
    paths: PolicyPaths
    model?: string
    native_session_id?: string
    binding?: NativeBinding
    tools?: DebuggerToolDefinition[]
  }
) {
  const { paths, model, native_session_id } = options
  const init = await request('initialize', {
    clientInfo: { name: 'abele-node', version: '0.3.7' },
    capabilities: { experimentalApi: true },
  })
  if (init.codexHome !== paths.home) throw new Error('codex_home_mismatch')
  await initialized()
  const inspect = async () => {
    const requirements = await request('configRequirements/read')
    const effective = await request('config/read', {
      cwd: paths.workspace,
      includeLayers: true,
    })
    checkEffective(effective.config, requirements, paths)
  }
  await inspect()
  const account = await request('account/read', { refreshToken: false })
  if (!isCodexAuthenticated(account)) throw new Error('codex_authentication_required')
  const models = await request('model/list', { includeHidden: false, limit: 100 })
  if (!validCodexCatalog(models) || (model && !codexModelAvailable(models, model)))
    throw new Error('codex_selected_model_unavailable')
  const params = {
    ...(model ? { model } : {}),
    cwd: paths.workspace,
    runtimeWorkspaceRoots: [paths.workspace],
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
    permissions: 'abele',
  }
  const native = await request(
    native_session_id ? 'thread/resume' : 'thread/start',
    native_session_id
      ? { ...params, modelProvider: 'openai', threadId: native_session_id, excludeTurns: true }
      : {
          ...params,
          modelProvider: 'openai',
          ephemeral: false,
          ...(options.tools?.length
            ? { dynamicTools: options.tools.map((tool) => ({ type: 'function', ...tool })) }
            : {}),
        }
  ).catch((error) => {
    if (native_session_id && error instanceof Error && error.message.startsWith('codex_rpc_error:'))
      throw new Error('codex_native_context_unavailable')
    throw error
  })
  if (
    !opaqueId(native?.thread?.id) ||
    (native_session_id && native.thread.id !== native_session_id) ||
    !validCodexModel(native.model) ||
    (model !== undefined && native.model !== model) ||
    (native_session_id && native.model !== options.binding?.model) ||
    native.modelProvider !== 'openai' ||
    native.cwd !== paths.workspace ||
    native.approvalPolicy !== 'on-request' ||
    native.approvalsReviewer !== 'user' ||
    native.activePermissionProfile?.id !== 'abele' ||
    native.activePermissionProfile.extends !== null ||
    JSON.stringify(native.runtimeWorkspaceRoots) !== JSON.stringify([paths.workspace])
  )
    throw new Error('codex_thread_policy_mismatch')
  // Codex resolves its own default at thread creation. Check the actual model
  // before binding or sending text, without turning it into a node override.
  if (!codexModelAvailable(models, native.model))
    throw new Error('codex_selected_model_unavailable')
  return {
    thread_id: native.thread.id as string,
    model: native.model as string,
    params,
    inspect,
  }
}
